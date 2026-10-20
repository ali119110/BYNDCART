import React from "react";
import { useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/app.warehouse";
import { requireTenantContext } from "../utils/tenant.server";
import prisma from "../db.server";
import { receiveInboundRequest, completeWarehouseInspection } from "../services/warehouse.server";
import { updateExchangeStatus } from "../services/exchanges.server";
import { executeShopifyDraftOrderCreate } from "../services/shopifySync.server";

const conditions = ["RESTOCKABLE", "DAMAGED", "DEFECTIVE", "WRONG_ITEM", "MISSING_ITEM", "DISCARD"] as const;

export async function loader({ request }: Route.LoaderArgs) {
  const { shopifyStoreId } = await requireTenantContext(request);
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
  const withTracking = (rows: any[], type: "RETURN" | "EXCHANGE") => rows.map((row) => {
    const shipment = shipments.find((item) => type === "RETURN" ? item.returnRequestId === row.id : item.exchangeRequestId === row.id);
    return { ...row, customerTracking: shipment?.trackingNumber || "", customerCourier: shipment?.courier || "", trackingStatus: shipment?.status || "" };
  });
  return {
    returns: withTracking(returns, "RETURN").map((r) => ({ ...r, refundAmount: r.refundAmount === null ? null : Number(r.refundAmount) })),
    exchanges: withTracking(exchanges, "EXCHANGE").map((e) => ({ ...e, items: e.items.map((i: any) => ({ ...i, priceDifference: Number(i.priceDifference) })) })),
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
      return { success: true, message: "Warehouse receipt recorded. No courier API was called.", result };
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
      const updated = await updateExchangeStatus(exchange.id, shopifyStoreId, "FULFILLED", replacement.replacementOrderId, replacement.replacementOrderNumber, undefined, admin, "Replacement order creation retried after inspection.");
      return { success: true, message: `Replacement order ${updated.newOrderNumber || replacement.replacementOrderNumber || "created"} is now linked.`, result: updated };
    }

    if (actionType === "COMPLETE_INSPECTION") {
      const intakeId = String(form.get("intakeId") || "");
      const intake = await prisma.warehouseIntake.findFirst({
        where: { id: intakeId, shopifyStoreId },
        include: { returnRequest: { include: { items: true } }, exchangeRequest: { include: { items: true } } },
      });
      if (!intake) return { error: "Warehouse intake not found for this store." };
      const items: Array<{ shopifyLineItemId: string; receivedQuantity: number; condition: any; inspectionNotes?: string }> = [];
      if (intake.returnRequest) {
        intake.returnRequest.items.forEach((item, index) => items.push({
          shopifyLineItemId: item.shopifyLineItemId,
          receivedQuantity: Number(form.get(`receivedQuantity_${index}`)),
          condition: String(form.get(`condition_${index}`) || "RESTOCKABLE") as any,
          inspectionNotes: String(form.get(`inspectionNotes_${index}`) || ""),
        }));
      } else if (intake.exchangeRequest) {
        intake.exchangeRequest.items.forEach((item, index) => items.push({
          shopifyLineItemId: item.originalLineItemId,
          receivedQuantity: Number(form.get(`receivedQuantity_${index}`)),
          condition: String(form.get(`condition_${index}`) || "RESTOCKABLE") as any,
          inspectionNotes: String(form.get(`inspectionNotes_${index}`) || ""),
        }));
      } else {
        return { error: "The intake is not linked to a return or exchange request." };
      }
      const result = await completeWarehouseInspection({
        shopifyStoreId,
        intakeId,
        notes: String(form.get("inspectionNotes") || ""),
        items,
      });
      return { success: true, message: "Inspection saved. The next workflow step has been applied.", result };
    }
    return { error: "Unknown warehouse action." };
  } catch (error: any) {
    return { error: error?.message || String(error) };
  }
}

function ReceiveForm({ requestType, requestId, trackingNumber }: { requestType: "RETURN" | "EXCHANGE"; requestId: string; trackingNumber: string }) {
  const fetcher = useFetcher<typeof action>();
  return <fetcher.Form method="post" className="bc-inline-receive">
    <input type="hidden" name="actionType" value="RECEIVE_INBOUND" />
    <input type="hidden" name="requestType" value={requestType} />
    <input type="hidden" name="requestId" value={requestId} />
    <input name="scannedAwb" required minLength={3} defaultValue={trackingNumber} aria-label="Tracking number" placeholder="Tracking number" />
    <input name="notes" placeholder="Note" aria-label="Receiving note" />
    <button className="bc-btn primary" type="submit" disabled={fetcher.state !== "idle"}>{fetcher.state === "idle" ? "Receive" : "Saving…"}</button>
    {fetcher.data?.error ? <span className="bc-error">{fetcher.data.error}</span> : null}
  </fetcher.Form>;
}

function RetryReplacementForm({ requestId }: { requestId: string }) {
  const fetcher = useFetcher<typeof action>();
  return <fetcher.Form method="post" className="bc-form-row">
    <input type="hidden" name="actionType" value="RETRY_REPLACEMENT" />
    <input type="hidden" name="requestId" value={requestId} />
    <p className="bc-meta">Inspection is complete, but Shopify has not yet returned a replacement order. You can safely retry creation here.</p>
    <button className="bc-btn primary" type="submit" disabled={fetcher.state !== "idle"}>{fetcher.state === "idle" ? "Retry replacement order" : "Retrying…"}</button>
    {fetcher.data?.error ? <p className="bc-error">{fetcher.data.error}</p> : null}
    {fetcher.data?.success ? <p className="bc-success">{fetcher.data.message}</p> : null}
  </fetcher.Form>;
}

function InspectionForm({ requestType, requestId, intakeId, items }: { requestType: "RETURN" | "EXCHANGE"; requestId: string; intakeId: string; items: any[] }) {
  const fetcher = useFetcher<typeof action>();
  return <fetcher.Form method="post" className="bc-inspection-form">
    <input type="hidden" name="actionType" value="COMPLETE_INSPECTION" />
    <input type="hidden" name="requestType" value={requestType} />
    <input type="hidden" name="requestId" value={requestId} />
    <input type="hidden" name="intakeId" value={intakeId} />
    {items.map((item, index) => {
      const title = item.title || item.replacementTitle || item.shopifyLineItemId || item.originalLineItemId || `Item ${index + 1}`;
      const expected = Number(item.quantity ?? item.originalQuantity ?? 0);
      return <div className="bc-inspection-item" key={item.id}>
        <div className="bc-inspection-item-title"><strong>{title}</strong><small>Expected: {expected}</small></div>
        <label>Received qty<input name={`receivedQuantity_${index}`} type="number" min="0" max={expected} defaultValue={expected} required /></label>
        <label>Condition<select name={`condition_${index}`} defaultValue="RESTOCKABLE">{conditions.map((condition) => <option key={condition} value={condition}>{condition.replaceAll("_", " ")}</option>)}</select></label>
        <label>Item note<input name={`inspectionNotes_${index}`} placeholder="Optional condition note" /></label>
      </div>;
    })}
    <label>Inspection summary<input name="inspectionNotes" placeholder="Optional overall inspection note" /></label>
    <button className="bc-btn primary" type="submit" disabled={fetcher.state !== "idle"}>{fetcher.state === "idle" ? "Complete inspection" : "Saving…"}</button>
    {fetcher.data?.error ? <p className="bc-error">{fetcher.data.error}</p> : null}
    {fetcher.data?.success ? <p className="bc-success">{fetcher.data.message}</p> : null}
  </fetcher.Form>;
}

export default function WarehouseReceiving() {
  const { returns, exchanges } = useLoaderData<typeof loader>();
  const [tab, setTab] = React.useState<"RETURNS" | "EXCHANGES">("RETURNS");
  const [filter, setFilter] = React.useState("ALL");
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
  return <main className="bc-page">
    <style>{`
      .bc-page{max-width:1360px;margin:0 auto;padding:24px;color:#0f172a;font-family:Inter,system-ui,sans-serif}
      .bc-eyebrow{margin:0 0 6px;color:#64748b;letter-spacing:.12em;font-size:11px;font-weight:800}
      .bc-page h1{font-size:28px;letter-spacing:-.03em;margin:0}.bc-page p{color:#64748b}
      .bc-tabs,.bc-filters{display:flex;gap:8px;margin:18px 0;flex-wrap:wrap}.bc-tabs button,.bc-filters button{border:1px solid #e2e8f0;background:white;padding:8px 12px;border-radius:10px;cursor:pointer;font-weight:700}.bc-tabs button[aria-pressed="true"],.bc-filters button[aria-pressed="true"]{background:#0f172a;color:white;border-color:#0f172a}
      .bc-table-wrap{overflow:auto;border:1px solid #e2e8f0;border-radius:14px;background:white}
      .bc-table{width:100%;border-collapse:collapse;font-size:13px}.bc-table th,.bc-table td{padding:12px;border-bottom:1px solid #eef2f6;text-align:left;vertical-align:middle}
      .bc-table th{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#64748b;background:#f8fafc}
      .bc-meta{font-size:12px;color:#64748b}.bc-status{font-size:11px;font-weight:800;border-radius:99px;padding:4px 8px;background:#fef3c7;color:#92400e;white-space:nowrap}
      .bc-inline-receive{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.bc-inline-receive input{border:1px solid #cbd5e1;border-radius:8px;padding:8px 10px;min-width:0;font:inherit}
      .bc-btn{border-radius:8px;border:1px solid #cbd5e1;padding:8px 12px;background:white;font-weight:700;cursor:pointer}.bc-btn.primary{background:#111827;color:white;border-color:#111827}.bc-error{color:#b91c1c;font-size:12px}.bc-success{color:#047857;font-size:12px}
      .bc-empty{border:1px dashed #cbd5e1;border-radius:16px;padding:34px;text-align:center;color:#64748b;background:#f8fafc}
      .bc-details{margin-top:8px}.bc-inspection-form{display:flex;flex-direction:column;gap:10px}.bc-inspection-item{display:grid;grid-template-columns:1.4fr .6fr 1fr;gap:8px}
      @media(max-width:760px){.bc-page{padding:14px}.bc-inspection-item{grid-template-columns:1fr}}
    `}</style>
    <header><p className="bc-eyebrow">OPERATIONS</p><h1>Warehouse receiving & inspection</h1><p>Customer tracking numbers appear here automatically. Receive the parcel, then inspect it.</p></header>
    <div className="bc-tabs"><button type="button" aria-pressed={tab === "RETURNS"} onClick={() => { setTab("RETURNS"); setFilter("ALL"); }}>Returns ({returns.length})</button><button type="button" aria-pressed={tab === "EXCHANGES"} onClick={() => { setTab("EXCHANGES"); setFilter("ALL"); }}>Exchanges ({exchanges.length})</button></div>
    <div className="bc-filters">
      <button type="button" aria-pressed={filter === "ALL"} onClick={() => setFilter("ALL")}>All</button>
      <button type="button" aria-pressed={filter === "MISSING"} onClick={() => setFilter("MISSING")}>Tracking not added</button>
      <button type="button" aria-pressed={filter === "TRANSIT"} onClick={() => setFilter("TRANSIT")}>In transit</button>
      <button type="button" aria-pressed={filter === "WAREHOUSE"} onClick={() => setFilter("WAREHOUSE")}>At warehouse</button>
      {tab === "EXCHANGES" ? <button type="button" aria-pressed={filter === "EXCHANGED"} onClick={() => setFilter("EXCHANGED")}>Exchanged out</button> : null}
    </div>
    {visible.length === 0 ? <div className="bc-empty">No requests match this filter.</div> : <div className="bc-table-wrap"><table className="bc-table"><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Tracking</th><th>Status</th><th>Action</th></tr></thead><tbody>
      {visible.map((request: any) => {
        const intake = request.warehouseIntakes?.[0];
        const requestType = tab === "RETURNS" ? "RETURN" : "EXCHANGE";
        const requestItems = request.items || [];
        const exchangedOut = requestType === "EXCHANGE" && String(request.newOrderId || "").startsWith("gid://shopify/Order/");
        return <tr key={request.id}>
          <td><strong>{request.orderNumber}</strong><div className="bc-meta">#{request.id.slice(0, 8)}</div></td>
          <td>{request.customerName || "Customer"}</td>
          <td className="bc-meta">{requestItems.map((item: any) => `${item.title || item.replacementTitle || "Item"} × ${item.quantity ?? item.originalQuantity}`).join(", ")}</td>
          <td>{request.customerTracking ? <><strong>{request.customerTracking}</strong><div className="bc-meta">{request.customerCourier || "Customer submitted"}{request.trackingStatus ? ` · ${request.trackingStatus}` : ""}</div></> : <span className="bc-meta">Not submitted</span>}</td>
          <td><span className="bc-status">{request.status}</span>{exchangedOut ? <div className="bc-success">Replacement {request.newOrderNumber || "linked"}</div> : null}</td>
          <td>
            {request.status === "APPROVED" ? <ReceiveForm requestType={requestType} requestId={request.id} trackingNumber={request.customerTracking || ""} /> : null}
            {request.status === "RECEIVED" && intake?.status === "RECEIVED" ? <details className="bc-details"><summary>Inspect</summary><InspectionForm requestType={requestType} requestId={request.id} intakeId={intake.id} items={requestItems} /></details> : null}
            {requestType === "EXCHANGE" && request.status === "INSPECTED" && !exchangedOut ? <RetryReplacementForm requestId={request.id} /> : null}
          </td>
        </tr>;
      })}
    </tbody></table></div>}
  </main>;
}
