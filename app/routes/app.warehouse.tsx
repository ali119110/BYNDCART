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
  return {
    returns: returns.map((r) => ({ ...r, refundAmount: r.refundAmount === null ? null : Number(r.refundAmount) })),
    exchanges: exchanges.map((e) => ({ ...e, items: e.items.map((i) => ({ ...i, priceDifference: Number(i.priceDifference) })) })),
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

function ReceiveForm({ requestType, requestId }: { requestType: "RETURN" | "EXCHANGE"; requestId: string }) {
  const fetcher = useFetcher<typeof action>();
  return <fetcher.Form method="post" className="bc-form-row">
    <input type="hidden" name="actionType" value="RECEIVE_INBOUND" />
    <input type="hidden" name="requestType" value={requestType} />
    <input type="hidden" name="requestId" value={requestId} />
    <label>Customer-provided tracking / AWB<input name="scannedAwb" required minLength={3} placeholder="Enter or scan tracking number" /></label>
    <label>Receiving note<input name="notes" placeholder="Optional package note" /></label>
    <button className="bc-btn primary" type="submit" disabled={fetcher.state !== "idle"}>{fetcher.state === "idle" ? "Receive package" : "Saving…"}</button>
    {fetcher.data?.error ? <p className="bc-error">{fetcher.data.error}</p> : null}
    {fetcher.data?.success ? <p className="bc-success">{fetcher.data.message}</p> : null}
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
  const rows = tab === "RETURNS" ? returns : exchanges;
  return <main className="bc-page">
    <style>{`
      .bc-page{max-width:1360px;margin:0 auto;padding:24px;color:#0f172a;font-family:Inter,system-ui,sans-serif}
      .bc-header{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-bottom:22px;flex-wrap:wrap}
      .bc-eyebrow{margin:0 0 6px;color:#64748b;letter-spacing:.12em;font-size:11px;font-weight:800}
      .bc-page h1{font-size:28px;letter-spacing:-.03em;margin:0}.bc-page p{color:#64748b}
      .bc-tabs{display:flex;gap:8px;margin:18px 0}.bc-tabs button{border:1px solid #e2e8f0;background:white;padding:10px 16px;border-radius:10px;cursor:pointer;font-weight:700}.bc-tabs button[aria-pressed="true"]{background:#0f172a;color:white;border-color:#0f172a}
      .bc-warehouse-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,460px),1fr));gap:16px}
      .bc-card{border:1px solid #e2e8f0;border-radius:16px;background:white;padding:18px;box-shadow:0 1px 3px rgba(15,23,42,.04)}
      .bc-card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px}.bc-card h2{font-size:17px;margin:0 0 4px}.bc-meta{font-size:12px;color:#64748b}
      .bc-status{font-size:11px;font-weight:800;border-radius:99px;padding:5px 9px;background:#fef3c7;color:#92400e;white-space:nowrap}
      .bc-form-row,.bc-inspection-form{display:flex;flex-direction:column;gap:12px;margin-top:14px}.bc-form-row label,.bc-inspection-form label{display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:700;color:#475569}
      .bc-form-row input,.bc-inspection-form input,.bc-inspection-form select{border:1px solid #cbd5e1;border-radius:8px;padding:9px 10px;min-width:0;font:inherit;background:#fff;color:#0f172a}
      .bc-inspection-item{display:grid;grid-template-columns:1.5fr .7fr 1fr;gap:8px;align-items:end;border:1px solid #e2e8f0;padding:12px;border-radius:10px}
      .bc-inspection-item-title{display:flex;flex-direction:column;gap:4px;min-width:0;overflow-wrap:anywhere}.bc-inspection-item-title small{font-size:11px;color:#64748b}
      .bc-btn{border-radius:8px;border:1px solid #cbd5e1;padding:9px 13px;background:white;font-weight:700;cursor:pointer}.bc-btn.primary{background:#111827;color:white;border-color:#111827}.bc-error{color:#b91c1c!important;font-size:12px;margin:0}.bc-success{color:#047857!important;font-size:12px;margin:0}
      .bc-empty{border:1px dashed #cbd5e1;border-radius:16px;padding:34px;text-align:center;color:#64748b;background:#f8fafc}
      @media(max-width:620px){.bc-page{padding:14px}.bc-inspection-item{grid-template-columns:1fr 1fr}.bc-inspection-item-title{grid-column:span 2}}
    `}</style>
    <header className="bc-header"><div><p className="bc-eyebrow">OPERATIONS</p><h1>Warehouse receiving & inspection</h1><p>Record the physical receipt of customer-arranged shipments, inspect every requested item, then release the workflow to refund or replacement processing.</p></div></header>
    <div className="bc-tabs"><button type="button" aria-pressed={tab === "RETURNS"} onClick={() => setTab("RETURNS")}>Returns ({returns.length})</button><button type="button" aria-pressed={tab === "EXCHANGES"} onClick={() => setTab("EXCHANGES")}>Exchanges ({exchanges.length})</button></div>
    {rows.length === 0 ? <div className="bc-empty">No approved requests are waiting for warehouse action in this tab.</div> : <div className="bc-warehouse-grid">
      {rows.map((request: any) => {
        const intake = request.warehouseIntakes?.[0];
        const requestType = tab === "RETURNS" ? "RETURN" : "EXCHANGE";
        const requestItems = request.items || [];
        return <article className="bc-card" key={request.id}>
          <div className="bc-card-head"><div><h2>{requestType === "RETURN" ? "Return" : "Exchange"} · {request.orderNumber}</h2><div className="bc-meta">Request #{request.id.slice(0, 8)} · {request.customerName || "Customer"}</div></div><span className="bc-status">{request.status}</span></div>
          <p className="bc-meta">{requestItems.map((item: any) => `${item.title || item.replacementTitle || item.shopifyLineItemId || item.originalLineItemId} × ${item.quantity ?? item.originalQuantity}`).join(" · ")}</p>
          {request.status === "APPROVED" ? <ReceiveForm requestType={requestType} requestId={request.id} /> : null}
          {request.status === "RECEIVED" && intake?.status === "RECEIVED" ? <InspectionForm requestType={requestType} requestId={request.id} intakeId={intake.id} items={requestItems} /> : null}
          {request.status === "RECEIVED" && intake?.status === "INSPECTED" ? <p className="bc-success">Inspection was recorded; refresh the page to see the resulting refund/replacement status.</p> : null}
          {requestType === "EXCHANGE" && request.status === "INSPECTED" && (!request.newOrderId || String(request.newOrderId).startsWith("gid://shopify/DraftOrder/")) ? <RetryReplacementForm requestId={request.id} /> : null}
          {requestType === "EXCHANGE" && request.newOrderNumber ? <p className="bc-success">Replacement order linked: {request.newOrderNumber}</p> : null}
          {intake ? <p className="bc-meta">Latest intake: {intake.scannedAwb} · received {new Date(intake.receivedAt).toLocaleString()}</p> : null}
        </article>;
      })}
    </div>}
  </main>;
}
