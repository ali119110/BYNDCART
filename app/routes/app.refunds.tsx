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

const REFUND_METHODS = ["SHOPIFY", "STORE_CREDIT", "BANK_TRANSFER", "EASYPAISA", "JAZZCASH", "MANUAL"] as const;

export async function loader({ request }: LoaderFunctionArgs) {
  const { shopifyStoreId } = await requireTenantContext(request);
  const [refunds, evidence] = await Promise.all([
    listRefundRecords(shopifyStoreId),
    listEvidence(shopifyStoreId),
  ]);
  return { refunds, evidence };
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
