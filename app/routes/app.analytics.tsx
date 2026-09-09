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
    <s-page heading="Returns & Exchanges Analytics">

      {/* Header Actions */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "16px" }}>
        <exportFetcher.Form method="POST">
          <s-button variant="primary" type="submit">
            Export Financial CSV Ledger
          </s-button>
        </exportFetcher.Form>
      </div>

      {/* Rate Metrics Cards */}
      <s-section heading="Key Rate & PKR Financial Metrics">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px", marginBottom: "20px" }}>
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="small">
              <s-text tone="neutral">Return Rate</s-text>
              <s-heading>{summary.returnRate}%</s-heading>
              <s-text tone="neutral">{summary.totalReturns} of {summary.totalRequests} requests</s-text>
            </s-stack>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="small">
              <s-text tone="neutral">Exchange Rate</s-text>
              <s-heading>{summary.exchangeRate}%</s-heading>
              <s-text tone="neutral">{summary.totalExchanges} of {summary.totalRequests} requests</s-text>
            </s-stack>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="small">
              <s-text tone="neutral">Total PKR Refunded</s-text>
              <s-heading>Rs. {(summary.totalRefunded || 0).toLocaleString()}</s-heading>
              <s-text tone="neutral">Net payout for completed returns</s-text>
            </s-stack>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="small">
              <s-text tone="neutral">Exchange Price Diff (Completed)</s-text>
              <s-heading>Rs. {(summary.revenueFromExchanges || 0).toLocaleString()}</s-heading>
              <s-text tone="neutral">Net revenue retained from exchanges</s-text>
            </s-stack>
          </s-box>
        </div>
      </s-section>

      {/* Monthly Return Trend Chart */}
      <s-section heading="Monthly Returns & Exchanges Trend">
        <div style={{ marginBottom: "20px" }}>
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="base">
              <s-paragraph>Volume of returns vs exchanges over the last 6 months.</s-paragraph>

              {monthlyTrend.length === 0 ? (
                <s-text tone="neutral">No data yet.</s-text>
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
                              background: "#5c6ac4",
                              borderRadius: "2px 2px 0 0"
                            }}
                            title={`Returns: ${t.returnsCount}`}
                          />

                          {/* Exchanges Bar */}
                          <div
                            style={{
                              width: "16px",
                              height: `${(t.exchangesCount / maxTrendValue) * 100}%`,
                              background: "#008060",
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
                      <div style={{ width: "12px", height: "12px", background: "#5c6ac4", borderRadius: "2px" }} />
                      <span>Returns</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <div style={{ width: "12px", height: "12px", background: "#008060", borderRadius: "2px" }} />
                      <span>Exchanges</span>
                    </div>
                  </div>
                </>
              )}

            </s-stack>
          </s-box>
        </div>
      </s-section>

      {/* Return Reasons Breakdown + Top Returned Products */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "16px" }}>
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-stack direction="block" gap="base">
            <s-heading>Return Reasons Analysis</s-heading>
            {returnReasons.length === 0 ? (
              <s-text tone="neutral">No returns recorded yet.</s-text>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
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
          </s-stack>
        </s-box>

        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-stack direction="block" gap="base">
            <s-heading>Top Returned Products</s-heading>
            {topReturnedProducts.length === 0 ? (
              <s-text tone="neutral">
                No data yet. This populates once orders have synced (Orders page → Sync Orders) and returns exist against them.
              </s-text>
            ) : (
              <s-stack direction="block" gap="small">
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
                          background: "#5c6ac4",
                          borderRadius: "3px",
                        }}
                      />
                    </div>
                  </div>
                ))}
              </s-stack>
            )}
          </s-stack>
        </s-box>
      </div>

    </s-page>
  );
}
