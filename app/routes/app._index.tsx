import React from "react";
import { useLoaderData, useSearchParams, Link } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requireTenantContext } from "../utils/tenant.server";
import prisma from "../db.server";
import { executeInitialShopifySync } from "../services/shopifySync.server";

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function dateKeyStartInTimeZone(value: string, timeZone: string): Date | null {
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const targetMidnightUtc = Date.UTC(year, month - 1, day);
  if (new Date(targetMidnightUtc).toISOString().slice(0, 10) !== value) return null;

  // Convert calendar midnight in the dashboard user's timezone into UTC.
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let guess = targetMidnightUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(guess))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    const displayedAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const offsetMs = displayedAsUtc - guess;
    const corrected = targetMidnightUtc - offsetMs;
    if (corrected === guess) break;
    guess = corrected;
  }
  return new Date(guess);
}

function nextDateKey(value: string): string | null {
  const parsed = dateKeyStartInTimeZone(value, "UTC");
  if (!parsed) return null;
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { shopifyStoreId, admin } = await requireTenantContext(request);
    const url = new URL(request.url);
    const requestedRange = url.searchParams.get("range") || "30d";
    const range = ["7d", "30d", "90d", "all", "custom"].includes(requestedRange) ? requestedRange : "30d";
    const customFrom = url.searchParams.get("from") || "";
    const customTo = url.searchParams.get("to") || "";
    const requestedTimeZone = url.searchParams.get("tz") || "UTC";
    const timeZone = isValidTimeZone(requestedTimeZone) ? requestedTimeZone : "UTC";

    let startDate: Date | undefined;
    let endExclusiveDate: Date | undefined;
    let dateRangeError: string | null = null;
    const now = new Date();

    if (range === "custom") {
      const candidateStart = dateKeyStartInTimeZone(customFrom, timeZone);
      const nextDayAfterTo = nextDateKey(customTo);
      const candidateEnd = nextDayAfterTo ? dateKeyStartInTimeZone(nextDayAfterTo, timeZone) : null;
      if (candidateStart && candidateEnd && customFrom <= customTo) {
        startDate = candidateStart;
        endExclusiveDate = candidateEnd;
      } else {
        // Never silently use an invalid custom range. Disclose the 30-day fallback.
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        endExclusiveDate = now;
        dateRangeError = "Choose a valid start and end date. The dashboard is temporarily showing the last 30 days.";
      }
    } else if (range === "7d" || range === "30d" || range === "90d") {
      const days = Number(range.slice(0, -1));
      startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      endExclusiveDate = now;
    } // "all" intentionally leaves both bounds undefined.

    const dateFilter = startDate || endExclusiveDate
      ? { createdAt: { ...(startDate ? { gte: startDate } : {}), ...(endExclusiveDate ? { lt: endExclusiveDate } : {}) } }
      : {};

    let store = await prisma.shopifyStore.findUnique({
      where: { id: shopifyStoreId },
      select: {
        shop: true,
        syncStatus: true,
        lastSyncAt: true,
      },
    });

    // Auto-trigger sync if syncStatus is PENDING or lastSyncAt is missing
    if (store && (store.syncStatus === "PENDING" || !store.lastSyncAt) && admin) {
      try {
        await executeInitialShopifySync({ shopifyStoreId, admin });
        store = await prisma.shopifyStore.findUnique({
          where: { id: shopifyStoreId },
          select: {
            shop: true,
            syncStatus: true,
            lastSyncAt: true,
          },
        });
      } catch (syncErr) {
        console.error("[Dashboard Loader] Auto-sync attempt failed:", syncErr);
      }
    }

    let historicalOrdersAccess = { checked: false, hasReadAllOrders: false };
    if (admin) {
      try {
        const scopeResponse = await admin.graphql(`
          query DashboardAccessScopes {
            currentAppInstallation { accessScopes { handle } }
          }
        `);
        const scopePayload = await scopeResponse.json();
        if (scopePayload?.errors?.length) {
          throw new Error(scopePayload.errors.map((entry: any) => entry.message).join("; "));
        }
        const scopes = scopePayload?.data?.currentAppInstallation?.accessScopes;
        if (Array.isArray(scopes)) {
          historicalOrdersAccess = {
            checked: true,
            hasReadAllOrders: scopes.some((scope: any) => scope.handle === "read_all_orders"),
          };
        }
      } catch (scopeError) {
        console.warn("[Dashboard Loader] Could not determine historical-order access:", scopeError);
      }
    }

    // Query real counts from Database with date filter where relevant
    const [
      returnsCount,
      exchangesCount,
      incomingExchanges,
      outgoingExchanges,
      returnIntake,
      recentReturnsDb,
      recentExchangesDb,
      pendingReturns,
      pendingExchanges,
      inTransit,
      awaitingInspection,
      pendingRefunds,
      failedShipments,
      bookedParcels,
    ] = await Promise.all([
      // Total return requests in range
      prisma.returnRequest.count({ where: { shopifyStoreId, ...dateFilter } }),
      // Total exchange requests in range
      prisma.exchangeRequest.count({ where: { shopifyStoreId, ...dateFilter } }),
      // Incoming Exchanges: customer parcels returning to warehouse (APPROVED or RECEIVED)
      prisma.exchangeRequest.count({
        where: { shopifyStoreId, status: { in: ["APPROVED", "RECEIVED"] }, ...dateFilter },
      }),
      // Outgoing Exchanges: replacement parcels sent to customers (FULFILLED or COMPLETED)
      prisma.exchangeRequest.count({
        where: { shopifyStoreId, status: { in: ["FULFILLED", "COMPLETED"] }, ...dateFilter },
      }),
      // Count historical inbound return intakes, including ones already inspected.
      prisma.warehouseIntake.count({
        where: {
          shopifyStoreId,
          returnRequestId: { not: null },
          status: { in: ["RECEIVED", "INSPECTED"] },
          ...dateFilter,
        },
      }),
      // Recent returns
      prisma.returnRequest.findMany({
        where: { shopifyStoreId, ...dateFilter },
        take: 5,
        orderBy: { createdAt: "desc" },
      }),
      // Recent exchanges
      prisma.exchangeRequest.findMany({
        where: { shopifyStoreId, ...dateFilter },
        take: 5,
        orderBy: { createdAt: "desc" },
        include: { items: true },
      }),
      // Operational queues
      prisma.returnRequest.count({ where: { shopifyStoreId, status: "PENDING" } }),
      prisma.exchangeRequest.count({ where: { shopifyStoreId, status: "PENDING" } }),
      prisma.shipmentTrack.count({ where: { shopifyStoreId, status: { in: ["IN_TRANSIT", "OUT_FOR_DELIVERY"] } } }),
      prisma.warehouseIntake.count({ where: { shopifyStoreId, status: "RECEIVED" } }),
      prisma.refundRecord.count({ where: { shopifyStoreId, status: "PENDING" } }),
      prisma.shipmentTrack.count({ where: { shopifyStoreId, status: "FAILED" } }),
      prisma.shipmentTrack.count({ where: { shopifyStoreId, status: "LABEL_CREATED" } }),
    ]);

    return {
      shop: store?.shop ?? "Connected Store",
      range,
      customFrom,
      customTo,
      timeZone,
      dateRangeError,
      dataAvailable: true,
      historicalOrdersAccess,
      metrics: {
        returnsCount,
        exchangesCount,
        incomingExchanges,
        outgoingExchanges,
        returnIntake,
      },
      operations: {
        pendingReturns,
        pendingExchanges,
        inTransit,
        awaitingInspection,
        pendingRefunds,
        failedShipments,
        bookedParcels,
      },
      recentReturns: recentReturnsDb.map((r) => ({
        id: r.id,
        orderNumber: r.orderNumber,
        customerName: r.customerName || r.customerEmail,
        status: r.status,
        date: r.createdAt.toISOString(),
      })),
      recentExchanges: recentExchangesDb.map((e) => ({
        id: e.id,
        orderNumber: e.orderNumber,
        customerName: e.customerName || e.customerEmail,
        replacementTitle: e.items?.[0]?.replacementTitle || "Replacement Item",
        status: e.status,
        date: e.createdAt.toISOString(),
      })),
    };
  } catch (error) {
    console.error("[Dashboard Loader] Error:", error);
    return {
      shop: "Connected Store",
      range: "30d",
      customFrom: "",
      customTo: "",
      timeZone: "UTC",
      dateRangeError: null,
      dataAvailable: false,
      historicalOrdersAccess: { checked: false, hasReadAllOrders: false },
      metrics: {
        returnsCount: 0,
        exchangesCount: 0,
        incomingExchanges: 0,
        outgoingExchanges: 0,
        returnIntake: 0,
      },
      operations: {
        pendingReturns: 0,
        pendingExchanges: 0,
        inTransit: 0,
        awaitingInspection: 0,
        pendingRefunds: 0,
        failedShipments: 0,
        bookedParcels: 0,
      },
      recentReturns: [],
      recentExchanges: [],
    };
  }
}

function getStatusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  const normalized = String(status || "").toUpperCase();

  if (["COMPLETED", "APPROVED", "RECEIVED", "DELIVERED", "REFUNDED", "RESOLVED", "FULFILLED"].includes(normalized)) {
    return "success";
  }
  if (["PENDING", "IN_PROGRESS", "PROCESSING", "UNDER_REVIEW", "RETURN_IN_PROGRESS", "OPEN"].includes(normalized)) {
    return "warning";
  }
  if (["FAILED", "REJECTED", "CANCELLED", "CANCELED", "ERROR"].includes(normalized)) {
    return "danger";
  }
  return "neutral";
}

export default function Dashboard() {
  const loaderData = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const shop = loaderData?.shop ?? "Connected Store";
  const currentRange = loaderData?.range ?? "30d";
  const dataAvailable = loaderData?.dataAvailable !== false;
  const dateRangeError = loaderData?.dateRangeError ?? null;
  const [customFrom, setCustomFrom] = React.useState(loaderData?.customFrom ?? "");
  const [customTo, setCustomTo] = React.useState(loaderData?.customTo ?? "");
  const [dateInputError, setDateInputError] = React.useState<string | null>(null);
  React.useEffect(() => {
    setCustomFrom(loaderData?.customFrom ?? "");
    setCustomTo(loaderData?.customTo ?? "");
    setDateInputError(null);
  }, [loaderData?.customFrom, loaderData?.customTo]);
  const historicalOrdersAccess = loaderData?.historicalOrdersAccess ?? { checked: false, hasReadAllOrders: false };
  const metrics = loaderData?.metrics ?? {
    returnsCount: 0,
    exchangesCount: 0,
    incomingExchanges: 0,
    outgoingExchanges: 0,
    returnIntake: 0,
  };
  const operations = loaderData?.operations ?? {
    pendingReturns: 0,
    pendingExchanges: 0,
    inTransit: 0,
    awaitingInspection: 0,
    pendingRefunds: 0,
    failedShipments: 0,
    bookedParcels: 0,
  };
  const recentReturns = loaderData?.recentReturns ?? [];
  const recentExchanges = loaderData?.recentExchanges ?? [];

  const handleRangeChange = (range: string) => {
    const next = new URLSearchParams(searchParams);
    if (range === "30d") next.delete("range");
    else next.set("range", range);

    if (range !== "custom") {
      next.delete("from");
      next.delete("to");
      next.delete("tz");
      setCustomFrom("");
      setCustomTo("");
      setDateInputError(null);
    }
    setSearchParams(next);
  };

  const applyCustomRange = () => {
    if (!customFrom || !customTo) {
      setDateInputError("Select both a start date and an end date.");
      return;
    }
    if (customFrom > customTo) {
      setDateInputError("The start date must be on or before the end date.");
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.set("range", "custom");
    next.set("from", customFrom);
    next.set("to", customTo);
    next.set("tz", Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    setDateInputError(null);
    setSearchParams(next);
  };

  const formatCount = (value: number) => dataAvailable ? value.toLocaleString("en-PK") : "—";

  return (
    <main className="bc-page bc-dashboard">
      <header className="bc-dashboard-header">
        <div className="bc-dashboard-header-copy">
          <h1>Dashboard</h1>
          <p>Monitor reverse logistics, manage open requests, and keep fulfilment moving.</p>
        </div>

        <div className="bc-dashboard-controls">
          <div className="bc-dashboard-filter-stack">
            <div className="bc-range-filter" role="group" aria-label="Date range filter">
              {[
                { id: "7d", label: "7 days" },
                { id: "30d", label: "30 days" },
                { id: "90d", label: "90 days" },
                { id: "all", label: "All time" },
                { id: "custom", label: "Custom" },
              ].map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`bc-range-btn ${currentRange === option.id ? "active" : ""}`}
                  onClick={() => handleRangeChange(option.id)}
                  aria-pressed={currentRange === option.id}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {currentRange === "custom" && (
              <div className="bc-custom-date-filter">
                <label className="bc-custom-date-field">
                  <span>From</span>
                  <input type="date" value={customFrom} max={customTo || undefined} onChange={(event) => { setCustomFrom(event.target.value); setDateInputError(null); }} />
                </label>
                <label className="bc-custom-date-field">
                  <span>To</span>
                  <input type="date" value={customTo} min={customFrom || undefined} onChange={(event) => { setCustomTo(event.target.value); setDateInputError(null); }} />
                </label>
                <button type="button" className="bc-custom-date-apply" onClick={applyCustomRange}>Apply</button>
              </div>
            )}
            {(dateInputError || dateRangeError) && currentRange === "custom" && (
              <p className="bc-dashboard-date-error" role="alert">{dateInputError || dateRangeError}</p>
            )}
          </div>

          <div className="bc-dashboard-store" title={shop}>
            <span className="bc-store-avatar" aria-hidden="true">
              {String(shop || "S").trim().slice(0, 1).toUpperCase() || "S"}
            </span>
            <span className="bc-store-copy">
              <span className="bc-store-label">STORE</span>
              <strong>{shop}</strong>
            </span>
          </div>
        </div>
      </header>

      {historicalOrdersAccess.checked && !historicalOrdersAccess.hasReadAllOrders && (
        <section role="status" aria-label="Historical order access notice" style={{ margin: "14px 0", padding: "12px 16px", borderRadius: "8px", border: "1px solid #e4e4e7", background: "#f4f4f5", color: "#18181b" }}>
          <strong>Historical order access note</strong>
          <p style={{ margin: "4px 0 0", lineHeight: 1.45, fontSize: "13px" }}>Shopify grants order access without read_all_orders scope. Older orders may need partner approval for full store history.</p>
        </section>
      )}

      {!dataAvailable && (
        <section className="bc-dashboard-data-error" role="alert">
          <strong>Dashboard data could not be loaded.</strong>
          <p>Metrics are hidden instead of showing misleading zeros. Reload the dashboard; the technical error is available in the server logs.</p>
        </section>
      )}

      {/* KPI Cards: Linked to relevant operational pages */}
      <section className="bc-dashboard-section" aria-labelledby="bc-overview-title">
        <div className="bc-dashboard-section-heading">
          <div>
            <h2 id="bc-overview-title">Overview</h2>
            <p>Request counts use the selected creation-date range. The operational queue below shows current outstanding work.</p>
          </div>
        </div>

        <div className="bc-kpi-grid">
          <Link to="/app/returns" className="bc-kpi-card bc-kpi-link">
            <div className="bc-kpi-card-top">
              <span className="bc-kpi-label">Return requests</span>
            </div>
            <p className="bc-kpi-value">{formatCount(metrics.returnsCount)}</p>
            <span className="bc-kpi-sub">View returns</span>
          </Link>

          <Link to="/app/exchanges" className="bc-kpi-card bc-kpi-link">
            <div className="bc-kpi-card-top">
              <span className="bc-kpi-label">Exchange requests</span>
            </div>
            <p className="bc-kpi-value">{formatCount(metrics.exchangesCount)}</p>
            <span className="bc-kpi-sub">View exchanges</span>
          </Link>

          <Link to="/app/warehouse" className="bc-kpi-card bc-kpi-link">
            <div className="bc-kpi-card-top">
              <span className="bc-kpi-label">Incoming exchanges</span>
            </div>
            <p className="bc-kpi-value">{formatCount(metrics.incomingExchanges)}</p>
            <span className="bc-kpi-sub">Approved or received exchange requests</span>
          </Link>

          <Link to="/app/warehouse?tab=EXCHANGES&filter=EXCHANGED" className="bc-kpi-card bc-kpi-link">
            <div className="bc-kpi-card-top">
              <span className="bc-kpi-label">Outgoing exchanges</span>
            </div>
            <p className="bc-kpi-value">{formatCount(metrics.outgoingExchanges)}</p>
            <span className="bc-kpi-sub">Replacements fulfilled</span>
          </Link>

          <Link to="/app/warehouse?tab=RETURNS&filter=WAREHOUSE" className="bc-kpi-card bc-kpi-link">
            <div className="bc-kpi-card-top">
              <span className="bc-kpi-label">Return intake</span>
            </div>
            <p className="bc-kpi-value">{formatCount(metrics.returnIntake)}</p>
            <span className="bc-kpi-sub">Return parcels received during the selected period</span>
          </Link>
        </div>
      </section>

      {/* Operational Queue */}
      <section className="bc-dashboard-section" aria-labelledby="bc-operations-title">
        <div className="bc-dashboard-section-heading">
          <div>
            <h2 id="bc-operations-title">Operational queue</h2>
            <p>Action items requiring attention.</p>
          </div>
        </div>

        <div className="bc-ops-grid">
          <Link className="bc-ops-card" to="/app/bookings">
            <span className="bc-ops-label">Bookings ready</span>
            <span className="bc-ops-value">{formatCount(operations.bookedParcels)}</span>
          </Link>
          <Link className={`bc-ops-card ${operations.pendingReturns > 0 ? "has-attention" : ""}`} to="/app/returns">
            <span className="bc-ops-label">Pending returns</span>
            <span className="bc-ops-value">{formatCount(operations.pendingReturns)}</span>
          </Link>
          <Link className={`bc-ops-card ${operations.pendingExchanges > 0 ? "has-attention" : ""}`} to="/app/exchanges">
            <span className="bc-ops-label">Pending exchanges</span>
            <span className="bc-ops-value">{formatCount(operations.pendingExchanges)}</span>
          </Link>
          <Link className="bc-ops-card" to="/app/shipments?type=All">
            <span className="bc-ops-label">Parcels in transit</span>
            <span className="bc-ops-value">{formatCount(operations.inTransit)}</span>
          </Link>
          <Link className="bc-ops-card" to="/app/warehouse">
            <span className="bc-ops-label">Awaiting inspection</span>
            <span className="bc-ops-value">{formatCount(operations.awaitingInspection)}</span>
          </Link>
          <Link className={`bc-ops-card ${operations.pendingRefunds > 0 ? "has-attention" : ""}`} to="/app/refunds">
            <span className="bc-ops-label">Refunds pending</span>
            <span className="bc-ops-value">{formatCount(operations.pendingRefunds)}</span>
          </Link>
          <Link className={`bc-ops-card ${operations.failedShipments > 0 ? "has-error" : ""}`} to="/app/shipments">
            <span className="bc-ops-label">Failed shipments</span>
            <span className="bc-ops-value">{formatCount(operations.failedShipments)}</span>
          </Link>
        </div>
      </section>

      {/* Recent Activity */}
      <section className="bc-dashboard-section" aria-labelledby="bc-activity-title">
        <div className="bc-dashboard-section-heading">
          <div>
            <h2 id="bc-activity-title">Recent activity</h2>
            <p>Latest return and exchange requests.</p>
          </div>
        </div>

        <div className="bc-activity-grid">
          <section className="bc-activity-card" aria-labelledby="bc-recent-returns-title">
            <header className="bc-activity-card-header">
              <div>
                <h3 id="bc-recent-returns-title">Recent returns</h3>
                <p>Latest return requests</p>
              </div>
              <Link className="bc-text-link" to="/app/returns">View all</Link>
            </header>

            {!dataAvailable ? (
              <div className="bc-empty-state"><strong>Activity unavailable</strong><p>Could not load return activity.</p></div>
            ) : recentReturns.length === 0 ? (
              <div className="bc-empty-state">
                <strong>No returns in this period</strong>
                <p>Return requests created during the selected date range will appear here.</p>
              </div>
            ) : (
              <div className="bc-dashboard-table-wrap">
                <table className="bc-dashboard-table">
                  <thead>
                    <tr>
                      <th scope="col">Order</th>
                      <th scope="col">Customer</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="bc-date-cell">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentReturns.map((item) => (
                      <tr key={item.id}>
                        <td><span className="bc-table-primary">{item.orderNumber || "—"}</span></td>
                        <td><span className="bc-table-secondary" title={item.customerName || "—"}>{item.customerName || "—"}</span></td>
                        <td><span className={`bc-status-badge bc-status-${getStatusTone(item.status)}`}>{item.status}</span></td>
                        <td className="bc-date-cell"><span className="bc-table-date">{new Date(item.date).toLocaleDateString()}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="bc-activity-card" aria-labelledby="bc-recent-exchanges-title">
            <header className="bc-activity-card-header">
              <div>
                <h3 id="bc-recent-exchanges-title">Recent exchanges</h3>
                <p>Latest exchange requests</p>
              </div>
              <Link className="bc-text-link" to="/app/exchanges">View all</Link>
            </header>

            {!dataAvailable ? (
              <div className="bc-empty-state"><strong>Activity unavailable</strong><p>Could not load exchange activity.</p></div>
            ) : recentExchanges.length === 0 ? (
              <div className="bc-empty-state">
                <strong>No exchanges in this period</strong>
                <p>Exchange requests created during the selected date range will appear here.</p>
              </div>
            ) : (
              <div className="bc-dashboard-table-wrap">
                <table className="bc-dashboard-table">
                  <thead>
                    <tr>
                      <th scope="col">Order</th>
                      <th scope="col">Replacement</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="bc-date-cell">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentExchanges.map((item) => (
                      <tr key={item.id}>
                        <td><span className="bc-table-primary">{item.orderNumber || "—"}</span></td>
                        <td><span className="bc-table-secondary" title={item.replacementTitle || "—"}>{item.replacementTitle || "—"}</span></td>
                        <td><span className={`bc-status-badge bc-status-${getStatusTone(item.status)}`}>{item.status}</span></td>
                        <td className="bc-date-cell"><span className="bc-table-date">{new Date(item.date).toLocaleDateString()}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}
