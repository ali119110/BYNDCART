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

      await confirmRefundRecord(refundId, shopifyStoreId);
      const customerEmail = String((requestRecord as any).customerEmail || order?.customerEmail || "").trim();
      const customerName = String((requestRecord as any).customerName || order?.customerName || "Customer").trim();
      const customerPhone = String(order?.customerPhone || "").trim();
      const variables = {
        customer_name: customerName,
        order_number: requestRecord.orderNumber,
        refund_amount: Number(refund.amount).toFixed(2),
        refund_method: refund.method.replaceAll("_", " "),
        refund_reference: refund.reference || "",
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
  const { refunds, evidence } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

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
