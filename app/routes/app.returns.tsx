import React, { useEffect, useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/app.returns";
import { requireTenantContext } from "../utils/tenant.server";
import prisma from "../db.server";
import { getReturnRequests, updateReturnRequestStatus, createReturnRequest } from "../services/returns.server";
import { getCustomerRiskFlagsForEmails } from "../services/fraud.server";
import { searchOrSyncOrders } from "../services/orders.server";
import { describeAuditEvent } from "../utils/auditSentence";

// ===== LOADER: Fetch returns and store orders from database =====
export async function loader({ request }: Route.LoaderArgs) {
  const { shopifyStoreId } = await requireTenantContext(request);

  try {
    const returns = await getReturnRequests(shopifyStoreId);
    const emails = returns.map((r) => r.customerEmail);
    const riskFlags = await getCustomerRiskFlagsForEmails(shopifyStoreId, emails);

    return {
      returns,
      orders: [],
      // Map isn't serializable across the loader boundary, convert to plain object
      riskFlags: Object.fromEntries(riskFlags),
    };
  } catch (error) {
    console.error("Failed to fetch returns or orders:", error);
    return { returns: [], orders: [], riskFlags: {} as Record<string, { flagged: boolean; reasons: string[] }> };
  }
}

// ===== ACTION: Handle status updates & manual return creation =====
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return { error: "Method not allowed" };
  }

  const { shopifyStoreId, admin } = await requireTenantContext(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType") as string;

  if (actionType === "SEARCH_ORDERS") {
    const query = String(formData.get("query") || "").trim();
    if (query.length < 2) return { query, orders: [] };
    try {
      return { query, orders: await searchOrSyncOrders({ shopifyStoreId, admin, query }) };
    } catch (error) {
      console.error("[Manual Return] Shopify search failed:", error);
      return { query, orders: [], error: error instanceof Error ? error.message : "Shopify order search failed. Please try again." };
    }
  }

  if (actionType === "CREATE_MANUAL_RETURN") {
    const shopifyOrderId = formData.get("shopifyOrderId") as string;
    const orderNumber = formData.get("orderNumber") as string;
    const customerEmail = formData.get("customerEmail") as string;
    const customerName = formData.get("customerName") as string;
    const reason = formData.get("reason") as string;
    const adminNote = formData.get("adminNote") as string;
    const refundAmountRaw = formData.get("refundAmount") as string;
    const itemsJson = formData.get("items") as string;

    if (!shopifyOrderId || !orderNumber || !itemsJson) {
      return { error: "Order and items selection are required for manual return." };
    }

    // Validate Order Ownership against current merchant store
    const existingOrder = await prisma.order.findFirst({
      where: { shopifyOrderId, shopifyStoreId },
    });

    if (!existingOrder) {
      return { error: "Invalid order selection. Order does not belong to this merchant store." };
    }

    let parsedItems = [];
    try {
      parsedItems = JSON.parse(itemsJson);
    } catch {
      return { error: "Invalid line items payload." };
    }

    if (!Array.isArray(parsedItems) || parsedItems.length === 0) {
      return { error: "Please select at least one item to return." };
    }

    try {
      const createdReturn = await createReturnRequest({
        shopifyStoreId,
        shopifyOrderId,
        orderNumber,
        customerEmail: customerEmail || existingOrder.customerEmail || "",
        customerName: customerName || existingOrder.customerName || "Customer",
        reason: reason || "Merchant Created Return",
        customerNote: "Created manually by store merchant admin",
        adminNote: adminNote || undefined,
        requestSource: "MERCHANT",
        policyOverrideReason: adminNote || undefined,
        refundAmount: refundAmountRaw ? parseFloat(refundAmountRaw) : undefined,
        items: parsedItems.map((i: any) => ({
          shopifyLineItemId: i.lineItemId,
          quantity: parseInt(i.quantity, 10) || 1,
          reason: i.reason || reason || "MERCHANT_CREATED",
          reasonNote: i.reasonNote || "Manual return item",
        })),
      });

      return { success: true, message: `Manual return for ${orderNumber} created successfully!`, return: createdReturn };
    } catch (err: any) {
      console.error("Failed to create manual return:", err);
      return { error: err.message || "Failed to create manual return." };
    }
  }

  const returnId = formData.get("returnId") as string;
  const newStatus = formData.get("status") as string;
  const adminNote = formData.get("adminNote") as string;

  if (!returnId || !newStatus) {
    return { error: "Missing returnId or status" };
  }

  try {
    const updated = await updateReturnRequestStatus(
      returnId,
      shopifyStoreId,
      newStatus as "PENDING" | "APPROVED" | "REJECTED" | "RECEIVED" | "INSPECTED" | "REFUND_PENDING" | "COMPLETED" | "CANCELLED",
      adminNote || undefined,
      undefined,
      admin
    );

    return { success: true, return: updated };
  } catch (error) {
    console.error("Failed to update return:", error);
    return { error: String(error) };
  }
}

// ===== COMPONENT =====
export default function Returns() {
  const { returns: dbReturns, riskFlags } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const orderSearchFetcher = useFetcher<typeof action>();
  // Manual Return Creation Modal State
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [orderSearchQuery, setOrderSearchQuery] = useState<string>("");
  const [selectedOrderId, setSelectedOrderId] = useState<string>("");
  const orderSearchResult = orderSearchFetcher.data as any;
  const activeSearchQuery = orderSearchQuery.trim();
  const availableOrders = activeSearchQuery.length >= 2 && orderSearchResult?.query === activeSearchQuery && Array.isArray(orderSearchResult.orders) ? orderSearchResult.orders : [];
  const isSearchingOrders = orderSearchFetcher.state !== "idle" && orderSearchFetcher.formData?.get("actionType") === "SEARCH_ORDERS";
  const [selectedItems, setSelectedItems] = useState<Record<string, { quantity: number; reason: string }>>({});
  const [refundAmountInput, setRefundAmountInput] = useState<string>("");
  const [returnReasonInput, setReturnReasonInput] = useState<string>("DEFECTIVE");
  const [adminNoteInput, setAdminNoteInput] = useState<string>("");
  const [showConfirmStep, setShowConfirmStep] = useState<boolean>(false);

  // Selected Order for Modal
  const selectedOrder = availableOrders.find((o: any) => o.shopifyOrderId === selectedOrderId);

  // Shopify search returns matching records; don't hide matches with a second client-side filter.
  const filteredOrders = availableOrders;

  useEffect(() => {
    const query = orderSearchQuery.trim();
    if (query.length < 2) return;
    const timer = setTimeout(() => {
      orderSearchFetcher.submit({ actionType: "SEARCH_ORDERS", query }, { method: "post" });
    }, 350);
    return () => clearTimeout(timer);
  }, [orderSearchQuery]);

  const handleOrderSelect = (ord: any) => {
    setSelectedOrderId(ord.shopifyOrderId);
    setSelectedItems({});
    setShowConfirmStep(false);
    setRefundAmountInput("");
  };

  const handleItemToggle = (item: any) => {
    setSelectedItems((prev) => {
      const next = { ...prev };
      if (next[item.lineItemId]) {
        delete next[item.lineItemId];
      } else {
        next[item.lineItemId] = { quantity: 1, reason: returnReasonInput };
      }
      return next;
    });
  };

  const handleItemQuantityChange = (lineItemId: string, qty: number) => {
    setSelectedItems((prev) => ({
      ...prev,
      [lineItemId]: { ...prev[lineItemId], quantity: Math.max(1, qty) },
    }));
  };

  const handleItemReasonChange = (lineItemId: string, reason: string) => {
    setSelectedItems((prev) => ({
      ...prev,
      [lineItemId]: { ...prev[lineItemId], reason },
    }));
  };

  const handleCreateManualReturnSubmit = () => {
    if (!selectedOrder) return;
    const itemsArray = Object.entries(selectedItems).map(([lineItemId, data]) => ({
      lineItemId,
      quantity: data.quantity,
      reason: data.reason,
    }));

    fetcher.submit(
      {
        actionType: "CREATE_MANUAL_RETURN",
        shopifyOrderId: selectedOrder.shopifyOrderId,
        orderNumber: selectedOrder.orderNumber,
        customerEmail: selectedOrder.customerEmail || "",
        customerName: selectedOrder.customerName || "",
        reason: returnReasonInput,
        refundAmount: refundAmountInput.trim(),
        adminNote: adminNoteInput,
        items: JSON.stringify(itemsArray),
      },
      { method: "POST" }
    );
  };

  const handleCloseModal = () => {
    setIsCreateModalOpen(false);
    setSelectedOrderId("");
    setOrderSearchQuery("");
    setSelectedItems({});
    setShowConfirmStep(false);
  };

  // Convert DB data to UI format
  const returnsList = dbReturns.map((ret: any) => ({
    id: ret.id,
    orderNumber: ret.orderNumber,
    customerName: ret.customerName || "Unknown",
    customerEmail: ret.customerEmail,
    status: ret.status,
    reason: ret.reason || "Not specified",
    customerNote: ret.customerNote,
    adminNote: ret.adminNote,
    date: new Date(ret.createdAt).toLocaleDateString(),
    riskFlag: riskFlags[ret.customerEmail] ?? { flagged: false, reasons: [] },
    items: (ret.items || []).map((item: any) => ({
      name: `Item ${item.id}`,
      sku: item.shopifyLineItemId,
      quantity: item.quantity,
      reason: item.reason,
      price: 0,
    })),
    timeline: (ret.auditHistory || []).map((entry: any) => {
      const event = describeAuditEvent(entry.action, entry.metadata);
      return {
        status: entry.action,
        title: event.title,
        description: event.description,
        date: new Date(entry.createdAt).toLocaleString(),
      };
    }).concat((ret.auditHistory || []).length ? [] : [{
      status: ret.status,
      title: `Return ${ret.status}`,
      description: `Current status: ${ret.status}`,
      date: new Date(ret.updatedAt).toLocaleString(),
    }]),
  }));

  // Local state for interactive features
  const [selectedReturn, setSelectedReturn] = useState<(typeof returnsList)[0] | null>(null);

  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [dateFilter, setDateFilter] = useState("");
  const [flaggedOnly, setFlaggedOnly] = useState(false);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 6;

  // Filter returns based on search, status, date, and fraud flag
  const filteredReturns = returnsList.filter((item) => {
    const matchesSearch =
      item.orderNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.customerEmail.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.id.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus = statusFilter === "All" || item.status === statusFilter;
    const matchesDate = !dateFilter || item.date === dateFilter;
    const matchesFlag = !flaggedOnly || item.riskFlag.flagged;

    return matchesSearch && matchesStatus && matchesDate && matchesFlag;
  });

  // Paginated returns
  const totalPages = Math.ceil(filteredReturns.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const paginatedReturns = filteredReturns.slice(startIndex, startIndex + itemsPerPage);

  // Status Action Handler (submit to server)
  const handleUpdateStatus = (id: string, newStatus: string) => {
    let adminNote = "";
    if (newStatus === "COMPLETED") {
      adminNote = window.prompt("Enter the manual refund reference or confirmation note:", "") || "";
      if (adminNote.trim().length < 2) return;
    }
    fetcher.submit({ returnId: id, status: newStatus, adminNote }, { method: "POST" });
  };

  const isSubmitting = fetcher.state !== "idle" && fetcher.formData?.get("actionType") === "CREATE_MANUAL_RETURN";

  return (
    <div className="bc-page">
      <header className="bc-header">
        <div className="bc-page-bar">
          <div className="bc-header-copy">
            <p className="bc-eyebrow">REQUESTS</p>
            <h1>Return requests</h1>
            <p>Approve requests, inspect customer-arranged shipments in Warehouse, and confirm manual refunds when required.</p>
          </div>
          <button type="button" className="bc-btn primary" onClick={() => setIsCreateModalOpen(true)}>
            Create return
          </button>
        </div>
      </header>

      <section className="bc-card bc-toolbar">
          <div className="bc-grow">
            <input
              type="text"
              placeholder="Search by order number, customer name, or email"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
            />
          </div>
          <div>
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setCurrentPage(1);
              }}
            >
              <option value="All">All Statuses</option>
              <option value="PENDING">Pending</option>
              <option value="APPROVED">Approved</option>
              <option value="RECEIVED">Received at warehouse</option>
              <option value="INSPECTED">Inspected</option>
              <option value="REFUND_PENDING">Refund pending</option>
              <option value="REJECTED">Rejected</option>
              <option value="COMPLETED">Completed</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>
          <label className="bc-check">
            <input
              type="checkbox"
              checked={flaggedOnly}
              onChange={(e) => {
                setFlaggedOnly(e.target.checked);
                setCurrentPage(1);
              }}
              style={{ width: "16px", height: "16px" }}
            />
            <span className="bc-check-copy"><span className="bc-check-title">Flagged for review only</span></span>
          </label>
      </section>

      <section className="bc-table-wrap">
        {filteredReturns.length === 0 ? (
          <div className="bc-empty-state">
            <strong>No return requests</strong>
            <p>Try another search or filter.</p>
          </div>
        ) : (
          <div>
            <table className="bc-table">
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                  <th style={{ padding: "12px 16px", fontSize: "11.5px", color: "#64748b", textTransform: "uppercase" }}>Return ID</th>
                  <th style={{ padding: "12px 16px", fontSize: "11.5px", color: "#64748b", textTransform: "uppercase" }}>Order</th>
                  <th style={{ padding: "12px 16px", fontSize: "11.5px", color: "#64748b", textTransform: "uppercase" }}>Customer</th>
                  <th style={{ padding: "12px 16px", fontSize: "11.5px", color: "#64748b", textTransform: "uppercase" }}>Reason</th>
                  <th style={{ padding: "12px 16px", fontSize: "11.5px", color: "#64748b", textTransform: "uppercase" }}>Status</th>
                  <th style={{ padding: "12px 16px", fontSize: "11.5px", color: "#64748b", textTransform: "uppercase" }}>Date</th>
                  <th style={{ padding: "12px 16px", fontSize: "11.5px", color: "#64748b", textTransform: "uppercase", textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {paginatedReturns.map((ret) => (
                  <tr
                    key={ret.id}
                    onClick={() => setSelectedReturn(ret)}
                    style={{
                      borderBottom: "1px solid #f1f5f9",
                      cursor: "pointer",
                      backgroundColor: selectedReturn?.id === ret.id ? "#f8fafc" : "transparent",
                    }}
                  >
                    <td style={{ padding: "12px 16px", fontWeight: 700, color: "#0f172a" }}>#{ret.id.substring(0, 8)}</td>
                    <td style={{ padding: "12px 16px", fontWeight: 600 }}>{ret.orderNumber}</td>
                    <td style={{ padding: "12px 16px" }}>
                      <div style={{ fontWeight: 600, color: "#1e293b" }}>{ret.customerName}</div>
                      <div style={{ fontSize: "12px", color: "#64748b" }}>{ret.customerEmail}</div>
                    </td>
                    <td style={{ padding: "12px 16px", fontSize: "13px", color: "#475569" }}>{ret.reason}</td>
                    <td style={{ padding: "12px 16px" }}>
                      <span
                        style={{
                          fontSize: "11.5px",
                          fontWeight: 700,
                          padding: "3px 10px",
                          borderRadius: "12px",
                          backgroundColor:
                            ret.status === "APPROVED" || ret.status === "COMPLETED"
                              ? "#dcfce7"
                              : ret.status === "PENDING"
                              ? "#fef3c7"
                              : "#fee2e2",
                          color:
                            ret.status === "APPROVED" || ret.status === "COMPLETED"
                              ? "#15803d"
                              : ret.status === "PENDING"
                              ? "#d97706"
                              : "#b91c1c",
                        }}
                      >
                        {ret.status}
                      </span>
                    </td>
                    <td style={{ padding: "12px 16px", fontSize: "13px", color: "#64748b" }}>{ret.date}</td>
                    <td style={{ padding: "12px 16px", textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: "flex", justifyContent: "flex-end", gap: "6px", flexWrap: "wrap" }}>
                        <button type="button" className="bc-btn" onClick={() => setSelectedReturn(ret)}>View</button>
                        {ret.status === "PENDING" ? <>
                          <button type="button" className="bc-btn primary" onClick={() => handleUpdateStatus(ret.id, "APPROVED")}>Approve</button>
                          <button type="button" className="bc-btn" onClick={() => handleUpdateStatus(ret.id, "REJECTED")}>Reject</button>
                        </> : null}
                        {ret.status === "REFUND_PENDING" ? <button type="button" className="bc-btn primary" onClick={() => handleUpdateStatus(ret.id, "COMPLETED")}>Confirm manual refund</button> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Bar */}
        {totalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderTop: "1px solid #e2e8f0", background: "#f8fafc" }}>
            <span style={{ fontSize: "13px", color: "#64748b" }}>
              Showing {startIndex + 1} to {Math.min(startIndex + itemsPerPage, filteredReturns.length)} of {filteredReturns.length} returns
            </span>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                disabled={currentPage === 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                style={{ opacity: currentPage === 1 ? 0.5 : 1, cursor: currentPage === 1 ? "not-allowed" : "pointer" }}
              >
                Previous
              </button>
              <button
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                style={{ opacity: currentPage === totalPages ? 0.5 : 1, cursor: currentPage === totalPages ? "not-allowed" : "pointer" }}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Advanced Search Autocomplete Manual Return Modal */}
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
              backgroundColor: "rgba(15, 23, 42, 0.5)",
              backdropFilter: "blur(4px)",
              zIndex: 1000,
            }}
          />
          <div
            className="bc-manual-request-modal"
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              width: "min(840px, calc(100vw - 24px))",
              maxWidth: "calc(100vw - 24px)",
              maxHeight: "calc(100dvh - 32px)",
              overflowY: "auto",
              overflowX: "hidden",
              boxSizing: "border-box",
              backgroundColor: "#ffffff",
              borderRadius: "16px",
              boxShadow: "0 20px 40px rgba(0,0,0,0.2)",
              zIndex: 1001,
              padding: "28px",
              display: "flex",
              flexDirection: "column",
              gap: "20px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #e2e8f0", paddingBottom: "14px" }}>
              <h2 style={{ fontSize: "18px", fontWeight: 700, margin: 0, fontFamily: "Outfit, sans-serif" }}>
                {showConfirmStep ? "Review & Confirm Return" : "Create Manual Return"}
              </h2>
              <button onClick={handleCloseModal} style={{ padding: "4px 10px", fontSize: "12px" }}>
                ✕ Close
              </button>
            </div>
            {fetcher.data?.error ? <p role="alert" style={{ color: "#b91c1c", background: "#fef2f2", padding: "10px 12px", borderRadius: "8px", margin: 0 }}>{fetcher.data.error}</p> : null}
            {fetcher.data?.success ? <p role="status" style={{ color: "#047857", background: "#ecfdf5", padding: "10px 12px", borderRadius: "8px", margin: 0 }}>{fetcher.data.message || "Return request saved."} You can close this panel when ready.</p> : null}

            {!showConfirmStep ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                {/* Search Autocomplete Order Picker */}
                <div>
                  <label style={{ display: "block", fontWeight: 700, fontSize: "13.5px", marginBottom: "6px", color: "#0f172a" }}>
                    Search & Select Store Order *
                  </label>
                  <input
                    type="text"
                    placeholder="Search by order #, customer name, email, or product title..."
                    value={orderSearchQuery}
                    onChange={(e) => setOrderSearchQuery(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "10px 14px",
                      border: "1px solid #cbd5e1",
                      borderRadius: "8px",
                      fontSize: "14px",
                      marginBottom: "8px",
                    }}
                  />

                  {!selectedOrder && (
                    <div style={{ maxHeight: "280px", overflowY: "auto", overflowX: "hidden", border: "1px solid #e2e8f0", borderRadius: "10px", background: "#fff" }}>
                      {activeSearchQuery.length < 2 ? (
                        <div style={{ padding: "18px 14px", color: "#64748b", fontSize: "13px", textAlign: "center" }}>
                          Start typing at least 2 characters to search Shopify orders. No orders are loaded until you search.
                        </div>
                      ) : orderSearchResult?.query !== activeSearchQuery || isSearchingOrders ? (
                        <div role="status" style={{ padding: "18px 14px", color: "#475569", fontSize: "13px", textAlign: "center" }}>Searching Shopify orders…</div>
                      ) : orderSearchResult?.error ? (
                        <div role="alert" style={{ padding: "18px 14px", color: "#b91c1c", fontSize: "13px" }}>{orderSearchResult.error}</div>
                      ) : filteredOrders.length === 0 ? (
                        <div style={{ padding: "18px 14px", color: "#64748b", fontSize: "13px", textAlign: "center" }}>No matching orders found. Try another order number, customer name, or email.</div>
                      ) : (
                        <>
                          <div style={{ padding: "9px 14px", color: "#64748b", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: "12px" }}>{filteredOrders.length.toLocaleString()} matching orders · Select an order</div>
                          {filteredOrders.map((ord: any) => (
                            <button key={ord.shopifyOrderId} type="button" onClick={() => handleOrderSelect(ord)} style={{ display: "block", width: "100%", textAlign: "left", padding: "12px 14px", border: 0, borderBottom: "1px solid #e2e8f0", borderRadius: 0, background: "#fff", color: "#0f172a", cursor: "pointer" }}>
                              <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}><strong style={{ fontSize: "14px", color: "#0f172a" }}>{ord.orderNumber}</strong><span style={{ fontSize: "13px", fontWeight: 700, color: "#059669", whiteSpace: "nowrap" }}>{ord.currency || "USD"} {Number(ord.totalPrice).toFixed(2)}</span></span>
                              <span style={{ display: "block", fontSize: "12px", color: "#64748b", marginTop: "3px" }}>{ord.customerName || "Customer details unavailable"} · {ord.customerEmail || ord.customerPhone || "No email/phone"}</span>
                            </button>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                  {/* Selected Order Summary Banner */}
                  {selectedOrder && (
                    <div style={{ backgroundColor: "#f0fdf4", border: "1px solid #bbf7d0", padding: "12px 14px", borderRadius: "8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <strong style={{ color: "#15803d", fontSize: "14px" }}>Selected Order: {selectedOrder.orderNumber}</strong>
                        <div style={{ fontSize: "12px", color: "#166534" }}>{selectedOrder.customerName} ({selectedOrder.customerEmail})</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedOrderId("")}
                        style={{ fontSize: "12px", background: "#ffffff", color: "#15803d", border: "1px solid #bbf7d0" }}
                      >
                        Change Order
                      </button>
                    </div>
                  )}
                </div>

                {/* Line Item Picker */}
                {selectedOrder && (
                  <div>
                    <label style={{ display: "block", fontWeight: 700, fontSize: "13.5px", marginBottom: "8px", color: "#0f172a" }}>
                      Select Order Line Items to Return *
                    </label>
                    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                      {((selectedOrder as any).lineItems || []).map((li: any) => {
                        const isSelected = Boolean(selectedItems[li.lineItemId]);
                        const itemData = selectedItems[li.lineItemId] || {};

                        return (
                          <div
                            key={li.lineItemId}
                            style={{
                              border: isSelected ? "2px solid #6366f1" : "1px solid #e2e8f0",
                              borderRadius: "10px",
                              padding: "14px",
                              backgroundColor: isSelected ? "#f5f3ff" : "#ffffff",
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                              <input
                                type="checkbox"
                                id={`ret-item-${li.lineItemId}`}
                                checked={isSelected}
                                onChange={() => handleItemToggle(li)}
                                style={{ width: "18px", height: "18px", cursor: "pointer" }}
                              />
                              {li.imageUrl ? <img src={li.imageUrl} alt={li.title || "Product"} loading="lazy" style={{ width: "64px", height: "72px", objectFit: "cover", borderRadius: "8px", background: "#f1f2f3", flex: "0 0 auto" }} /> : <span aria-label="Product image unavailable" style={{ width: "64px", height: "72px", borderRadius: "8px", background: "#f1f2f3", flex: "0 0 auto" }} />}
                              <label htmlFor={`ret-item-${li.lineItemId}`} style={{ flex: 1, cursor: "pointer", minWidth: 0 }}>
                                <div style={{ fontWeight: 650, fontSize: "14px", color: "#0f172a" }}>{li.title}</div>
                                <div style={{ fontSize: "12px", color: "#475569", marginTop: "3px" }}>{li.variantTitle && li.variantTitle !== "Default Title" ? `Variant / size: ${li.variantTitle}` : "Variant / size: not available"}{li.sku ? ` · SKU ${li.sku}` : ""}</div>
                                <div style={{ fontSize: "12px", color: "#64748b", marginTop: "3px" }}>
                                  Unit Price: {selectedOrder.currency || "USD"} {Number(li.price).toFixed(2)} | Max Qty: {li.quantity}
                                </div>
                              </label>
                            </div>

                            {isSelected && (
                              <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px solid #ddd6fe", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: "12px" }}>
                                <div>
                                  <label style={{ fontSize: "12px", fontWeight: 700, color: "#475569" }}>Return Quantity</label>
                                  <input
                                    type="number"
                                    min="1"
                                    max={li.quantity}
                                    value={itemData.quantity}
                                    onChange={(e) => handleItemQuantityChange(li.lineItemId, parseInt(e.target.value) || 1)}
                                    style={{ width: "100%", padding: "6px 10px", marginTop: "4px" }}
                                  />
                                </div>
                                <div>
                                  <label style={{ fontSize: "12px", fontWeight: 700, color: "#475569" }}>Item Reason</label>
                                  <select
                                    value={itemData.reason || returnReasonInput}
                                    onChange={(e) => handleItemReasonChange(li.lineItemId, e.target.value)}
                                    style={{ width: "100%", padding: "6px 10px", marginTop: "4px" }}
                                  >
                                    <option value="DEFECTIVE">Defective / Damaged</option>
                                    <option value="SIZE_TOO_SMALL">Size Too Small</option>
                                    <option value="SIZE_TOO_LARGE">Size Too Large</option>
                                    <option value="WRONG_ITEM">Wrong Item Sent</option>
                                    <option value="CUSTOMER_CHANGE">Changed Mind</option>
                                  </select>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Additional Return Options */}
                {selectedOrder && Object.keys(selectedItems).length > 0 && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: "14px" }}>
                    <div>
                      <label style={{ display: "block", fontWeight: 700, fontSize: "12.5px", color: "#475569", marginBottom: "4px" }}>
                        Global Return Reason
                      </label>
                      <select
                        value={returnReasonInput}
                        onChange={(e) => setReturnReasonInput(e.target.value)}
                        style={{ width: "100%", padding: "8px 12px" }}
                      >
                        <option value="DEFECTIVE">Defective / Damaged</option>
                        <option value="SIZE_TOO_SMALL">Size Too Small</option>
                        <option value="SIZE_TOO_LARGE">Size Too Large</option>
                        <option value="WRONG_ITEM">Wrong Item Sent</option>
                        <option value="CUSTOMER_CHANGE">Changed Mind</option>
                      </select>
                    </div>

                    <div>
                      <label style={{ display: "block", fontWeight: 700, fontSize: "12.5px", color: "#475569", marginBottom: "4px" }}>
                        Optional refund override ({selectedOrder?.currency || "order currency"})
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        value={refundAmountInput}
                        onChange={(e) => setRefundAmountInput(e.target.value)}
                        min="0"
                        placeholder="Leave blank to calculate after inspection"
                        style={{ width: "100%", padding: "8px 12px" }}
                      />
                    </div>

                    <div style={{ gridColumn: "span 2" }}>
                      <label style={{ display: "block", fontWeight: 700, fontSize: "12.5px", color: "#475569", marginBottom: "4px" }}>
                        Internal note / policy-override reason (required for policy exceptions)
                      </label>
                      <input
                        type="text"
                        placeholder="Internal note; explain any eligibility override here..."
                        value={adminNoteInput}
                        onChange={(e) => setAdminNoteInput(e.target.value)}
                      />
                    </div>

                    <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "12px" }}>
                      <button
                        onClick={() => setIsCreateModalOpen(false)}
                        style={{ padding: "8px 16px", borderRadius: "8px", border: "1px solid #cbd5e1", background: "#fff", cursor: "pointer" }}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => setShowConfirmStep(true)}
                        disabled={Object.keys(selectedItems).length === 0}
                        style={{
                          padding: "8px 16px",
                          borderRadius: "8px",
                          border: "none",
                          background: Object.keys(selectedItems).length === 0 ? "#cbd5e1" : "#4f46e5",
                          color: "#fff",
                          fontWeight: 600,
                          cursor: Object.keys(selectedItems).length === 0 ? "not-allowed" : "pointer",
                        }}
                      >
                        Review & Confirm →
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Confirmation Prompt Step */
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                <s-box padding="base" background="subdued">
                  <h4 style={{ margin: "0 0 8px 0" }}>Confirm Manual Return Creation</h4>
                  <p style={{ margin: 0, fontSize: "13.5px", color: "#475569" }}>
                    Please confirm creating return request for <strong>{selectedOrder?.orderNumber}</strong> with{" "}
                    <strong>{Object.keys(selectedItems).length} item(s)</strong> and a refund amount of{" "}
                    <strong>{refundAmountInput.trim() ? `${selectedOrder?.currency || "Order currency"} ${refundAmountInput}` : "Calculated after warehouse inspection"}</strong>.
                  </p>
                </s-box>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px" }}>
                  <button
                    onClick={() => setShowConfirmStep(false)}
                    style={{ padding: "8px 16px", borderRadius: "8px", border: "1px solid #cbd5e1", background: "#fff", cursor: "pointer" }}
                  >
                    ← Back to Edit
                  </button>
                  <button
                    onClick={handleCreateManualReturnSubmit}
                    style={{
                      padding: "8px 16px",
                      borderRadius: "8px",
                      border: "none",
                      background: "#10b981",
                      color: "#fff",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Confirm & Save Return
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {selectedReturn && (
        <>
          <div onClick={() => setSelectedReturn(null)} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.4)", zIndex: 1100 }} />
          <aside role="dialog" aria-label="Return request details and audit history" style={{ position: "fixed", top: 0, right: 0, height: "100%", width: "min(500px,100%)", overflowY: "auto", background: "#fff", zIndex: 1101, padding: 24, boxShadow: "-8px 0 28px rgba(15,23,42,.16)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}><div><p style={{ margin: 0, color: "#64748b", fontSize: 11, fontWeight: 800, letterSpacing: ".1em" }}>RETURN REQUEST</p><h2 style={{ margin: "4px 0 0", fontSize: 21 }}>#{selectedReturn.id.slice(0, 8)} · {selectedReturn.orderNumber}</h2></div><button type="button" className="bc-btn" onClick={() => setSelectedReturn(null)}>Close</button></div>
            <div style={{ display: "grid", gap: 8, marginTop: 20, fontSize: 13 }}><div><strong>Customer:</strong> {selectedReturn.customerName} ({selectedReturn.customerEmail})</div><div><strong>Status:</strong> {selectedReturn.status}</div><div><strong>Reason:</strong> {selectedReturn.reason}</div>{selectedReturn.customerNote ? <div><strong>Customer note:</strong> {selectedReturn.customerNote}</div> : null}{selectedReturn.adminNote ? <div><strong>Merchant note:</strong> {selectedReturn.adminNote}</div> : null}</div>
            <h3 style={{ margin: "24px 0 10px", fontSize: 15 }}>Items</h3>
            <div style={{ display: "grid", gap: 8 }}>{selectedReturn.items.map((item: any, index: number) => <div key={`${item.sku}-${index}`} style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 12 }}><strong>{item.sku}</strong><div style={{ color: "#64748b", fontSize: 12 }}>Quantity: {item.quantity} · Reason: {item.reason}</div></div>)}</div>
            <h3 style={{ margin: "24px 0 10px", fontSize: 15 }}>Audit history</h3>
            <div style={{ display: "grid", gap: 12 }}>{selectedReturn.timeline.map((event: any, index: number) => <div key={`${event.title}-${index}`} style={{ borderLeft: "2px solid #cbd5e1", paddingLeft: 12 }}><strong style={{ fontSize: 12 }}>{event.title}</strong><div style={{ color: "#64748b", fontSize: 11, marginTop: 3 }}>{event.date}</div><p style={{ color: "#334155", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "5px 0 0" }}>{event.description}</p></div>)}</div>
          </aside>
        </>
      )}

      {/* Shared row and responsive manual-request modal styling */}
      <style>{`
        .hover-row:hover { background-color: #f9fafb !important; }
        .bc-manual-request-modal, .bc-manual-request-modal * { box-sizing: border-box; min-width: 0; }
        .bc-manual-request-modal { overscroll-behavior: contain; }
        .bc-manual-request-modal input, .bc-manual-request-modal select, .bc-manual-request-modal textarea { max-width: 100%; min-width: 0; }
        @media (max-width: 640px) {
          .bc-manual-request-modal { width: calc(100vw - 20px) !important; max-width: calc(100vw - 20px) !important; max-height: calc(100dvh - 20px) !important; padding: 16px !important; }
          .bc-manual-request-modal [style*="grid-column: span 2"] { grid-column: auto !important; }
        }
      `}</style>
    </div>
  );
}
