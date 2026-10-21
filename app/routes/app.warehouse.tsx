import React from "react";
import { useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/app.warehouse";
import { requireTenantContext } from "../utils/tenant.server";
import prisma from "../db.server";
import { receiveInboundRequest, completeWarehouseInspection } from "../services/warehouse.server";
import { updateExchangeStatus } from "../services/exchanges.server";
import { executeShopifyDraftOrderCreate } from "../services/shopifySync.server";

const conditions = [
  { value: "RESTOCKABLE", label: "Restockable", description: "Resaleable, tags intact & like new", tone: "success", icon: "✨" },
  { value: "DAMAGED", label: "Damaged", description: "Transit or handling damage", tone: "warning", icon: "⚠️" },
  { value: "DEFECTIVE", label: "Defective", description: "Manufacturing flaw / faulty", tone: "critical", icon: "❌" },
  { value: "WRONG_ITEM", label: "Wrong Item", description: "Customer returned different item", tone: "critical", icon: "🔄" },
  { value: "MISSING_ITEM", label: "Missing Item", description: "Package was empty or incomplete", tone: "critical", icon: "❓" },
  { value: "DISCARD", label: "Discard / Scrap", description: "Unusable, dispose safely", tone: "critical", icon: "🗑️" },
] as const;

export async function loader({ request }: Route.LoaderArgs) {
  const { shopifyStoreId, admin } = await requireTenantContext(request);
  const [returns, exchanges] = await Promise.all([
    prisma.returnRequest.findMany({
      where: { shopifyStoreId, status: { in: ["APPROVED", "RECEIVED"] } },
      include: { items: true, warehouseIntakes: { include: { inspections: true }, orderBy: { receivedAt: "desc" } } },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.exchangeRequest.findMany({
      where: { shopifyStoreId, status: { in: ["APPROVED", "RECEIVED", "INSPECTED"] } },
      include: { items: true, warehouseIntakes: { include: { inspections: true }, orderBy: { receivedAt: "desc" } } },
      orderBy: { updatedAt: "desc" },
    }),
  ]);

  const returnIds = returns.map((row) => row.id);
  const exchangeIds = exchanges.map((row) => row.id);
  const shipmentFilters = [
    returnIds.length ? { returnRequestId: { in: returnIds } } : null,
    exchangeIds.length ? { exchangeRequestId: { in: exchangeIds } } : null,
  ].filter(Boolean);

  const shipments = shipmentFilters.length
    ? await prisma.shipmentTrack.findMany({ where: { shopifyStoreId, OR: shipmentFilters as any[] }, orderBy: { createdAt: "desc" } })
    : [];

  // Query linked orders to extract exact returned item titles and variants
  const allOrderIdentifiers = [
    ...returns.map((r) => r.shopifyOrderId),
    ...exchanges.map((e) => e.shopifyOrderId),
    ...returns.map((r) => r.orderNumber),
    ...exchanges.map((e) => e.orderNumber),
  ].filter(Boolean);

  const orders = allOrderIdentifiers.length
    ? await prisma.order.findMany({
        where: {
          shopifyStoreId,
          OR: [
            { shopifyOrderId: { in: allOrderIdentifiers } },
            { orderNumber: { in: allOrderIdentifiers } },
          ],
        },
        select: { shopifyOrderId: true, orderNumber: true, lineItems: true },
      })
    : [];

  const orderLinesMap = new Map<string, any[]>();
  for (const order of orders) {
    const lines = Array.isArray(order.lineItems) ? order.lineItems : [];
    if (order.shopifyOrderId) orderLinesMap.set(order.shopifyOrderId, lines);
    if (order.orderNumber) {
      orderLinesMap.set(order.orderNumber, lines);
      orderLinesMap.set(order.orderNumber.replace(/^#/, ""), lines);
    }
  }

  // Fallback: If any order line items are missing from cache and admin client is available, fetch them
  const missingOrders = [
    ...returns.filter((r) => !orderLinesMap.has(r.shopifyOrderId) && !orderLinesMap.has(r.orderNumber)),
    ...exchanges.filter((e) => !orderLinesMap.has(e.shopifyOrderId) && !orderLinesMap.has(e.orderNumber)),
  ];

  if (missingOrders.length > 0 && admin) {
    try {
      const { searchOrSyncOrders } = await import("../services/orders.server");
      for (const req of missingOrders.slice(0, 5)) {
        const query = req.orderNumber ? `name:${req.orderNumber.replace(/^#/, "")}` : req.shopifyOrderId;
        const synced = await searchOrSyncOrders({ shopifyStoreId, admin, query });
        for (const order of synced) {
          const lines = Array.isArray(order.lineItems) ? order.lineItems : [];
          if (order.shopifyOrderId) orderLinesMap.set(order.shopifyOrderId, lines);
          if (order.orderNumber) {
            orderLinesMap.set(order.orderNumber, lines);
            orderLinesMap.set(order.orderNumber.replace(/^#/, ""), lines);
          }
        }
      }
    } catch (err) {
      console.warn("[Warehouse Loader] Could not fetch missing order details:", err);
    }
  }

  function resolveLineItem(orderId: string, orderNumber: string, lineItemId: string) {
    const lines = orderLinesMap.get(orderId) || orderLinesMap.get(orderNumber) || orderLinesMap.get(orderNumber.replace(/^#/, "")) || [];
    const targetStr = String(lineItemId || "").trim();
    const targetDigits = targetStr.replace(/\D/g, "");
    return lines.find((l: any) => {
      const lineStr = String(l.lineItemId || "").trim();
      return lineStr === targetStr || (targetDigits && lineStr.replace(/\D/g, "") === targetDigits);
    });
  }

  const withTracking = (rows: any[], type: "RETURN" | "EXCHANGE") => rows.map((row) => {
    const shipment = shipments.find((item) => type === "RETURN" ? item.returnRequestId === row.id : item.exchangeRequestId === row.id);
    return { ...row, customerTracking: shipment?.trackingNumber || "", customerCourier: shipment?.courier || "", trackingStatus: shipment?.status || "" };
  });

  const enrichedReturns = withTracking(returns, "RETURN").map((r) => ({
    ...r,
    refundAmount: r.refundAmount === null ? null : Number(r.refundAmount),
    items: r.items.map((item: any) => {
      const originalLine = resolveLineItem(r.shopifyOrderId, r.orderNumber, item.shopifyLineItemId);
      return {
        ...item,
        returnedTitle: originalLine?.title || item.title || "Returned item",
        quantity: Number(item.quantity || 0),
      };
    }),
  }));

  const enrichedExchanges = withTracking(exchanges, "EXCHANGE").map((e) => ({
    ...e,
    items: e.items.map((item: any) => {
      const originalLine = resolveLineItem(e.shopifyOrderId, e.orderNumber, item.originalLineItemId);
      return {
        ...item,
        returnedTitle: originalLine?.title || item.title || "Original item",
        replacementTitle: item.replacementTitle || "Replacement item",
        originalQuantity: Number(item.originalQuantity || 0),
        replacementQuantity: Number(item.replacementQuantity || 0),
        priceDifference: Number(item.priceDifference || 0),
      };
    }),
  }));

  return {
    returns: enrichedReturns,
    exchanges: enrichedExchanges,
  };
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return { error: "Method not allowed" };
  const { shopifyStoreId, admin } = await requireTenantContext(request);
  const form = await request.formData();
  const actionType = String(form.get("actionType") || "");

  try {
    if (actionType === "RECEIVE_INBOUND") {
      const result = await receiveInboundRequest({
        shopifyStoreId,
        requestType: String(form.get("requestType") || "RETURN") as "RETURN" | "EXCHANGE",
        requestId: String(form.get("requestId") || ""),
        scannedAwb: String(form.get("scannedAwb") || ""),
        notes: String(form.get("notes") || ""),
      });
      return { success: true, message: "Warehouse receipt recorded successfully.", result };
    }

    if (actionType === "RETRY_REPLACEMENT") {
      const exchangeId = String(form.get("requestId") || "");
      const exchange = await prisma.exchangeRequest.findFirst({ where: { id: exchangeId, shopifyStoreId } });
      if (!exchange) return { error: "Exchange request not found for this store." };
      if (exchange.status !== "INSPECTED") return { error: "Only an inspected exchange can retry replacement-order creation." };
      if (exchange.newOrderId && !exchange.newOrderId.startsWith("gid://shopify/DraftOrder/")) {
        return { error: "A replacement Shopify order is already linked to this exchange." };
      }
      const replacement = await executeShopifyDraftOrderCreate({ shopifyStoreId, entityId: exchange.id, admin });
      if (!replacement?.success || replacement?.skipped || !replacement?.replacementOrderId) {
        return { error: replacement?.reason || "Shopify did not confirm creation of the replacement order." };
      }
      const updated = await updateExchangeStatus(
        exchange.id,
        shopifyStoreId,
        "FULFILLED",
        replacement.replacementOrderId,
        replacement.replacementOrderNumber,
        undefined,
        admin,
        "Replacement order creation retried after inspection."
      );
      return { success: true, message: `Replacement order ${updated.newOrderNumber || replacement.replacementOrderNumber || "created"} is now linked.`, result: updated };
    }

    if (actionType === "COMPLETE_INSPECTION") {
      const intakeId = String(form.get("intakeId") || "");
      const intake = await prisma.warehouseIntake.findFirst({
        where: { id: intakeId, shopifyStoreId },
        include: { returnRequest: { include: { items: true } }, exchangeRequest: { include: { items: true } } },
      });
      if (!intake) return { error: "Warehouse intake not found for this store." };

      const items: Array<{
        shopifyLineItemId: string;
        receivedQuantity: number;
        condition: any;
        inspectionNotes?: string;
        title?: string;
      }> = [];

      if (intake.returnRequest) {
        intake.returnRequest.items.forEach((item, index) => {
          items.push({
            shopifyLineItemId: item.shopifyLineItemId,
            title: String(form.get(`title_${index}`) || ""),
            receivedQuantity: Number(form.get(`receivedQuantity_${index}`)),
            condition: String(form.get(`condition_${index}`) || "RESTOCKABLE") as any,
            inspectionNotes: String(form.get(`inspectionNotes_${index}`) || ""),
          });
        });
      } else if (intake.exchangeRequest) {
        intake.exchangeRequest.items.forEach((item, index) => {
          items.push({
            shopifyLineItemId: item.originalLineItemId,
            title: String(form.get(`title_${index}`) || ""),
            receivedQuantity: Number(form.get(`receivedQuantity_${index}`)),
            condition: String(form.get(`condition_${index}`) || "RESTOCKABLE") as any,
            inspectionNotes: String(form.get(`inspectionNotes_${index}`) || ""),
          });
        });
      } else {
        return { error: "The intake is not linked to a return or exchange request." };
      }

      const result = await completeWarehouseInspection({
        shopifyStoreId,
        intakeId,
        notes: String(form.get("inspectionNotes") || ""),
        items,
      });

      return { success: true, message: "Inspection completed successfully! Workflow updated.", result };
    }

    return { error: "Unknown warehouse action." };
  } catch (error: any) {
    return { error: error?.message || String(error) };
  }
}

// Receive Package Modal Component
function ReceiveModal({
  requestType,
  request,
  onClose,
}: {
  requestType: "RETURN" | "EXCHANGE";
  request: any;
  onClose: () => void;
}) {
  const fetcher = useFetcher<typeof action>();

  React.useEffect(() => {
    if (fetcher.data?.success && fetcher.state === "idle") {
      const timer = setTimeout(() => onClose(), 800);
      return () => clearTimeout(timer);
    }
  }, [fetcher.data, fetcher.state, onClose]);

  return (
    <div className="bc-modal-backdrop" onClick={onClose}>
      <div className="bc-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="bc-modal-header">
          <div>
            <span className="bc-modal-eyebrow">RECEIVING PARCEL</span>
            <h2 className="bc-modal-title">Order #{request.orderNumber}</h2>
          </div>
          <button type="button" className="bc-modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <fetcher.Form method="post" className="bc-modal-form">
          <input type="hidden" name="actionType" value="RECEIVE_INBOUND" />
          <input type="hidden" name="requestType" value={requestType} />
          <input type="hidden" name="requestId" value={request.id} />

          <div className="bc-meta-banner">
            <div>
              <span className="bc-meta-label">Customer</span>
              <strong>{request.customerName || "Customer"}</strong>
            </div>
            <div>
              <span className="bc-meta-label">Courier</span>
              <span>{request.customerCourier || "Customer submitted"}</span>
            </div>
          </div>

          <div className="bc-form-group">
            <label htmlFor="scannedAwb" className="bc-label">
              Tracking / Airway Bill (AWB) Number <span className="bc-req">*</span>
            </label>
            <input
              id="scannedAwb"
              name="scannedAwb"
              className="bc-input"
              required
              minLength={3}
              defaultValue={request.customerTracking || ""}
              placeholder="e.g. 2781739123"
              autoFocus
            />
          </div>

          <div className="bc-form-group">
            <label htmlFor="receiveNotes" className="bc-label">Receiving Notes (Optional)</label>
            <input
              id="receiveNotes"
              name="notes"
              className="bc-input"
              placeholder="e.g. Box intact, arrived via TCS courier"
            />
          </div>

          {fetcher.data?.error && <div className="bc-alert error">{fetcher.data.error}</div>}
          {fetcher.data?.success && <div className="bc-alert success">{fetcher.data.message}</div>}

          <div className="bc-modal-footer">
            <button type="button" className="bc-btn-secondary" onClick={onClose} disabled={fetcher.state !== "idle"}>
              Cancel
            </button>
            <button type="submit" className="bc-btn-primary" disabled={fetcher.state !== "idle"}>
              {fetcher.state !== "idle" ? "Recording…" : "Confirm Parcel Receipt"}
            </button>
          </div>
        </fetcher.Form>
      </div>
    </div>
  );
}

// Complete Inspection Modal Component
function InspectionModal({
  requestType,
  request,
  intake,
  onClose,
}: {
  requestType: "RETURN" | "EXCHANGE";
  request: any;
  intake: any;
  onClose: () => void;
}) {
  const fetcher = useFetcher<typeof action>();
  const items = request.items || [];

  React.useEffect(() => {
    if (fetcher.data?.success && fetcher.state === "idle") {
      const timer = setTimeout(() => onClose(), 800);
      return () => clearTimeout(timer);
    }
  }, [fetcher.data, fetcher.state, onClose]);

  return (
    <div className="bc-modal-backdrop" onClick={onClose}>
      <div className="bc-modal-card bc-modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="bc-modal-header">
          <div>
            <div className="bc-header-tags">
              <span className="bc-tag-type">{requestType === "EXCHANGE" ? "EXCHANGE INSPECTION" : "RETURN INSPECTION"}</span>
              <span className="bc-tag-status">RECEIVED AT WAREHOUSE</span>
            </div>
            <h2 className="bc-modal-title">Inspection · Order #{request.orderNumber}</h2>
            <p className="bc-modal-sub">
              Customer: <strong>{request.customerName || "Customer"}</strong> · AWB: <strong>{request.customerTracking || "Manual Receipt"}</strong>
            </p>
          </div>
          <button type="button" className="bc-modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <fetcher.Form method="post" className="bc-modal-form">
          <input type="hidden" name="actionType" value="COMPLETE_INSPECTION" />
          <input type="hidden" name="requestType" value={requestType} />
          <input type="hidden" name="requestId" value={request.id} />
          <input type="hidden" name="intakeId" value={intake.id} />

          {/* Context Banner: Explaining what is being inspected vs replacement requested */}
          {requestType === "EXCHANGE" ? (
            <div className="bc-exchange-context-card">
              <div className="bc-exchange-col returned">
                <span className="bc-col-badge in">📦 INBOUND PARCEL (TO INSPECT)</span>
                {items.map((item: any, idx: number) => (
                  <div key={idx} className="bc-exchange-product">
                    <span className="bc-product-title">{item.returnedTitle}</span>
                    <span className="bc-product-qty">Quantity: <strong>{item.originalQuantity}</strong></span>
                  </div>
                ))}
              </div>
              <div className="bc-exchange-divider">
                <span className="bc-arrow-icon">➔</span>
              </div>
              <div className="bc-exchange-col replacement">
                <span className="bc-col-badge out">🔄 REQUESTED REPLACEMENT</span>
                {items.map((item: any, idx: number) => (
                  <div key={idx} className="bc-exchange-product">
                    <span className="bc-product-title">{item.replacementTitle}</span>
                    <span className="bc-product-qty">Quantity: <strong>{item.replacementQuantity}</strong></span>
                  </div>
                ))}
                {request.newOrderNumber && (
                  <div className="bc-replacement-link">
                    Replacement Order: <strong>{request.newOrderNumber}</strong>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bc-return-context-card">
              <span className="bc-col-badge in">📦 RETURNED ITEM FOR REFUND</span>
              {items.map((item: any, idx: number) => (
                <div key={idx} className="bc-return-product">
                  <span className="bc-product-title">{item.returnedTitle}</span>
                  <span className="bc-product-qty">Quantity: <strong>{item.quantity}</strong></span>
                </div>
              ))}
            </div>
          )}

          {/* Item Inspection Cards */}
          <div className="bc-inspection-items-list">
            <h3 className="bc-section-title">Item Inspection Results</h3>
            {items.map((item: any, index: number) => {
              const expected = requestType === "EXCHANGE" ? Number(item.originalQuantity || 1) : Number(item.quantity || 1);
              const returnedItemTitle = item.returnedTitle || "Returned Item";

              return (
                <div className="bc-item-card" key={item.id || index}>
                  <input type="hidden" name={`title_${index}`} value={returnedItemTitle} />

                  <div className="bc-item-card-header">
                    <div>
                      <span className="bc-inspect-tag">INSPECTING ITEM #{index + 1}</span>
                      <h4 className="bc-item-heading">{returnedItemTitle}</h4>
                    </div>
                    <div className="bc-expected-badge">
                      Expected: <strong>{expected}</strong> unit{expected > 1 ? "s" : ""}
                    </div>
                  </div>

                  <div className="bc-item-fields-grid">
                    <div className="bc-field">
                      <label htmlFor={`receivedQuantity_${index}`} className="bc-label">
                        Received Quantity <span className="bc-req">*</span>
                      </label>
                      <input
                        id={`receivedQuantity_${index}`}
                        name={`receivedQuantity_${index}`}
                        type="number"
                        min="0"
                        max={expected}
                        defaultValue={expected}
                        className="bc-input"
                        required
                      />
                    </div>

                    <div className="bc-field">
                      <label htmlFor={`condition_${index}`} className="bc-label">
                        Item Condition <span className="bc-req">*</span>
                      </label>
                      <select
                        id={`condition_${index}`}
                        name={`condition_${index}`}
                        defaultValue="RESTOCKABLE"
                        className="bc-select"
                      >
                        {conditions.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.icon} {c.label} ({c.description})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="bc-field bc-mt-2">
                    <label htmlFor={`inspectionNotes_${index}`} className="bc-label">Item Note</label>
                    <input
                      id={`inspectionNotes_${index}`}
                      name={`inspectionNotes_${index}`}
                      className="bc-input"
                      placeholder="e.g. Tags attached, original polybag intact, unworn"
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="bc-form-group">
            <label htmlFor="overallNotes" className="bc-label">Overall Inspection Summary</label>
            <input
              id="overallNotes"
              name="inspectionNotes"
              className="bc-input"
              placeholder="e.g. Package verified by warehouse team, safe for restocking."
            />
          </div>

          {fetcher.data?.error && <div className="bc-alert error">{fetcher.data.error}</div>}
          {fetcher.data?.success && <div className="bc-alert success">{fetcher.data.message}</div>}

          <div className="bc-modal-footer">
            <button type="button" className="bc-btn-secondary" onClick={onClose} disabled={fetcher.state !== "idle"}>
              Cancel
            </button>
            <button type="submit" className="bc-btn-primary" disabled={fetcher.state !== "idle"}>
              {fetcher.state !== "idle" ? "Completing Inspection…" : "✓ Complete Inspection"}
            </button>
          </div>
        </fetcher.Form>
      </div>
    </div>
  );
}

// Retry Replacement Order Component
function RetryReplacementForm({ requestId }: { requestId: string }) {
  const fetcher = useFetcher<typeof action>();
  return (
    <fetcher.Form method="post" className="bc-retry-card">
      <input type="hidden" name="actionType" value="RETRY_REPLACEMENT" />
      <input type="hidden" name="requestId" value={requestId} />
      <span className="bc-retry-text">Inspection complete. Replacement order pending.</span>
      <button className="bc-btn-retry" type="submit" disabled={fetcher.state !== "idle"}>
        {fetcher.state === "idle" ? "🔄 Create Replacement Order" : "Creating…"}
      </button>
      {fetcher.data?.error && <div className="bc-alert error mt-1">{fetcher.data.error}</div>}
      {fetcher.data?.success && <div className="bc-alert success mt-1">{fetcher.data.message}</div>}
    </fetcher.Form>
  );
}

export default function WarehouseReceiving() {
  const { returns, exchanges } = useLoaderData<typeof loader>();
  const [tab, setTab] = React.useState<"RETURNS" | "EXCHANGES">("EXCHANGES");
  const [filter, setFilter] = React.useState("ALL");

  const [inspectingItem, setInspectingItem] = React.useState<{
    requestType: "RETURN" | "EXCHANGE";
    request: any;
    intake: any;
  } | null>(null);

  const [receivingItem, setReceivingItem] = React.useState<{
    requestType: "RETURN" | "EXCHANGE";
    request: any;
  } | null>(null);

  const rows = tab === "RETURNS" ? returns : exchanges;
  const visible = rows.filter((request: any) => {
    const hasTracking = Boolean(request.customerTracking);
    const exchangedOut = tab === "EXCHANGES" && (request.status === "FULFILLED" || String(request.newOrderId || "").startsWith("gid://shopify/Order/"));
    if (filter === "MISSING") return request.status === "APPROVED" && !hasTracking;
    if (filter === "TRANSIT") return request.status === "APPROVED" && hasTracking;
    if (filter === "WAREHOUSE") return request.status === "RECEIVED" || request.status === "INSPECTED";
    if (filter === "EXCHANGED") return exchangedOut;
    return true;
  });

  return (
    <main className="bc-page">
      <style>{`
        :root {
          --bc-bg: #f8fafc;
          --bc-surface: #ffffff;
          --bc-border: #e2e8f0;
          --bc-text-dark: #0f172a;
          --bc-text-muted: #64748b;
          --bc-brand: #0f172a;
          --bc-brand-hover: #1e293b;
          --bc-primary-accent: #4f46e5;
          --bc-primary-accent-hover: #4338ca;
        }

        .bc-page {
          max-width: 1400px;
          margin: 0 auto;
          padding: 28px 24px;
          color: var(--bc-text-dark);
          font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }

        .bc-header-wrap {
          margin-bottom: 24px;
        }

        .bc-eyebrow {
          margin: 0 0 6px;
          color: #6366f1;
          letter-spacing: .08em;
          font-size: 11px;
          font-weight: 800;
          text-transform: uppercase;
        }

        .bc-header-wrap h1 {
          font-size: 28px;
          font-weight: 800;
          letter-spacing: -0.025em;
          margin: 0 0 6px;
          color: var(--bc-text-dark);
        }

        .bc-header-wrap p {
          color: var(--bc-text-muted);
          font-size: 14px;
          margin: 0;
        }

        /* Tabs & Filter Bars */
        .bc-controls-bar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 16px;
          margin: 22px 0 16px;
          flex-wrap: wrap;
        }

        .bc-tabs {
          display: inline-flex;
          background: #f1f5f9;
          padding: 4px;
          border-radius: 12px;
          gap: 4px;
        }

        .bc-tab-btn {
          border: none;
          background: transparent;
          padding: 8px 18px;
          border-radius: 9px;
          cursor: pointer;
          font-weight: 700;
          font-size: 13.5px;
          color: #475569;
          transition: all 0.15s ease;
        }

        .bc-tab-btn[aria-pressed="true"] {
          background: #ffffff;
          color: #0f172a;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
        }

        .bc-filters {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }

        .bc-filter-btn {
          border: 1px solid var(--bc-border);
          background: #ffffff;
          padding: 6px 14px;
          border-radius: 9999px;
          cursor: pointer;
          font-size: 12.5px;
          font-weight: 600;
          color: #64748b;
          transition: all 0.15s ease;
        }

        .bc-filter-btn:hover {
          border-color: #cbd5e1;
          color: #0f172a;
        }

        .bc-filter-btn[aria-pressed="true"] {
          background: #0f172a;
          color: #ffffff;
          border-color: #0f172a;
        }

        /* Table Card */
        .bc-table-wrap {
          overflow-x: auto;
          border: 1px solid var(--bc-border);
          border-radius: 16px;
          background: #ffffff;
          box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04);
        }

        .bc-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13.5px;
        }

        .bc-table th {
          padding: 14px 16px;
          border-bottom: 1px solid var(--bc-border);
          text-align: left;
          font-size: 11px;
          letter-spacing: .06em;
          text-transform: uppercase;
          font-weight: 700;
          color: #64748b;
          background: #f8fafc;
        }

        .bc-table td {
          padding: 16px;
          border-bottom: 1px solid #f1f5f9;
          text-align: left;
          vertical-align: middle;
        }

        .bc-table tbody tr:hover {
          background: #fafcff;
        }

        /* Order & Customer Column */
        .bc-order-title {
          font-weight: 800;
          font-size: 14px;
          color: #0f172a;
        }

        .bc-order-sub {
          font-size: 11.5px;
          color: #94a3b8;
          margin-top: 2px;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }

        .bc-customer-name {
          font-weight: 600;
          color: #1e293b;
        }

        /* Items Display */
        .bc-items-cell {
          display: flex;
          flex-direction: column;
          gap: 6px;
          max-width: 360px;
        }

        .bc-item-entry {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
        }

        .bc-pill-tag {
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          padding: 2px 7px;
          border-radius: 6px;
          white-space: nowrap;
        }

        .bc-pill-tag.inbound {
          background: #fef3c7;
          color: #92400e;
          border: 1px solid #fde68a;
        }

        .bc-pill-tag.outbound {
          background: #e0e7ff;
          color: #3730a3;
          border: 1px solid #c7d2fe;
        }

        .bc-item-name {
          font-weight: 600;
          color: #1e293b;
        }

        .bc-item-qty {
          color: #64748b;
          font-weight: 700;
          font-size: 12px;
        }

        /* Tracking & Status */
        .bc-tracking-num {
          font-weight: 700;
          color: #0f172a;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 13px;
        }

        .bc-tracking-sub {
          font-size: 11.5px;
          color: #64748b;
          margin-top: 3px;
        }

        .bc-status-chip {
          display: inline-block;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.04em;
          padding: 4px 10px;
          border-radius: 9999px;
          white-space: nowrap;
        }

        .bc-status-chip.RECEIVED {
          background: #fef3c7;
          color: #92400e;
          border: 1px solid #fde68a;
        }

        .bc-status-chip.APPROVED {
          background: #e0e7ff;
          color: #3730a3;
          border: 1px solid #c7d2fe;
        }

        .bc-status-chip.INSPECTED {
          background: #dcfce7;
          color: #166534;
          border: 1px solid #bbf7d0;
        }

        .bc-status-chip.FULFILLED {
          background: #f0fdf4;
          color: #15803d;
          border: 1px solid #86efac;
        }

        .bc-replacement-sub {
          font-size: 11.5px;
          color: #059669;
          font-weight: 600;
          margin-top: 4px;
        }

        /* Action Buttons */
        .bc-btn-inspect {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: #0f172a;
          color: #ffffff;
          border: 1px solid #0f172a;
          padding: 8px 14px;
          border-radius: 9px;
          font-size: 12.5px;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.15s ease;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
        }

        .bc-btn-inspect:hover {
          background: #1e293b;
          transform: translateY(-1px);
          box-shadow: 0 3px 6px rgba(0, 0, 0, 0.08);
        }

        .bc-btn-receive {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: #ffffff;
          color: #4f46e5;
          border: 1.5px solid #c7d2fe;
          padding: 7px 14px;
          border-radius: 9px;
          font-size: 12.5px;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .bc-btn-receive:hover {
          background: #f5f7ff;
          border-color: #6366f1;
        }

        .bc-btn-retry {
          background: #ffffff;
          color: #d97706;
          border: 1px solid #fde68a;
          padding: 6px 12px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
        }

        .bc-empty {
          border: 1px dashed #cbd5e1;
          border-radius: 16px;
          padding: 48px;
          text-align: center;
          color: #64748b;
          background: #ffffff;
          font-size: 14px;
        }

        /* Modal Overlays */
        .bc-modal-backdrop {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(15, 23, 42, 0.65);
          backdrop-filter: blur(4px);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          z-index: 9999;
          animation: bcFadeIn 0.15s ease;
        }

        @keyframes bcFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        .bc-modal-card {
          background: #ffffff;
          border-radius: 20px;
          width: 100%;
          max-width: 580px;
          box-shadow: 0 25px 50px -12px rgba(15, 23, 42, 0.25);
          overflow: hidden;
          animation: bcSlideUp 0.18s ease;
        }

        .bc-modal-card.bc-modal-lg {
          max-width: 680px;
        }

        @keyframes bcSlideUp {
          from { opacity: 0; transform: translateY(12px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }

        .bc-modal-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          padding: 24px 28px 18px;
          border-bottom: 1px solid #f1f5f9;
        }

        .bc-header-tags {
          display: flex;
          gap: 6px;
          margin-bottom: 6px;
        }

        .bc-tag-type {
          font-size: 10.5px;
          font-weight: 800;
          letter-spacing: 0.05em;
          padding: 3px 8px;
          border-radius: 6px;
          background: #eef2ff;
          color: #4338ca;
        }

        .bc-tag-status {
          font-size: 10.5px;
          font-weight: 800;
          letter-spacing: 0.05em;
          padding: 3px 8px;
          border-radius: 6px;
          background: #fef3c7;
          color: #92400e;
        }

        .bc-modal-title {
          font-size: 20px;
          font-weight: 800;
          letter-spacing: -0.02em;
          margin: 0;
          color: #0f172a;
        }

        .bc-modal-sub {
          font-size: 13px;
          color: #64748b;
          margin: 4px 0 0;
        }

        .bc-modal-close {
          border: none;
          background: #f1f5f9;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 14px;
          color: #475569;
          cursor: pointer;
          transition: all 0.12s ease;
        }

        .bc-modal-close:hover {
          background: #e2e8f0;
          color: #0f172a;
        }

        .bc-modal-form {
          padding: 24px 28px;
          max-height: 80vh;
          overflow-y: auto;
        }

        /* Exchange Context Banner */
        .bc-exchange-context-card {
          display: grid;
          grid-template-columns: 1fr auto 1fr;
          gap: 14px;
          align-items: center;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 14px;
          padding: 16px;
          margin-bottom: 22px;
        }

        .bc-exchange-col {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .bc-col-badge {
          font-size: 9.5px;
          font-weight: 800;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          margin-bottom: 4px;
        }

        .bc-col-badge.in { color: #d97706; }
        .bc-col-badge.out { color: #4f46e5; }

        .bc-product-title {
          font-weight: 700;
          font-size: 13.5px;
          color: #0f172a;
        }

        .bc-product-qty {
          font-size: 12px;
          color: #64748b;
        }

        .bc-exchange-divider {
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .bc-arrow-icon {
          font-size: 18px;
          color: #94a3b8;
        }

        .bc-return-context-card {
          background: #fffbeb;
          border: 1px solid #fde68a;
          border-radius: 14px;
          padding: 14px 18px;
          margin-bottom: 22px;
        }

        /* Section & Inspection Item Card */
        .bc-section-title {
          font-size: 13px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #64748b;
          margin: 0 0 12px;
        }

        .bc-item-card {
          border: 1px solid var(--bc-border);
          border-radius: 14px;
          padding: 16px;
          background: #ffffff;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
          margin-bottom: 16px;
        }

        .bc-item-card-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 14px;
          padding-bottom: 10px;
          border-bottom: 1px dashed #e2e8f0;
        }

        .bc-inspect-tag {
          font-size: 10px;
          font-weight: 800;
          color: #6366f1;
          letter-spacing: 0.06em;
          text-transform: uppercase;
        }

        .bc-item-heading {
          font-size: 15px;
          font-weight: 800;
          color: #0f172a;
          margin: 3px 0 0;
        }

        .bc-expected-badge {
          background: #f1f5f9;
          font-size: 12px;
          color: #334155;
          padding: 4px 10px;
          border-radius: 8px;
          font-weight: 600;
        }

        .bc-item-fields-grid {
          display: grid;
          grid-template-columns: 1fr 1.6fr;
          gap: 12px;
        }

        .bc-field {
          display: flex;
          flex-direction: column;
          gap: 5px;
        }

        .bc-mt-2 { margin-top: 10px; }

        .bc-label {
          font-size: 12px;
          font-weight: 700;
          color: #334155;
        }

        .bc-req { color: #dc2626; }

        .bc-input, .bc-select {
          border: 1.5px solid #cbd5e1;
          border-radius: 9px;
          padding: 9px 12px;
          font-size: 13.5px;
          color: #0f172a;
          background: #ffffff;
          outline: none;
          transition: border-color 0.15s ease, box-shadow 0.15s ease;
          font-family: inherit;
        }

        .bc-input:focus, .bc-select:focus {
          border-color: #4f46e5;
          box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.12);
        }

        .bc-form-group {
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin-top: 14px;
        }

        .bc-modal-footer {
          display: flex;
          justify-content: flex-end;
          gap: 10px;
          margin-top: 24px;
          padding-top: 18px;
          border-top: 1px solid #f1f5f9;
        }

        .bc-btn-secondary {
          border: 1px solid #cbd5e1;
          background: #ffffff;
          color: #334155;
          padding: 9px 18px;
          border-radius: 10px;
          font-size: 13.5px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .bc-btn-secondary:hover {
          background: #f8fafc;
        }

        .bc-btn-primary {
          border: none;
          background: #0f172a;
          color: #ffffff;
          padding: 9px 22px;
          border-radius: 10px;
          font-size: 13.5px;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.15s ease;
          box-shadow: 0 2px 4px rgba(15, 23, 42, 0.15);
        }

        .bc-btn-primary:hover {
          background: #1e293b;
          transform: translateY(-1px);
        }

        .bc-btn-primary:disabled, .bc-btn-secondary:disabled {
          opacity: 0.6;
          cursor: not-allowed;
          transform: none;
        }

        .bc-alert {
          padding: 10px 14px;
          border-radius: 10px;
          font-size: 13px;
          font-weight: 600;
          margin-top: 12px;
        }

        .bc-alert.error {
          background: #fef2f2;
          color: #b91c1c;
          border: 1px solid #fecaca;
        }

        .bc-alert.success {
          background: #f0fdf4;
          color: #15803d;
          border: 1px solid #bbf7d0;
        }

        .bc-meta-banner {
          display: flex;
          gap: 20px;
          background: #f8fafc;
          padding: 12px 16px;
          border-radius: 10px;
          border: 1px solid #e2e8f0;
          margin-bottom: 16px;
        }

        .bc-meta-label {
          display: block;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #64748b;
          font-weight: 700;
        }

        @media (max-width: 768px) {
          .bc-page { padding: 16px; }
          .bc-controls-bar { flex-direction: column; align-items: stretch; }
          .bc-item-fields-grid { grid-template-columns: 1fr; }
          .bc-exchange-context-card { grid-template-columns: 1fr; }
          .bc-exchange-divider { transform: rotate(90deg); margin: 4px 0; }
        }
      `}</style>

      {/* Header */}
      <div className="bc-header-wrap">
        <p className="bc-eyebrow">FULFILMENT & REVERSE LOGISTICS</p>
        <h1>Warehouse Receiving & Inspection</h1>
        <p>Review inbound customer return parcels, inspect garment conditions, and release replacement exchanges.</p>
      </div>

      {/* Controls Bar: Tabs and Filters */}
      <div className="bc-controls-bar">
        <div className="bc-tabs">
          <button
            type="button"
            className="bc-tab-btn"
            aria-pressed={tab === "EXCHANGES"}
            onClick={() => {
              setTab("EXCHANGES");
              setFilter("ALL");
            }}
          >
            Exchanges ({exchanges.length})
          </button>
          <button
            type="button"
            className="bc-tab-btn"
            aria-pressed={tab === "RETURNS"}
            onClick={() => {
              setTab("RETURNS");
              setFilter("ALL");
            }}
          >
            Returns ({returns.length})
          </button>
        </div>

        <div className="bc-filters">
          <button
            type="button"
            className="bc-filter-btn"
            aria-pressed={filter === "ALL"}
            onClick={() => setFilter("ALL")}
          >
            All
          </button>
          <button
            type="button"
            className="bc-filter-btn"
            aria-pressed={filter === "MISSING"}
            onClick={() => setFilter("MISSING")}
          >
            Tracking not added
          </button>
          <button
            type="button"
            className="bc-filter-btn"
            aria-pressed={filter === "TRANSIT"}
            onClick={() => setFilter("TRANSIT")}
          >
            In transit
          </button>
          <button
            type="button"
            className="bc-filter-btn"
            aria-pressed={filter === "WAREHOUSE"}
            onClick={() => setFilter("WAREHOUSE")}
          >
            At warehouse
          </button>
          {tab === "EXCHANGES" && (
            <button
              type="button"
              className="bc-filter-btn"
              aria-pressed={filter === "EXCHANGED"}
              onClick={() => setFilter("EXCHANGED")}
            >
              Exchanged out
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      {visible.length === 0 ? (
        <div className="bc-empty">No requests match this filter.</div>
      ) : (
        <div className="bc-table-wrap">
          <table className="bc-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th>Items</th>
                <th>Tracking</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((request: any) => {
                const intake = request.warehouseIntakes?.[0];
                const requestType = tab === "RETURNS" ? "RETURN" : "EXCHANGE";
                const requestItems = request.items || [];
                const exchangedOut =
                  requestType === "EXCHANGE" &&
                  String(request.newOrderId || "").startsWith("gid://shopify/Order/");

                return (
                  <tr key={request.id}>
                    {/* Order */}
                    <td>
                      <div className="bc-order-title">{request.orderNumber}</div>
                      <div className="bc-order-sub">#{request.id.slice(0, 8)}</div>
                    </td>

                    {/* Customer */}
                    <td>
                      <div className="bc-customer-name">{request.customerName || "Customer"}</div>
                    </td>

                    {/* Items */}
                    <td>
                      <div className="bc-items-cell">
                        {requestType === "EXCHANGE"
                          ? requestItems.map((item: any, i: number) => (
                              <div key={i} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                <div className="bc-item-entry">
                                  <span className="bc-pill-tag inbound">In Parcel</span>
                                  <span className="bc-item-name">{item.returnedTitle}</span>
                                  <span className="bc-item-qty">×{item.originalQuantity}</span>
                                </div>
                                <div className="bc-item-entry">
                                  <span className="bc-pill-tag outbound">Exchange</span>
                                  <span className="bc-item-name" style={{ color: "#4f46e5" }}>
                                    {item.replacementTitle}
                                  </span>
                                  <span className="bc-item-qty">×{item.replacementQuantity}</span>
                                </div>
                              </div>
                            ))
                          : requestItems.map((item: any, i: number) => (
                              <div key={i} className="bc-item-entry">
                                <span className="bc-pill-tag inbound">Return</span>
                                <span className="bc-item-name">{item.returnedTitle}</span>
                                <span className="bc-item-qty">×{item.quantity}</span>
                              </div>
                            ))}
                      </div>
                    </td>

                    {/* Tracking */}
                    <td>
                      {request.customerTracking ? (
                        <>
                          <div className="bc-tracking-num">{request.customerTracking}</div>
                          <div className="bc-tracking-sub">
                            {request.customerCourier || "Customer submitted"}
                            {request.trackingStatus ? ` · ${request.trackingStatus}` : ""}
                          </div>
                        </>
                      ) : (
                        <span className="bc-tracking-sub">Pending submission</span>
                      )}
                    </td>

                    {/* Status */}
                    <td>
                      <span className={`bc-status-chip ${request.status}`}>{request.status}</span>
                      {exchangedOut && (
                        <div className="bc-replacement-sub">
                          Replacement {request.newOrderNumber || "linked"}
                        </div>
                      )}
                    </td>

                    {/* Action */}
                    <td>
                      {request.status === "APPROVED" && (
                        <button
                          type="button"
                          className="bc-btn-receive"
                          onClick={() => setReceivingItem({ requestType, request })}
                        >
                          <span>📥</span> Receive Parcel
                        </button>
                      )}

                      {request.status === "RECEIVED" && intake?.status === "RECEIVED" && (
                        <button
                          type="button"
                          className="bc-btn-inspect"
                          onClick={() =>
                            setInspectingItem({
                              requestType,
                              request,
                              intake,
                            })
                          }
                        >
                          <span>🔍</span> Inspect Item
                        </button>
                      )}

                      {requestType === "EXCHANGE" && request.status === "INSPECTED" && !exchangedOut && (
                        <RetryReplacementForm requestId={request.id} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modals */}
      {inspectingItem && (
        <InspectionModal
          requestType={inspectingItem.requestType}
          request={inspectingItem.request}
          intake={inspectingItem.intake}
          onClose={() => setInspectingItem(null)}
        />
      )}

      {receivingItem && (
        <ReceiveModal
          requestType={receivingItem.requestType}
          request={receivingItem.request}
          onClose={() => setReceivingItem(null)}
        />
      )}
    </main>
  );
}
