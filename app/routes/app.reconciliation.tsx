import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useSearchParams } from "react-router";
import { requireTenantContext } from "../utils/tenant.server";
import { assertPermission } from "../services/permissions.server";
import {
  confirmCodSettlement,
  exportCodCsv,
  importCodCsv,
  listCodSettlements,
  recordAutoReconciledSettlement,
} from "../services/cod.server";
import { countPendingCodOrders, markVerifiedCodPaid, verifyCodBatch } from "../services/codVerification.server";
import { getSettings } from "../services/settings.server";
import { logAction } from "../services/audit.server";
import { CodPaymentCheck } from "../components/CodPaymentCheck";

export async function loader({ request }: LoaderFunctionArgs) {
  const { shopifyStoreId } = await requireTenantContext(request);
  const url = new URL(request.url);

  const courierFilter = url.searchParams.get("courier") || undefined;
  const statusFilter = url.searchParams.get("status") || undefined;
  const searchFilter = url.searchParams.get("q") || undefined;

  if (url.searchParams.get("export") === "csv") {
    const csv = await exportCodCsv(shopifyStoreId, courierFilter);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=byndcart-cod-settlements.csv",
      },
    });
  }

  const settlements = await listCodSettlements(shopifyStoreId, {
    courier: courierFilter,
    status: statusFilter,
    search: searchFilter,
  });

  const settings = await getSettings(shopifyStoreId).catch(() => null);

  return {
    settlements,
    courierFilter: courierFilter || "ALL",
    statusFilter: statusFilter || "ALL",
    searchFilter: searchFilter || "",
    codTaxPercent: Number(settings?.codTaxPercent ?? 4),
    codDeliveryCharge: Number(settings?.codDeliveryCharge ?? 280),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { shopifyStoreId, session, admin } = await requireTenantContext(request);
  await assertPermission(shopifyStoreId, session, "cod");
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "VERIFY") {
      const cursor = String(form.get("cursor") || "") || null;
      const settings = await getSettings(shopifyStoreId).catch(() => null);
      const [batch, totalPending] = await Promise.all([
        verifyCodBatch(admin, shopifyStoreId, cursor, Number(settings?.codTaxPercent ?? 4)),
        countPendingCodOrders(admin),
      ]);
      return { ok: true, intent: "VERIFY", mode: String(form.get("mode") || "replace"), totalPending, ...batch };
    }

    if (intent === "MARK") {
      const orderIds = String(form.get("orderIds") || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .slice(0, 100);

      if (!orderIds.length) {
        return { ok: false, intent: "MARK", message: "Select at least one settled order." };
      }

      const marked: Array<{
        orderId: string;
        orderName: string;
        courier?: string;
        tracking?: string;
        shopifyAmount?: number;
        courierAmount?: number;
        deliveryCharges?: number;
        amountMatched?: boolean;
      }> = [];
      const failed: Array<{ orderId: string; message: string }> = [];

      for (const orderId of orderIds) {
        try {
          const res = await markVerifiedCodPaid(admin, shopifyStoreId, orderId);
          marked.push(res);

          // Automatically record settled order in the database ledger
          await recordAutoReconciledSettlement(shopifyStoreId, {
            courier: res.courier || "COURIER",
            orderNumber: res.orderName,
            trackingNumber: res.tracking,
            expectedAmount: Number(res.shopifyAmount || 0),
            collectedAmount: Number(res.courierAmount || 0),
            shippingCharge: Number(res.deliveryCharges || 0),
            settlementDate: res.paymentDate && res.paymentDate !== "-" ? new Date() : new Date(),
            status: res.amountMatched ? "CONFIRMED" : "DISPUTED",
            notes: `Auto-reconciled with ${res.courier}. Marked paid in Shopify.`,
          });
        } catch (error) {
          failed.push({
            orderId,
            message: error instanceof Error ? error.message : "Shopify did not mark this order paid.",
          });
        }
      }

      // Record audit action for compliance
      if (marked.length > 0) {
        await logAction({
          shopifyStoreId,
          userId: session?.id,
          action: "COD_AUTO_RECONCILE",
          entityType: "CodSettlement",
          metadata: {
            reconciledCount: marked.length,
            orderNames: marked.map((m) => m.orderName),
            couriers: Array.from(new Set(marked.map((m) => m.courier).filter(Boolean))),
          },
        });
      }

      const failedNote = failed.length
        ? ` ${failed.length} could not be marked: ${failed.map((row) => row.message).join(" ")}`
        : "";

      return {
        ok: failed.length === 0,
        intent: "MARK",
        marked,
        failed,
        message: `Auto-reconciled and marked ${marked.length} of ${orderIds.length} orders paid in Shopify.${failedNote}`,
      };
    }

    if (intent === "CONFIRM") {
      await confirmCodSettlement(String(form.get("settlementId") || ""), shopifyStoreId);
      return { ok: true, message: "Settlement marked confirmed by merchant." };
    }

    if (intent === "IMPORT_CSV") {
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) {
        return { ok: false, message: "Choose a CSV file." };
      }
      const contents = await file.text();
      const result = await importCodCsv(shopifyStoreId, file.name || "settlements.csv", contents);
      return { ok: true, message: `Imported ${result.rowCount} settlement rows from statement.` };
    }

    return { ok: false, message: "Unknown action intent." };
  } catch (error: unknown) {
    if (error instanceof Response) throw error;
    return { ok: false, message: error instanceof Error ? error.message : "Could not complete COD reconciliation action." };
  }
}

function badgeClass(status: string) {
  if (status === "CONFIRMED" || status === "MATCHED") return "bc-badge ok";
  if (status === "DISPUTED") return "bc-badge bad";
  return "bc-badge warn";
}

function money(value: string | number) {
  const num = Number(value) || 0;
  return `PKR ${Math.round(num).toLocaleString("en-PK")}`;
}

export default function ReconciliationPage() {
  const data = useLoaderData<typeof loader>();
  const settlements = data && "settlements" in data ? data.settlements : [];
  const actionData = useActionData<typeof action>();
  const [searchParams, setSearchParams] = useSearchParams();

  const handleCourierFilterChange = (courier: string) => {
    const next = new URLSearchParams(searchParams);
    if (courier !== "ALL") next.set("courier", courier);
    else next.delete("courier");
    setSearchParams(next);
  };

  const handleStatusFilterChange = (status: string) => {
    const next = new URLSearchParams(searchParams);
    if (status !== "ALL") next.set("status", status);
    else next.delete("status");
    setSearchParams(next);
  };

  const handleSearchChange = (q: string) => {
    const next = new URLSearchParams(searchParams);
    if (q.trim()) next.set("q", q.trim());
    else next.delete("q");
    setSearchParams(next);
  };

  const activeCourier = searchParams.get("courier") || "ALL";
  const activeStatus = searchParams.get("status") || "ALL";
  const currentSearch = searchParams.get("q") || "";

  return (
    <div className="bc-page bc-reconciliation-page">
      <header className="bc-header">
        <div className="bc-header-copy">
          <p className="bc-eyebrow">PAYMENTS & RECONCILIATION</p>
          <h1>COD reconciliation</h1>
          <p>
            Automated courier remittance reconciliation: verify deliveries and collected COD with PostEx & Leopards, then auto-reconcile orders directly into Shopify and your database ledger.
          </p>
        </div>
      </header>

      {/* Main Verification & Auto-Reconciliation Panel */}
      <CodPaymentCheck
        taxPercent={Number(data && "codTaxPercent" in data ? data.codTaxPercent : 4)}
        deliveryCharge={Number(data && "codDeliveryCharge" in data ? data.codDeliveryCharge : 280)}
      />

      {actionData?.message && (
        <div className={actionData.ok ? "bc-note ok" : "bc-note bad"}>
          {actionData.message}
        </div>
      )}

      {/* Reconciled Settlements Ledger & Statement Import */}
      <div className="bc-stack">
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
          <div>
            <h2 className="bc-title" style={{ margin: 0 }}>Settlement Ledger</h2>
            <p className="bc-muted" style={{ margin: "4px 0 0" }}>
              Permanent record of all auto-reconciled courier settlements and imported statements.
            </p>
          </div>

          <div className="bc-actions">
            <a
              href={`/app/reconciliation?export=csv${activeCourier !== "ALL" ? `&courier=${activeCourier}` : ""}`}
              className="bc-btn"
            >
              Export CSV ledger
            </a>
          </div>
        </div>

        {/* Ledger Filter Bar */}
        <section className="bc-card bc-toolbar" style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center" }}>
          <label style={{ flex: "1 1 240px" }}>
            <span className="bc-field-label">Search ledger</span>
            <input
              type="search"
              placeholder="Order number, tracking number, or courier reference"
              defaultValue={currentSearch}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
          </label>

          <div className="bc-filter-field">
            <span className="bc-field-label">Courier</span>
            <div className="bc-range-filter" role="group" aria-label="Filter ledger by courier">
              <button
                type="button"
                className={`bc-range-btn ${activeCourier === "ALL" ? "active" : ""}`}
                onClick={() => handleCourierFilterChange("ALL")}
              >
                All
              </button>
              <button
                type="button"
                className={`bc-range-btn ${activeCourier === "POSTEX" ? "active" : ""}`}
                onClick={() => handleCourierFilterChange("POSTEX")}
              >
                PostEx
              </button>
              <button
                type="button"
                className={`bc-range-btn ${activeCourier === "LEOPARD" ? "active" : ""}`}
                onClick={() => handleCourierFilterChange("LEOPARD")}
              >
                Leopards
              </button>
              <button
                type="button"
                className={`bc-range-btn ${activeCourier === "TCS" ? "active" : ""}`}
                onClick={() => handleCourierFilterChange("TCS")}
              >
                TCS
              </button>
            </div>
          </div>

          <div className="bc-filter-field">
            <span className="bc-field-label">Status</span>
            <div className="bc-range-filter" role="group" aria-label="Filter ledger by status">
              <button
                type="button"
                className={`bc-range-btn ${activeStatus === "ALL" ? "active" : ""}`}
                onClick={() => handleStatusFilterChange("ALL")}
              >
                All
              </button>
              <button
                type="button"
                className={`bc-range-btn ${activeStatus === "CONFIRMED" ? "active" : ""}`}
                onClick={() => handleStatusFilterChange("CONFIRMED")}
              >
                Confirmed
              </button>
              <button
                type="button"
                className={`bc-range-btn ${activeStatus === "MATCHED" ? "active" : ""}`}
                onClick={() => handleStatusFilterChange("MATCHED")}
              >
                Matched
              </button>
              <button
                type="button"
                className={`bc-range-btn ${activeStatus === "DISPUTED" ? "active" : ""}`}
                onClick={() => handleStatusFilterChange("DISPUTED")}
              >
                Disputed
              </button>
            </div>
          </div>
        </section>

        {/* Settlements Table */}
        <div className="bc-table-wrap">
          <table className="bc-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Source</th>
                <th>Courier</th>
                <th>Order</th>
                <th>Expected</th>
                <th>Collected</th>
                <th>Charges</th>
                <th>Net payout</th>
                <th>Reference</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {settlements.length === 0 && (
                <tr>
                  <td colSpan={10}>No COD settlements found for the current filter.</td>
                </tr>
              )}
              {settlements.map((row) => (
                <tr key={row.id}>
                  <td><span className={badgeClass(row.status)}>{row.status}</span></td>
                  <td>
                    <span className="bc-badge">
                      {row.source === "AUTO_RECONCILE" ? "Auto" : row.source}
                    </span>
                  </td>
                  <td><strong>{row.courier}</strong></td>
                  <td>{row.orderNumber || "—"}</td>
                  <td>{money(String(row.expectedAmount))}</td>
                  <td>{money(String(row.collectedAmount))}</td>
                  <td>{money(String(row.shippingCharge))}</td>
                  <td><strong>{money(String(row.netAmount))}</strong></td>
                  <td>{row.trackingNumber || row.courierReference || "—"}</td>
                  <td>
                    {row.status !== "CONFIRMED" && (
                      <Form method="post">
                        <input type="hidden" name="intent" value="CONFIRM" />
                        <input type="hidden" name="settlementId" value={row.id} />
                        <button type="submit" className="bc-btn">Confirm</button>
                      </Form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Import CSV Courier Statement */}
        <section className="bc-card" style={{ marginTop: "16px" }}>
          <h2 className="bc-title">Import courier statement (CSV)</h2>
          <p className="bc-muted">
            If a courier (such as TCS, Trax, or PostEx) provides a weekly bank remittance spreadsheet, upload the CSV file here to import and match against orders.
          </p>
          <Form method="post" encType="multipart/form-data" className="bc-stack" style={{ marginTop: "12px" }}>
            <input type="hidden" name="intent" value="IMPORT_CSV" />
            <p className="bc-muted" style={{ fontSize: "11px" }}>
              Required headers: courier, expectedAmount, collectedAmount. Optional: orderNumber, trackingNumber, shippingCharge, reverseCharge, fees, adjustments, settlementDate, batchReference, courierReference, bankReference, notes.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "12px" }}>
              <input name="file" type="file" accept=".csv,text/csv" required style={{ maxWidth: "340px" }} />
              <button type="submit" className="bc-btn primary">Import statement</button>
            </div>
          </Form>
        </section>
      </div>
    </div>
  );
}
