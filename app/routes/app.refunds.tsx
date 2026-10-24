import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import React, { useEffect, useMemo, useState } from "react";
import { requireTenantContext } from "../utils/tenant.server";
import { assertPermission } from "../services/permissions.server";
import prisma from "../db.server";
import { triggerLifecycleNotification } from "../services/notifications.server";
import { validateEvidence, saveEvidence, listEvidence } from "../services/evidence.server";
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
      where: { shopifyStoreId, status: { notIn: ["CANCELLED", "REJECTED"] } },
      include: { items: true },
      orderBy: { createdAt: "desc" },
      take: 150,
    }),
    prisma.exchangeRequest.findMany({
      where: { shopifyStoreId, status: { notIn: ["CANCELLED", "REJECTED", "COMPLETED"] } },
      include: { items: true },
      orderBy: { createdAt: "desc" },
      take: 150,
    }),
  ]);

  const orderIds = Array.from(new Set([
    ...returns.map((row) => row.shopifyOrderId),
    ...exchanges.map((row) => row.shopifyOrderId),
  ]));
  const orderSnapshots = orderIds.length ? await prisma.order.findMany({
    where: { shopifyStoreId, shopifyOrderId: { in: orderIds } },
    select: { shopifyOrderId: true, customerName: true, customerEmail: true, customerPhone: true, currency: true },
  }) : [];
  const orderById = new Map(orderSnapshots.map((order) => [order.shopifyOrderId, order]));
  const existingRefundFor = (type: "RETURN" | "EXCHANGE", id: string) =>
    refunds.find((refund) =>
      refund.status !== "CANCELLED"
      && (type === "RETURN" ? refund.returnRequestId === id : refund.exchangeRequestId === id)
    ) || null;

  const refundCandidates = [
    ...returns.map((row) => {
      const order = orderById.get(row.shopifyOrderId);
      return {
        key: `RETURN:${row.id}`,
        requestType: "RETURN" as const,
        id: row.id,
        orderNumber: row.orderNumber,
        status: row.status,
        customerName: row.customerName || order?.customerName || "Customer",
        customerEmail: row.customerEmail || order?.customerEmail || "",
        customerPhone: order?.customerPhone || "",
        currency: order?.currency || "PKR",
        reason: row.reason || "Customer return request",
        customerNote: row.customerNote || "",
        refundAmount: row.refundAmount === null ? null : Number(row.refundAmount),
        createdAt: row.createdAt.toISOString(),
        items: row.items.map((item) => ({ title: item.shopifyLineItemId, quantity: item.quantity, reason: item.reason, reasonNote: item.reasonNote, status: item.status })),
        existingRefund: existingRefundFor("RETURN", row.id),
        canProcess: ["APPROVED", "RECEIVED", "INSPECTED", "COMPLETED"].includes(row.status),
      };
    }),
    ...exchanges.map((row) => {
      const order = orderById.get(row.shopifyOrderId);
      const difference = row.items.reduce((sum, item) => sum + Number(item.priceDifference || 0), 0);
      return {
        key: `EXCHANGE:${row.id}`,
        requestType: "EXCHANGE" as const,
        id: row.id,
        orderNumber: row.orderNumber,
        status: row.status,
        customerName: row.customerName || order?.customerName || "Customer",
        customerEmail: row.customerEmail || order?.customerEmail || "",
        customerPhone: order?.customerPhone || "",
        currency: order?.currency || "PKR",
        reason: row.reason || "Customer exchange request",
        customerNote: row.customerNote || "",
        refundAmount: difference < 0 ? Math.abs(difference) : 0,
        createdAt: row.createdAt.toISOString(),
        items: row.items.map((item) => ({ title: item.replacementTitle || item.replacementVariantId, quantity: item.replacementQuantity, reason: item.originalLineItemId, reasonNote: null, status: row.status })),
        existingRefund: existingRefundFor("EXCHANGE", row.id),
        canProcess: ["PENDING", "APPROVED"].includes(row.status),
      };
    }),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return { refunds, evidence, refundCandidates };
}

export async function action({ request }: ActionFunctionArgs) {
  const { shopifyStoreId, session } = await requireTenantContext(request);
  await assertPermission(shopifyStoreId, session, "refunds");
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "PROCESS_REFUND") {
      const requestType = String(form.get("requestType") || "").toUpperCase() === "EXCHANGE" ? "EXCHANGE" : "RETURN";
      const requestId = String(form.get("requestId") || "").trim();
      const methodValue = String(form.get("method") || "");
      if (!requestId) return { ok: false, intent, message: "Choose a return or exchange request." };
      if (!isRefundMethod(methodValue) || methodValue === "SHOPIFY") {
        return { ok: false, intent, message: "Choose a supported manual payment method. Shopify refunds must be issued through Shopify's refund workflow." };
      }

      const amount = Number(form.get("amount"));
      if (!Number.isFinite(amount) || amount < 0.01) return { ok: false, intent, message: "Enter a refund amount greater than zero." };
      const reference = String(form.get("reference") || "").trim();
      const reason = String(form.get("reason") || "").trim();
      const file = form.get("evidence");
      if (!(file instanceof File) || file.size < 1) return { ok: false, intent, message: "Upload a screenshot of the payment confirmation before completing the refund." };
      const allowedMime = new Set(["image/jpeg", "image/png", "image/webp"]);
      if (!allowedMime.has(file.type)) return { ok: false, intent, message: "Payment evidence must be a JPEG, PNG, or WebP image." };
      if (file.size > 1_500_000) return { ok: false, intent, message: "Payment screenshot must be 1.5 MB or smaller." };

      const request = requestType === "RETURN"
        ? await prisma.returnRequest.findFirst({ where: { id: requestId, shopifyStoreId }, include: { items: true } })
        : await prisma.exchangeRequest.findFirst({ where: { id: requestId, shopifyStoreId }, include: { items: true } });
      if (!request) return { ok: false, intent, message: "Request not found for this store." };
      const allowedStatuses = requestType === "RETURN"
        ? ["APPROVED", "RECEIVED", "INSPECTED", "COMPLETED"]
        : ["PENDING", "APPROVED"];
      if (!allowedStatuses.includes(request.status)) return { ok: false, intent, message: "This request is not in a status that can be paid as a refund." };

      const existingRefund = await prisma.refundRecord.findFirst({
        where: {
          shopifyStoreId,
          ...(requestType === "RETURN" ? { returnRequestId: requestId } : { exchangeRequestId: requestId }),
          status: { not: "CANCELLED" },
        },
      });
      if (existingRefund) return { ok: false, intent, message: `A refund record already exists for this request (${existingRefund.status}). Check the refund ledger before paying again.` };

      const order = await prisma.order.findFirst({
        where: { shopifyStoreId, shopifyOrderId: request.shopifyOrderId },
        select: { customerName: true, customerEmail: true, customerPhone: true, currency: true },
      });
      if (!order) return { ok: false, intent, message: "Original Shopify order details are missing. Sync orders and retry." };
      const bytes = Buffer.from(await file.arrayBuffer());
      const contentBase64 = bytes.toString("base64");
      validateEvidence({
        fileName: file.name || "refund-payment-evidence.png",
        mimeType: file.type,
        sizeBytes: bytes.byteLength,
        contentBase64,
      });

      // Keep the record pending until the screenshot is stored and the merchant confirms
      // that the external transfer has actually been sent.
      const refund = await createRefundRecord({
        shopifyStoreId,
        ...(requestType === "RETURN" ? { returnRequestId: requestId } : { exchangeRequestId: requestId }),
        method: methodValue,
        amount,
        currency: order.currency || "PKR",
        reference: reference || undefined,
        reason: reason || request.reason || "Customer refund",
        notes: "Payment screenshot required and stored by BYNDCART.",
        confirmed: false,
      });
      await saveEvidence({
        shopifyStoreId,
        ...(requestType === "RETURN" ? { returnRequestId: requestId } : { exchangeRequestId: requestId }),
        fileName: file.name || "refund-payment-evidence.png",
        mimeType: file.type,
        sizeBytes: bytes.byteLength,
        contentBase64,
        uploadedBy: "MERCHANT",
      });
      const confirmedRefund = await confirmRefundRecord(refund.id, shopifyStoreId);

      const variables = {
        customer_name: request.customerName || order.customerName || "Customer",
        order_number: request.orderNumber,
        refund_amount: amount.toFixed(2),
        refund_currency: order.currency || "PKR",
        refund_method: methodValue.replaceAll("_", " "),
        refund_reference: reference || "Available from the merchant",
        reason: reason || request.reason || "Customer refund",
      };
      const delivery = [
        triggerLifecycleNotification({
          shopifyStoreId, eventType: "REFUND_INITIATED", entityId: confirmedRefund.id,
          recipientEmail: request.customerEmail || order.customerEmail || "",
          recipientPhone: order.customerPhone || undefined, channel: "EMAIL", variables,
        }),
        order.customerPhone ? triggerLifecycleNotification({
          shopifyStoreId, eventType: "REFUND_INITIATED", entityId: confirmedRefund.id,
          recipientEmail: request.customerEmail || order.customerEmail || "",
          recipientPhone: order.customerPhone || undefined, channel: "WHATSAPP", variables,
        }) : Promise.resolve({ status: "SKIPPED", reason: "No checkout phone number" }),
      ];
      const results = await Promise.all(delivery);
      const failed = results.filter((result: any) => !["SENT", "SKIPPED", "IDEMPOTENT_SKIP", undefined].includes(result.status));
      return {
        ok: true,
        intent,
        message: `Refund of ${(order.currency || "PKR")} ${amount.toFixed(2)} recorded with payment screenshot. Customer notifications queued; ${failed.length} delivery channel(s) reported an issue.`,
      };
    }

    if (intent === "CONFIRM_REFUND") {
      await confirmRefundRecord(String(form.get("refundId") || ""), shopifyStoreId);
      return { ok: true, message: "Refund marked confirmed by a merchant. This is not a payment-provider receipt." };
    }

    if (intent === "ATTACH_EVIDENCE") {
      const file = form.get("file");
      const sourceUrl = String(form.get("sourceUrl") || "").trim();
      const returnRequestId = String(form.get("returnRequestId") || "").trim();
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
        returnRequestId,
        fileName,
        mimeType,
        sizeBytes,
        sourceUrl: sourceUrl || undefined,
        contentBase64,
        uploadedBy: "MERCHANT",
      });
      return { ok: true, message: "Evidence saved for this return." };
    }

    const method = String(form.get("method") || "");
    if (!isRefundMethod(method)) return { ok: false, message: "Choose a refund method." };
    if (method === "SHOPIFY") {
      return {
        ok: false,
        message: "This form records external refund payments only. To issue a Shopify payment refund, open the order in Shopify Admin and use Shopify's refund action, then record the confirmed result here.",
      };
    }
    const amount = Number(form.get("amount"));
    const returnRequestId = String(form.get("returnRequestId") || "").trim() || undefined;
    const exchangeRequestId = String(form.get("exchangeRequestId") || "").trim() || undefined;
    const payload = {
      shopifyStoreId,
      method,
      amount,
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
  const { refunds, evidence, refundCandidates } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [selectedCandidateKey, setSelectedCandidateKey] = useState<string | null>(null);
  const selectedCandidate = useMemo(
    () => refundCandidates.find((candidate) => candidate.key === selectedCandidateKey) || null,
    [refundCandidates, selectedCandidateKey],
  );

  useEffect(() => {
    if (actionData?.ok && actionData.intent === "PROCESS_REFUND") setSelectedCandidateKey(null);
  }, [actionData]);

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
        <h2 className="bc-title">Refund requests</h2>
        <p className="bc-muted">Review customer-submitted details first. Open a request to inspect its notes and items; enter the amount actually sent and attach payment evidence before the refund is marked confirmed.</p>
        <div className="bc-table-wrap">
          <table className="bc-table">
            <thead><tr><th>Order</th><th>Type</th><th>Customer</th><th>Request status</th><th>Requested amount</th><th>Refund record</th><th>Action</th></tr></thead>
            <tbody>
              {refundCandidates.length === 0 && <tr><td colSpan={7}>No return or exchange requests are available for refund processing.</td></tr>}
              {refundCandidates.map((candidate) => (
                <tr key={candidate.key}>
                  <td><strong>{candidate.orderNumber}</strong><div className="bc-muted" style={{fontSize:11}}>{new Date(candidate.createdAt).toLocaleDateString()}</div></td>
                  <td>{candidate.requestType}</td>
                  <td>{candidate.customerName}<div className="bc-muted" style={{fontSize:11}}>{candidate.customerEmail || candidate.customerPhone || "No contact detail"}</div></td>
                  <td><span className={`bc-badge ${["COMPLETED","INSPECTED","RECEIVED"].includes(candidate.status) ? "ok" : "warn"}`}>{candidate.status}</span></td>
                  <td>{candidate.currency} {candidate.refundAmount === null ? "—" : candidate.refundAmount.toFixed(2)}</td>
                  <td>{candidate.existingRefund ? <span className={badgeClass(candidate.existingRefund.status)}>{candidate.existingRefund.status}</span> : <span className="bc-muted">Not paid</span>}</td>
                  <td>
                    {candidate.existingRefund
                      ? <span className="bc-muted">Check ledger</span>
                      : candidate.canProcess
                        ? <button type="button" className="bc-btn primary" onClick={() => setSelectedCandidateKey((current) => current === candidate.key ? null : candidate.key)}>{selectedCandidateKey === candidate.key ? "Close details" : "Give refund"}</button>
                        : <span className="bc-muted" title="Approve and receive/inspect the request before issuing a refund">Not ready</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selectedCandidate && (
          <div className="bc-form" style={{marginTop:16}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,flexWrap:"wrap"}}>
              <div>
                <h3 className="bc-title" style={{margin:"0 0 4px"}}>Refund {selectedCandidate.orderNumber}</h3>
                <p className="bc-muted" style={{margin:0}}>Customer-submitted request · {selectedCandidate.requestType} · {selectedCandidate.status}</p>
              </div>
              <button type="button" className="bc-btn" onClick={() => setSelectedCandidateKey(null)}>Close</button>
            </div>
            <div className="bc-grid" style={{gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))"}}>
              <div><span className="bc-field-label">Customer</span><strong>{selectedCandidate.customerName}</strong></div>
              <div><span className="bc-field-label">Email</span><span>{selectedCandidate.customerEmail || "Not provided"}</span></div>
              <div><span className="bc-field-label">Phone</span><span>{selectedCandidate.customerPhone || "Not available"}</span></div>
              <div><span className="bc-field-label">Reason</span><span>{selectedCandidate.reason}</span></div>
            </div>
            <div style={{marginTop:12}}>
              <span className="bc-field-label">Customer note / details</span>
              <p style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{selectedCandidate.customerNote || "No additional customer note was submitted."}</p>
            </div>
            <div style={{marginTop:12}}>
              <span className="bc-field-label">Requested items</span>
              <ul style={{paddingLeft:22}}>
                {selectedCandidate.items.map((item,index)=><li key={index}>{item.title} · Qty {item.quantity} · {item.reason}{item.reasonNote ? ` — ${item.reasonNote}` : ""}{item.status ? ` · ${item.status}` : ""}</li>)}
              </ul>
            </div>
            <Form method="post" encType="multipart/form-data" className="bc-stack" style={{marginTop:16}}>
              <input type="hidden" name="intent" value="PROCESS_REFUND" />
              <input type="hidden" name="requestType" value={selectedCandidate.requestType} />
              <input type="hidden" name="requestId" value={selectedCandidate.id} />
              <label>Payment method
                <select name="method" defaultValue="BANK_TRANSFER" required>
                  {REFUND_METHODS.filter((method) => method !== "SHOPIFY").map((method) => <option key={method} value={method}>{method.replaceAll("_"," ")}</option>)}
                </select>
              </label>
              <label>Amount actually sent ({selectedCandidate.currency})
                <input name="amount" type="number" min="0.01" step="0.01" defaultValue={selectedCandidate.refundAmount ?? ""} required />
              </label>
              <label>Payment / transaction reference
                <input name="reference" placeholder="Bank transfer, Easypaisa, or JazzCash reference" />
              </label>
              <label>Reason / message
                <textarea name="reason" rows={2} defaultValue={selectedCandidate.reason} />
              </label>
              <label>Payment screenshot (required, JPEG/PNG/WebP, max 1.5 MB)
                <input name="evidence" type="file" accept="image/jpeg,image/png,image/webp" required />
              </label>
              <p className="bc-muted">Only submit after you have sent the refund outside Shopify. BYNDCART will save the screenshot, mark this manual payment confirmed, and queue email/WhatsApp notifications. Shopify refunds must be issued through Shopify Admin.</p>
              <button type="submit" className="bc-btn primary">Confirm payment & notify customer</button>
            </Form>
          </div>
        )}
      </section>

      <div className="bc-split">
        <Form method="post" className="bc-form">
          <h2 className="bc-title">Record a refund</h2>
          <input type="hidden" name="intent" value="CREATE_REFUND" />
          <label>Return id<input name="returnRequestId" placeholder="Optional if an exchange id is set" /></label>
          <label>Exchange id<input name="exchangeRequestId" placeholder="Converts only from the exchange action below" /></label>
          <label>Method
            <select name="method" defaultValue="BANK_TRANSFER">
              {REFUND_METHODS.map((method) => <option key={method} value={method}>{method.replaceAll("_", " ")}</option>)}
            </select>
          </label>
          <label>Amount (PKR)<input name="amount" type="number" min="0" step="0.01" required /></label>
          <label>Reference<input name="reference" placeholder="Bank, wallet, or Shopify reference" /></label>
          <label>Reason<input name="reason" /></label>
          <label><span>Merchant has confirmed this payment</span><select name="confirmed" defaultValue="no"><option value="no">No, keep pending</option><option value="yes">Yes, I confirmed it</option></select></label>
          <button type="submit">Save refund</button>
        </Form>
        <Form method="post" className="bc-form">
          <h2 className="bc-title">Convert exchange to refund</h2>
          <input type="hidden" name="intent" value="CONVERT_EXCHANGE" />
          <label>Exchange id<input name="exchangeRequestId" required /></label>
          <label>Method
            <select name="method" defaultValue="STORE_CREDIT">
              {REFUND_METHODS.map((method) => <option key={method} value={method}>{method.replaceAll("_", " ")}</option>)}
            </select>
          </label>
          <label>Amount (PKR)<input name="amount" type="number" min="0" step="0.01" required /></label>
          <label>Reference<input name="reference" /></label>
          <button type="submit">Convert exchange</button>
        </Form>
      </div>
      <Form method="post" encType="multipart/form-data" className="bc-form">
        <h2 className="bc-title">Attach evidence</h2>
        <input type="hidden" name="intent" value="ATTACH_EVIDENCE" />
        <label>Return id<input name="returnRequestId" required /></label>
        <label>Photo or video, up to 1.5 MB<input name="file" type="file" accept="image/jpeg,image/png,image/webp,video/mp4" /></label>
        <label>Or HTTPS URL<input name="sourceUrl" placeholder="https://..." /></label>
        <button type="submit">Save evidence</button>
      </Form>
      <div className="bc-table-wrap">
        <table className="bc-table">
          <thead>
            <tr><th>Status</th><th>Method</th><th>Amount</th><th>Linked record</th><th>Reference</th><th></th></tr>
          </thead>
          <tbody>
            {refunds.length === 0 && <tr><td colSpan={6}>No refund records yet.</td></tr>}
            {refunds.map((refund) => (
              <tr key={refund.id}>
                <td><span className={badgeClass(refund.status)}>{refund.status}</span></td>
                <td>{refund.method}</td>
                <td>{refund.currency} {String(refund.amount)}</td>
                <td>{refund.returnRequestId || refund.exchangeRequestId}</td>
                <td>{refund.reference || "—"}</td>
                <td>
                  {refund.status === "PENDING" && (
                    <Form method="post">
                      <input type="hidden" name="intent" value="CONFIRM_REFUND" />
                      <input type="hidden" name="refundId" value={refund.id} />
                      <button type="submit">Mark confirmed</button>
                    </Form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="bc-table-wrap">
        <table className="bc-table">
          <thead><tr><th>Evidence</th><th>Return</th><th>Type</th><th>Size</th></tr></thead>
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
