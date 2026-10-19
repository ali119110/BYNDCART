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
  const [riskFilter, setRiskFilter] = useState("ALL");
  const visibleCustomers = customers.filter((customer) => {
    if (riskFilter === "HIGH") return customer.riskFlag?.flagged;
    if (riskFilter === "LOW") return !customer.riskFlag?.flagged;
    return true;
  });
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
    <div className="bc-page">
      <header className="bc-header">
        <div className="bc-header-copy">
          <p className="bc-eyebrow">CUSTOMERS</p>
          <h1>Customer risk</h1>
          <p>See order history, refund totals, and which shoppers are flagged for review.</p>
        </div>
      </header>
      <section className="bc-card bc-toolbar">
        <label className="bc-field-label">
          Risk
          <select value={riskFilter} onChange={(event) => setRiskFilter(event.target.value)}>
            <option value="ALL">All customers</option>
            <option value="HIGH">High risk</option>
            <option value="LOW">Low risk</option>
          </select>
        </label>
        <div className="bc-grow">
          <input
            type="text"
            placeholder="Search by customer name or email"
            defaultValue={search}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
        </div>
      </section>

      <section className="bc-table-wrap">
        {visibleCustomers.length === 0 ? (
          <div className="bc-empty-state">
            <strong>No customers yet</strong>
            <p>Profiles appear after orders and return requests are recorded.</p>
          </div>
        ) : (
          <table className="bc-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Orders</th>
                <th>Returns</th>
                <th>Exchanges</th>
                <th>Refunded</th>
                <th>Return rate</th>
                <th>Risk</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visibleCustomers.map((c: CustomerMetrics) => (
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
                    <span className={parseFloat(c.returnRate) > 30 ? "bc-badge bad" : "bc-badge"}>{c.returnRate}</span>
                  </td>
                  <td style={{ padding: "12px 8px" }}>
                    <span className={c.riskFlag?.flagged ? "bc-badge bad" : "bc-badge ok"}>
                      {c.riskFlag?.flagged ? "High risk" : "Low risk"}
                    </span>
                  </td>
                  <td style={{ padding: "12px 8px", textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="bc-btn" onClick={() => setSelectedCustomer(c)}>View</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

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
              <h2 className="bc-title">{selectedCustomer.name}</h2>
              <button type="button" className="bc-btn" onClick={() => setSelectedCustomer(null)}>Close</button>
            </div>

            <p className="bc-muted">{selectedCustomer.email}</p>
            <div style={{ margin: "16px 0" }}>
              <span className={selectedCustomer.riskFlag?.flagged ? "bc-badge bad" : "bc-badge ok"}>
                {selectedCustomer.riskFlag?.flagged ? "High risk" : "Low risk"}
              </span>
            </div>

            {selectedCustomer.riskFlag?.reasons && selectedCustomer.riskFlag.reasons.length > 0 && (
              <div style={{ marginBottom: "16px" }}>
                <div className="bc-note bad">
                  <span>Review reasons</span>
                  <ul style={{ margin: "8px 0 0 16px", padding: 0 }}>
                    {selectedCustomer.riskFlag.reasons.map((r: string, i: number) => (
                      <li key={i} style={{ fontSize: "13px", color: "#d72c0d" }}>
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "20px" }}>
              <article className="bc-kpi-card"><span className="bc-kpi-label">Orders</span><p className="bc-kpi-value">{selectedCustomer.ordersCount}</p></article>
              <article className="bc-kpi-card"><span className="bc-kpi-label">Return rate</span><p className="bc-kpi-value">{selectedCustomer.returnRate}</p></article>
              <article className="bc-kpi-card"><span className="bc-kpi-label">Returns / exchanges</span><p className="bc-kpi-value">{selectedCustomer.returnsCount} / {selectedCustomer.exchangesCount}</p></article>
              <article className="bc-kpi-card"><span className="bc-kpi-label">Refunded</span><p className="bc-kpi-value">Rs. {(selectedCustomer.totalRefundedPKR ?? 0).toLocaleString()}</p></article>
            </div>

            <h3 className="bc-title">Recent history</h3>
            <div style={{ marginTop: "8px" }}>
              {(!selectedCustomer.recentReturns || selectedCustomer.recentReturns.length === 0) ? (
                <p className="bc-muted">No return requests on file.</p>
              ) : (
                selectedCustomer.recentReturns.map((r: any) => (
                  <div key={r.id} style={{ padding: "8px 0", borderBottom: "1px solid #f1f2f3" }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <strong>{r.orderNumber}</strong>
                      <span className={r.status === "APPROVED" ? "bc-badge ok" : "bc-badge warn"}>{r.status}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
