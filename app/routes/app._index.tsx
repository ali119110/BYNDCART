import React from "react";
import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requireTenantContext } from "../utils/tenant.server";
import prisma from "../db.server";
import { executeInitialShopifySync } from "../services/shopifySync.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { shopifyStoreId, admin } = await requireTenantContext(request);
    
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
    // Query real counts from Database
    const [ordersCount, returnsCount, exchangesCount, customerCacheCount, exchangeItems, recentReturnsDb, recentExchangesDb, pendingReturns, pendingExchanges, inTransit, awaitingInspection, pendingRefunds, unreconciledCod, failedShipments] = await Promise.all([
      prisma.order.count({ where: { shopifyStoreId } }),
      prisma.returnRequest.count({ where: { shopifyStoreId } }),
      prisma.exchangeRequest.count({ where: { shopifyStoreId } }),
      prisma.customerCache.count({ where: { shopifyStoreId } }),
      prisma.exchangeItem.findMany({
        where: { exchangeRequest: { shopifyStoreId, status: "COMPLETED" } },
        select: { priceDifference: true },
      }),
      prisma.returnRequest.findMany({
        where: { shopifyStoreId },
        take: 5,
        orderBy: { createdAt: "desc" },
      }),
      prisma.exchangeRequest.findMany({
        where: { shopifyStoreId },
        take: 5,
        orderBy: { createdAt: "desc" },
        include: { items: true },
      }),
      prisma.returnRequest.count({ where: { shopifyStoreId, status: "PENDING" } }),
      prisma.exchangeRequest.count({ where: { shopifyStoreId, status: "PENDING" } }),
      prisma.shipmentTrack.count({ where: { shopifyStoreId, status: "IN_TRANSIT" } }),
      prisma.warehouseIntake.count({ where: { shopifyStoreId, status: "RECEIVED" } }),
      prisma.refundRecord.count({ where: { shopifyStoreId, status: "PENDING" } }),
      prisma.codSettlement.count({ where: { shopifyStoreId, status: { in: ["EXPECTED", "IMPORTED", "DISPUTED"] } } }),
      prisma.shipmentTrack.count({ where: { shopifyStoreId, status: "FAILED" } }),
    ]);

    // Calculate revenue retained from exchanges
    const revenueRetained = exchangeItems.reduce((acc, item) => {
      const val = item.priceDifference ? Number(item.priceDifference) : 0;
      return acc + (Number.isFinite(val) ? Math.max(0, val) : 0);
    }, 0);

    // If customerCacheCount is 0, count unique customer emails from Orders
    let customersCount = customerCacheCount;
    if (customersCount === 0) {
      const distinctCustomers = await prisma.order.findMany({
        where: { shopifyStoreId, customerEmail: { not: null } },
        select: { customerEmail: true },
        distinct: ["customerEmail"],
      });
      customersCount = distinctCustomers.length;
    }

    return {
      shop: store?.shop ?? "Connected Store",
      historicalOrdersAccess,
      metrics: {
        ordersCount,
        returnsCount,
        exchangesCount,
        customersCount,
        revenueRetained,
      },
      operations: {
        pendingReturns,
        pendingExchanges,
        inTransit,
        awaitingInspection,
        pendingRefunds,
        unreconciledCod,
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
      historicalOrdersAccess: { checked: false, hasReadAllOrders: false },
      metrics: {
        ordersCount: 0,
        returnsCount: 0,
        exchangesCount: 0,
        customersCount: 0,
        revenueRetained: 0,
      },
      operations: {
        pendingReturns: 0,
        pendingExchanges: 0,
        inTransit: 0,
        awaitingInspection: 0,
        pendingRefunds: 0,
        unreconciledCod: 0,
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

  const shop = loaderData?.shop ?? "Connected Store";
  const historicalOrdersAccess = loaderData?.historicalOrdersAccess ?? { checked: false, hasReadAllOrders: false };
  const metrics = loaderData?.metrics ?? {
    ordersCount: 0,
    returnsCount: 0,
    exchangesCount: 0,
    customersCount: 0,
    revenueRetained: 0,
  };
  const operations = loaderData?.operations ?? {
    pendingReturns: 0,
    pendingExchanges: 0,
    inTransit: 0,
    awaitingInspection: 0,
    pendingRefunds: 0,
    unreconciledCod: 0,
    failedShipments: 0,
  };
  const recentReturns = loaderData?.recentReturns ?? [];
  const recentExchanges = loaderData?.recentExchanges ?? [];

  const revenueRetained = `PKR ${Number(metrics.revenueRetained || 0).toLocaleString("en-PK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

  return (
    <main className="bc-page bc-dashboard">
      <header className="bc-dashboard-header">
        <div className="bc-dashboard-header-copy">
          <p className="bc-eyebrow">OPERATIONS OVERVIEW</p>
          <h1>Dashboard</h1>
          <p>Monitor store activity, manage open requests, and keep fulfilment moving.</p>
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
      </header>

      {historicalOrdersAccess.checked && !historicalOrdersAccess.hasReadAllOrders && (
        <section role="status" aria-label="Historical order access notice" style={{ margin: "18px 0", padding: "16px 18px", borderRadius: "12px", border: "1px solid #f6d28b", background: "#fffbeb", color: "#78350f" }}>
          <strong>Historical order access is not enabled</strong>
          <p style={{ margin: "6px 0 0", lineHeight: 1.5 }}>Shopify currently grants BYNDCART order access without the read_all_orders permission. Older orders may be missing from dashboard totals and manual return/exchange search. Request read_all_orders access in the Shopify Partner Dashboard; after Shopify approves it, enable the scope for this app and run a full store sync.</p>
        </section>
      )}

      <section className="bc-dashboard-section" aria-labelledby="bc-overview-title">
        <div className="bc-dashboard-section-heading">
          <div>
            <h2 id="bc-overview-title">Store overview</h2>
            <p>Your store totals and retained exchange revenue.</p>
          </div>
          <span className="bc-dashboard-section-tag">SUMMARY</span>
        </div>

        <div className="bc-kpi-grid">
          <article className="bc-kpi-card bc-kpi-orders">
            <div className="bc-kpi-card-top">
              <span className="bc-kpi-label">{historicalOrdersAccess.checked && !historicalOrdersAccess.hasReadAllOrders ? "Orders synced / available" : "Total store orders"}</span>
              <span className="bc-kpi-marker" aria-hidden="true">#</span>
            </div>
            <p className="bc-kpi-value">{metrics.ordersCount.toLocaleString("en-PK")}</p>
          </article>

          <article className="bc-kpi-card bc-kpi-returns">
            <div className="bc-kpi-card-top">
              <span className="bc-kpi-label">Return requests</span>
              <span className="bc-kpi-marker" aria-hidden="true">↩</span>
            </div>
            <p className="bc-kpi-value">{metrics.returnsCount.toLocaleString("en-PK")}</p>
          </article>

          <article className="bc-kpi-card bc-kpi-exchanges">
            <div className="bc-kpi-card-top">
              <span className="bc-kpi-label">Exchange requests</span>
              <span className="bc-kpi-marker" aria-hidden="true">⇄</span>
            </div>
            <p className="bc-kpi-value">{metrics.exchangesCount.toLocaleString("en-PK")}</p>
          </article>

          <article className="bc-kpi-card bc-kpi-customers">
            <div className="bc-kpi-card-top">
              <span className="bc-kpi-label">Registered customers</span>
              <span className="bc-kpi-marker" aria-hidden="true">◎</span>
            </div>
            <p className="bc-kpi-value">{metrics.customersCount.toLocaleString("en-PK")}</p>
          </article>

          <article className="bc-kpi-card bc-kpi-revenue">
            <div className="bc-kpi-card-top">
              <span className="bc-kpi-label">Revenue retained</span>
              <span className="bc-kpi-marker" aria-hidden="true">₨</span>
            </div>
            <p className="bc-kpi-value bc-kpi-value-currency">{revenueRetained}</p>
          </article>
        </div>
      </section>

      <section className="bc-dashboard-section" aria-labelledby="bc-operations-title">
        <div className="bc-dashboard-section-heading">
          <div>
            <h2 id="bc-operations-title">Operational queue</h2>
            <p>Select a queue to review the records that need attention.</p>
          </div>
        </div>

        <div className="bc-ops-grid">
          <a className={`bc-ops-card ${operations.pendingReturns > 0 ? "has-attention" : ""}`} href="/app/returns">
            <span className="bc-ops-label">Pending returns</span>
            <span className="bc-ops-value">{operations.pendingReturns.toLocaleString("en-PK")}</span>
            <span className="bc-ops-arrow" aria-hidden="true">↗</span>
          </a>
          <a className={`bc-ops-card ${operations.pendingExchanges > 0 ? "has-attention" : ""}`} href="/app/exchanges">
            <span className="bc-ops-label">Pending exchanges</span>
            <span className="bc-ops-value">{operations.pendingExchanges.toLocaleString("en-PK")}</span>
            <span className="bc-ops-arrow" aria-hidden="true">↗</span>
          </a>
          <a className="bc-ops-card" href="/app/shipments">
            <span className="bc-ops-label">Parcels in transit</span>
            <span className="bc-ops-value">{operations.inTransit.toLocaleString("en-PK")}</span>
            <span className="bc-ops-arrow" aria-hidden="true">↗</span>
          </a>
          <a className="bc-ops-card" href="/app/warehouse">
            <span className="bc-ops-label">Awaiting inspection</span>
            <span className="bc-ops-value">{operations.awaitingInspection.toLocaleString("en-PK")}</span>
            <span className="bc-ops-arrow" aria-hidden="true">↗</span>
          </a>
          <a className={`bc-ops-card ${operations.pendingRefunds > 0 ? "has-attention" : ""}`} href="/app/refunds">
            <span className="bc-ops-label">Refunds pending</span>
            <span className="bc-ops-value">{operations.pendingRefunds.toLocaleString("en-PK")}</span>
            <span className="bc-ops-arrow" aria-hidden="true">↗</span>
          </a>
          <a className={`bc-ops-card ${operations.unreconciledCod > 0 ? "has-attention" : ""}`} href="/app/reconciliation">
            <span className="bc-ops-label">Unreconciled COD</span>
            <span className="bc-ops-value">{operations.unreconciledCod.toLocaleString("en-PK")}</span>
            <span className="bc-ops-arrow" aria-hidden="true">↗</span>
          </a>
          <a className={`bc-ops-card ${operations.failedShipments > 0 ? "has-error" : ""}`} href="/app/shipments">
            <span className="bc-ops-label">Failed shipments</span>
            <span className="bc-ops-value">{operations.failedShipments.toLocaleString("en-PK")}</span>
            <span className="bc-ops-arrow" aria-hidden="true">↗</span>
          </a>
        </div>
      </section>

      <section className="bc-dashboard-section" aria-labelledby="bc-activity-title">
        <div className="bc-dashboard-section-heading">
          <div>
            <h2 id="bc-activity-title">Recent activity</h2>
            <p>The latest return and exchange requests recorded in BYNDCART.</p>
          </div>
        </div>

        <div className="bc-activity-grid">
          <section className="bc-activity-card" aria-labelledby="bc-recent-returns-title">
            <header className="bc-activity-card-header">
              <div>
                <h3 id="bc-recent-returns-title">Recent returns</h3>
                <p>Latest return requests</p>
              </div>
              <a className="bc-text-link" href="/app/returns">View all <span aria-hidden="true">→</span></a>
            </header>

            {recentReturns.length === 0 ? (
              <div className="bc-empty-state">
                <span className="bc-empty-symbol" aria-hidden="true">↩</span>
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
              <a className="bc-text-link" href="/app/exchanges">View all <span aria-hidden="true">→</span></a>
            </header>

            {recentExchanges.length === 0 ? (
              <div className="bc-empty-state">
                <span className="bc-empty-symbol" aria-hidden="true">⇄</span>
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
