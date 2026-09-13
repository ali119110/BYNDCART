import React, { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/app.exchanges";
import { requireTenantContext } from "../utils/tenant.server";
import { getExchangeRequests, updateExchangeStatus, approveExchangeWithDraftOrder, createExchangeRequest } from "../services/exchanges.server";
import { getCustomerRiskFlagsForEmails } from "../services/fraud.server";
import { assertRateLimit } from "../utils/rateLimit.server";
import { getStoreOrders } from "../services/orders.server";
import prisma from "../db.server";

// ===== LOADER: Fetch exchanges and orders from database =====
export async function loader({ request }: Route.LoaderArgs) {
  const { shopifyStoreId } = await requireTenantContext(request);

  try {
    const [exchanges, orders] = await Promise.all([
      getExchangeRequests(shopifyStoreId),
      getStoreOrders(shopifyStoreId, 100),
    ]);
    const emails = exchanges.map((e: any) => e.customerEmail);
    const riskFlags = await getCustomerRiskFlagsForEmails(shopifyStoreId, emails);

    return { exchanges, orders, riskFlags: Object.fromEntries(riskFlags) };
  } catch (error) {
    console.error("Failed to fetch exchanges:", error);
    return { exchanges: [], orders: [], riskFlags: {} as Record<string, { flagged: boolean; reasons: string[] }> };
  }
}

// ===== ACTION: Handle status updates & manual exchange creation =====
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return { error: "Method not allowed" };
  }

  const { shopifyStoreId, admin } = await requireTenantContext(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType") as string;

  // Handle Manual Exchange Creation
  if (actionType === "CREATE_MANUAL_EXCHANGE") {
    const shopifyOrderId = formData.get("shopifyOrderId") as string;
    const itemsJson = formData.get("items") as string;

    if (!shopifyOrderId || !itemsJson) {
      return { error: "Missing required order or items for exchange creation" };
    }

    try {
      // Validate order ownership
      const order = await prisma.order.findFirst({
        where: { shopifyOrderId, shopifyStoreId },
      });

      if (!order) {
        return { error: "Order not found or does not belong to this merchant's store" };
      }

      const parsedItems = JSON.parse(itemsJson);
      if (!Array.isArray(parsedItems) || parsedItems.length === 0) {
        return { error: "At least one replacement item must be selected" };
      }

      const exchangeRequest = await createExchangeRequest({
        shopifyStoreId,
        shopifyOrderId: order.shopifyOrderId,
        orderNumber: order.orderNumber,
        customerEmail: order.customerEmail || "customer@example.com",
        customerName: order.customerName || undefined,
        items: parsedItems,
      });

      return { success: true, exchange: exchangeRequest };
    } catch (error) {
      console.error("Failed to create manual exchange:", error);
      return { error: String(error) };
    }
  }

  // Handle Status Updates
  const exchangeId = formData.get("exchangeId") as string;
  const newStatus = formData.get("status") as string;
  const newOrderNumber = formData.get("newOrderNumber") as string | null;

  if (!exchangeId || !newStatus) {
    return { error: "Missing exchangeId or status" };
  }

  try {
    if (newStatus === "APPROVED") {
      assertRateLimit(`exchange-approve:${shopifyStoreId}`, { limit: 20, windowMs: 60_000 });
    }

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
  const { exchanges: dbExchanges, orders = [], riskFlags } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  // Create Exchange Modal State
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [exchangeItems, setExchangeItems] = useState<
    Record<
      string,
      {
        originalQuantity: number;
        replacementTitle: string;
        replacementVariantId: string;
        replacementQuantity: number;
        priceDifference: number;
      }
    >
  >({});
  const [isConfirmStep, setIsConfirmStep] = useState(false);

  // Selected Order details for modal
  const selectedOrder = orders.find((o: any) => o.shopifyOrderId === selectedOrderId);
  const isSubmitting = fetcher.state !== "idle" && fetcher.formData?.get("actionType") === "CREATE_MANUAL_EXCHANGE";

  // Convert DB data to UI format
  const exchangesList = dbExchanges.map((exc: any) => ({
    id: exc.id,
    originalOrder: exc.orderNumber,
    customerName: exc.customerName || "Customer",
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
    status: exc.status,
    priceDifference: exc.items?.[0]?.priceDifference || 0,
    trackingNumber: null,
    courier: null,
    newOrderId: exc.newOrderId || null,
    newOrderNumber: exc.newOrderNumber || null,
    date: new Date(exc.createdAt).toLocaleDateString(),
    items: (exc.items || []).map((item: any) => ({
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

    if (selectedExchange?.id === id) {
      setSelectedExchange({
        ...selectedExchange,
        status: newStatus,
      });
    }
  };

  const handleOrderChange = (orderId: string) => {
    setSelectedOrderId(orderId);
    setExchangeItems({});
    setIsConfirmStep(false);
  };

  const handleToggleItem = (lineItemId: string, defaultTitle: string) => {
    setExchangeItems((prev) => {
      const next = { ...prev };
      if (next[lineItemId]) {
        delete next[lineItemId];
      } else {
        next[lineItemId] = {
          originalQuantity: 1,
          replacementTitle: `${defaultTitle} (Replacement)`,
          replacementVariantId: `gid://shopify/ProductVariant/manual`,
          replacementQuantity: 1,
          priceDifference: 0,
        };
      }
      return next;
    });
  };

  const handleItemChange = (lineItemId: string, field: string, value: any) => {
    setExchangeItems((prev) => ({
      ...prev,
      [lineItemId]: {
        ...prev[lineItemId],
        [field]: value,
      },
    }));
  };

  const handleCloseModal = () => {
    setIsCreateModalOpen(false);
    setSelectedOrderId("");
    setExchangeItems({});
    setIsConfirmStep(false);
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrder) return;

    const items = Object.entries(exchangeItems).map(([lineItemId, data]) => ({
      originalLineItemId: lineItemId,
      originalQuantity: Number(data.originalQuantity) || 1,
      replacementVariantId: data.replacementVariantId || "gid://shopify/ProductVariant/manual",
      replacementQuantity: Number(data.replacementQuantity) || 1,
      replacementTitle: data.replacementTitle || "Replacement Item",
      priceDifference: Number(data.priceDifference) || 0,
    }));

    fetcher.submit(
      {
        actionType: "CREATE_MANUAL_EXCHANGE",
        shopifyOrderId: selectedOrder.shopifyOrderId,
        items: JSON.stringify(items),
      },
      { method: "POST" }
    );

    handleCloseModal();
  };

  const isApproving = fetcher.state !== "idle" && fetcher.formData?.get("status") === "APPROVED";

  return (
    <s-page heading="Exchange Requests">
      {/* Header Bar with Create Exchange Button */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <div>
          <s-paragraph tone="neutral">Manage and create exchanges directly for customer orders.</s-paragraph>
        </div>
        <s-button variant="primary" onClick={() => setIsCreateModalOpen(true)}>
          + Create Exchange
        </s-button>
      </div>

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

      {/* Manual Create Exchange Modal */}
      {isCreateModalOpen && (
        <>
          <div
            onClick={handleCloseModal}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              backgroundColor: "rgba(0,0,0,0.4)",
              zIndex: 1000,
            }}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              width: "min(600px, 92vw)",
              maxHeight: "85vh",
              overflowY: "auto",
              backgroundColor: "#ffffff",
              borderRadius: "8px",
              boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
              zIndex: 1001,
              padding: "24px",
              display: "flex",
              flexDirection: "column",
              gap: "16px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #e1e3e5", paddingBottom: "12px" }}>
              <s-heading style={{ margin: 0 }}>
                {isConfirmStep ? "Confirm Exchange Creation" : "Create Manual Exchange"}
              </s-heading>
              <s-button variant="secondary" onClick={handleCloseModal}>Close</s-button>
            </div>

            <form onSubmit={handleCreateSubmit}>
              {!isConfirmStep ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  {/* Step 1: Select Order */}
                  <div>
                    <label style={{ display: "block", fontWeight: "bold", fontSize: "14px", marginBottom: "6px" }}>
                      Select Order *
                    </label>
                    <select
                      value={selectedOrderId}
                      onChange={(e) => handleOrderChange(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "10px",
                        borderRadius: "4px",
                        border: "1px solid #c9cccf",
                        fontSize: "14px",
                      }}
                      required
                    >
                      <option value="">-- Choose an order from store --</option>
                      {orders.map((ord: any) => (
                        <option key={ord.shopifyOrderId} value={ord.shopifyOrderId}>
                          {ord.orderNumber} - {ord.customerEmail || "No Email"} (${Number(ord.totalPrice).toFixed(2)})
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Step 2 & 3: Select Items and Replacements */}
                  {selectedOrder && (
                    <div>
                      <label style={{ display: "block", fontWeight: "bold", fontSize: "14px", marginBottom: "8px" }}>
                        Select Items to Exchange & Specify Replacements *
                      </label>

                      {((selectedOrder as any).lineItems || []).length === 0 ? (
                        <s-text tone="neutral">No items recorded in this order.</s-text>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                          {((selectedOrder as any).lineItems || []).map((li: any) => {
                            const isSelected = Boolean(exchangeItems[li.lineItemId]);
                            const itemData = exchangeItems[li.lineItemId] || {};

                            return (
                              <div
                                key={li.lineItemId}
                                style={{
                                  border: isSelected ? "2px solid #008060" : "1px solid #e1e3e5",
                                  borderRadius: "6px",
                                  padding: "12px",
                                  backgroundColor: isSelected ? "#f4f6f8" : "#ffffff",
                                }}
                              >
                                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                                  <input
                                    type="checkbox"
                                    id={`item-${li.lineItemId}`}
                                    checked={isSelected}
                                    onChange={() => handleToggleItem(li.lineItemId, li.title)}
                                    style={{ width: "18px", height: "18px", cursor: "pointer" }}
                                  />
                                  <label htmlFor={`item-${li.lineItemId}`} style={{ cursor: "pointer", flex: 1, fontWeight: 500 }}>
                                    {li.title} (${Number(li.price).toFixed(2)} ea) - Max Qty: {li.quantity}
                                  </label>
                                </div>

                                {isSelected && (
                                  <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px solid #e1e3e5", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                                    <div>
                                      <label style={{ fontSize: "12px", fontWeight: "bold", color: "#6d7175" }}>Qty to Return</label>
                                      <input
                                        type="number"
                                        min="1"
                                        max={li.quantity}
                                        value={itemData.originalQuantity}
                                        onChange={(e) => handleItemChange(li.lineItemId, "originalQuantity", Math.max(1, parseInt(e.target.value) || 1))}
                                        style={{ width: "100%", padding: "6px 8px", border: "1px solid #c9cccf", borderRadius: "4px" }}
                                      />
                                    </div>
                                    <div>
                                      <label style={{ fontSize: "12px", fontWeight: "bold", color: "#6d7175" }}>Replacement Title</label>
                                      <input
                                        type="text"
                                        value={itemData.replacementTitle}
                                        onChange={(e) => handleItemChange(li.lineItemId, "replacementTitle", e.target.value)}
                                        style={{ width: "100%", padding: "6px 8px", border: "1px solid #c9cccf", borderRadius: "4px" }}
                                      />
                                    </div>
                                    <div>
                                      <label style={{ fontSize: "12px", fontWeight: "bold", color: "#6d7175" }}>Replacement Qty</label>
                                      <input
                                        type="number"
                                        min="1"
                                        value={itemData.replacementQuantity}
                                        onChange={(e) => handleItemChange(li.lineItemId, "replacementQuantity", Math.max(1, parseInt(e.target.value) || 1))}
                                        style={{ width: "100%", padding: "6px 8px", border: "1px solid #c9cccf", borderRadius: "4px" }}
                                      />
                                    </div>
                                    <div>
                                      <label style={{ fontSize: "12px", fontWeight: "bold", color: "#6d7175" }}>Price Difference ($)</label>
                                      <input
                                        type="number"
                                        step="0.01"
                                        placeholder="0.00 (+ owed / - refund)"
                                        value={itemData.priceDifference}
                                        onChange={(e) => handleItemChange(li.lineItemId, "priceDifference", parseFloat(e.target.value) || 0)}
                                        style={{ width: "100%", padding: "6px 8px", border: "1px solid #c9cccf", borderRadius: "4px" }}
                                      />
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "12px" }}>
                    <s-button variant="secondary" onClick={handleCloseModal}>Cancel</s-button>
                    <button
                      type="button"
                      disabled={!selectedOrder || Object.keys(exchangeItems).length === 0}
                      onClick={() => setIsConfirmStep(true)}
                      style={{
                        backgroundColor: !selectedOrder || Object.keys(exchangeItems).length === 0 ? "#8c9196" : "#008060",
                        color: "#ffffff",
                        border: "none",
                        padding: "8px 16px",
                        borderRadius: "4px",
                        cursor: !selectedOrder || Object.keys(exchangeItems).length === 0 ? "not-allowed" : "pointer",
                        fontWeight: "bold"
                      }}
                    >
                      Next: Review Confirmation
                    </button>
                  </div>
                </div>
              ) : (
                /* Step 4: Confirmation */
                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <s-box padding="base" background="subdued" borderRadius="base">
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      <div><strong>Order Number:</strong> {selectedOrder?.orderNumber}</div>
                      <div><strong>Customer Email:</strong> {selectedOrder?.customerEmail || "N/A"}</div>
                      <div><strong>Status:</strong> Manual (Merchant-Created)</div>
                      <hr style={{ border: "none", borderTop: "1px solid #e1e3e5", margin: "8px 0" }} />
                      <div><strong>Exchange Items:</strong></div>
                      {Object.entries(exchangeItems).map(([lineItemId, data]) => {
                        const originalLine = (selectedOrder?.lineItems || []).find((l: any) => l.lineItemId === lineItemId);
                        return (
                          <div key={lineItemId} style={{ fontSize: "13px", paddingLeft: "10px", borderLeft: "2px solid #008060", marginBottom: "6px" }}>
                            <div>Returning: <strong>{data.originalQuantity}x {originalLine?.title || lineItemId}</strong></div>
                            <div>Replacement: <strong>{data.replacementQuantity}x {data.replacementTitle}</strong></div>
                            <div>Price Diff: <strong>{data.priceDifference >= 0 ? `+$${data.priceDifference}` : `-$${Math.abs(data.priceDifference)}`}</strong></div>
                          </div>
                        );
                      })}
                    </div>
                  </s-box>

                  <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
                    <button
                      type="button"
                      onClick={() => setIsConfirmStep(false)}
                      style={{
                        backgroundColor: "#f1f2f3",
                        color: "#202223",
                        border: "1px solid #c9cccf",
                        padding: "8px 16px",
                        borderRadius: "4px",
                        cursor: "pointer",
                      }}
                    >
                      Back to Edit
                    </button>
                    <button
                      type="submit"
                      disabled={isSubmitting}
                      style={{
                        backgroundColor: "#008060",
                        color: "#ffffff",
                        border: "none",
                        padding: "8px 16px",
                        borderRadius: "4px",
                        cursor: isSubmitting ? "not-allowed" : "pointer",
                        fontWeight: "bold",
                      }}
                    >
                      {isSubmitting ? "Saving Exchange..." : "Confirm & Save Exchange"}
                    </button>
                  </div>
                </div>
              )}
            </form>
          </div>
        </>
      )}

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
                  {selectedExchange.timeline.map((evt: any, idx: number) => (
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
