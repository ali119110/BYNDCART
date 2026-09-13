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
  const [selectedOrderId, setSelectedOrderId] = useState<string>("");
  const [selectedItems, setSelectedItems] = useState<Record<string, { quantity: number; reason: string }>>({});
  const [refundAmountInput, setRefundAmountInput] = useState<string>("0.00");
  const [returnReasonInput, setReturnReasonInput] = useState<string>("DEFECTIVE");
  const [adminNoteInput, setAdminNoteInput] = useState<string>("");
  const [showConfirmStep, setShowConfirmStep] = useState<boolean>(false);

  const selectedOrder = dbOrders.find((o: any) => o.shopifyOrderId === selectedOrderId);

  const handleOrderChange = (orderId: string) => {
    setSelectedOrderId(orderId);
    setSelectedItems({});
    setShowConfirmStep(false);
    const ord = dbOrders.find((o: any) => o.shopifyOrderId === orderId);
    if (ord) {
      setRefundAmountInput(ord.totalPrice.toString());
    }
  };

  const handleItemToggle = (item: any) => {
    setSelectedItems((prev) => {
      const next = { ...prev };
      if (next[item.lineItemId]) {
        delete next[item.lineItemId];
      } else {
        next[item.lineItemId] = { quantity: item.quantity, reason: returnReasonInput };
      }
      return next;
    });
  };

  const handleItemQuantityChange = (lineItemId: string, qty: number) => {
    setSelectedItems((prev) => ({
      ...prev,
      [lineItemId]: { ...prev[lineItemId], quantity: qty },
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

    setIsCreateModalOpen(false);
    setSelectedOrderId("");
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
    items: ret.items.map((item: any) => ({
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
  const itemsPerPage = 5;

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

    // Optimistically update the selected return status
    if (selectedReturn?.id === id) {
      setSelectedReturn({
        ...selectedReturn,
        status: newStatus,
      });
    }
  };

  return (
    <s-page heading="Return Requests">
      {/* Header Bar with Create Return Button */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <div>
          <s-paragraph tone="neutral">Manage customer returns and directly create manual returns for store orders.</s-paragraph>
        </div>
        <s-button variant="primary" onClick={() => setIsCreateModalOpen(true)}>
          + Create Return
        </s-button>
      </div>

      {/* Search & Filter Toolbar */}
      <div style={{ marginBottom: "16px" }}>
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center" }}>
            {/* Search Box */}
            <div style={{ flex: "1 1 200px" }}>
              <input
                type="text"
                placeholder="Search by ID, Order, or Customer..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setCurrentPage(1);
                }}
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  border: "1px solid #c9cccf",
                  borderRadius: "4px",
                  fontSize: "14px",
                }}
              />
            </div>

            {/* Status Dropdown */}
            <div style={{ flex: "0 1 180px" }}>
              <select
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value);
                  setCurrentPage(1);
                }}
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  border: "1px solid #c9cccf",
                  borderRadius: "4px",
                  fontSize: "14px",
                }}
              >
                <option value="All">All Statuses</option>
                <option value="PENDING">Pending</option>
                <option value="APPROVED">Approved</option>
                <option value="COMPLETED">Completed</option>
                <option value="REJECTED">Rejected</option>
                <option value="CANCELLED">Cancelled</option>
              </select>
            </div>

            {/* Date Picker */}
            <div style={{ flex: "0 1 180px" }}>
              <input
                type="date"
                value={dateFilter}
                onChange={(e) => {
                  setDateFilter(e.target.value);
                  setCurrentPage(1);
                }}
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  border: "1px solid #c9cccf",
                  borderRadius: "4px",
                  fontSize: "14px",
                }}
              />
            </div>

            {/* Flagged Only Toggle */}
            <div style={{ flex: "0 0 auto" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "14px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={flaggedOnly}
                  onChange={(e) => {
                    setFlaggedOnly(e.target.checked);
                    setCurrentPage(1);
                  }}
                />
                Flagged only
              </label>
            </div>

            {/* Clear Filters Button */}
            {(searchQuery || statusFilter !== "All" || dateFilter || flaggedOnly) && (
              <s-button
                onClick={() => {
                  setSearchQuery("");
                  setStatusFilter("All");
                  setDateFilter("");
                  setFlaggedOnly(false);
                  setCurrentPage(1);
                }}
              >
                Clear Filters
              </s-button>
            )}
          </div>
        </s-box>
      </div>

      {/* Main Returns Index Table */}
      <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
        {paginatedReturns.length === 0 ? (
          <s-stack direction="block" gap="base">
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                padding: "40px 0",
                width: "100%",
              }}
            >
              <s-heading>No Returns Match Search/Filters</s-heading>
              <s-paragraph tone="neutral">Adjust your queries or filters and try again.</s-paragraph>
            </div>
          </s-stack>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                  <th style={{ padding: "12px 8px" }}>
                    <s-text tone="neutral">Return ID</s-text>
                  </th>
                  <th style={{ padding: "12px 8px" }}>
                    <s-text tone="neutral">Order</s-text>
                  </th>
                  <th style={{ padding: "12px 8px" }}>
                    <s-text tone="neutral">Customer</s-text>
                  </th>
                  <th style={{ padding: "12px 8px" }}>
                    <s-text tone="neutral">Items</s-text>
                  </th>
                  <th style={{ padding: "12px 8px" }}>
                    <s-text tone="neutral">Reason</s-text>
                  </th>
                  <th style={{ padding: "12px 8px" }}>
                    <s-text tone="neutral">Status</s-text>
                  </th>
                  <th style={{ padding: "12px 8px" }}>
                    <s-text tone="neutral">Date</s-text>
                  </th>
                  <th style={{ padding: "12px 8px", textAlign: "right" }}>
                    <s-text tone="neutral">Action</s-text>
                  </th>
                </tr>
              </thead>
              <tbody>
                {paginatedReturns.map((ret) => (
                  <tr
                    key={ret.id}
                    onClick={() => setSelectedReturn(ret)}
                    style={{
                      borderBottom: "1px solid #f1f2f3",
                      cursor: "pointer",
                      backgroundColor: selectedReturn?.id === ret.id ? "#f4f6f8" : "transparent",
                    }}
                    className="hover-row"
                  >
                    <td style={{ padding: "12px 8px" }}>
                      <strong>{ret.id.substring(0, 8)}</strong>
                    </td>
                    <td style={{ padding: "12px 8px" }}>{ret.orderNumber}</td>
                    <td style={{ padding: "12px 8px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <div style={{ fontWeight: "bold" }}>{ret.customerName}</div>
                        {ret.riskFlag.flagged && (
                          <span
                            title={ret.riskFlag.reasons.join("; ")}
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
                      <div style={{ fontSize: "12px", color: "#6d7175" }}>{ret.customerEmail}</div>
                    </td>
                    <td style={{ padding: "12px 8px" }}>
                      {ret.items.length} item{ret.items.length !== 1 ? "s" : ""}
                    </td>
                    <td style={{ padding: "12px 8px" }}>{ret.reason}</td>
                    <td style={{ padding: "12px 8px" }}>
                      <s-text
                        tone={
                          ret.status === "COMPLETED" || ret.status === "APPROVED"
                            ? "success"
                            : ret.status === "PENDING"
                            ? "warning"
                            : "critical"
                        }
                      >
                        {ret.status}
                      </s-text>
                    </td>
                    <td style={{ padding: "12px 8px" }}>{ret.date}</td>
                    <td
                      style={{ padding: "12px 8px", textAlign: "right" }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <s-button onClick={() => setSelectedReturn(ret)}>View Details</s-button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Toolbar */}
        {totalPages > 1 && (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: "16px",
              paddingTop: "12px",
              borderTop: "1px solid #e1e3e5",
            }}
          >
            <s-text tone="neutral">
              Showing {startIndex + 1} to {Math.min(startIndex + itemsPerPage, filteredReturns.length)}{" "}
              of {filteredReturns.length} returns
            </s-text>
            <s-stack direction="inline" gap="small">
              <s-button
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                {...(currentPage === 1 ? { disabled: true } : {})}
              >
                Previous
              </s-button>
              <s-button
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                {...(currentPage === totalPages ? { disabled: true } : {})}
              >
                Next
              </s-button>
            </s-stack>
          </div>
        )}
      </s-box>

      {/* Slide-out Return Details Drawer Overlay */}
      {selectedReturn && (
        <>
          {/* Backdrop wrapper */}
          <div
            onClick={() => setSelectedReturn(null)}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              backgroundColor: "rgba(0,0,0,0.3)",
              zIndex: 999,
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
              borderLeft: "1px solid #c9cccf",
            }}
          >
            {/* Header */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                borderBottom: "1px solid #f1f2f3",
                paddingBottom: "12px",
              }}
            >
              <div>
                <s-text tone="neutral">Return Request</s-text>
                <s-heading>{selectedReturn.id.substring(0, 12)}</s-heading>
              </div>
              <s-button variant="secondary" onClick={() => setSelectedReturn(null)}>
                Close
              </s-button>
            </div>

            {/* Fraud Risk Banner */}
            {selectedReturn.riskFlag.flagged && (
              <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <s-text tone="critical"><strong>⚠ Customer Flagged for Review</strong></s-text>
                  {selectedReturn.riskFlag.reasons.map((reason: string, idx: number) => (
                    <s-text key={idx} tone="neutral">{reason}</s-text>
                  ))}
                </div>
              </s-box>
            )}

            {/* Status Summary */}
            <s-box padding="base" background="subdued" borderRadius="base" borderWidth="base">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <s-text>Current Status:</s-text>
                <strong>
                  <s-text
                    tone={
                      selectedReturn.status === "COMPLETED" || selectedReturn.status === "APPROVED"
                        ? "success"
                        : selectedReturn.status === "PENDING"
                        ? "warning"
                        : "critical"
                    }
                  >
                    {selectedReturn.status}
                  </s-text>
                </strong>
              </div>
            </s-box>

            {/* Customer Info */}
            <div>
              <h3
                style={{
                  margin: "0 0 8px 0",
                  fontSize: "14px",
                  fontWeight: "bold",
                  textTransform: "uppercase",
                  color: "#6d7175",
                }}
              >
                Customer Details
              </h3>
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <strong>{selectedReturn.customerName}</strong>
                  <s-text>{selectedReturn.customerEmail}</s-text>
                </div>
              </s-box>
            </div>

            {/* Order Info */}
            <div>
              <h3
                style={{
                  margin: "0 0 8px 0",
                  fontSize: "14px",
                  fontWeight: "bold",
                  textTransform: "uppercase",
                  color: "#6d7175",
                }}
              >
                Order & Return Items
              </h3>
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="base">
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <s-text>Original Order:</s-text>
                    <strong>{selectedReturn.orderNumber}</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <s-text>Date Requested:</s-text>
                    <s-text>{selectedReturn.date}</s-text>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      borderBottom: "1px solid #f1f2f3",
                      paddingBottom: "8px",
                    }}
                  >
                    <s-text>Return Reason:</s-text>
                    <s-text tone="critical">
                      <strong>{selectedReturn.reason}</strong>
                    </s-text>
                  </div>

                  {/* Items List */}
                  {selectedReturn.items.map((item: any, idx: number) => (
                    <div
                      key={idx}
                      style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                    >
                      <div>
                        <div style={{ fontWeight: "bold" }}>{item.name}</div>
                        <div style={{ fontSize: "12px", color: "#6d7175" }}>
                          Reason: {item.reason}
                        </div>
                      </div>
                      <div style={{ whiteSpace: "nowrap" }}>x{item.quantity}</div>
                    </div>
                  ))}
                </s-stack>
              </s-box>
            </div>

            {/* Notes */}
            {selectedReturn.customerNote && (
              <div>
                <h3
                  style={{
                    margin: "0 0 8px 0",
                    fontSize: "14px",
                    fontWeight: "bold",
                    textTransform: "uppercase",
                    color: "#6d7175",
                  }}
                >
                  Customer Note
                </h3>
                <s-box padding="base" background="subdued" borderRadius="base">
                  <s-text>{selectedReturn.customerNote}</s-text>
                </s-box>
              </div>
            )}

            {/* Action Buttons Panel */}
            <div>
              <h3
                style={{
                  margin: "0 0 8px 0",
                  fontSize: "14px",
                  fontWeight: "bold",
                  textTransform: "uppercase",
                  color: "#6d7175",
                }}
              >
                Administrative Action
              </h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "4px" }}>
                {selectedReturn.status === "PENDING" ? (
                  <>
                    <s-button
                      variant="primary"
                      onClick={() => handleUpdateStatus(selectedReturn.id, "APPROVED")}
                    >
                      Approve Return
                    </s-button>
                    <s-button
                      variant="secondary"
                      tone="critical"
                      onClick={() => handleUpdateStatus(selectedReturn.id, "REJECTED")}
                    >
                      Reject Return
                    </s-button>
                  </>
                ) : selectedReturn.status === "APPROVED" ? (
                  <>
                    <s-button
                      variant="primary"
                      onClick={() => handleUpdateStatus(selectedReturn.id, "COMPLETED")}
                    >
                      Mark Completed
                    </s-button>
                  </>
                ) : selectedReturn.status === "COMPLETED" ? (
                  <s-text tone="neutral">Return is closed.</s-text>
                ) : (
                  <s-text tone="neutral">No outstanding actions.</s-text>
                )}
              </div>
            </div>

            {/* Timeline */}
            <div>
              <h3
                style={{
                  margin: "0 0 8px 0",
                  fontSize: "14px",
                  fontWeight: "bold",
                  textTransform: "uppercase",
                  color: "#6d7175",
                }}
              >
                Activity History
              </h3>
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="base">
                  {selectedReturn.timeline.map((evt, idx) => (
                    <div
                      key={idx}
                      style={{
                        display: "flex",
                        gap: "12px",
                        borderLeft: "2px solid #e1e3e5",
                        paddingLeft: "12px",
                        position: "relative",
                      }}
                    >
                      {/* Node Bullet */}
                      <div
                        style={{
                          position: "absolute",
                          left: "-6px",
                          top: "2px",
                          width: "10px",
                          height: "10px",
                          borderRadius: "50%",
                          backgroundColor: idx === 0 ? "#5c6ac4" : "#c9cccf",
                        }}
                      />
                      <div style={{ display: "flex", flexDirection: "column" }}>
                        <strong style={{ fontSize: "13px" }}>{evt.title}</strong>
                        <span style={{ fontSize: "12px", color: "#6d7175" }}>{evt.description}</span>
                        <span style={{ fontSize: "11px", color: "#8c9196", marginTop: "2px" }}>
                          {evt.date}
                        </span>
                      </div>
                    </div>
                  ))}
                </s-stack>
              </s-box>
            </div>
          </div>
        </>
      )}

      {/* MANUAL RETURN CREATION MODAL */}
      {isCreateModalOpen && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100vw",
            height: "100vh",
            backgroundColor: "rgba(15, 23, 42, 0.6)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: "16px",
              padding: "24px",
              maxWidth: "600px",
              width: "90%",
              maxHeight: "85vh",
              overflowY: "auto",
              boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <s-heading>Create Manual Return Request</s-heading>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                style={{ background: "none", border: "none", fontSize: "18px", cursor: "pointer", color: "#64748b" }}
              >
                ✕
              </button>
            </div>

            {!showConfirmStep ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                {/* 1. Select Store Order */}
                <div>
                  <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "6px" }}>
                    Select Order *
                  </label>
                  <select
                    value={selectedOrderId}
                    onChange={(e) => handleOrderChange(e.target.value)}
                    style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1px solid #cbd5e1" }}
                  >
                    <option value="">-- Choose an order --</option>
                    {dbOrders.map((o: any) => (
                      <option key={o.shopifyOrderId} value={o.shopifyOrderId}>
                        {o.orderNumber} ({o.customerName || o.customerEmail || "Guest"}) - ${Number(o.totalPrice).toFixed(2)}
                      </option>
                    ))}
                  </select>
                </div>

                {selectedOrder && (
                  <>
                    {/* 2. Pick Items to Return */}
                    <div>
                      <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "6px" }}>
                        Select Items to Return *
                      </label>
                      <div style={{ border: "1px solid #e2e8f0", borderRadius: "8px", padding: "12px", background: "#f8fafc" }}>
                        {(selectedOrder.lineItems as any[]).map((item: any) => {
                          const isSelected = !!selectedItems[item.lineItemId];
                          return (
                            <div
                              key={item.lineItemId}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "12px",
                                padding: "8px 0",
                                borderBottom: "1px solid #e2e8f0",
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => handleItemToggle(item)}
                              />
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: "13.5px", fontWeight: 600 }}>{item.title}</div>
                                <div style={{ fontSize: "12px", color: "#64748b" }}>
                                  Qty: {item.quantity} | Price: ${Number(item.price).toFixed(2)}
                                </div>
                              </div>
                              {isSelected && (
                                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                                  <input
                                    type="number"
                                    min="1"
                                    max={item.quantity}
                                    value={selectedItems[item.lineItemId]?.quantity ?? 1}
                                    onChange={(e) =>
                                      handleItemQuantityChange(item.lineItemId, parseInt(e.target.value, 10) || 1)
                                    }
                                    style={{ width: "50px", padding: "4px 8px", fontSize: "12px" }}
                                  />
                                  <select
                                    value={selectedItems[item.lineItemId]?.reason ?? "DEFECTIVE"}
                                    onChange={(e) => handleItemReasonChange(item.lineItemId, e.target.value)}
                                    style={{ padding: "4px 8px", fontSize: "12px" }}
                                  >
                                    <option value="DEFECTIVE">Defective</option>
                                    <option value="SIZE_TOO_SMALL">Size Too Small</option>
                                    <option value="SIZE_TOO_LARGE">Size Too Large</option>
                                    <option value="WRONG_ITEM">Wrong Item Sent</option>
                                    <option value="CHANGED_MIND">Buyer Remorse</option>
                                  </select>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* 3. Refund Amount & Notes */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                      <div>
                        <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "6px" }}>
                          Refund Amount ($)
                        </label>
                        <input
                          type="text"
                          value={refundAmountInput}
                          onChange={(e) => setRefundAmountInput(e.target.value)}
                          style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1px solid #cbd5e1" }}
                        />
                      </div>
                      <div>
                        <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "6px" }}>
                          Main Return Reason
                        </label>
                        <select
                          value={returnReasonInput}
                          onChange={(e) => setReturnReasonInput(e.target.value)}
                          style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1px solid #cbd5e1" }}
                        >
                          <option value="DEFECTIVE">Defective Item</option>
                          <option value="SIZE_TOO_SMALL">Size Too Small</option>
                          <option value="SIZE_TOO_LARGE">Size Too Large</option>
                          <option value="WRONG_ITEM">Wrong Item Sent</option>
                          <option value="CHANGED_MIND">Buyer Remorse</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "6px" }}>
                        Admin / Merchant Note
                      </label>
                      <input
                        type="text"
                        placeholder="Internal note for merchant record..."
                        value={adminNoteInput}
                        onChange={(e) => setAdminNoteInput(e.target.value)}
                        style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1px solid #cbd5e1" }}
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
                  </>
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
        </div>
      )}

      {/* Basic Hover Row Styling */}
      <style>{`
        .hover-row:hover {
          background-color: #f9fafb !important;
        }
      `}</style>
    </s-page>
  );
}
