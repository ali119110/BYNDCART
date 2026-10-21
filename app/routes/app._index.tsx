import React from "react";
import { useLoaderData, useSearchParams, Link } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requireTenantContext } from "../utils/tenant.server";
import prisma from "../db.server";
import { executeInitialShopifySync } from "../services/shopifySync.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { shopifyStoreId, admin } = await requireTenantContext(request);
    const url = new URL(request.url);
    const range = url.searchParams.get("range") || "30d";

    let startDate: Date | undefined;
    const now = Date.now();
    if (range === "7d") {
      startDate = new Date(now - 7 * 24 * 60 * 60 * 1000);
    } else if (range === "30d") {
      startDate = new Date(now - 30 * 24 * 60 * 60 * 1000);
    } else if (range === "90d") {
      startDate = new Date(now - 90 * 24 * 60 * 60 * 1000);
    } // "all" leaves startDate undefined

    const dateFilter = startDate ? { createdAt: { gte: startDate } } : {};

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
      // Return Intake: return parcels received at warehouse awaiting inspection
      prisma.returnRequest.count({
        where: { shopifyStoreId, status: "RECEIVED", ...dateFilter },
      }),
      // Recent returns
      prisma.returnRequest.findMany({
        where: { shopifyStoreId },
        take: 5,
        orderBy: { createdAt: "desc" },
      }),
      // Recent exchanges
      prisma.exchangeRequest.findMany({
        where: { shopifyStoreId },
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
    ]);

    return {
      shop: store?.shop ?? "Connected Store",
      range,
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
      },
      recentReturns: recentReturnsDb.map((r) => ({
        id: r.id,
        orderNumber: r.orderNumber,
        customerName: r.customerName || r.customerEmail,
        status: r.status,
        date: new Date(r.createdAt).toLocaleDateString(),
      })),
      recentExchanges: recentExchangesDb.map((e) => ({
        id: e.id,
        orderNumber: e.orderNumber,
        customerName: e.customerName || e.customerEmail,
        replacementTitle: e.items?.[0]?.replacementTitle || "Replacement Item",
        status: e.status,
        date: new Date(e.createdAt).toLocaleDateString(),
      })),
    };
  } catch (error) {
    console.error("[Dashboard Loader] Error:", error);
    return {
      shop: "Connected Store",
      range: "30d",
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
  };
  const recentReturns = loaderData?.recentReturns ?? [];
  const recentExchanges = loaderData?.recentExchanges ?? [];

  const handleRangeChange = (range: string) => {
    const next = new URLSearchParams(searchParams);
    if (range === "30d") next.delete("range");
    else next.set("range", range);
    setSearchParams(next);
  };

  return (
    <main className="bc-page bc-dashboard">
      <header className="bc-dashboard-header">
        <div className="bc-dashboard-header-copy">
          <h1>Dashboard</h1>
          <p>Monitor reverse logistics, manage open requests, and keep fulfilment moving.</p>
        </div>

        <div className="bc-dashboard-controls">
          <div className="bc-range-filter" role="group" aria-label="Date range filter">
            {[
              { id: "7d", label: "7 days" },
              { id: "30d", label: "30 days" },
              { id: "90d", label: "90 days" },
              { id: "all", label: "All time" },
            ].map((option) => (
              <button
                key={option.id}
                type="button"
                className={`bc-range-btn ${currentRange === option.id ? "active" : ""}`}
                onClick={() => handleRangeChange(option.id)}
              >
                {option.label}
              </button>
            ))}
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

      {/* KPI Cards: Linked to relevant operational pages */}
      <section className="bc-dashboard-section" aria-labelledby="bc-overview-title">
        <div className="bc-dashboard-section-heading">
          <div>
            <h2 id="bc-overview-title">Overview</h2>
            <p>Operational summary for the selected period.</p>
          </div>
        </div>

        <div className="bc-kpi-grid">
          <Link to="/app/returns" className="bc-kpi-card bc-kpi-link">
            <div className="bc-kpi-card-top">
              <span className="bc-kpi-label">Return requests</span>
            </div>
            <p className="bc-kpi-value">{metrics.returnsCount.toLocaleString("en-PK")}</p>
            <span className="bc-kpi-sub">View returns</span>
          </Link>

          <Link to="/app/exchanges" className="bc-kpi-card bc-kpi-link">
            <div className="bc-kpi-card-top">
              <span className="bc-kpi-label">Exchange requests</span>
            </div>
            <p className="bc-kpi-value">{metrics.exchangesCount.toLocaleString("en-PK")}</p>
            <span className="bc-kpi-sub">View exchanges</span>
          </Link>

          <Link to="/app/warehouse" className="bc-kpi-card bc-kpi-link">
            <div className="bc-kpi-card-top">
              <span className="bc-kpi-label">Incoming exchanges</span>
            </div>
            <p className="bc-kpi-value">{metrics.incomingExchanges.toLocaleString("en-PK")}</p>
            <span className="bc-kpi-sub">Parcels returning to warehouse</span>
          </Link>

          <Link to="/app/warehouse?tab=EXCHANGES&filter=EXCHANGED" className="bc-kpi-card bc-kpi-link">
            <div className="bc-kpi-card-top">
              <span className="bc-kpi-label">Outgoing exchanges</span>
            </div>
            <p className="bc-kpi-value">{metrics.outgoingExchanges.toLocaleString("en-PK")}</p>
            <span className="bc-kpi-sub">Replacements fulfilled</span>
          </Link>

          <Link to="/app/warehouse?tab=RETURNS&filter=WAREHOUSE" className="bc-kpi-card bc-kpi-link">
            <div className="bc-kpi-card-top">
              <span className="bc-kpi-label">Return intake</span>
            </div>
            <p className="bc-kpi-value">{metrics.returnIntake.toLocaleString("en-PK")}</p>
            <span className="bc-kpi-sub">Received at warehouse</span>
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
          <Link className={`bc-ops-card ${operations.pendingReturns > 0 ? "has-attention" : ""}`} to="/app/returns">
            <span className="bc-ops-label">Pending returns</span>
            <span className="bc-ops-value">{operations.pendingReturns.toLocaleString("en-PK")}</span>
          </Link>
          <Link className={`bc-ops-card ${operations.pendingExchanges > 0 ? "has-attention" : ""}`} to="/app/exchanges">
            <span className="bc-ops-label">Pending exchanges</span>
            <span className="bc-ops-value">{operations.pendingExchanges.toLocaleString("en-PK")}</span>
          </Link>
          <Link className="bc-ops-card" to="/app/shipments?type=All">
            <span className="bc-ops-label">Parcels in transit</span>
            <span className="bc-ops-value">{operations.inTransit.toLocaleString("en-PK")}</span>
          </Link>
          <Link className="bc-ops-card" to="/app/warehouse">
            <span className="bc-ops-label">Awaiting inspection</span>
            <span className="bc-ops-value">{operations.awaitingInspection.toLocaleString("en-PK")}</span>
          </Link>
          <Link className={`bc-ops-card ${operations.pendingRefunds > 0 ? "has-attention" : ""}`} to="/app/refunds">
            <span className="bc-ops-label">Refunds pending</span>
            <span className="bc-ops-value">{operations.pendingRefunds.toLocaleString("en-PK")}</span>
          </Link>
          <Link className={`bc-ops-card ${operations.failedShipments > 0 ? "has-error" : ""}`} to="/app/shipments">
            <span className="bc-ops-label">Failed shipments</span>
            <span className="bc-ops-value">{operations.failedShipments.toLocaleString("en-PK")}</span>
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

            {recentReturns.length === 0 ? (
              <div className="bc-empty-state">
                <strong>No returns yet</strong>
                <p>New return requests will appear here.</p>
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
                        <td className="bc-date-cell"><span className="bc-table-date">{item.date}</span></td>
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

            {recentExchanges.length === 0 ? (
              <div className="bc-empty-state">
                <strong>No exchanges yet</strong>
                <p>New exchange requests will appear here.</p>
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
                        <td className="bc-date-cell"><span className="bc-table-date">{item.date}</span></td>
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
