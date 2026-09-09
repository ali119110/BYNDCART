import React, { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/app.exchanges";
import { requireTenantContext } from "../utils/tenant.server";
import { getExchangeRequests, updateExchangeStatus, approveExchangeWithDraftOrder } from "../services/exchanges.server";
import { getCustomerRiskFlagsForEmails } from "../services/fraud.server";
import { assertRateLimit } from "../utils/rateLimit.server";

// ===== LOADER: Fetch exchanges from database =====
export async function loader({ request }: Route.LoaderArgs) {
  const { shopifyStoreId } = await requireTenantContext(request);

  try {
    const exchanges = await getExchangeRequests(shopifyStoreId);
    const emails = exchanges.map((e: any) => e.customerEmail);
    const riskFlags = await getCustomerRiskFlagsForEmails(shopifyStoreId, emails);

    return { exchanges, riskFlags: Object.fromEntries(riskFlags) };
  } catch (error) {
    console.error("Failed to fetch exchanges:", error);
    return { exchanges: [], riskFlags: {} as Record<string, { flagged: boolean; reasons: string[] }> };
  }
}

// ===== ACTION: Handle status updates =====
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return { error: "Method not allowed" };
  }

  const { shopifyStoreId, admin } = await requireTenantContext(request);
  const formData = await request.formData();

  const exchangeId = formData.get("exchangeId") as string;
  const newStatus = formData.get("status") as string;
  const newOrderNumber = formData.get("newOrderNumber") as string | null;

  if (!exchangeId || !newStatus) {
    return { error: "Missing exchangeId or status" };
  }

  try {
    // Draft order creation hits Shopify's Admin API — cap at 20/min per
    // store so a fast double-click or script can't hammer it.
    if (newStatus === "APPROVED") {
      assertRateLimit(`exchange-approve:${shopifyStoreId}`, { limit: 20, windowMs: 60_000 });
    }

    // Approving triggers real draft order creation in Shopify. Every other
    // transition is a plain status update.
    const updated =
      newStatus === "APPROVED"
        ? await approveExchangeWithDraftOrder(admin, exchangeId, shopifyStoreId)
        : await updateExchangeStatus(
            exchangeId,
            shopifyStoreId,
            newStatus as "PENDING" | "APPROVED" | "REJECTED" | "FULFILLED" | "COMPLETED" | "CANCELLED",
            undefined,
            newOrderNumber || undefined
          );

    return { success: true, exchange: updated };
  } catch (error) {
    console.error("Failed to update exchange:", error);
    return { error: String(error) };
  }
}

// ===== COMPONENT =====
export default function Exchanges() {
  // Load real data from database
  const { exchanges: dbExchanges, riskFlags } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  // Convert DB data to UI format
  const exchangesList = dbExchanges.map((exc: any) => ({
    id: exc.id,
    originalOrder: exc.orderNumber,
    customerName: "Customer", // Optional field in DB
    customerEmail: exc.customerEmail,
    riskFlag: riskFlags[exc.customerEmail] ?? { flagged: false, reasons: [] },
    originalItem: {
      name: exc.items?.[0]?.originalLineItemId || "Original Item",
      sku: exc.items?.[0]?.originalLineItemId || "",
    },
    replacementItem: {
      name: exc.items?.[0]?.replacementTitle || "Replacement Item",
      sku: exc.items?.[0]?.replacementVariantId || "",
    },
    status: exc.status, // PENDING, APPROVED, FULFILLED, COMPLETED, REJECTED, CANCELLED
    priceDifference: exc.items?.[0]?.priceDifference || 0,
    trackingNumber: null, // Future field
    courier: null, // Future field
    newOrderId: exc.newOrderId || null,
    newOrderNumber: exc.newOrderNumber || null,
    date: new Date(exc.createdAt).toLocaleDateString(),
    items: exc.items.map((item: any) => ({
      id: item.id,
      originalLineItemId: item.originalLineItemId,
      originalQuantity: item.originalQuantity,
      replacementVariantId: item.replacementVariantId,
      replacementQuantity: item.replacementQuantity,
      replacementTitle: item.replacementTitle,
      priceDifference: item.priceDifference,
    })),
    timeline: [
      {
        status: exc.status,
        title: `Exchange ${exc.status}`,
        description: `Status is currently ${exc.status}`,
        date: new Date(exc.updatedAt).toLocaleString(),
      },
    ],
  }));

  // Local state for interactive features
  const [selectedExchange, setSelectedExchange] = useState<(typeof exchangesList)[0] | null>(null);

  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");

  // Filtering
  const filteredExchanges = exchangesList.filter((item) => {
    const matchesSearch =
      item.originalOrder.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.customerEmail.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.id.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus = statusFilter === "All" || item.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  // Status Action Handler (submit to server)
  const handleUpdateStatus = (id: string, newStatus: string) => {
    fetcher.submit(
      { exchangeId: id, status: newStatus },
      { method: "POST" }
    );

    // Optimistically update the selected exchange status
    if (selectedExchange?.id === id) {
      setSelectedExchange({
        ...selectedExchange,
        status: newStatus,
      });
    }
  };

  const isApproving = fetcher.state !== "idle" && fetcher.formData?.get("status") === "APPROVED";

  return (
    <s-page heading="Exchange Requests">

      <div style={{ marginBottom: "16px" }}>
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
            <div style={{ flex: "1" }}>
              <input
                type="text"
                placeholder="Search by ID, original order, or customer name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  border: "1px solid #c9cccf",
                  borderRadius: "4px",
                  fontSize: "14px"
                }}
              />
            </div>
            <div>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                style={{
                  padding: "8px 12px",
                  border: "1px solid #c9cccf",
                  borderRadius: "4px",
                  fontSize: "14px"
                }}
              >
                <option value="All">All Statuses</option>
                <option value="PENDING">Pending</option>
                <option value="APPROVED">Approved</option>
                <option value="FULFILLED">Fulfilled</option>
                <option value="COMPLETED">Completed</option>
                <option value="REJECTED">Rejected</option>
                <option value="CANCELLED">Cancelled</option>
              </select>
            </div>
          </div>
        </s-box>
      </div>

      {/* Main Table */}
      <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
        {filteredExchanges.length === 0 ? (
          <s-stack direction="block" gap="base">
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 0", width: "100%" }}>
              <s-heading>No Exchange Requests Found</s-heading>
              <s-paragraph tone="neutral">Refine your search or filters.</s-paragraph>
            </div>
          </s-stack>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                  <th style={{ padding: "12px 8px" }}><s-text tone="neutral">Exchange ID</s-text></th>
                  <th style={{ padding: "12px 8px" }}><s-text tone="neutral">Original Order</s-text></th>
                  <th style={{ padding: "12px 8px" }}><s-text tone="neutral">Customer</s-text></th>
                  <th style={{ padding: "12px 8px" }}><s-text tone="neutral">Original Item</s-text></th>
                  <th style={{ padding: "12px 8px" }}><s-text tone="neutral">Replacement Item</s-text></th>
                  <th style={{ padding: "12px 8px" }}><s-text tone="neutral">Status</s-text></th>
                  <th style={{ padding: "12px 8px" }}><s-text tone="neutral">Date</s-text></th>
                  <th style={{ padding: "12px 8px", textAlign: "right" }}><s-text tone="neutral">Action</s-text></th>
                </tr>
              </thead>
              <tbody>
                {filteredExchanges.map((exc) => (
                  <tr
                    key={exc.id}
                    onClick={() => setSelectedExchange(exc)}
                    style={{
                      borderBottom: "1px solid #f1f2f3",
                      cursor: "pointer",
                      backgroundColor: selectedExchange?.id === exc.id ? "#f4f6f8" : "transparent"
                    }}
                    className="hover-row"
                  >
                    <td style={{ padding: "12px 8px" }}><strong>{exc.id.substring(0, 8)}</strong></td>
                    <td style={{ padding: "12px 8px" }}>{exc.originalOrder}</td>
                    <td style={{ padding: "12px 8px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <div style={{ fontWeight: "bold" }}>{exc.customerName}</div>
                        {exc.riskFlag.flagged && (
                          <span
                            title={exc.riskFlag.reasons.join("; ")}
                            style={{
                              fontSize: "11px",
                              fontWeight: "bold",
                              color: "#8e1f0b",
                              background: "#fed3d1",
                              padding: "1px 6px",
                              borderRadius: "10px",
                            }}
                          >
                            ⚠ Flagged
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: "12px", color: "#6d7175" }}>{exc.customerEmail}</div>
                    </td>
                    <td style={{ padding: "12px 8px" }}>{exc.originalItem.name.split(" - ")[0]}</td>
                    <td style={{ padding: "12px 8px" }}>{exc.replacementItem.name.split(" - ")[0]}</td>
                    <td style={{ padding: "12px 8px" }}>
                      <s-text tone={
                        exc.status === "COMPLETED" || exc.status === "APPROVED" || exc.status === "FULFILLED"
                          ? "success"
                          : exc.status === "PENDING"
                          ? "warning"
                          : "critical"
                      }>
                        {exc.status}
                      </s-text>
                    </td>
                    <td style={{ padding: "12px 8px" }}>{exc.date}</td>
                    <td style={{ padding: "12px 8px", textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                      <s-button onClick={() => setSelectedExchange(exc)}>View Workflow</s-button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </s-box>

      {/* Slide-out Exchange Workflow Drawer */}
      {selectedExchange && (
        <>
          {/* Backdrop wrapper */}
          <div
            onClick={() => setSelectedExchange(null)}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              backgroundColor: "rgba(0,0,0,0.3)",
              zIndex: 999
            }}
          />

          {/* Drawer container */}
          <div
            style={{
              position: "fixed",
              top: 0,
              right: 0,
              width: "min(460px, 100%)",
              height: "100%",
              backgroundColor: "#ffffff",
              boxShadow: "-4px 0 12px rgba(0,0,0,0.15)",
              zIndex: 1000,
              padding: "24px",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: "20px",
              borderLeft: "1px solid #c9cccf"
            }}
          >
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #f1f2f3", paddingBottom: "12px" }}>
              <div>
                <s-text tone="neutral">Exchange Workflow</s-text>
                <s-heading>{selectedExchange.id.substring(0, 12)}</s-heading>
              </div>
              <s-button variant="secondary" onClick={() => setSelectedExchange(null)}>
                Close
              </s-button>
            </div>

            {/* Fraud Risk Banner */}
            {selectedExchange.riskFlag.flagged && (
              <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <s-text tone="critical"><strong>⚠ Customer Flagged for Review</strong></s-text>
                  {selectedExchange.riskFlag.reasons.map((reason: string, idx: number) => (
                    <s-text key={idx} tone="neutral">{reason}</s-text>
                  ))}
                </div>
              </s-box>
            )}

            {/* Visual Workflow Steps diagram */}
            <div>
              <h3 style={{ margin: "0 0 8px 0", fontSize: "14px", fontWeight: "bold", textTransform: "uppercase", color: "#6d7175" }}>Exchange Progression</h3>
              <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>

                  {/* Step 1: Original Item */}
                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <div style={{ width: "24px", height: "24px", borderRadius: "50%", background: "#e1e3e5", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px" }}>1</div>
                    <div>
                      <div style={{ fontSize: "11px", color: "#6d7175" }}>Original Item</div>
                      <strong>{selectedExchange.originalItem.name}</strong>
                    </div>
                  </div>

                  <div style={{ paddingLeft: "11px", borderLeft: "2px dashed #e1e3e5", height: "16px", marginLeft: "11px" }} />

                  {/* Step 2: Replacement Item */}
                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <div style={{ width: "24px", height: "24px", borderRadius: "50%", background: "#5c6ac4", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px" }}>2</div>
                    <div>
                      <div style={{ fontSize: "11px", color: "#6d7175" }}>Requested Replacement</div>
                      <strong>{selectedExchange.replacementItem.name}</strong>
                    </div>
                  </div>

                  <div style={{ paddingLeft: "11px", borderLeft: "2px dashed #e1e3e5", height: "16px", marginLeft: "11px" }} />

                  {/* Step 3: Shipment */}
                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <div style={{
                      width: "24px",
                      height: "24px",
                      borderRadius: "50%",
                      background: selectedExchange.trackingNumber ? "#008060" : "#e1e3e5",
                      color: selectedExchange.trackingNumber ? "#fff" : "#000",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "12px"
                    }}>3</div>
                    <div>
                      <div style={{ fontSize: "11px", color: "#6d7175" }}>Replacement Shipment</div>
                      <strong>
                        {selectedExchange.trackingNumber
                          ? `${selectedExchange.courier} (${selectedExchange.trackingNumber})`
                          : "Awaiting approval / return receipt"
                        }
                      </strong>
                    </div>
                  </div>

                </div>
              </s-box>
            </div>

            {/* Draft Order (created on Approve) */}
            {selectedExchange.newOrderNumber && (
              <div>
                <h3 style={{ margin: "0 0 8px 0", fontSize: "14px", fontWeight: "bold", textTransform: "uppercase", color: "#6d7175" }}>Shopify Draft Order</h3>
                <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <s-text>Draft order created:</s-text>
                    <strong>{selectedExchange.newOrderNumber}</strong>
                  </div>
                </s-box>
              </div>
            )}

            {/* Price difference */}
            <div>
              <h3 style={{ margin: "0 0 8px 0", fontSize: "14px", fontWeight: "bold", textTransform: "uppercase", color: "#6d7175" }}>Price Difference</h3>
              <s-box padding="base" background={selectedExchange.priceDifference >= 0 ? "subdued" : "transparent"} borderRadius="base">
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <s-text>Balance:</s-text>
                  <strong>
                    {selectedExchange.priceDifference === 0
                      ? "Even Exchange ($0.00)"
                      : selectedExchange.priceDifference > 0
                      ? `Customer Owed +$${selectedExchange.priceDifference.toFixed(2)}`
                      : `Refund Customer $${Math.abs(selectedExchange.priceDifference).toFixed(2)}`
                    }
                  </strong>
                </div>
              </s-box>
            </div>

            {/* Actions */}
            <div>
              <h3 style={{ margin: "0 0 8px 0", fontSize: "14px", fontWeight: "bold", textTransform: "uppercase", color: "#6d7175" }}>Actions</h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "4px" }}>
                {selectedExchange.status === "PENDING" ? (
                  <>
                    <s-button variant="primary" disabled={isApproving} onClick={() => handleUpdateStatus(selectedExchange.id, "APPROVED")}>
                      {isApproving ? "Creating Draft Order..." : "Approve & Draft Order"}
                    </s-button>
                    <s-button variant="secondary" tone="critical" onClick={() => handleUpdateStatus(selectedExchange.id, "REJECTED")}>
                      Reject
                    </s-button>
                  </>
                ) : selectedExchange.status === "APPROVED" ? (
                  <s-button variant="primary" onClick={() => handleUpdateStatus(selectedExchange.id, "FULFILLED")}>
                    Dispatch Replacement (In Transit)
                  </s-button>
                ) : selectedExchange.status === "FULFILLED" ? (
                  <s-button variant="primary" onClick={() => handleUpdateStatus(selectedExchange.id, "COMPLETED")}>
                    Mark Complete
                  </s-button>
                ) : (
                  <s-text tone="neutral">Exchange closed.</s-text>
                )}
              </div>
              {fetcher.data?.error && (
                <s-text tone="critical">{fetcher.data.error}</s-text>
              )}
            </div>

            {/* Timeline */}
            <div>
              <h3 style={{ margin: "0 0 8px 0", fontSize: "14px", fontWeight: "bold", textTransform: "uppercase", color: "#6d7175" }}>Activity History</h3>
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="base">
                  {selectedExchange.timeline.map((evt, idx) => (
                    <div key={idx} style={{ display: "flex", gap: "12px", borderLeft: "2px solid #e1e3e5", paddingLeft: "12px", position: "relative" }}>
                      <div style={{
                        position: "absolute",
                        left: "-6px",
                        top: "2px",
                        width: "10px",
                        height: "10px",
                        borderRadius: "50%",
                        backgroundColor: idx === 0 ? "#5c6ac4" : "#c9cccf"
                      }} />
                      <div style={{ display: "flex", flexDirection: "column" }}>
                        <strong style={{ fontSize: "13px" }}>{evt.title}</strong>
                        <span style={{ fontSize: "12px", color: "#6d7175" }}>{evt.description}</span>
                        <span style={{ fontSize: "11px", color: "#8c9196", marginTop: "2px" }}>{evt.date}</span>
                      </div>
                    </div>
                  ))}
                </s-stack>
              </s-box>
            </div>

          </div>
        </>
      )}

      <style>{`
        .hover-row:hover {
          background-color: #f9fafb !important;
        }
      `}</style>

    </s-page>
  );
}
