import { mockReturns, mockExchanges, mockAnalytics } from "../mocks/byndcartMocks";

export default function Dashboard() {
  const stats = mockAnalytics;
  const recentReturns = mockReturns.slice(0, 3);
  const recentExchanges = mockExchanges.slice(0, 3);

  return (
    <s-page heading="BYNDCART Dashboard">
      <s-button slot="primary-action" variant="primary" onClick={() => window.alert("Configure Shopify Admin Integration (Mock)")}>
        Sync Shopify Store
      </s-button>

      {/* Top Metrics Cards */}
      <s-section heading="Performance Overview">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px", marginBottom: "20px" }}>
          {/* Card 1 */}
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="small">
              <s-text tone="neutral">Total Returns</s-text>
              <s-heading>148</s-heading>
              <s-text tone="success">↑ 12% vs last month</s-text>
            </s-stack>
          </s-box>

          {/* Card 2 */}
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="small">
              <s-text tone="neutral">Exchanges</s-text>
              <s-heading>42</s-heading>
              <s-text tone="success">↑ 8% vs last month</s-text>
            </s-stack>
          </s-box>

          {/* Card 3 */}
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="small">
              <s-text tone="neutral">Refunds</s-text>
              <s-heading>96</s-heading>
              <s-text tone="critical">↓ 4% vs last month</s-text>
            </s-stack>
          </s-box>

          {/* Card 4 */}
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="small">
              <s-text tone="neutral">Revenue Retained</s-text>
              <s-heading>{stats.revenueRetained}</s-heading>
              <s-text tone="success">{stats.retainedPercent} retained via exchanges</s-text>
            </s-stack>
          </s-box>
        </div>
      </s-section>

      {/* Core Insights: Rates and Reasons */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "16px", marginBottom: "20px" }}>
        
        {/* Return Rate & Trend Card */}
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-stack direction="block" gap="base">
            <s-heading>SaaS Metrics</s-heading>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #f1f2f3" }}>
              <s-text>Return Rate</s-text>
              <strong>{stats.returnRate}</strong>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #f1f2f3" }}>
              <s-text>Exchange Rate</s-text>
              <strong>{stats.exchangeRate}</strong>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #f1f2f3" }}>
              <s-text>Refund Rate</s-text>
              <strong>{stats.refundRate}</strong>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0" }}>
              <s-text>Exchange Offset Ratio</s-text>
              <strong style={{ color: "#008060" }}>{stats.retainedPercent}</strong>
            </div>
          </s-stack>
        </s-box>

        {/* Return Reasons Card */}
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-stack direction="block" gap="base">
            <s-heading>Return Reasons Breakdown</s-heading>
            {stats.returnReasons.map((item, idx) => (
              <div key={idx} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "14px" }}>
                  <s-text>{item.reason}</s-text>
                  <strong>{item.count} ({item.percent})</strong>
                </div>
                {/* Horizontal Progress Bar */}
                <div style={{ width: "100%", height: "8px", background: "#f1f2f3", borderRadius: "4px", overflow: "hidden" }}>
                  <div style={{ width: item.percent, height: "100%", background: idx === 0 ? "#008060" : "#5c6ac4", borderRadius: "4px" }} />
                </div>
              </div>
            ))}
          </s-stack>
        </s-box>
      </div>

      {/* Recent Activities Section */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "16px" }}>
        
        {/* Recent Returns */}
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-stack direction="block" gap="base">
            <s-heading>Recent Returns</s-heading>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #f1f2f3", textAlign: "left" }}>
                  <th style={{ padding: "8px 0" }}><s-text tone="neutral">Order</s-text></th>
                  <th style={{ padding: "8px 0" }}><s-text tone="neutral">Customer</s-text></th>
                  <th style={{ padding: "8px 0" }}><s-text tone="neutral">Status</s-text></th>
                </tr>
              </thead>
              <tbody>
                {recentReturns.map((item) => (
                  <tr key={item.id} style={{ borderBottom: "1px solid #f9f9f9" }}>
                    <td style={{ padding: "8px 0" }}><strong>{item.orderNumber}</strong></td>
                    <td style={{ padding: "8px 0" }}>{item.customerName}</td>
                    <td style={{ padding: "8px 0" }}>
                      <s-text tone={item.status === "Pending" ? "warning" : "success"}>{item.status}</s-text>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </s-stack>
        </s-box>

        {/* Recent Exchanges */}
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-stack direction="block" gap="base">
            <s-heading>Recent Exchanges</s-heading>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #f1f2f3", textAlign: "left" }}>
                  <th style={{ padding: "8px 0" }}><s-text tone="neutral">Order</s-text></th>
                  <th style={{ padding: "8px 0" }}><s-text tone="neutral">Replacement</s-text></th>
                  <th style={{ padding: "8px 0" }}><s-text tone="neutral">Status</s-text></th>
                </tr>
              </thead>
              <tbody>
                {recentExchanges.map((item) => (
                  <tr key={item.id} style={{ borderBottom: "1px solid #f9f9f9" }}>
                    <td style={{ padding: "8px 0" }}><strong>{item.originalOrder}</strong></td>
                    <td style={{ padding: "8px 0" }}>{item.replacementItem.name.split(" - ")[0]}</td>
                    <td style={{ padding: "8px 0" }}>
                      <s-text tone={item.status === "Pending" ? "warning" : "success"}>{item.status}</s-text>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </s-stack>
        </s-box>

      </div>
    </s-page>
  );
}
