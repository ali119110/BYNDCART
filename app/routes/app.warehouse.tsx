import React from "react";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import type { Route } from "./+types/app.warehouse";
import { requireTenantContext } from "../utils/tenant.server";
import prisma from "../db.server";
import { receiveInboundRequest, completeWarehouseInspection } from "../services/warehouse.server";
import { updateExchangeStatus } from "../services/exchanges.server";
import { executeShopifyDraftOrderCreate } from "../services/shopifySync.server";

const conditions = [
  { value: "RESTOCKABLE", label: "Restockable" },
  { value: "DAMAGED", label: "Damaged" },
  { value: "DEFECTIVE", label: "Defective" },
  { value: "WRONG_ITEM", label: "Wrong item" },
  { value: "MISSING_ITEM", label: "Missing item" },
  { value: "DISCARD", label: "Discard" },
] as const;

export async function loader({ request }: Route.LoaderArgs) {
  const { shopifyStoreId, admin } = await requireTenantContext(request);
  const [returns, exchanges] = await Promise.all([
    prisma.returnRequest.findMany({
      where: { shopifyStoreId, status: { in: ["APPROVED", "RECEIVED", "INSPECTED"] } },
      include: { items: true, warehouseIntakes: { include: { inspections: true }, orderBy: { receivedAt: "desc" } } },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.exchangeRequest.findMany({
      where: { shopifyStoreId, status: { in: ["APPROVED", "RECEIVED", "INSPECTED", "FULFILLED", "COMPLETED"] } },
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
      return { success: true, message: "Receipt recorded.", result };
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
      return { success: true, message: `Replacement order ${updated.newOrderNumber || replacement.replacementOrderNumber || "created"} linked.`, result: updated };
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

      return { success: true, message: "Inspection completed.", result };
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
            <h2 className="bc-modal-title">Receive parcel · #{request.orderNumber}</h2>
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
              <span>{request.customerName || "Customer"}</span>
            </div>
            <div>
              <span className="bc-meta-label">Courier</span>
              <span>{request.customerCourier || "Customer submitted"}</span>
            </div>
          </div>

          <div className="bc-form-group">
            <label htmlFor="scannedAwb" className="bc-label">
              Tracking / AWB <span className="bc-req">*</span>
            </label>
            <input
              id="scannedAwb"
              name="scannedAwb"
              className="bc-input"
              required
              minLength={3}
              defaultValue={request.customerTracking || ""}
              placeholder="Tracking number"
              autoFocus
            />
          </div>

          <div className="bc-form-group">
            <label htmlFor="receiveNotes" className="bc-label">Notes</label>
            <input
              id="receiveNotes"
              name="notes"
              className="bc-input"
              placeholder="Optional notes"
            />
          </div>

          {fetcher.data?.error && <div className="bc-alert error">{fetcher.data.error}</div>}
          {fetcher.data?.success && <div className="bc-alert success">{fetcher.data.message}</div>}

          <div className="bc-modal-footer">
            <button type="button" className="bc-btn-secondary" onClick={onClose} disabled={fetcher.state !== "idle"}>
              Cancel
            </button>
            <button type="submit" className="bc-btn-primary" disabled={fetcher.state !== "idle"}>
              {fetcher.state !== "idle" ? "Saving…" : "Confirm receipt"}
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
            <h2 className="bc-modal-title">
              {requestType === "EXCHANGE" ? "Exchange inspection" : "Return inspection"} · #{request.orderNumber}
            </h2>
            <p className="bc-modal-sub">
              {request.customerName || "Customer"} · Tracking: {request.customerTracking || "None"}
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
              <div className="bc-exchange-col">
                <span className="bc-col-label">Inbound (To inspect)</span>
                {items.map((item: any, idx: number) => (
                  <div key={idx} className="bc-exchange-product">
                    <span className="bc-product-title">{item.returnedTitle}</span>
                    <span className="bc-product-qty">Qty: {item.originalQuantity}</span>
                  </div>
                ))}
              </div>
              <div className="bc-exchange-divider">
                <span className="bc-arrow-text">→</span>
              </div>
              <div className="bc-exchange-col">
                <span className="bc-col-label">Requested replacement</span>
                {items.map((item: any, idx: number) => (
                  <div key={idx} className="bc-exchange-product">
                    <span className="bc-product-title">{item.replacementTitle}</span>
                    <span className="bc-product-qty">Qty: {item.replacementQuantity}</span>
                  </div>
                ))}
                {request.newOrderNumber && (
                  <div className="bc-replacement-link">
                    Replacement order: {request.newOrderNumber}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bc-return-context-card">
              <span className="bc-col-label">Returned item</span>
              {items.map((item: any, idx: number) => (
                <div key={idx} className="bc-return-product">
                  <span className="bc-product-title">{item.returnedTitle}</span>
                  <span className="bc-product-qty">Qty: {item.quantity}</span>
                </div>
              ))}
            </div>
          )}

          {/* Item Inspection Cards */}
          <div className="bc-inspection-items-list">
            <h3 className="bc-section-title">Items</h3>
            {items.map((item: any, index: number) => {
              const expected = requestType === "EXCHANGE" ? Number(item.originalQuantity || 1) : Number(item.quantity || 1);
              const returnedItemTitle = item.returnedTitle || "Returned Item";

              return (
                <div className="bc-item-card" key={item.id || index}>
                  <input type="hidden" name={`title_${index}`} value={returnedItemTitle} />

                  <div className="bc-item-card-header">
                    <div>
                      <h4 className="bc-item-heading">{returnedItemTitle}</h4>
                    </div>
                    <div className="bc-expected-badge">
                      Expected: {expected}
                    </div>
                  </div>

                  <div className="bc-item-fields-grid">
                    <div className="bc-field">
                      <label htmlFor={`receivedQuantity_${index}`} className="bc-label">
                        Received qty
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
                        Condition
                      </label>
                      <select
                        id={`condition_${index}`}
                        name={`condition_${index}`}
                        defaultValue="RESTOCKABLE"
                        className="bc-select"
                      >
                        {conditions.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="bc-field bc-mt-2">
                    <label htmlFor={`inspectionNotes_${index}`} className="bc-label">Note</label>
                    <input
                      id={`inspectionNotes_${index}`}
                      name={`inspectionNotes_${index}`}
                      className="bc-input"
                      placeholder="Optional item note"
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="bc-form-group">
            <label htmlFor="overallNotes" className="bc-label">Overall notes</label>
            <input
              id="overallNotes"
              name="inspectionNotes"
              className="bc-input"
              placeholder="Optional summary"
            />
          </div>

          {fetcher.data?.error && <div className="bc-alert error">{fetcher.data.error}</div>}
          {fetcher.data?.success && <div className="bc-alert success">{fetcher.data.message}</div>}

          <div className="bc-modal-footer">
            <button type="button" className="bc-btn-secondary" onClick={onClose} disabled={fetcher.state !== "idle"}>
              Cancel
            </button>
            <button type="submit" className="bc-btn-primary" disabled={fetcher.state !== "idle"}>
              {fetcher.state !== "idle" ? "Saving…" : "Complete inspection"}
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
      <span className="bc-retry-text">Replacement pending</span>
      <button className="bc-btn-retry" type="submit" disabled={fetcher.state !== "idle"}>
        {fetcher.state === "idle" ? "Create replacement order" : "Creating…"}
      </button>
      {fetcher.data?.error && <div className="bc-alert error mt-1">{fetcher.data.error}</div>}
      {fetcher.data?.success && <div className="bc-alert success mt-1">{fetcher.data.message}</div>}
    </fetcher.Form>
  );
}

export default function WarehouseReceiving() {
  const { returns, exchanges } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const initialTab: "RETURNS" | "EXCHANGES" = requestedTab === "RETURNS" ? "RETURNS" : "EXCHANGES";
  const requestedFilter = searchParams.get("filter") || "ALL";
  const allowedFilters = ["ALL", "MISSING", "TRANSIT", "WAREHOUSE", "EXCHANGED"];
  const initialFilter = allowedFilters.includes(requestedFilter) ? requestedFilter : "ALL";
  const [tab, setTab] = React.useState<"RETURNS" | "EXCHANGES">(initialTab);
  const [filter, setFilter] = React.useState(initialFilter);

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
        }

        .bc-page {
          max-width: 1400px;
          margin: 0 auto;
          padding: 24px;
          color: var(--bc-text-dark);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }

        .bc-header-wrap {
          margin-bottom: 20px;
        }

        .bc-header-wrap h1 {
          font-size: 24px;
          font-weight: 700;
          letter-spacing: -0.02em;
          margin: 0 0 4px;
          color: var(--bc-text-dark);
        }

        .bc-header-wrap p {
          color: var(--bc-text-muted);
          font-size: 13.5px;
          margin: 0;
        }

        /* Tabs & Filter Bars */
        .bc-controls-bar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          margin: 18px 0 14px;
          flex-wrap: wrap;
        }

        .bc-tabs {
          display: inline-flex;
          background: #f1f5f9;
          padding: 3px;
          border-radius: 8px;
          gap: 2px;
        }

        .bc-tab-btn {
          border: none;
          background: transparent;
          padding: 6px 14px;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
          font-size: 13px;
          color: #64748b;
          transition: all 0.15s ease;
        }

        .bc-tab-btn[aria-pressed="true"] {
          background: #ffffff;
          color: #0f172a;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
        }

        .bc-filters {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }

        .bc-filter-btn {
          border: 1px solid var(--bc-border);
          background: #ffffff;
          padding: 5px 12px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 500;
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
          border-radius: 10px;
          background: #ffffff;
        }

        .bc-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }

        .bc-table th {
          padding: 12px 14px;
          border-bottom: 1px solid var(--bc-border);
          text-align: left;
          font-size: 11px;
          letter-spacing: .04em;
          text-transform: uppercase;
          font-weight: 600;
          color: #64748b;
          background: #f8fafc;
        }

        .bc-table td {
          padding: 14px;
          border-bottom: 1px solid #f1f5f9;
          text-align: left;
          vertical-align: middle;
        }

        .bc-table tbody tr:hover {
          background: #f8fafc;
        }

        .bc-order-title {
          font-weight: 600;
          font-size: 13.5px;
          color: #0f172a;
        }

        .bc-order-sub {
          font-size: 11px;
          color: #94a3b8;
          margin-top: 2px;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }

        .bc-customer-name {
          font-weight: 500;
          color: #1e293b;
        }

        .bc-items-cell {
          display: flex;
          flex-direction: column;
          gap: 4px;
          max-width: 360px;
        }

        .bc-item-entry {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12.5px;
        }

        .bc-pill-tag {
          font-size: 10px;
          font-weight: 500;
          padding: 1px 6px;
          border-radius: 4px;
          white-space: nowrap;
          background: #f1f5f9;
          color: #475569;
          border: 1px solid #e2e8f0;
        }

        .bc-item-name {
          font-weight: 500;
          color: #1e293b;
        }

        .bc-item-qty {
          color: #94a3b8;
          font-size: 11.5px;
        }

        .bc-tracking-num {
          font-weight: 500;
          color: #0f172a;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 12.5px;
        }

        .bc-tracking-sub {
          font-size: 11.5px;
          color: #64748b;
          margin-top: 2px;
        }

        .bc-status-chip {
          display: inline-block;
          font-size: 11px;
          font-weight: 600;
          padding: 2px 8px;
          border-radius: 4px;
          background: #f1f5f9;
          color: #334155;
          border: 1px solid #e2e8f0;
          white-space: nowrap;
        }

        .bc-status-chip.INSPECTED {
          background: #0f172a;
          color: #ffffff;
          border-color: #0f172a;
        }

        .bc-replacement-sub {
          font-size: 11px;
          color: #64748b;
          margin-top: 3px;
        }

        /* Action Buttons */
        .bc-btn-inspect {
          background: #0f172a;
          color: #ffffff;
          border: 1px solid #0f172a;
          padding: 6px 14px;
          border-radius: 6px;
          font-size: 12.5px;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.15s ease;
        }

        .bc-btn-inspect:hover {
          background: #1e293b;
        }

        .bc-btn-receive {
          background: #ffffff;
          color: #0f172a;
          border: 1px solid var(--bc-border);
          padding: 6px 14px;
          border-radius: 6px;
          font-size: 12.5px;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.15s ease;
        }

        .bc-btn-receive:hover {
          background: #f8fafc;
        }

        .bc-btn-retry {
          background: #ffffff;
          color: #0f172a;
          border: 1px solid var(--bc-border);
          padding: 5px 10px;
          border-radius: 6px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
        }

        .bc-empty {
          border: 1px dashed var(--bc-border);
          border-radius: 10px;
          padding: 40px;
          text-align: center;
          color: #64748b;
          background: #ffffff;
          font-size: 13.5px;
        }

        /* Modal Overlays */
        .bc-modal-backdrop {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(15, 23, 42, 0.4);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
          z-index: 9999;
        }

        .bc-modal-card {
          background: #ffffff;
          border-radius: 10px;
          width: 100%;
          max-width: 520px;
          box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1);
          overflow: hidden;
          border: 1px solid var(--bc-border);
        }

        .bc-modal-card.bc-modal-lg {
          max-width: 580px;
        }

        .bc-modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px 20px;
          border-bottom: 1px solid #f1f5f9;
        }

        .bc-modal-title {
          font-size: 16px;
          font-weight: 600;
          margin: 0;
          color: #0f172a;
        }

        .bc-modal-sub {
          font-size: 12.5px;
          color: #64748b;
          margin: 2px 0 0;
        }

        .bc-modal-close {
          border: none;
          background: transparent;
          width: 28px;
          height: 28px;
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 15px;
          color: #64748b;
          cursor: pointer;
        }

        .bc-modal-close:hover {
          background: #f1f5f9;
          color: #0f172a;
        }

        .bc-modal-form {
          padding: 18px 20px;
          max-height: 80vh;
          overflow-y: auto;
        }

        /* Exchange context card */
        .bc-exchange-context-card {
          display: grid;
          grid-template-columns: 1fr auto 1fr;
          gap: 12px;
          align-items: center;
          background: #f8fafc;
          border: 1px solid var(--bc-border);
          border-radius: 8px;
          padding: 12px 14px;
          margin-bottom: 16px;
        }

        .bc-exchange-col {
          display: flex;
          flex-direction: column;
          gap: 3px;
        }

        .bc-col-label {
          font-size: 11px;
          font-weight: 600;
          color: #64748b;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          margin-bottom: 2px;
        }

        .bc-product-title {
          font-weight: 600;
          font-size: 13px;
          color: #0f172a;
        }

        .bc-product-qty {
          font-size: 12px;
          color: #64748b;
        }

        .bc-arrow-text {
          font-size: 14px;
          color: #94a3b8;
        }

        .bc-replacement-link {
          font-size: 11px;
          color: #64748b;
          margin-top: 4px;
        }

        .bc-return-context-card {
          background: #f8fafc;
          border: 1px solid var(--bc-border);
          border-radius: 8px;
          padding: 12px 14px;
          margin-bottom: 16px;
        }

        /* Item cards */
        .bc-section-title {
          font-size: 11.5px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: #64748b;
          margin: 0 0 10px;
        }

        .bc-item-card {
          border: 1px solid var(--bc-border);
          border-radius: 8px;
          padding: 12px 14px;
          background: #ffffff;
          margin-bottom: 12px;
        }

        .bc-item-card-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
          padding-bottom: 8px;
          border-bottom: 1px solid #f1f5f9;
        }

        .bc-item-heading {
          font-size: 13.5px;
          font-weight: 600;
          color: #0f172a;
          margin: 0;
        }

        .bc-expected-badge {
          background: #f1f5f9;
          font-size: 11.5px;
          color: #475569;
          padding: 2px 8px;
          border-radius: 4px;
        }

        .bc-item-fields-grid {
          display: grid;
          grid-template-columns: 1fr 1.6fr;
          gap: 10px;
        }

        .bc-field {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .bc-mt-2 { margin-top: 8px; }

        .bc-label {
          font-size: 11.5px;
          font-weight: 500;
          color: #475569;
        }

        .bc-req { color: #dc2626; }

        .bc-input, .bc-select {
          border: 1px solid var(--bc-border);
          border-radius: 6px;
          padding: 7px 10px;
          font-size: 13px;
          color: #0f172a;
          background: #ffffff;
          outline: none;
          font-family: inherit;
        }

        .bc-input:focus, .bc-select:focus {
          border-color: #0f172a;
        }

        .bc-form-group {
          display: flex;
          flex-direction: column;
          gap: 4px;
          margin-top: 12px;
        }

        .bc-modal-footer {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 16px;
          padding-top: 14px;
          border-top: 1px solid #f1f5f9;
        }

        .bc-btn-secondary {
          border: 1px solid var(--bc-border);
          background: #ffffff;
          color: #334155;
          padding: 7px 14px;
          border-radius: 6px;
          font-size: 12.5px;
          font-weight: 500;
          cursor: pointer;
        }

        .bc-btn-secondary:hover {
          background: #f8fafc;
        }

        .bc-btn-primary {
          border: 1px solid #0f172a;
          background: #0f172a;
          color: #ffffff;
          padding: 7px 16px;
          border-radius: 6px;
          font-size: 12.5px;
          font-weight: 500;
          cursor: pointer;
        }

        .bc-btn-primary:hover {
          background: #1e293b;
        }

        .bc-btn-primary:disabled, .bc-btn-secondary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .bc-alert {
          padding: 8px 12px;
          border-radius: 6px;
          font-size: 12px;
          margin-top: 10px;
        }

        .bc-alert.error {
          background: #fef2f2;
          color: #991b1b;
          border: 1px solid #fee2e2;
        }

        .bc-alert.success {
          background: #f1f5f9;
          color: #0f172a;
          border: 1px solid var(--bc-border);
        }

        .bc-meta-banner {
          display: flex;
          gap: 16px;
          background: #f8fafc;
          padding: 10px 12px;
          border-radius: 6px;
          border: 1px solid var(--bc-border);
          margin-bottom: 14px;
          font-size: 12px;
        }

        .bc-meta-label {
          display: block;
          font-size: 10.5px;
          color: #64748b;
          font-weight: 500;
        }

        .bc-retry-card {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .bc-retry-text {
          font-size: 12px;
          color: #64748b;
        }

        @media (max-width: 768px) {
          .bc-page { padding: 14px; }
          .bc-controls-bar { flex-direction: column; align-items: stretch; }
          .bc-item-fields-grid { grid-template-columns: 1fr; }
          .bc-exchange-context-card { grid-template-columns: 1fr; }
          .bc-exchange-divider { display: none; }
        }
      `}</style>

      {/* Header */}
      <div className="bc-header-wrap">
        <h1>Warehouse</h1>
        <p>Receiving and inspection</p>
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
                                  <span className="bc-pill-tag">In parcel</span>
                                  <span className="bc-item-name">{item.returnedTitle}</span>
                                  <span className="bc-item-qty">×{item.originalQuantity}</span>
                                </div>
                                <div className="bc-item-entry">
                                  <span className="bc-pill-tag">Exchange</span>
                                  <span className="bc-item-name">
                                    {item.replacementTitle}
                                  </span>
                                  <span className="bc-item-qty">×{item.replacementQuantity}</span>
                                </div>
                              </div>
                            ))
                          : requestItems.map((item: any, i: number) => (
                              <div key={i} className="bc-item-entry">
                                <span className="bc-pill-tag">Return</span>
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
                          Receive
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
                          Inspect
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
