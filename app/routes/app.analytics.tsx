import React from "react";
import { useLoaderData, useSearchParams, useFetcher } from "react-router";
import type { Route } from "./+types/app.analytics";
import { requireTenantContext } from "../utils/tenant.server";
import { assertPermission } from "../services/permissions.server";
import { getAnalytics, exportFinancialCSV } from "../services/analytics.server";

// ===== LOADER: Fetch analytics from database with date-range filter =====
export async function loader({ request }: Route.LoaderArgs) {
  const { shopifyStoreId } = await requireTenantContext(request);
  const url = new URL(request.url);
  const range = url.searchParams.get("range") || "all";

  let startDate: Date | undefined;
  const now = new Date();
  if (range === "7d") {
    startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (range === "30d") {
    startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else if (range === "90d") {
    startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  }

  try {
    const analytics = await getAnalytics(shopifyStoreId, { startDate, endDate: now });
    return { analytics, range, dataAvailable: true };
  } catch (error) {
    console.error("Failed to fetch analytics:", error);
    return {
      analytics: {
        summary: {
          totalReturns: 0,
          totalExchanges: 0,
          totalRequests: 0,
          returnRequestShare: 0,
          exchangeRequestShare: 0,
          orderedUnits: 0,
          receivedReturnUnits: 0,
          unitReturnRate: null,
          totalRefunded: 0,
          confirmedRefundsByCurrency: [],
          revenueFromExchanges: 0,
          revenueRetained: 0,
        },
        returnsByStatus: [],
        exchangesByStatus: [],
        returnReasons: [],
        monthlyTrend: [],
        topReturnedProducts: [],
      },
      range,
      dataAvailable: false,
    };
  }
}

// ===== ACTION: Handle CSV Export Download =====
export async function action({ request }: Route.ActionArgs) {
  const { shopifyStoreId, session } = await requireTenantContext(request);
  // The ledger includes customer identifiers and refund/exchange financial records.
  await assertPermission(shopifyStoreId, session, "refunds");
  const csvData = await exportFinancialCSV(shopifyStoreId);

  return new Response(csvData, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="byndcart_ledger_${Date.now()}.csv"`,
    },
  });
}

export default function Analytics() {
  const { analytics, range, dataAvailable = true } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { summary, returnReasons, monthlyTrend, topReturnedProducts, returnsByStatus, exchangesByStatus } = analytics;
  const otherRefundCurrencies = (summary.confirmedRefundsByCurrency || []).filter((item: { currency: string }) => item.currency !== "PKR");
  const exportFetcher = useFetcher();

  const handleRangeChange = (newRange: string) => {
    const next = new URLSearchParams(searchParams);
    if (newRange !== "all") {
      next.set("range", newRange);
    } else {
      next.delete("range");
    }
    setSearchParams(next);
  };

  // Highest bar value across both series, used to scale the chart
  const maxTrendValue = Math.max(
    1,
    ...monthlyTrend.map((t) => Math.max(t.returnsCount, t.exchangesCount))
  );

  const maxProductReturnCount = Math.max(1, ...topReturnedProducts.map((p) => p.receivedUnits));
  const totalByStatus = (items: Array<{ status: string; count: number }>) =>
    items.reduce((total, item) => total + item.count, 0);
  const returnStatusTotal = totalByStatus(returnsByStatus || []);
  const exchangeStatusTotal = totalByStatus(exchangesByStatus || []);
  const activeStatuses = new Set(["PENDING", "APPROVED", "RECEIVED", "INSPECTED", "UNDER_REVIEW", "IN_PROGRESS"]);
  const completedStatuses = new Set(["COMPLETED", "FULFILLED", "REFUNDED"]);
  const activeQueueCount = [...(returnsByStatus || []), ...(exchangesByStatus || [])]
    .filter((item) => activeStatuses.has(String(item.status).toUpperCase()))
    .reduce((total, item) => total + item.count, 0);
  const completedRequestCount = [...(returnsByStatus || []), ...(exchangesByStatus || [])]
    .filter((item) => completedStatuses.has(String(item.status).toUpperCase()))
    .reduce((total, item) => total + item.count, 0);
  const currencyPriceDifference = (summary.revenueFromExchanges || 0).toLocaleString("en-PK", { maximumFractionDigits: 2 });

  // Top 5 reasons and top 5 products (enforce max 5)
  const displayReasons = returnReasons.slice(0, 5);
  const displayProducts = topReturnedProducts.slice(0, 5);

  return (
    <div className="bc-page bc-analytics-page">
      <header className="bc-header">
        <div className="bc-page-bar">
          <div className="bc-header-copy">
            <p className="bc-eyebrow">INSIGHTS</p>
            <h1>Analytics</h1>
            <p>Warehouse-confirmed item return rate, request mix, confirmed refund payouts, and product return units.</p>
          </div>
          <div className="bc-dashboard-controls">
            <div className="bc-range-filter" role="group" aria-label="Filter analytics date range">
              <button
                type="button"
                className={`bc-range-btn ${range === "7d" ? "active" : ""}`}
                onClick={() => handleRangeChange("7d")}
              >
                7d
              </button>
              <button
                type="button"
                className={`bc-range-btn ${range === "30d" ? "active" : ""}`}
                onClick={() => handleRangeChange("30d")}
              >
                30d
              </button>
              <button
                type="button"
                className={`bc-range-btn ${range === "90d" ? "active" : ""}`}
                onClick={() => handleRangeChange("90d")}
              >
                90d
              </button>
              <button
                type="button"
                className={`bc-range-btn ${range === "all" ? "active" : ""}`}
                onClick={() => handleRangeChange("all")}
              >
                All time
              </button>
            </div>
            <exportFetcher.Form method="POST">
              <button type="submit" className="bc-btn primary">Export CSV</button>
            </exportFetcher.Form>
          </div>
        </div>
      </header>

      <main className="bc-analytics-content">
        {!dataAvailable && (
          <div className="bc-note bad" role="alert">
            Analytics could not be loaded. The figures below are marked unavailable rather than shown as zero.
          </div>
        )}

        <section className="bc-analytics-kpi-grid" aria-label="Returns and exchanges key metrics">
          <article className="bc-analytics-metric bc-metric-blue">
            <span className="bc-kpi-label">Total requests</span>
            <strong>{dataAvailable ? summary.totalRequests.toLocaleString("en-PK") : "—"}</strong>
            <span className="bc-analytics-metric-foot">{dataAvailable ? `${summary.totalReturns} returns · ${summary.totalExchanges} exchanges` : "Unavailable"}</span>
          </article>
          <article className="bc-analytics-metric bc-metric-violet">
            <span className="bc-kpi-label">Active workflow queue</span>
            <strong>{dataAvailable ? activeQueueCount.toLocaleString("en-PK") : "—"}</strong>
            <span className="bc-analytics-metric-foot">Requests awaiting next action</span>
          </article>
          <article className="bc-analytics-metric bc-metric-green">
            <span className="bc-kpi-label">Warehouse-confirmed return ratio</span>
            <strong>{!dataAvailable ? "—" : summary.unitReturnRate === null ? "N/A" : `${summary.unitReturnRate}%`}</strong>
            <span className="bc-analytics-metric-foot">
              {dataAvailable ? `${summary.receivedReturnUnits.toLocaleString("en-PK")} received / inspected of ${summary.orderedUnits.toLocaleString("en-PK")} ordered units` : "Unavailable"}
            </span>
          </article>
          <article className="bc-analytics-metric bc-metric-amber">
            <span className="bc-kpi-label">Confirmed refunds</span>
            <strong>{dataAvailable ? `Rs. ${(summary.totalRefunded || 0).toLocaleString("en-PK")}` : "—"}</strong>
            <span className="bc-analytics-metric-foot">PKR records confirmed in BYNDCART</span>
          </article>
          <article className="bc-analytics-metric bc-metric-ink">
            <span className="bc-kpi-label">Exchange price difference</span>
            <strong>{dataAvailable ? currencyPriceDifference : "—"}</strong>
            <span className="bc-analytics-metric-foot">Completed exchanges · no FX conversion</span>
          </article>
        </section>

        <section className="bc-analytics-workflow-grid" aria-label="Request status distribution">
          <article className="bc-card bc-analytics-panel">
            <div className="bc-analytics-panel-heading">
              <div><p className="bc-eyebrow">LIFECYCLE</p><h2 className="bc-title">Return workflow</h2></div>
              <span className="bc-analytics-total">{dataAvailable ? returnStatusTotal : "—"}</span>
            </div>
            {!dataAvailable ? <p className="bc-muted">Status distribution unavailable.</p> : !(returnsByStatus || []).length ? <p className="bc-muted">No return requests in this period.</p> : (
              <div className="bc-analytics-status-list">
                {returnsByStatus.map((item) => (
                  <div className="bc-analytics-status-row" key={item.status}>
                    <div className="bc-analytics-status-copy"><span>{String(item.status).replaceAll("_", " ")}</span><strong>{item.count}</strong></div>
                    <div className="bc-analytics-progress"><span className="is-return" style={{ width: `${returnStatusTotal ? (item.count / returnStatusTotal) * 100 : 0}%` }} /></div>
                  </div>
                ))}
              </div>
            )}
          </article>
          <article className="bc-card bc-analytics-panel">
            <div className="bc-analytics-panel-heading">
              <div><p className="bc-eyebrow">LIFECYCLE</p><h2 className="bc-title">Exchange workflow</h2></div>
              <span className="bc-analytics-total">{dataAvailable ? exchangeStatusTotal : "—"}</span>
            </div>
            {!dataAvailable ? <p className="bc-muted">Status distribution unavailable.</p> : !(exchangesByStatus || []).length ? <p className="bc-muted">No exchange requests in this period.</p> : (
              <div className="bc-analytics-status-list">
                {exchangesByStatus.map((item) => (
                  <div className="bc-analytics-status-row" key={item.status}>
                    <div className="bc-analytics-status-copy"><span>{String(item.status).replaceAll("_", " ")}</span><strong>{item.count}</strong></div>
                    <div className="bc-analytics-progress"><span className="is-exchange" style={{ width: `${exchangeStatusTotal ? (item.count / exchangeStatusTotal) * 100 : 0}%` }} /></div>
                  </div>
                ))}
              </div>
            )}
          </article>
        </section>

        <section className="bc-card bc-analytics-panel">
          <div className="bc-analytics-panel-heading">
            <div>
              <p className="bc-eyebrow">VOLUME TREND</p>
              <h2 className="bc-title">Returns and exchanges over time</h2>
              <p className="bc-muted">Monthly request counts for the last six months. This chart is independent of the selected KPI range.</p>
            </div>
            <div className="bc-analytics-legend">
              <span><i className="is-return" /> Returns</span>
              <span><i className="is-exchange" /> Exchanges</span>
            </div>
          </div>
          {!dataAvailable ? <p className="bc-muted">Trend unavailable until analytics loads successfully.</p> : monthlyTrend.length === 0 ? <p className="bc-muted">No trend data yet.</p> : (
            <div className="bc-analytics-chart">
              {monthlyTrend.map((item, index) => (
                <div className="bc-analytics-month" key={`${item.month}-${index}`}>
                  <div className="bc-analytics-bars" title={`${item.month}: ${item.returnsCount} returns, ${item.exchangesCount} exchanges`}>
                    <span className="is-return" style={{ height: `${Math.max(2, item.returnsCount / maxTrendValue * 100)}%` }} />
                    <span className="is-exchange" style={{ height: `${Math.max(2, item.exchangesCount / maxTrendValue * 100)}%` }} />
                  </div>
                  <span className="bc-analytics-month-label">{item.month}</span>
                  <span className="bc-analytics-month-total">{item.returnsCount + item.exchangesCount}</span>
                </div>
              ))}
            </div>
          )}
          <p className="bc-analytics-footnote">A request count is not an item return rate. The unit ratio uses ordered units as its denominator; unfulfilled orders may still be included, and return receipts can occur after the order date range.</p>
        </section>

        <section className="bc-analytics-detail-grid">
          <article className="bc-card bc-analytics-panel">
            <div className="bc-analytics-panel-heading">
              <div><p className="bc-eyebrow">CUSTOMER EXPERIENCE</p><h2 className="bc-title">Return reasons</h2></div>
              <span className="bc-analytics-total">Top 5</span>
            </div>
            {!dataAvailable ? <p className="bc-muted">Reason data unavailable.</p> : displayReasons.length === 0 ? <p className="bc-muted">No returns recorded yet.</p> : (
              <div className="bc-analytics-status-list">
                {displayReasons.map((item, index) => (
                  <div className="bc-analytics-status-row" key={`${item.reason}-${index}`}>
                    <div className="bc-analytics-status-copy"><span>{item.reason}</span><strong>{item.count} · {item.percent}</strong></div>
                    <div className="bc-analytics-progress"><span className="is-reason" style={{ width: `${Math.min(100, Number.parseFloat(item.percent) || 0)}%` }} /></div>
                  </div>
                ))}
              </div>
            )}
          </article>
          <article className="bc-card bc-analytics-panel">
            <div className="bc-analytics-panel-heading">
              <div><p className="bc-eyebrow">PRODUCT QUALITY</p><h2 className="bc-title">Products / SKUs with returns</h2></div>
              <span className="bc-analytics-total">{dataAvailable ? displayProducts.length : "—"}</span>
            </div>
            <p className="bc-muted">Ranked by received or inspected units for orders placed in the selected period. Returns may be received later.</p>
            {!dataAvailable ? <p className="bc-muted">Product data unavailable.</p> : displayProducts.length === 0 ? <p className="bc-muted">Product return performance appears once orders and warehouse statuses have synced.</p> : (
              <div className="bc-analytics-product-list">
                {displayProducts.map((product, index) => (
                  <div className="bc-analytics-product-row" key={product.productKey || index}>
                    <div className="bc-analytics-status-copy">
                      <span className="bc-analytics-product-title">{product.title}{product.sku ? ` · SKU ${product.sku}` : ""}</span>
                      <strong>{product.unitReturnRate === null ? "Rate N/A" : `${product.unitReturnRate}%`}</strong>
                    </div>
                    <p className="bc-analytics-product-meta">{product.receivedUnits} received / inspected · {product.requestedUnits} requested · {product.orderedUnits} ordered</p>
                    <div className="bc-analytics-progress"><span className="is-return" style={{ width: `${(product.receivedUnits / maxProductReturnCount) * 100}%` }} /></div>
                  </div>
                ))}
              </div>
            )}
          </article>
        </section>
        <section className="bc-analytics-footer-note">
          <span className="bc-analytics-footer-icon" aria-hidden="true">i</span>
          <div>
            <strong>How to read these metrics</strong>
            <p>Request share compares returns and exchanges; it is not a percentage of units sold. Confirmed refunds come from BYNDCART refund records, not a direct bank feed. Exchange price difference is the stored value difference and is not converted between currencies.</p>
            {dataAvailable && otherRefundCurrencies.length > 0 && <p>Other recorded refund currencies: {otherRefundCurrencies.map((item: { currency: string; amount: number }) => `${item.currency} ${item.amount.toLocaleString()}`).join(" · ")}.</p>}
            {dataAvailable && <p>{completedRequestCount} requests are in a completed state; {activeQueueCount} are in the active workflow queue.</p>}
          </div>
        </section>
      </main>
    </div>
