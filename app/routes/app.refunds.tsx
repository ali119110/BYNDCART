import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { useState } from "react";
import prisma from "../db.server";
import { triggerLifecycleNotification } from "../services/notifications.server";
import { requireTenantContext } from "../utils/tenant.server";
import { assertPermission } from "../services/permissions.server";
import { listEvidence, saveEvidence } from "../services/evidence.server";
import {
  confirmRefundRecord,
  convertExchangeToManualRefund,
  createRefundRecord,
  isRefundMethod,
  listRefundRecords,
} from "../services/refunds.server";

const REFUND_METHODS = ["SHOPIFY", "STORE_CREDIT", "BANK_TRANSFER", "EASYPAISA", "JAZZCASH", "MANUAL"] as const;

export async function loader({ request }: LoaderFunctionArgs) {
  const { shopifyStoreId } = await requireTenantContext(request);
  const [refunds, evidence, returns, exchanges] = await Promise.all([
    listRefundRecords(shopifyStoreId),
    listEvidence(shopifyStoreId),
    prisma.returnRequest.findMany({
      where: { shopifyStoreId, status: { in: ["APPROVED", "COMPLETED"] } },
      include: { items: true },
      orderBy: { updatedAt: "desc" },
      take: 200,
    }),
    prisma.exchangeRequest.findMany({
      where: { shopifyStoreId, status: { in: ["PENDING", "APPROVED"] } },
      include: { items: true },
      orderBy: { updatedAt: "desc" },
      take: 200,
    }),
  ]);

  const shopifyOrderIds = Array.from(new Set([
    ...returns.map((item: any) => item.shopifyOrderId),
    ...exchanges.map((item: any) => item.shopifyOrderId),
  ].filter(Boolean)));
  const orders = shopifyOrderIds.length
    ? await prisma.order.findMany({
        where: { shopifyStoreId, shopifyOrderId: { in: shopifyOrderIds } },
      })
    : [];
  const orderMap = new Map(orders.map((order: any) => [order.shopifyOrderId, order]));
  const refundRequestKeys = new Set(refunds
    .filter((refund) => refund.status !== "CANCELLED")
    .flatMap((refund) => [
      refund.returnRequestId ? `RETURN:${refund.returnRequestId}` : "",
      refund.exchangeRequestId ? `EXCHANGE:${refund.exchangeRequestId}` : "",
    ])
    .filter(Boolean));

  const refundableRequests = [
    ...returns.map((item: any) => ({ ...item, requestType: "RETURN", order: orderMap.get(item.shopifyOrderId) || null })),
    ...exchanges.map((item: any) => ({ ...item, requestType: "EXCHANGE", order: orderMap.get(item.shopifyOrderId) || null })),
  ].filter((item: any) => !refundRequestKeys.has(`${item.requestType}:${item.id}`));

  const linkedReturns = Array.from(new Set(refunds.map((refund) => refund.returnRequestId).filter(Boolean))) as string[];
  const linkedExchanges = Array.from(new Set(refunds.map((refund) => refund.exchangeRequestId).filter(Boolean))) as string[];
  const [refundReturnDetails, refundExchangeDetails] = await Promise.all([
    linkedReturns.length ? prisma.returnRequest.findMany({ where: { shopifyStoreId, id: { in: linkedReturns } }, include: { items: true } }) : [],
    linkedExchanges.length ? prisma.exchangeRequest.findMany({ where: { shopifyStoreId, id: { in: linkedExchanges } }, include: { items: true } }) : [],
  ]);
  const refundDetailMap = new Map<string, any>();
  refundReturnDetails.forEach((request: any) => refundDetailMap.set(`RETURN:${request.id}`, request));
  refundExchangeDetails.forEach((request: any) => refundDetailMap.set(`EXCHANGE:${request.id}`, request));
  const refundOrderIds = Array.from(new Set([
    ...refundReturnDetails.map((item: any) => item.shopifyOrderId),
    ...refundExchangeDetails.map((item: any) => item.shopifyOrderId),
  ].filter(Boolean)));
  const refundOrders = refundOrderIds.length
    ? await prisma.order.findMany({ where: { shopifyStoreId, shopifyOrderId: { in: refundOrderIds } } })
    : [];
  const refundOrderMap = new Map(refundOrders.map((order: any) => [order.shopifyOrderId, order]));
  const hydratedRefunds = refunds.map((refund) => {
    const requestType = refund.returnRequestId ? "RETURN" : "EXCHANGE";
    const requestId = refund.returnRequestId || refund.exchangeRequestId;
    const request = requestId ? refundDetailMap.get(`${requestType}:${requestId}`) : null;
    const order = request ? refundOrderMap.get(request.shopifyOrderId) || null : null;
    const linkedEvidence = evidence.filter((item) => item.returnRequestId === refund.returnRequestId || item.exchangeRequestId === refund.exchangeRequestId);
    return { ...refund, requestType, requestDetails: request || null, orderDetails: order, linkedEvidence };
  });

  return { refunds: hydratedRefunds, evidence, refundableRequests };
}

export async function action({ request }: ActionFunctionArgs) {
  const { shopifyStoreId, session } = await requireTenantContext(request);
  await assertPermission(shopifyStoreId, session, "refunds");
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "CONFIRM_REFUND") {
      const refundId = String(form.get("refundId") || "").trim();
      const refund = await prisma.refundRecord.findFirst({ where: { id: refundId, shopifyStoreId } });
      if (!refund) return { ok: false, message: "Refund record not found for this store." };
      if (refund.status === "CONFIRMED") return { ok: true, message: "This refund is already confirmed." };

      const proof = form.get("proof");
      const requiresProof = !["SHOPIFY", "STORE_CREDIT"].includes(refund.method);
      const proofFile = proof instanceof File && proof.size > 0 ? proof : null;
      if (requiresProof && !proofFile) {
        return { ok: false, message: "Upload the payment receipt/screenshot before confirming this refund." };
      }
      if (proofFile && !["image/jpeg", "image/png", "image/webp"].includes(proofFile.type)) {
        return { ok: false, message: "Payment proof must be a JPEG, PNG, or WebP screenshot." };
      }

      const requestType = refund.returnRequestId ? "RETURN" : "EXCHANGE";
      const requestId = refund.returnRequestId || refund.exchangeRequestId;
      const requestRecord = requestId
        ? requestType === "RETURN"
          ? await prisma.returnRequest.findFirst({ where: { id: requestId, shopifyStoreId } })
          : await prisma.exchangeRequest.findFirst({ where: { id: requestId, shopifyStoreId } })
        : null;
      if (!requestRecord) return { ok: false, message: "The linked return/exchange request was not found." };
      const order = await prisma.order.findFirst({
        where: { shopifyStoreId, shopifyOrderId: requestRecord.shopifyOrderId },
      });

      // Save the proof before changing the refund to CONFIRMED so a storage validation
      // failure cannot leave a manually paid refund without the required receipt.
      if (proofFile) {
        const bytes = Buffer.from(await proofFile.arrayBuffer());
        await saveEvidence({
          shopifyStoreId,
          returnRequestId: refund.returnRequestId || undefined,
          exchangeRequestId: refund.exchangeRequestId || undefined,
          fileName: proofFile.name || "refund-payment-proof",
          mimeType: proofFile.type,
          sizeBytes: bytes.byteLength,
          contentBase64: bytes.toString("base64"),
          uploadedBy: "MERCHANT",
        });
      }

      const paymentReference = String(form.get("reference") || "").trim();
      await confirmRefundRecord(refundId, shopifyStoreId, paymentReference || undefined);
      const customerEmail = String((requestRecord as any).customerEmail || order?.customerEmail || "").trim();
      const customerName = String((requestRecord as any).customerName || order?.customerName || "Customer").trim();
      const customerPhone = String(order?.customerPhone || "").trim();
      const variables = {
        customer_name: customerName,
        order_number: requestRecord.orderNumber,
        refund_amount: Number(refund.amount).toFixed(2),
        refund_method: refund.method.replaceAll("_", " "),
        refund_currency: refund.currency,
        refund_reference: paymentReference || refund.reference || "",
      };
      const notices = await Promise.all([
        customerEmail ? triggerLifecycleNotification({
          shopifyStoreId,
          eventType: "REFUND_INITIATED",
          entityId: refund.id,
          recipientEmail: customerEmail,
          channel: "EMAIL",
          variables,
        }) : Promise.resolve({ status: "SKIPPED_NO_EMAIL" }),
        customerPhone ? triggerLifecycleNotification({
          shopifyStoreId,
          eventType: "REFUND_INITIATED",
          entityId: refund.id,
          recipientEmail: customerEmail,
          recipientPhone: customerPhone,
          channel: "WHATSAPP",
          variables,
        }) : Promise.resolve({ status: "SKIPPED_NO_PHONE" }),
      ]);
      const noticeSummary = notices.some((notice: any) => notice.status === "QUEUED")
        ? " Customer notification delivery was attempted; check Notification logs for provider acceptance."
        : " No customer contact was available, so no notification was sent.";
      return {
        ok: true,
        message: `Refund payment confirmed${proofFile ? " with screenshot evidence saved" : ""}.${noticeSummary} This confirmation is a merchant record, not independent payment-provider proof.`,
      };
    }

    if (intent === "ATTACH_EVIDENCE") {
      const file = form.get("file");
      const sourceUrl = String(form.get("sourceUrl") || "").trim();
      const returnRequestId = String(form.get("returnRequestId") || "").trim();
      const exchangeRequestId = String(form.get("exchangeRequestId") || "").trim();
      if (!(file instanceof File) && !sourceUrl) {
        return { ok: false, message: "Choose a file or paste an HTTPS URL." };
      }
      let contentBase64: string | undefined;
      let fileName = "evidence-link";
      let mimeType = "image/jpeg";
      let sizeBytes = sourceUrl.length;
      if (file instanceof File && file.size > 0) {
        const bytes = Buffer.from(await file.arrayBuffer());
        contentBase64 = bytes.toString("base64");
        fileName = file.name || "evidence";
        mimeType = file.type || "application/octet-stream";
        sizeBytes = bytes.byteLength;
      }
      await saveEvidence({
        shopifyStoreId,
        returnRequestId: returnRequestId || undefined,
        exchangeRequestId: exchangeRequestId || undefined,
        fileName,
        mimeType,
        sizeBytes,
        sourceUrl: sourceUrl || undefined,
        contentBase64,
        uploadedBy: "MERCHANT",
      });
      return { ok: true, message: "Evidence saved for this return/exchange." };
    }

    const method = String(form.get("method") || "");
    if (!isRefundMethod(method)) return { ok: false, message: "Choose a refund method." };
    const amount = Number(form.get("amount"));
    const returnRequestId = String(form.get("returnRequestId") || "").trim() || undefined;
    const exchangeRequestId = String(form.get("exchangeRequestId") || "").trim() || undefined;
    const payload = {
      shopifyStoreId,
      method,
      amount,
      currency: String(form.get("currency") || "PKR"),
      reference: String(form.get("reference") || "") || undefined,
      reason: String(form.get("reason") || "") || undefined,
    };

    if (intent === "CONVERT_EXCHANGE") {
      if (!exchangeRequestId) return { ok: false, message: "An exchange id is required." };
      await convertExchangeToManualRefund({ ...payload, exchangeRequestId });
      return { ok: true, message: "Exchange cancelled and a pending refund record was opened. Shopify was not refunded." };
    }

    await createRefundRecord({
      ...payload,
      returnRequestId,
      exchangeRequestId,
      confirmed: form.get("confirmed") === "yes",
    });
    return { ok: true, message: form.get("confirmed") === "yes"
      ? "Refund recorded as merchant-confirmed."
      : "Refund saved as pending. It is not marked paid." };
  } catch (error: unknown) {
    if (error instanceof Response) throw error;
    return { ok: false, message: error instanceof Error ? error.message : "Refund action failed." };
  }
}

function badgeClass(status: string) {
  if (status === "CONFIRMED") return "bc-badge ok";
  if (status === "FAILED" || status === "CANCELLED") return "bc-badge bad";
  return "bc-badge warn";
}

export default function RefundsPage() {
  const { refunds, evidence, refundableRequests } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [selectedRequest, setSelectedRequest] = useState<any | null>(null);
  const [expandedRefundId, setExpandedRefundId] = useState<string | null>(null);

  return (
    <div className="bc-page">
      <header className="bc-header">
        <div className="bc-header-copy">
          <p className="bc-eyebrow">PAYMENTS</p>
          <h1>Refunds and evidence</h1>
          <p>Shopify, store credit, bank transfer, Easypaisa, and JazzCash stay pending until a merchant confirms them. Saving a record does not move money.</p>
        </div>
      </header>
      {actionData?.message && <div className={actionData.ok ? "bc-note ok" : "bc-note bad"}>{actionData.message}</div>}
      <section className="bc-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
          <div>
            <h2 className="bc-title">Requests awaiting refund decision</h2>
            <p className="bc-muted">Open an approved return or eligible exchange to review what the customer submitted. Creating a refund record does not transfer money.</p>
          </div>
          <span className="bc-badge">{refundableRequests.length} requests</span>
        </div>
        <div className="bc-table-wrap" style={{ marginTop: 14 }}>
          <table className="bc-table">
            <thead><tr><th>Order</th><th>Customer</th><th>Request</th><th>Status</th><th>Customer note</th><th>Action</th></tr></thead>
            <tbody>
              {refundableRequests.length === 0 && <tr><td colSpan={6}>No eligible return or exchange requests are waiting for a refund record.</td></tr>}
              {refundableRequests.map((request: any) => (
                <tr key={`${request.requestType}:${request.id}`}>
                  <td><strong>{request.orderNumber}</strong></td>
                  <td>
                    <strong>{request.customerName || request.order?.customerName || "Customer"}</strong>
                    <div className="bc-muted">{request.customerEmail || request.order?.customerEmail || "No email on file"}</div>
                  </td>
                  <td>{request.requestType === "RETURN" ? "Return" : "Exchange"}</td>
                  <td><span className={badgeClass(request.status)}>{request.status}</span></td>
                  <td style={{ maxWidth: 260, overflowWrap: "anywhere" }}>{request.customerNote || request.reason || "No customer note"}</td>
                  <td><button type="button" className="bc-btn primary" onClick={() => setSelectedRequest(request)}>Give refund</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {selectedRequest && (
        <div
          role="presentation"
          onClick={() => setSelectedRequest(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.55)", zIndex: 1000, padding: 16, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="refund-request-details-title"
            onClick={(event) => event.stopPropagation()}
            className="bc-card"
            style={{ width: "min(100%, 760px)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <div>
                <p className="bc-eyebrow">CUSTOMER SUBMISSION</p>
                <h2 id="refund-request-details-title" className="bc-title">{selectedRequest.requestType === "RETURN" ? "Return" : "Exchange"} · {selectedRequest.orderNumber}</h2>
                <p className="bc-muted">{selectedRequest.customerName || selectedRequest.order?.customerName || "Customer"} · {selectedRequest.customerEmail || selectedRequest.order?.customerEmail || "No email"}</p>
              </div>
              <button type="button" className="bc-btn" onClick={() => setSelectedRequest(null)}>Close</button>
            </div>
            <div className="bc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", marginTop: 16 }}>
              <article className="bc-card" style={{ boxShadow: "none" }}><span className="bc-kpi-label">Request status</span><p className="bc-metric">{selectedRequest.status}</p></article>
              <article className="bc-card" style={{ boxShadow: "none" }}><span className="bc-kpi-label">Customer phone</span><p className="bc-subtitle">{selectedRequest.order?.customerPhone || "Not provided"}</p></article>
              <article className="bc-card" style={{ boxShadow: "none" }}><span className="bc-kpi-label">Customer reason</span><p className="bc-subtitle">{selectedRequest.reason || "Not specified"}</p></article>
            </div>
            <div style={{ marginTop: 16 }}>
              <h3 className="bc-subtitle">Customer's note</h3>
              <p className="bc-muted" style={{ whiteSpace: "pre-wrap" }}>{selectedRequest.customerNote || "No additional note submitted."}</p>
              <h3 className="bc-subtitle" style={{ marginTop: 18 }}>Submitted items</h3>
              {(selectedRequest.items || []).length ? (
                <div className="bc-table-wrap">
                  <table className="bc-table">
                    <thead><tr><th>Item</th><th>Quantity</th><th>Reason / note</th></tr></thead>
                    <tbody>
                      {selectedRequest.items.map((item: any) => (
                        <tr key={item.id}>
                          <td>{item.originalTitle || item.title || item.replacementTitle || item.productTitle || "Item"}</td>
                          <td>{item.originalQuantity || item.quantity || 1}</td>
                          <td>{item.reasonNote || item.customerNote || item.reason || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="bc-muted">No line-item details were included with this request.</p>}
            </div>
            <Form method="post" className="bc-form" style={{ marginTop: 18 }} onSubmit={() => setSelectedRequest(null)}>
              <h3 className="bc-title">Create pending refund</h3>
              <p className="bc-muted">Confirm the correct amount and method before sending money. The refund will stay pending until payment proof is recorded.</p>
              <input type="hidden" name="intent" value="CREATE_REFUND" />
              <input type="hidden" name="returnRequestId" value={selectedRequest.requestType === "RETURN" ? selectedRequest.id : ""} />
              <input type="hidden" name="exchangeRequestId" value={selectedRequest.requestType === "EXCHANGE" ? selectedRequest.id : ""} />
              <input type="hidden" name="currency" value={selectedRequest.order?.currency || "PKR"} />
              <label>Refund method
                <select name="method" defaultValue="BANK_TRANSFER" required>
                  {REFUND_METHODS.map((method) => <option key={method} value={method}>{method.replaceAll("_", " ")}</option>)}
                </select>
              </label>
              <label>Refund amount ({selectedRequest.order?.currency || "PKR"})
                <input name="amount" type="number" min="0.01" step="0.01" defaultValue={selectedRequest.refundAmount ? Number(selectedRequest.refundAmount) : ""} required />
              </label>
              <label>Payment/reference note
                <input name="reference" placeholder="Leave blank until payment is sent" />
              </label>
              <label>Internal reason
                <input name="reason" defaultValue={`Refund for ${selectedRequest.requestType.toLowerCase()} request ${selectedRequest.orderNumber}`} />
              </label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="submit" className="bc-btn primary">Create pending refund</button>
                <button type="button" className="bc-btn" onClick={() => setSelectedRequest(null)}>Cancel</button>
              </div>
            </Form>
          </section>
        </div>
      )}

      <section className="bc-card">
        <div>
          <h2 className="bc-title">Refund ledger</h2>
          <p className="bc-muted">Open each record to review the original customer submission, save payment proof, and confirm the payment. Manual refunds require a screenshot before confirmation.</p>
        </div>
        <div className="bc-table-wrap" style={{ marginTop: 14 }}>
          <table className="bc-table">
            <thead>
              <tr><th>Order / customer</th><th>Status</th><th>Method</th><th>Amount</th><th>Reference</th><th>Evidence</th><th>Action</th></tr>
            </thead>
            <tbody>
              {refunds.length === 0 && <tr><td colSpan={7}>No refund records yet. Choose “Give refund” above to start one from an eligible customer request.</td></tr>}
              {refunds.map((refund: any) => {
                const request = refund.requestDetails;
                const order = refund.orderDetails;
                const isExpanded = expandedRefundId === refund.id;
                const requiresProof = !["SHOPIFY", "STORE_CREDIT"].includes(refund.method);
                return (
                  <>
                    <tr key={refund.id}>
                      <td>
                        <strong>{request?.orderNumber || "Order details unavailable"}</strong>
                        <div className="bc-muted">{request?.customerName || order?.customerName || "Customer"}</div>
                        <div className="bc-muted">{request?.customerEmail || order?.customerEmail || "No email on file"}</div>
                      </td>
                      <td><span className={badgeClass(refund.status)}>{refund.status}</span></td>
                      <td>{refund.method.replaceAll("_", " ")}</td>
                      <td><strong>{refund.currency} {Number(refund.amount).toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td>
                      <td>{refund.reference || "—"}</td>
                      <td>{(refund.linkedEvidence || []).length}</td>
                      <td>
                        <button
                          type="button"
                          className="bc-btn"
                          aria-expanded={isExpanded}
                          onClick={() => setExpandedRefundId(isExpanded ? null : refund.id)}
                        >
                          {isExpanded ? "Hide details" : refund.status === "PENDING" ? "Give refund / details" : "View details"}
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${refund.id}:details`}>
                        <td colSpan={7} style={{ background: "#f8fafc", padding: 18 }}>
                          <div className="bc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", marginBottom: 16 }}>
                            <div><span className="bc-kpi-label">Customer</span><p className="bc-subtitle">{request?.customerName || order?.customerName || "Customer"}</p></div>
                            <div><span className="bc-kpi-label">Email</span><p className="bc-subtitle">{request?.customerEmail || order?.customerEmail || "Not available"}</p></div>
                            <div><span className="bc-kpi-label">Phone</span><p className="bc-subtitle">{order?.customerPhone || "Not available"}</p></div>
                            <div><span className="bc-kpi-label">Original request</span><p className="bc-subtitle">{request?.reason || "No reason supplied"}</p></div>
                          </div>
                          <div style={{ marginBottom: 16 }}>
                            <strong>Customer note</strong>
                            <p className="bc-muted" style={{ whiteSpace: "pre-wrap" }}>{request?.customerNote || "No customer note submitted."}</p>
                            {(refund.linkedEvidence || []).map((proof: any) => (
                              <div key={proof.id} style={{ fontSize: 12, marginTop: 6 }}>
                                {proof.sourceUrl
                                  ? <a href={proof.sourceUrl} target="_blank" rel="noopener noreferrer">{proof.fileName}</a>
                                  : <span>{proof.fileName}</span>}
                                <span className="bc-muted"> · {proof.sizeBytes} bytes</span>
                              </div>
                            ))}
                          </div>
                          {refund.status === "PENDING" ? (
                            <Form method="post" encType="multipart/form-data" className="bc-form">
                              <input type="hidden" name="intent" value="CONFIRM_REFUND" />
                              <input type="hidden" name="refundId" value={refund.id} />
                              <h3 className="bc-title">Confirm payment and notify customer</h3>
                              <p className="bc-muted">Upload a screenshot of the bank/wallet transfer before confirming a manual payment. Email and WhatsApp notifications will be attempted after proof is saved and the refund is confirmed.</p>
                              <label>Payment proof screenshot {requiresProof ? "(required)" : "(optional for Shopify refund/store credit)"}
                                <input name="proof" type="file" accept="image/jpeg,image/png,image/webp" required={requiresProof} />
                              </label>
                              <label>Payment reference (optional update)
                                <input name="reference" defaultValue={refund.reference || ""} />
                              </label>
                              <button type="submit" className="bc-btn primary">Save proof, confirm payment & notify</button>
                            </Form>
                          ) : (
                            <p className="bc-note ok" role="status">
                              This record is {refund.status.toLowerCase()}. Notification results are available in the Notification logs.
                            </p>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <div className="bc-table-wrap">
        <table className="bc-table">
          <thead><tr><th>Evidence</th><th>Linked request</th><th>Type</th><th>Size</th></tr></thead>
          <tbody>
            {evidence.length === 0 && <tr><td colSpan={4}>No evidence saved.</td></tr>}
            {evidence.map((item) => (
              <tr key={item.id}>
                <td>{item.sourceUrl ? <a href={item.sourceUrl}>{item.fileName}</a> : item.fileName}</td>
                <td>{item.returnRequestId || item.exchangeRequestId}</td>
                <td>{item.kind}</td>
                <td>{item.sizeBytes} bytes</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
