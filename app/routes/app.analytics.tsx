import React from "react";
import { useLoaderData } from "react-router";
import type { Route } from "./+types/app.analytics";
import { requireTenantContext } from "../utils/tenant.server";
import { getAnalytics, exportFinancialCSV } from "../services/analytics.server";
import { useFetcher } from "react-router";

// ===== LOADER: Fetch analytics from database =====
export async function loader({ request }: Route.LoaderArgs) {
  const { shopifyStoreId } = await requireTenantContext(request);

  try {
    const analytics = await getAnalytics(shopifyStoreId);
    return { analytics };
  } catch (error) {
    console.error("Failed to fetch analytics:", error);
    return {
      analytics: {
        summary: {
          totalReturns: 0,
          totalExchanges: 0,
          totalRequests: 0,
          returnRate: 0,
          exchangeRate: 0,
          totalRefunded: 0,
          revenueFromExchanges: 0,
        },
        returnsByStatus: [],
        exchangesByStatus: [],
        returnReasons: [],
        monthlyTrend: [],
        topReturnedProducts: [],
      },
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
  const { analytics } = useLoaderData<typeof loader>();
  const { summary, returnReasons, monthlyTrend, topReturnedProducts } = analytics;
  const exportFetcher = useFetcher();

  // Highest bar value across both series, used to scale the chart
  const maxTrendValue = Math.max(
    1,
    ...monthlyTrend.map((t) => Math.max(t.returnsCount, t.exchangesCount))
  );

  const maxProductReturnCount = Math.max(1, ...topReturnedProducts.map((p) => p.returnCount));

  return (
    <div className="bc-page">
      <header className="bc-header">
        <div className="bc-page-bar">
          <div className="bc-header-copy">
            <p className="bc-eyebrow">INSIGHTS</p>
            <h1>Analytics</h1>
            <p>Return rate, refunds, and the products shoppers send back most often.</p>
          </div>
          <exportFetcher.Form method="POST">
            <button type="submit" className="bc-btn primary">Export CSV</button>
          </exportFetcher.Form>
        </div>
      </header>

      {/* Rate Metrics Cards */}
      <section className="bc-kpi-grid">
        <article className="bc-kpi-card bc-kpi-returns">
          <span className="bc-kpi-label">Return rate</span>
          <p className="bc-kpi-value">{summary.returnRate}%</p>
          <p className="bc-muted">{summary.totalReturns} of {summary.totalRequests} requests</p>
        </article>
        <article className="bc-kpi-card bc-kpi-exchanges">
          <span className="bc-kpi-label">Exchange rate</span>
          <p className="bc-kpi-value">{summary.exchangeRate}%</p>
          <p className="bc-muted">{summary.totalExchanges} of {summary.totalRequests} requests</p>
        </article>
        <article className="bc-kpi-card">
          <span className="bc-kpi-label">Refunded</span>
          <p className="bc-kpi-value bc-kpi-value-currency">Rs. {(summary.totalRefunded || 0).toLocaleString()}</p>
          <p className="bc-muted">Completed return payouts</p>
        </article>
        <article className="bc-kpi-card bc-kpi-revenue">
          <span className="bc-kpi-label">Kept from exchanges</span>
          <p className="bc-kpi-value bc-kpi-value-currency">Rs. {(summary.revenueFromExchanges || 0).toLocaleString()}</p>
          <p className="bc-muted">Price difference on completed exchanges</p>
        </article>
      </section>

      {/* Monthly Return Trend Chart */}
      <section className="bc-card">
        <h2 className="bc-title">Last 6 months</h2>
        <p className="bc-muted">Volume of returns and exchanges.</p>
        <div>
              {monthlyTrend.length === 0 ? (
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
                              borderRadius: "2px 2px 0 0"
                            }}
                            title={`Returns: ${t.returnsCount}`}
                          />

                          {/* Exchanges Bar */}
                          <div
                            style={{
                              width: "16px",
                              height: `${(t.exchangesCount / maxTrendValue) * 100}%`,
                              background: "#16866d",
                              borderRadius: "2px 2px 0 0"
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

      {/* Return Reasons Breakdown + Top Returned Products */}
      <div className="bc-split">
        <section className="bc-card">
            <h2 className="bc-title">Return reasons</h2>
            {returnReasons.length === 0 ? (
              <p className="bc-muted">No returns recorded yet.</p>
            ) : (
              <table className="bc-table">
                <thead>
                  <tr style={{ borderBottom: "1px solid #f1f2f3", textAlign: "left" }}>
                    <th style={{ padding: "8px 0" }}><s-text tone="neutral">Reason</s-text></th>
                    <th style={{ padding: "8px 0" }}><s-text tone="neutral">Occurrences</s-text></th>
                    <th style={{ padding: "8px 0" }}><s-text tone="neutral">Share</s-text></th>
                  </tr>
                </thead>
                <tbody>
                  {returnReasons.map((item, idx) => (
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
            <h2 className="bc-title">Most returned products</h2>
            {topReturnedProducts.length === 0 ? (
              <p className="bc-muted">This fills in after orders sync and returns exist.</p>
            ) : (
              <div className="bc-stack">
                {topReturnedProducts.map((p, idx) => (
                  <div key={idx} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                      <span>{p.title}</span>
                      <strong>{p.returnCount}</strong>
                    </div>
                    <div style={{ width: "100%", height: "6px", background: "#e1e3e5", borderRadius: "3px" }}>
                      <div
                        style={{
                          width: `${(p.returnCount / maxProductReturnCount) * 100}%`,
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
