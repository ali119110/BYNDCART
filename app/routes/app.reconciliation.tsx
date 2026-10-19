import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { requireTenantContext } from "../utils/tenant.server";
import { assertPermission } from "../services/permissions.server";
import {
  confirmCodSettlement,
  createManualSettlement,
  exportCodCsv,
  importCodCsv,
  listCodSettlements,
} from "../services/cod.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { shopifyStoreId } = await requireTenantContext(request);
  const url = new URL(request.url);
  if (url.searchParams.get("export") === "csv") {
    const csv = await exportCodCsv(shopifyStoreId);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=byndcart-cod-settlements.csv",
      },
    });
  }
  const settlements = await listCodSettlements(shopifyStoreId);
  return { settlements };
}

export async function action({ request }: ActionFunctionArgs) {
  const { shopifyStoreId, session } = await requireTenantContext(request);
  await assertPermission(shopifyStoreId, session, "cod");
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "CONFIRM") {
      await confirmCodSettlement(String(form.get("settlementId") || ""), shopifyStoreId);
      return { ok: true, message: "Settlement marked confirmed by a merchant." };
    }
    if (intent === "IMPORT_CSV") {
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) {
        return { ok: false, message: "Choose a CSV file." };
      }
      const contents = await file.text();
      const result = await importCodCsv(shopifyStoreId, file.name || "settlements.csv", contents);
      return { ok: true, message: `Imported ${result.rowCount} settlement rows.` };
    }

    await createManualSettlement(shopifyStoreId, {
      courier: String(form.get("courier") || ""),
      orderNumber: String(form.get("orderNumber") || "") || undefined,
      trackingNumber: String(form.get("trackingNumber") || "") || undefined,
      expectedAmount: Number(form.get("expectedAmount") || 0),
      collectedAmount: Number(form.get("collectedAmount") || 0),
      shippingCharge: Number(form.get("shippingCharge") || 0),
      reverseCharge: Number(form.get("reverseCharge") || 0),
      fees: Number(form.get("fees") || 0),
      adjustments: Number(form.get("adjustments") || 0),
      courierReference: String(form.get("courierReference") || "") || undefined,
      bankReference: String(form.get("bankReference") || "") || undefined,
      batchReference: String(form.get("batchReference") || "") || undefined,
      settlementDate: String(form.get("settlementDate") || "") || undefined,
      notes: String(form.get("notes") || "") || undefined,
      confirm: form.get("confirm") === "yes",
    });
    return { ok: true, message: "COD settlement saved. Amounts that do not match stay disputed." };
  } catch (error: unknown) {
    if (error instanceof Response) throw error;
    return { ok: false, message: error instanceof Error ? error.message : "Could not save the settlement." };
  }
}

function badgeClass(status: string) {
  if (status === "CONFIRMED" || status === "MATCHED") return "bc-badge ok";
  if (status === "DISPUTED") return "bc-badge bad";
  return "bc-badge warn";
}

export default function ReconciliationPage() {
  const data = useLoaderData<typeof loader>();
  const settlements = data && "settlements" in data ? data.settlements : [];
  const actionData = useActionData<typeof action>();

  return (
    <div className="bc-page">
      <header className="bc-header">
        <h1>COD reconciliation</h1>
        <p>Expected, imported, matched, disputed, and merchant-confirmed settlements. No courier settlement API is connected, so imports and manual entries are the source of truth.</p>
      </header>
      {actionData?.message && <div className={actionData.ok ? "bc-note ok" : "bc-note bad"}>{actionData.message}</div>}
      <div className="bc-split">
        <Form method="post" className="bc-form">
          <h2 className="bc-title">Manual settlement</h2>
          <input type="hidden" name="intent" value="MANUAL" />
          <label>Courier<input name="courier" required placeholder="TCS" /></label>
          <label>Order number<input name="orderNumber" /></label>
          <label>Tracking number<input name="trackingNumber" /></label>
          <label>Expected COD<input name="expectedAmount" type="number" min="0" step="0.01" required /></label>
          <label>Collected<input name="collectedAmount" type="number" min="0" step="0.01" defaultValue="0" /></label>
          <label>Shipping charge<input name="shippingCharge" type="number" min="0" step="0.01" defaultValue="0" /></label>
          <label>Reverse charge<input name="reverseCharge" type="number" min="0" step="0.01" defaultValue="0" /></label>
          <label>Fees<input name="fees" type="number" min="0" step="0.01" defaultValue="0" /></label>
          <label>Adjustments<input name="adjustments" type="number" step="0.01" defaultValue="0" /></label>
          <label>Courier reference<input name="courierReference" /></label>
          <label>Bank reference<input name="bankReference" /></label>
          <label>Batch<input name="batchReference" /></label>
          <label>Settlement date<input name="settlementDate" type="date" /></label>
          <label>Notes<textarea name="notes" rows={3} /></label>
          <label>Confirm now
            <select name="confirm" defaultValue="no"><option value="no">No</option><option value="yes">Yes, I confirmed these figures</option></select>
          </label>
          <button type="submit">Save settlement</button>
        </Form>
        <Form method="post" encType="multipart/form-data" className="bc-form">
          <h2 className="bc-title">Import CSV</h2>
          <input type="hidden" name="intent" value="IMPORT_CSV" />
          <p className="bc-muted">Headers: courier, expectedAmount, collectedAmount. Optional: orderNumber, trackingNumber, shippingCharge, reverseCharge, fees, adjustments, settlementDate, batchReference, courierReference, bankReference, notes.</p>
          <label>CSV file<input name="file" type="file" accept=".csv,text/csv" required /></label>
          <div className="bc-actions">
            <button type="submit">Import</button>
            <a href="/app/reconciliation?export=csv">Export current rows</a>
          </div>
        </Form>
      </div>
      <div className="bc-table-wrap">
        <table className="bc-table">
          <thead>
            <tr><th>Status</th><th>Courier</th><th>Order</th><th>Expected</th><th>Collected</th><th>Net</th><th>Reference</th><th></th></tr>
          </thead>
          <tbody>
            {settlements.length === 0 && <tr><td colSpan={8}>No COD settlements yet.</td></tr>}
            {settlements.map((row) => (
              <tr key={row.id}>
                <td><span className={badgeClass(row.status)}>{row.status}</span></td>
                <td>{row.courier}</td>
                <td>{row.orderNumber || "—"}</td>
                <td>{String(row.expectedAmount)}</td>
                <td>{String(row.collectedAmount)}</td>
                <td>{String(row.netAmount)}</td>
                <td>{row.courierReference || "—"}</td>
                <td>
                  {row.status !== "CONFIRMED" && (
                    <Form method="post">
                      <input type="hidden" name="intent" value="CONFIRM" />
                      <input type="hidden" name="settlementId" value={row.id} />
                      <button type="submit">Confirm</button>
                    </Form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
