import React from "react";
import { useLoaderData, useSearchParams, useFetcher } from "react-router";
import type { Route } from "./+types/app.analytics";
import { requireTenantContext } from "../utils/tenant.server";
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
  const { shopifyStoreId } = await requireTenantContext(request);
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
  const { summary, returnReasons, monthlyTrend, topReturnedProducts } = analytics;
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

  const maxProductReturnCount = Math.max(1, ...topReturnedProducts.map((p) => p.requestedUnits));

  // Top 5 reasons and top 5 products (enforce max 5)
  const displayReasons = returnReasons.slice(0, 5);
  const displayProducts = topReturnedProducts.slice(0, 5);

  return (
    <div className="bc-page">
      <header className="bc-header">
        <div className="bc-page-bar">
          <div className="bc-header-copy">
            <p className="bc-eyebrow">INSIGHTS</p>
            <h1>Analytics</h1>
            <p>Request mix, confirmed refund payouts, and products with the most return units requested.</p>
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

      {/* Rate Metrics Cards */}
      <section className="bc-kpi-grid">
        <article className="bc-kpi-card bc-kpi-returns">
          <span className="bc-kpi-label">Return request share</span>
          <p className="bc-kpi-value">{dataAvailable ? summary.returnRequestShare + "%" : "—"}</p>
          <p className="bc-muted">{dataAvailable ? summary.totalReturns + " of " + summary.totalRequests + " requests · request mix, not unit return rate" : "Unavailable"}</p>
        </article>
        <article className="bc-kpi-card bc-kpi-exchanges">
          <span className="bc-kpi-label">Exchange request share</span>
          <p className="bc-kpi-value">{dataAvailable ? summary.exchangeRequestShare + "%" : "—"}</p>
          <p className="bc-muted">{dataAvailable ? summary.totalExchanges + " of " + summary.totalRequests + " requests · request mix" : "Unavailable"}</p>
        </article>
        <article className="bc-kpi-card">
          <span className="bc-kpi-label">Confirmed refunds (PKR)</span>
          <p className="bc-kpi-value bc-kpi-value-currency">{dataAvailable ? "Rs. " + (summary.totalRefunded || 0).toLocaleString("en-PK") : "—"}</p>
          <p className="bc-muted">Confirmed refund records only</p>
          {dataAvailable && otherRefundCurrencies.length > 0 && (
            <p className="bc-muted">{otherRefundCurrencies.map((item: { currency: string; amount: number }) => item.currency + " " + item.amount.toLocaleString()).join(" · ")} in other currencies</p>
          )}
        </article>
        <article className="bc-kpi-card bc-kpi-revenue">
          <span className="bc-kpi-label">Recorded exchange price difference</span>
          <p className="bc-kpi-value bc-kpi-value-currency">{dataAvailable ? (summary.revenueFromExchanges || 0).toLocaleString("en-PK") : "—"}</p>
          <p className="bc-muted">Completed exchanges; currency is not stored per item and no conversion is applied</p>
        </article>
      </section>

      {/* Monthly Return Trend Chart */}
      <section className="bc-card">
        <h2 className="bc-title">Last 6 months</h2>
        <p className="bc-muted">Monthly return and exchange requests. This trend is independent of the selected KPI date range.</p>
        {!dataAvailable && <p className="bc-note warn" role="alert">Analytics could not be loaded. The displayed figures are unavailable, not zero.</p>}
        <div>
          {!dataAvailable ? (
            <p className="bc-muted">Trend unavailable until analytics loads successfully.</p>
          ) : monthlyTrend.length === 0 ? (
            <p className="bc-muted">No data yet.</p>
          ) : (
            <>
              {/* Bar Chart Container */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", height: "200px", padding: "20px 10px 10px 10px", borderBottom: "2px solid #e1e3e5" }}>
                {monthlyTrend.map((t, idx) => (
                  <div key={idx} style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "12%", gap: "8px" }}>
                    <div style={{ display: "flex", gap: "4px", width: "100%", height: "140px", alignItems: "flex-end", justifyContent: "center" }}>
                      {/* Returns Bar */}
                      <div
                        style={{
                          width: "16px",
                          height: `${(t.returnsCount / maxTrendValue) * 100}%`,
                          background: "#263f8c",
                          borderRadius: "2px 2px 0 0",
                        }}
                        title={`Returns: ${t.returnsCount}`}
                      />
                      {/* Exchanges Bar */}
                      <div
                        style={{
                          width: "16px",
                          height: `${(t.exchangesCount / maxTrendValue) * 100}%`,
                          background: "#16866d",
                          borderRadius: "2px 2px 0 0",
                        }}
                        title={`Exchanges: ${t.exchangesCount}`}
                      />
                    </div>
                    <strong style={{ fontSize: "12px" }}>{t.month}</strong>
                  </div>
                ))}
              </div>

              {/* Chart Legend */}
              <div style={{ display: "flex", gap: "16px", fontSize: "13px", justifyContent: "center", marginTop: "8px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <div style={{ width: "12px", height: "12px", background: "#263f8c", borderRadius: "2px" }} />
                  <span>Returns</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <div style={{ width: "12px", height: "12px", background: "#16866d", borderRadius: "2px" }} />
                  <span>Exchanges</span>
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      {/* Top 5 Return Reasons Breakdown + Top 5 Products by Return Units Requested */}
      <div className="bc-split">
        <section className="bc-card">
          <h2 className="bc-title">Top 5 Return Reasons</h2>
          {!dataAvailable ? (
            <p className="bc-muted">Return reasons unavailable until analytics loads successfully.</p>
          ) : displayReasons.length === 0 ? (
            <p className="bc-muted">No returns recorded yet.</p>
          ) : (
            <table className="bc-table">
              <thead>
                <tr style={{ borderBottom: "1px solid #f1f2f3", textAlign: "left" }}>
                  <th style={{ padding: "8px 0" }}>Reason</th>
                  <th style={{ padding: "8px 0" }}>Occurrences</th>
                  <th style={{ padding: "8px 0" }}>Share</th>
                </tr>
              </thead>
              <tbody>
                {displayReasons.map((item, idx) => (
                  <tr key={idx} style={{ borderBottom: "1px solid #f9f9f9" }}>
                    <td style={{ padding: "8px 0" }}>{item.reason}</td>
                    <td style={{ padding: "8px 0" }}>{item.count}</td>
                    <td style={{ padding: "8px 0" }}>
                      <strong>{item.percent}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="bc-card">
          <h2 className="bc-title">Top 5 Most-Returned Products</h2>
          {!dataAvailable ? (
            <p className="bc-muted">Product data unavailable until analytics loads successfully.</p>
          ) : displayProducts.length === 0 ? (
            <p className="bc-muted">This fills in after orders sync and return requests exist.</p>
          ) : (
            <div className="bc-stack">
              {displayProducts.map((p, idx) => (
                <div key={idx} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                    <span>{p.title}</span>
                    <strong>{p.requestedUnits} {p.requestedUnits === 1 ? "requested unit" : "requested units"}</strong>
                  </div>
                  <div style={{ width: "100%", height: "6px", background: "#e1e3e5", borderRadius: "3px" }}>
                    <div
                      style={{
                        width: `${(p.requestedUnits / maxProductReturnCount) * 100}%`,
                        height: "100%",
                        background: "#263f8c",
                        borderRadius: "3px",
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
