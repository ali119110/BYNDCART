import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { useState } from "react";
import { requireTenantContext } from "../services/tenant.server";
import { getStoreCustomers, CustomerMetrics } from "../services/customers.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopifyStoreId } = await requireTenantContext(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("search") || "";

  const customers = await getStoreCustomers(shopifyStoreId, search);
  return { customers, search };
};

export default function Customers() {
  const { customers, search } = useLoaderData<typeof loader>();
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerMetrics | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const handleSearchChange = (value: string) => {
    const newParams = new URLSearchParams(searchParams);
    if (value) {
      newParams.set("search", value);
    } else {
      newParams.delete("search");
    }
    setSearchParams(newParams);
  };

  return (
    <s-page heading="Customer Metrics & Return Risk Intelligence">
      <div style={{ marginBottom: "16px" }}>
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <input
            type="text"
            placeholder="Search by customer name or email..."
            defaultValue={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            style={{
              width: "100%",
              padding: "8px 12px",
              border: "1px solid #c9cccf",
              borderRadius: "4px",
              fontSize: "14px",
            }}
          />
        </s-box>
      </div>

      <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
        {customers.length === 0 ? (
          <s-stack direction="block" gap="base">
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 0", width: "100%" }}>
              <s-heading>No Customer Records Found</s-heading>
              <s-paragraph tone="neutral">Customer profiles compile automatically as orders and return requests are received.</s-paragraph>
            </div>
          </s-stack>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                <th style={{ padding: "12px 8px" }}><s-text tone="neutral">Customer</s-text></th>
                <th style={{ padding: "12px 8px" }}><s-text tone="neutral">Orders</s-text></th>
                <th style={{ padding: "12px 8px" }}><s-text tone="neutral">Returns</s-text></th>
                <th style={{ padding: "12px 8px" }}><s-text tone="neutral">Exchanges</s-text></th>
                <th style={{ padding: "12px 8px" }}><s-text tone="neutral">Total Refunded (PKR)</s-text></th>
                <th style={{ padding: "12px 8px" }}><s-text tone="neutral">Return Rate</s-text></th>
                <th style={{ padding: "12px 8px" }}><s-text tone="neutral">Risk Profile</s-text></th>
                <th style={{ padding: "12px 8px", textAlign: "right" }}><s-text tone="neutral">Action</s-text></th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c: CustomerMetrics) => (
                <tr
                  key={c.id}
                  onClick={() => setSelectedCustomer(c)}
                  style={{
                    borderBottom: "1px solid #f1f2f3",
                    cursor: "pointer",
                    backgroundColor: selectedCustomer?.id === c.id ? "#f4f6f8" : "transparent",
                  }}
                >
                  <td style={{ padding: "12px 8px" }}>
                    <div style={{ fontWeight: "bold" }}>{c.name}</div>
                    <div style={{ fontSize: "12px", color: "#6d7175" }}>{c.email}</div>
                  </td>
                  <td style={{ padding: "12px 8px" }}>{c.ordersCount}</td>
                  <td style={{ padding: "12px 8px" }}>{c.returnsCount}</td>
                  <td style={{ padding: "12px 8px" }}>{c.exchangesCount}</td>
                  <td style={{ padding: "12px 8px" }}>
                    <strong>Rs. {(c.totalRefundedPKR ?? 0).toLocaleString()}</strong>
                  </td>
                  <td style={{ padding: "12px 8px" }}>
                    <s-text tone={parseFloat(c.returnRate) > 30 ? "critical" : "neutral"}>
                      {c.returnRate}
                    </s-text>
                  </td>
                  <td style={{ padding: "12px 8px" }}>
                    <s-badge tone={c.riskFlag?.flagged ? "critical" : "success"}>
                      {c.riskFlag?.flagged ? "High Return Risk" : "Low Risk"}
                    </s-badge>
                  </td>
                  <td style={{ padding: "12px 8px", textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                    <s-button onClick={() => setSelectedCustomer(c)}>View Details</s-button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </s-box>

      {/* Customer Detail Drawer */}
      {selectedCustomer && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            backgroundColor: "rgba(0,0,0,0.4)",
            display: "flex",
            justifyContent: "flex-end",
            zIndex: 1000,
          }}
          onClick={() => setSelectedCustomer(null)}
        >
          <div
            style={{
              width: "480px",
              height: "100%",
              backgroundColor: "#fff",
              padding: "24px",
              boxSizing: "border-box",
              overflowY: "auto",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <s-heading>{selectedCustomer.name}</s-heading>
              <s-button onClick={() => setSelectedCustomer(null)}>Close</s-button>
            </div>

            <s-paragraph tone="neutral">{selectedCustomer.email}</s-paragraph>

            <div style={{ margin: "16px 0" }}>
              <s-badge tone={selectedCustomer.riskFlag?.flagged ? "critical" : "success"}>
                {selectedCustomer.riskFlag?.flagged ? "High Risk Account" : "Standard Account"}
              </s-badge>
            </div>

            {selectedCustomer.riskFlag?.reasons && selectedCustomer.riskFlag.reasons.length > 0 && (
              <div style={{ marginBottom: "16px" }}>
                <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
                  <strong>Risk Flag Reasons:</strong>
                  <ul style={{ margin: "8px 0 0 16px", padding: 0 }}>
                    {selectedCustomer.riskFlag.reasons.map((r: string, i: number) => (
                      <li key={i} style={{ fontSize: "13px", color: "#d72c0d" }}>
                        {r}
                      </li>
                    ))}
                  </ul>
                </s-box>
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "20px" }}>
              <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
                <div style={{ fontSize: "12px", color: "#6d7175" }}>Total Orders</div>
                <div style={{ fontSize: "18px", fontWeight: "bold" }}>{selectedCustomer.ordersCount}</div>
              </s-box>
              <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
                <div style={{ fontSize: "12px", color: "#6d7175" }}>Return Rate</div>
                <div style={{ fontSize: "18px", fontWeight: "bold" }}>{selectedCustomer.returnRate}</div>
              </s-box>
              <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
                <div style={{ fontSize: "12px", color: "#6d7175" }}>Returns / Exchanges</div>
                <div style={{ fontSize: "18px", fontWeight: "bold" }}>
                  {selectedCustomer.returnsCount} / {selectedCustomer.exchangesCount}
                </div>
              </s-box>
              <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
                <div style={{ fontSize: "12px", color: "#6d7175" }}>Total Refunded</div>
                <div style={{ fontSize: "18px", fontWeight: "bold" }}>Rs. {(selectedCustomer.totalRefundedPKR ?? 0).toLocaleString()}</div>
              </s-box>
            </div>

            <s-heading>Recent Returns History</s-heading>
            <div style={{ marginTop: "8px" }}>
              {(!selectedCustomer.recentReturns || selectedCustomer.recentReturns.length === 0) ? (
                <s-paragraph tone="neutral">No return requests on file.</s-paragraph>
              ) : (
                selectedCustomer.recentReturns.map((r: any) => (
                  <div key={r.id} style={{ padding: "8px 0", borderBottom: "1px solid #f1f2f3" }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <strong>{r.orderNumber}</strong>
                      <s-badge tone={r.status === "APPROVED" ? "success" : "warning"}>{r.status}</s-badge>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </s-page>
  );
}
