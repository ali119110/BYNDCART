import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
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
import { triggerLifecycleNotification } from "../services/notifications.server";
import prisma from "../db.server";

const REFUND_METHODS = ["SHOPIFY", "STORE_CREDIT", "BANK_TRANSFER", "EASYPAISA", "JAZZCASH", "MANUAL"] as const;

export async function loader({ request }: LoaderFunctionArgs) {
  const { shopifyStoreId } = await requireTenantContext(request);
  const [refunds, evidence, baseReturnRequests] = await Promise.all([
    listRefundRecords(shopifyStoreId),
    listEvidence(shopifyStoreId),
    prisma.returnRequest.findMany({
      where: { shopifyStoreId, status: { notIn: ["CANCELLED", "REJECTED"] } },
      include: { items: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);

  const refundExchangeIds = Array.from(new Set(
    refunds.filter((refund) => refund.exchangeRequestId && refund.status !== "CANCELLED")
      .map((refund) => refund.exchangeRequestId as string),
  ));
  const exchangeRequests = refundExchangeIds.length
    ? await prisma.exchangeRequest.findMany({
        where: { shopifyStoreId, id: { in: refundExchangeIds } },
        include: { items: true },
        orderBy: { createdAt: "desc" },
      })
    : [];

  const requestOrderIds = Array.from(new Set(baseReturnRequests.map((request) => request.shopifyOrderId)));
  const orderSnapshots = requestOrderIds.length
    ? await prisma.order.findMany({
        where: { shopifyStoreId, shopifyOrderId: { in: requestOrderIds } },
        select: { shopifyOrderId: true, lineItems: true },
      })
    : [];
  const orderLinesById = new Map<string, any[]>(
    orderSnapshots.map((order) => [
      order.shopifyOrderId,
      Array.isArray(order.lineItems) ? order.lineItems as any[] : [],
    ]),
  );
  const returnRequests = baseReturnRequests.map((request) => {
    const orderLines = orderLinesById.get(request.shopifyOrderId) || [];
    return {
      ...request,
      items: request.items.map((item) => {
        const line = orderLines.find((candidate) =>
          String(candidate.lineItemId || candidate.id || "") === String(item.shopifyLineItemId)
        );
        return { ...item, productTitle: line?.title || line?.name || "", sku: line?.sku || "" };
      }),
    };
  });

  return { refunds, evidence, returnRequests, exchangeRequests };
}

export async function action({ request }: ActionFunctionArgs) {
  const { shopifyStoreId, session } = await requireTenantContext(request);
  await assertPermission(shopifyStoreId, session, "refunds");
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "CONFIRM_REFUND") {
      await confirmRefundRecord(String(form.get("refundId") || ""), shopifyStoreId);
      return { ok: true, message: "Refund marked confirmed by a merchant. This is not a payment-provider receipt." };
    }

    if (intent === "SEND_REFUND_NOTIFICATION") {
      const refundId = String(form.get("refundId") || "").trim();
      const refund = await prisma.refundRecord.findFirst({ where: { id: refundId, shopifyStoreId } });
      if (!refund) return { ok: false, message: "Refund record not found for this store." };
      if (refund.status !== "CONFIRMED") return { ok: false, message: "Confirm the refund payment record before notifying the customer." };
      const returnRequest = refund.returnRequestId
        ? await prisma.returnRequest.findFirst({
            where: { id: refund.returnRequestId, shopifyStoreId },
            select: { id: true, shopifyOrderId: true, orderNumber: true, customerEmail: true, customerName: true },
          })
        : null;
      const exchangeRequest = refund.exchangeRequestId
        ? await prisma.exchangeRequest.findFirst({
            where: { id: refund.exchangeRequestId, shopifyStoreId },
            select: { id: true, shopifyOrderId: true, orderNumber: true, customerEmail: true, customerName: true },
          })
        : null;
      const linkedRequest = returnRequest || exchangeRequest;
      if (!linkedRequest) return { ok: false, message: "Linked return/exchange request was not found for this store." };
      const attachedEvidence = returnRequest
        ? await listEvidence(shopifyStoreId, returnRequest.id)
        : await prisma.evidenceAttachment.findMany({ where: { shopifyStoreId, exchangeRequestId: exchangeRequest!.id } });
      const merchantReceipts = attachedEvidence.filter((file: any) => file.uploadedBy === "MERCHANT");
      if (!merchantReceipts.length) return { ok: false, message: "Attach the merchant's transfer screenshot/receipt before sending customer notifications." };

      const order = await prisma.order.findFirst({
        where: { shopifyStoreId, shopifyOrderId: linkedRequest.shopifyOrderId },
        select: { customerEmail: true, customerPhone: true, customerName: true, currency: true },
      });
      const email = String(linkedRequest.customerEmail || order?.customerEmail || "").trim();
      const phone = String(order?.customerPhone || "").trim();
      if (!email && !phone) return { ok: false, message: "The linked order has no customer email or phone number." };

      const variables = {
        customer_name: linkedRequest.customerName || order?.customerName || "Customer",
        order_number: linkedRequest.orderNumber,
        refund_amount: String(refund.amount),
        refund_currency: refund.currency || "PKR",
        refund_method: refund.method.replaceAll("_", " "),
        refund_reference: refund.reference || "Not provided",
        refund_reason: refund.reason || "Return refund",
      };
      const tasks: Array<Promise<any>> = [];
      if (email) tasks.push(triggerLifecycleNotification({
        shopifyStoreId,
        eventType: "REFUND_INITIATED",
        entityId: refund.id,
        recipientEmail: email,
        recipientPhone: phone,
        channel: "EMAIL",
        variables,
      }));
      if (phone) tasks.push(triggerLifecycleNotification({
        shopifyStoreId,
        eventType: "REFUND_INITIATED",
        entityId: refund.id,
        recipientEmail: email,
        recipientPhone: phone,
        channel: "WHATSAPP",
        variables,
      }));
      const results = await Promise.all(tasks);
      await prisma.auditLog.create({
        data: {
          shopifyStoreId,
          action: "REFUND_CUSTOMER_NOTIFICATIONS_REQUESTED",
          entityType: "RefundRecord",
          entityId: refund.id,
          metadata: { emailRequested: Boolean(email), whatsappRequested: Boolean(phone), statuses: results.map((result) => result.status || "UNKNOWN") },
        },
      });
      const failedResults = results.filter((result) => ["FAILED", "FAILED_TRIGGER"].includes(String(result.status || "").toUpperCase()));
      if (failedResults.length) {
        return {
          ok: false,
          message: `At least one customer notification failed: ${failedResults.map((result) => result.error || result.status).join("; ")}. Check Notifications → Logs. The refund record and receipt remain saved; retry after fixing channel configuration.`,
        };
      }
      return {
        ok: true,
        message: `Customer notifications delivered or accepted for ${[email ? "email" : "", phone ? "WhatsApp" : ""].filter(Boolean).join(" and ")}. Check Notifications → Logs for the exact provider status.`,
      };
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

    const confirmed = form.get("confirmed") === "yes";
    const refund = await createRefundRecord({
      ...payload,
      returnRequestId,
      exchangeRequestId,
      confirmed,
    });
    if (confirmed && returnRequestId) {
      await prisma.returnRequest.updateMany({
        where: { id: returnRequestId, shopifyStoreId },
        data: { refundAmount: amount },
      });
    }
    return { ok: true, message: confirmed
      ? `Refund record ${refund.id} marked merchant-confirmed. Attach the receipt screenshot, then send customer notifications. This does not prove a payment-provider settlement.`
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
  const { refunds, evidence, returnRequests, exchangeRequests } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <div className="bc-page bc-refunds-page">
      <header className="bc-header">
        <div className="bc-header-copy">
          <p className="bc-eyebrow">PAYMENTS</p>
          <h1>Refunds and evidence</h1>
          <p>Shopify, store credit, bank transfer, Easypaisa, and JazzCash stay pending until a merchant confirms them. Saving a record does not move money.</p>
        </div>
      </header>
      {actionData?.message && <div className={actionData.ok ? "bc-note ok" : "bc-note bad"}>{actionData.message}</div>}
      <section className="bc-card bc-stack">
        <div>
          <p className="bc-eyebrow">REFUND WORK QUEUE</p>
          <h2 className="bc-title">Return requests awaiting refund review</h2>
          <p className="bc-muted">Open a request to review the reason and item details submitted through the customer portal. After recording the payout, attach a screenshot or receipt before notifying the customer.</p>
        </div>
        <div className="bc-table-wrap">
          <table className="bc-table">
            <thead><tr><th>Order</th><th>Customer</th><th>Reason / note</th><th>Items</th><th>Status</th><th>Review / give refund</th></tr></thead>
            <tbody>
              {returnRequests.length === 0 && <tr><td colSpan={6}>No return requests to review.</td></tr>}
              {returnRequests.map((request) => {
                const requestEvidence = evidence.filter((item) => item.returnRequestId === request.id);
                const receiptEvidence = requestEvidence.filter((item) => item.uploadedBy === "MERCHANT");
                const existingRefund = refunds.find((item) => item.returnRequestId === request.id && item.status !== "CANCELLED");
                return (
                  <tr key={request.id}>
                    <td><strong>{request.orderNumber}</strong><div className="bc-hint">{new Date(request.createdAt).toLocaleDateString("en-PK")}</div></td>
                    <td>{request.customerName || "Customer"}<div className="bc-hint">{request.customerEmail}</div></td>
                    <td>{request.reason || "Reason not specified"}<div className="bc-hint">{request.customerNote || "No additional customer note"}</div></td>
                    <td>{(request.items || []).map((item: any) => <div key={item.id} className="bc-hint">{item.quantity} × {item.productTitle || item.shopifyLineItemId}{item.sku ? ` · SKU ${item.sku}` : ""}<br />{item.reason.replaceAll("_", " ")}{item.reasonNote ? `: ${item.reasonNote}` : ""}</div>)}</td>
                    <td><span className={badgeClass(request.status)}>{request.status}</span>{existingRefund && <div className="bc-hint">Refund: {existingRefund.currency} {String(existingRefund.amount)} · {existingRefund.status}</div>}</td>
                    <td>
                      <details className="bc-refund-review">
                        <summary>{existingRefund ? "Review / continue" : "Give refund"}</summary>
                        <div className="bc-refund-review-body">
                          <p><strong>Customer-submitted details</strong></p>
                          <p className="bc-muted">Reason: {request.reason || "—"}<br />Note: {request.customerNote || "—"}<br />Admin note: {request.adminNote || "—"}<br />Policy override: {request.policyOverrideReason || "—"}</p>
                          <p className="bc-muted">{requestEvidence.length} customer/return evidence file(s) saved; {receiptEvidence.length} merchant payout receipt(s) attached.</p>
                          {!existingRefund && (
                            <Form method="post" className="bc-refund-inline-form">
                              <input type="hidden" name="intent" value="CREATE_REFUND" />
                              <input type="hidden" name="returnRequestId" value={request.id} />
                              <label>Refund method
                                <select name="method" defaultValue="BANK_TRANSFER">
                                  {REFUND_METHODS.map((method) => <option key={method} value={method}>{method.replaceAll("_", " ")}</option>)}
                                </select>
                              </label>
                              <label>Amount (PKR)
                                <input name="amount" type="number" min="0.01" step="0.01" required defaultValue={request.refundAmount ? String(request.refundAmount) : ""} />
                              </label>
                              <label>Transaction / payment reference<input name="reference" placeholder="Bank, wallet, or Shopify reference" /></label>
                              <label>Reason / note<input name="reason" defaultValue={request.reason || "Return refund"} /></label>
                              <label>Payment status
                                <select name="confirmed" defaultValue="no"><option value="no">Pending — not paid yet</option><option value="yes">Paid — I have sent the amount</option></select>
                              </label>
                              <button type="submit" className="bc-btn primary">Save refund record</button>
                            </Form>
                          )}
                          {existingRefund?.status === "CONFIRMED" && (
                            <div className="bc-refund-next-steps">
                              {receiptEvidence.length === 0 && (
                                <Form method="post" encType="multipart/form-data" className="bc-refund-inline-form">
                                  <input type="hidden" name="intent" value="ATTACH_EVIDENCE" />
                                  <input type="hidden" name="returnRequestId" value={request.id} />
                                  <label>Upload transfer screenshot / receipt (JPEG, PNG, WebP, MP4; max 1.5 MB)
                                    <input name="file" type="file" accept="image/jpeg,image/png,image/webp,video/mp4" required />
                                  </label>
                                  <button type="submit" className="bc-btn">Attach receipt</button>
                                </Form>
                              )}
                              {receiptEvidence.length > 0 && (
                                <Form method="post">
                                  <input type="hidden" name="intent" value="SEND_REFUND_NOTIFICATION" />
                                  <input type="hidden" name="refundId" value={existingRefund.id} />
                                  <button type="submit" className="bc-btn primary">Send email / WhatsApp update</button>
                                </Form>
                              )}
                            </div>
                          )}
                        </div>
                      </details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {exchangeRequests.length > 0 && (
        <section className="bc-card bc-stack">
          <div>
            <p className="bc-eyebrow">EXCHANGE REFUNDS</p>
            <h2 className="bc-title">Exchange orders with refund records</h2>
            <p className="bc-muted">These exchanges already have refund records. Review the customer-submitted details and attach a merchant payout receipt before sending the update.</p>
          </div>
          <div className="bc-table-wrap">
            <table className="bc-table">
              <thead><tr><th>Order</th><th>Customer</th><th>Reason / note</th><th>Items</th><th>Refund</th><th>Receipt / notification</th></tr></thead>
              <tbody>
                {exchangeRequests.map((request) => {
                  const requestEvidence = evidence.filter((item) => item.exchangeRequestId === request.id);
                  const receiptEvidence = requestEvidence.filter((item) => item.uploadedBy === "MERCHANT");
                  const existingRefund = refunds.find((item) => item.exchangeRequestId === request.id && item.status !== "CANCELLED");
                  return (
                    <tr key={request.id}>
                      <td><strong>{request.orderNumber}</strong><div className="bc-hint">{new Date(request.createdAt).toLocaleDateString("en-PK")}</div></td>
                      <td>{request.customerName || "Customer"}<div className="bc-hint">{request.customerEmail}</div></td>
                      <td>{request.reason || "Reason not specified"}<div className="bc-hint">{request.customerNote || "No additional customer note"}</div></td>
                      <td>{(request.items || []).map((item: any) => <div key={item.id} className="bc-hint">{item.originalQuantity} × {item.replacementTitle || item.replacementVariantId}<div>{item.priceDifference ? `Price difference: ${String(item.priceDifference)}` : ""}</div></div>)}</td>
                      <td>{existingRefund ? <><span className={badgeClass(existingRefund.status)}>{existingRefund.status}</span><div className="bc-hint">{existingRefund.currency} {String(existingRefund.amount)} · {existingRefund.method.replaceAll("_", " ")}</div></> : "No active refund record"}</td>
                      <td>
                        {existingRefund?.status === "CONFIRMED" && receiptEvidence.length === 0 && (
                          <Form method="post" encType="multipart/form-data" className="bc-refund-inline-form">
                            <input type="hidden" name="intent" value="ATTACH_EVIDENCE" />
                            <input type="hidden" name="exchangeRequestId" value={request.id} />
                            <label>Upload payout receipt (image, max 1.5 MB)<input name="file" type="file" accept="image/jpeg,image/png,image/webp" required /></label>
                            <button type="submit" className="bc-btn">Attach receipt</button>
                          </Form>
                        )}
                        {existingRefund?.status === "CONFIRMED" && receiptEvidence.length > 0 && (
                          <Form method="post">
                            <input type="hidden" name="intent" value="SEND_REFUND_NOTIFICATION" />
                            <input type="hidden" name="refundId" value={existingRefund.id} />
                            <button type="submit" className="bc-btn primary">Send email / WhatsApp</button>
                          </Form>
                        )}
                        {(!existingRefund || existingRefund.status !== "CONFIRMED") && <span className="bc-hint">Complete and confirm the refund record in the Refunds tab.</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
