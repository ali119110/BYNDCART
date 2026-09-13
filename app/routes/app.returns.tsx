import React, { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/app.returns";
import { requireTenantContext } from "../utils/tenant.server";
import prisma from "../db.server";
import { getReturnRequests, updateReturnRequestStatus, createReturnRequest } from "../services/returns.server";
import { getCustomerRiskFlagsForEmails } from "../services/fraud.server";
import { getStoreOrders } from "../services/orders.server";

// ===== LOADER: Fetch returns and store orders from database =====
export async function loader({ request }: Route.LoaderArgs) {
  const { shopifyStoreId } = await requireTenantContext(request);

  try {
    const [returns, orders] = await Promise.all([
      getReturnRequests(shopifyStoreId),
      getStoreOrders(shopifyStoreId, 100),
    ]);
    const emails = returns.map((r) => r.customerEmail);
    const riskFlags = await getCustomerRiskFlagsForEmails(shopifyStoreId, emails);

    return {
      returns,
      orders,
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

  const { shopifyStoreId } = await requireTenantContext(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType") as string;

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
        customerEmail: customerEmail || existingOrder.customerEmail || "merchant-created@store.com",
        customerName: customerName || existingOrder.customerName || "Customer",
        reason: reason || "Merchant Created Return",
        customerNote: "Created manually by store merchant admin",
        adminNote: adminNote || "Created manually via merchant dashboard",
        refundAmount: refundAmountRaw ? parseFloat(refundAmountRaw) : 0,
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
      newStatus as "PENDING" | "APPROVED" | "REJECTED" | "COMPLETED" | "CANCELLED",
      adminNote || undefined
    );

    return { success: true, return: updated };
  } catch (error) {
    console.error("Failed to update return:", error);
    return { error: String(error) };
  }
}

// ===== COMPONENT =====
export default function Returns() {
  const { returns: dbReturns, orders: dbOrders = [], riskFlags } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  // Manual Return Creation Modal State
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [orderSearchQuery, setOrderSearchQuery] = useState<string>("");
  const [selectedOrderId, setSelectedOrderId] = useState<string>("");
  const [selectedItems, setSelectedItems] = useState<Record<string, { quantity: number; reason: string }>>({});
  const [refundAmountInput, setRefundAmountInput] = useState<string>("0.00");
  const [returnReasonInput, setReturnReasonInput] = useState<string>("DEFECTIVE");
  const [adminNoteInput, setAdminNoteInput] = useState<string>("");
  const [showConfirmStep, setShowConfirmStep] = useState<boolean>(false);

  // Selected Order for Modal
  const selectedOrder = dbOrders.find((o: any) => o.shopifyOrderId === selectedOrderId);

  // Autocomplete Filtered Orders
  const filteredOrders = dbOrders.filter((ord: any) => {
    const q = orderSearchQuery.toLowerCase().trim();
    if (!q) return true;
    const matchOrderNumber = (ord.orderNumber || "").toLowerCase().includes(q);
    const matchCustomer =
      (ord.customerName || "").toLowerCase().includes(q) ||
      (ord.customerEmail || "").toLowerCase().includes(q);
    const matchItem = (ord.lineItems || []).some((li: any) =>
      (li.title || "").toLowerCase().includes(q)
    );
    return matchOrderNumber || matchCustomer || matchItem;
  });

  const handleOrderSelect = (ord: any) => {
    setSelectedOrderId(ord.shopifyOrderId);
    setSelectedItems({});
    setShowConfirmStep(false);
    setRefundAmountInput(Number(ord.totalPrice).toFixed(2));
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
        refundAmount: refundAmountInput,
        adminNote: adminNoteInput,
        items: JSON.stringify(itemsArray),
      },
      { method: "POST" }
    );

    handleCloseModal();
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
    timeline: [
      {
        status: ret.status,
        title: `Return ${ret.status}`,
        description: `Status is currently ${ret.status}`,
        date: new Date(ret.updatedAt).toLocaleString(),
      },
    ],
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
    fetcher.submit(
      { returnId: id, status: newStatus },
      { method: "POST" }
    );

    if (selectedReturn?.id === id) {
      setSelectedReturn({
        ...selectedReturn,
        status: newStatus,
      });
    }
  };

  const isSubmitting = fetcher.state !== "idle" && fetcher.formData?.get("actionType") === "CREATE_MANUAL_RETURN";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px", maxWidth: "1240px", margin: "0 auto" }}>
      {/* Header Bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #e2e8f0", paddingBottom: "16px" }}>
        <div>
          <h1 style={{ fontSize: "22px", fontWeight: "700", color: "#0f172a", margin: 0, fontFamily: "Outfit, sans-serif" }}>
            Return Requests
          </h1>
          <p style={{ margin: "4px 0 0 0", color: "#64748b", fontSize: "14px" }}>
            Manage customer returns and create manual return requests with full order validation.
          </p>
        </div>
        <button
          onClick={() => setIsCreateModalOpen(true)}
          style={{
            background: "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)",
            color: "#ffffff",
            border: "none",
            borderRadius: "8px",
            padding: "9px 18px",
            fontWeight: 600,
            fontSize: "13.5px",
            cursor: "pointer",
            boxShadow: "0 4px 12px rgba(99, 102, 241, 0.3)",
          }}
        >
          + Create Return
        </button>
      </div>

      {/* Search & Filter Toolbar */}
      <div style={{ background: "#ffffff", padding: "16px", borderRadius: "12px", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.02)" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center" }}>
          {/* Search Box */}
          <div style={{ flex: "1 1 240px" }}>
            <input
              type="text"
              placeholder="Search by Order #, Customer name or email..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
              style={{
                width: "100%",
                padding: "9px 14px",
                border: "1px solid #cbd5e1",
                borderRadius: "8px",
                fontSize: "13.5px",
              }}
            />
          </div>

          {/* Status Filter */}
          <div>
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setCurrentPage(1);
              }}
              style={{
                padding: "9px 14px",
                border: "1px solid #cbd5e1",
                borderRadius: "8px",
                fontSize: "13.5px",
              }}
            >
              <option value="All">All Statuses</option>
              <option value="PENDING">Pending</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
              <option value="COMPLETED">Completed</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>

          {/* Flagged Checkbox */}
          <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "#475569", cursor: "pointer", userSelect: "none" }}>
            <input
              type="checkbox"
              checked={flaggedOnly}
              onChange={(e) => {
                setFlaggedOnly(e.target.checked);
                setCurrentPage(1);
              }}
              style={{ width: "16px", height: "16px" }}
            />
            <span>Flagged for Risk Only</span>
          </label>
        </div>
      </div>

      {/* Main Returns Table */}
      <div style={{ background: "#ffffff", borderRadius: "16px", border: "1px solid #e2e8f0", overflow: "hidden" }}>
        {filteredReturns.length === 0 ? (
          <div style={{ padding: "48px 0", textAlign: "center" }}>
            <h3 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>No Return Requests Found</h3>
            <p style={{ color: "#64748b", fontSize: "13.5px", marginTop: "4px" }}>Refine your search or filters.</p>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
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
                      <button onClick={() => setSelectedReturn(ret)} style={{ fontSize: "12.5px" }}>
                        View Details
                      </button>
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
      </div>

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
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              width: "min(680px, 94vw)",
              maxHeight: "88vh",
              overflowY: "auto",
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

            {!showConfirmStep ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                {/* Search Autocomplete Order Picker */}
                <div>
                  <label style={{ display: "block", fontWeight: 700, fontSize: "13.5px", marginBottom: "6px", color: "#0f172a" }}>
                    Search & Select Store Order *
                  </label>
                  <input
                    type="text"
                    placeholder="🔍 Type Order #, Customer Name, Email, or Product title..."
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

                  {/* Scrollable Order Autocomplete Results */}
                  {!selectedOrder && (
                    <div style={{ maxHeight: "220px", overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: "8px", background: "#f8fafc" }}>
                      {filteredOrders.length === 0 ? (
                        <div style={{ padding: "16px", textAlign: "center", color: "#64748b", fontSize: "13px" }}>
                          No store orders match "{orderSearchQuery}"
                        </div>
                      ) : (
                        filteredOrders.map((ord: any) => (
                          <div
                            key={ord.shopifyOrderId}
                            onClick={() => handleOrderSelect(ord)}
                            style={{
                              padding: "12px 14px",
                              borderBottom: "1px solid #e2e8f0",
                              cursor: "pointer",
                              backgroundColor: "#ffffff",
                              transition: "background 0.15s",
                            }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <strong style={{ fontSize: "14px", color: "#0f172a" }}>{ord.orderNumber}</strong>
                              <span style={{ fontSize: "13px", fontWeight: 700, color: "#10b981" }}>${Number(ord.totalPrice).toFixed(2)}</span>
                            </div>
                            <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                              Customer: {ord.customerName || "N/A"} ({ord.customerEmail || "No Email"})
                            </div>
                          </div>
                        ))
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
                              <label htmlFor={`ret-item-${li.lineItemId}`} style={{ flex: 1, cursor: "pointer" }}>
                                <div style={{ fontWeight: 600, fontSize: "14px", color: "#0f172a" }}>{li.title}</div>
                                <div style={{ fontSize: "12px", color: "#64748b" }}>
                                  Unit Price: ${Number(li.price).toFixed(2)} | Max Qty: {li.quantity}
                                </div>
                              </label>
                            </div>

                            {isSelected && (
                              <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px solid #ddd6fe", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
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
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
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
                        Refund Amount ($)
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        value={refundAmountInput}
                        onChange={(e) => setRefundAmountInput(e.target.value)}
                        style={{ width: "100%", padding: "8px 12px" }}
                      />
                    </div>

                    <div style={{ gridColumn: "span 2" }}>
                      <label style={{ display: "block", fontWeight: 700, fontSize: "12.5px", color: "#475569", marginBottom: "4px" }}>
                        Merchant Internal Note
                      </label>
                      <input
                        type="text"
                        placeholder="Internal note for staff..."
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
                    <strong>${refundAmountInput}</strong>.
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

      {/* Basic Hover Row Styling */}
      <style>{`
        .hover-row:hover {
          background-color: #f9fafb !important;
        }
      `}</style>
    </div>
  );
}
