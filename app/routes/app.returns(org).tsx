import React, { useState } from "react";
import { mockReturns, MockReturn } from "../mocks/byndcartMocks";

export default function Returns() {
  // Local state for interactive features
  const [returnsList, setReturnsList] = useState<MockReturn[]>(mockReturns);
  const [selectedReturn, setSelectedReturn] = useState<MockReturn | null>(null);
  
  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [dateFilter, setDateFilter] = useState("");
  
  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 5;

  // Filter returns based on search, status, and date
  const filteredReturns = returnsList.filter((item) => {
    const matchesSearch =
      item.orderNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.customerEmail.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.id.toLowerCase().includes(searchQuery.toLowerCase());
      
    const matchesStatus = statusFilter === "All" || item.status === statusFilter;
    const matchesDate = !dateFilter || item.date === dateFilter;

    return matchesSearch && matchesStatus && matchesDate;
  });

  // Paginated returns
  const totalPages = Math.ceil(filteredReturns.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const paginatedReturns = filteredReturns.slice(startIndex, startIndex + itemsPerPage);

  // Status Action Handlers (local simulation)
  const handleUpdateStatus = (id: string, newStatus: MockReturn["status"]) => {
    const timeString = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateString = new Date().toLocaleDateString();

    const updatedList = returnsList.map((item) => {
      if (item.id === id) {
        const updatedItem = {
          ...item,
          status: newStatus,
          timeline: [
            {
              status: newStatus,
              title: `Return ${newStatus}`,
              description: `Status updated to ${newStatus} via Admin UI.`,
              date: `${dateString} ${timeString}`
            },
            ...item.timeline
          ]
        };
        // Update selectedReturn view in real-time
        if (selectedReturn?.id === id) {
          setSelectedReturn(updatedItem);
        }
        return updatedItem;
      }
      return item;
    });

    setReturnsList(updatedList);
  };

  return (
    <s-page heading="Return Requests">
      
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
                  fontSize: "14px"
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
                  fontSize: "14px"
                }}
              >
                <option value="All">All Statuses</option>
                <option value="Pending">Pending</option>
                <option value="Approved">Approved</option>
                <option value="In Transit">In Transit</option>
                <option value="Received">Received</option>
                <option value="Completed">Completed</option>
                <option value="Rejected">Rejected</option>
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
                  fontSize: "14px"
                }}
              />
            </div>

            {/* Clear Filters Button */}
            {(searchQuery || statusFilter !== "All" || dateFilter) && (
              <s-button onClick={() => {
                setSearchQuery("");
                setStatusFilter("All");
                setDateFilter("");
                setCurrentPage(1);
              }}>
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
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 0", width: "100%" }}>
              <s-heading>No Returns Match Search/Filters</s-heading>
              <s-paragraph tone="neutral">Adjust your queries or filters and try again.</s-paragraph>
            </div>
          </s-stack>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                  <th style={{ padding: "12px 8px" }}><s-text tone="neutral">Return ID</s-text></th>
                  <th style={{ padding: "12px 8px" }}><s-text tone="neutral">Order</s-text></th>
                  <th style={{ padding: "12px 8px" }}><s-text tone="neutral">Customer</s-text></th>
                  <th style={{ padding: "12px 8px" }}><s-text tone="neutral">Items</s-text></th>
                  <th style={{ padding: "12px 8px" }}><s-text tone="neutral">Reason</s-text></th>
                  <th style={{ padding: "12px 8px" }}><s-text tone="neutral">Status</s-text></th>
                  <th style={{ padding: "12px 8px" }}><s-text tone="neutral">Date</s-text></th>
                  <th style={{ padding: "12px 8px", textAlign: "right" }}><s-text tone="neutral">Action</s-text></th>
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
                      backgroundColor: selectedReturn?.id === ret.id ? "#f4f6f8" : "transparent"
                    }}
                    className="hover-row"
                  >
                    <td style={{ padding: "12px 8px" }}>
                      <strong>{ret.id}</strong>
                    </td>
                    <td style={{ padding: "12px 8px" }}>{ret.orderNumber}</td>
                    <td style={{ padding: "12px 8px" }}>
                      <div style={{ fontWeight: "bold" }}>{ret.customerName}</div>
                      <div style={{ fontSize: "12px", color: "#6d7175" }}>{ret.customerEmail}</div>
                    </td>
                    <td style={{ padding: "12px 8px" }}>
                      {ret.items.map((item) => `${item.name.split(" - ")[0]} (x${item.quantity})`).join(", ")}
                    </td>
                    <td style={{ padding: "12px 8px" }}>{ret.reason}</td>
                    <td style={{ padding: "12px 8px" }}>
                      <s-text tone={
                        ret.status === "Completed" || ret.status === "Approved"
                          ? "success"
                          : ret.status === "Pending" || ret.status === "In Transit"
                          ? "warning"
                          : "critical"
                      }>
                        {ret.status}
                      </s-text>
                    </td>
                    <td style={{ padding: "12px 8px" }}>{ret.date}</td>
                    <td style={{ padding: "12px 8px", textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
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
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "16px", paddingTop: "12px", borderTop: "1px solid #e1e3e5" }}>
            <s-text tone="neutral">Showing {startIndex + 1} to {Math.min(startIndex + itemsPerPage, filteredReturns.length)} of {filteredReturns.length} returns</s-text>
            <s-stack direction="inline" gap="small">
              <s-button onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} {...(currentPage === 1 ? { disabled: true } : {})}>
                Previous
              </s-button>
              <s-button onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} {...(currentPage === totalPages ? { disabled: true } : {})}>
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
                <s-text tone="neutral">Return Request</s-text>
                <s-heading>{selectedReturn.id}</s-heading>
              </div>
              <s-button variant="secondary" onClick={() => setSelectedReturn(null)}>✕ Close</s-button>
            </div>

            {/* Status Summary */}
            <s-box padding="base" background="subdued" borderRadius="base" borderWidth="base">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <s-text>Current Status:</s-text>
                <strong>
                  <s-text tone={
                    selectedReturn.status === "Completed" || selectedReturn.status === "Approved"
                      ? "success"
                      : selectedReturn.status === "Pending"
                      ? "warning"
                      : "critical"
                  }>
                    {selectedReturn.status}
                  </s-text>
                </strong>
              </div>
            </s-box>

            {/* Customer Info */}
            <div>
              <h3 style={{ margin: "0 0 8px 0", fontSize: "14px", fontWeight: "bold", textTransform: "uppercase", color: "#6d7175" }}>Customer Details</h3>
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <strong>{selectedReturn.customerName}</strong>
                  <s-text>{selectedReturn.customerEmail}</s-text>
                </div>
              </s-box>
            </div>

            {/* Order Info */}
            <div>
              <h3 style={{ margin: "0 0 8px 0", fontSize: "14px", fontWeight: "bold", textTransform: "uppercase", color: "#6d7175" }}>Order & Return Items</h3>
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
                  <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid #f1f2f3", paddingBottom: "8px" }}>
                    <s-text>Return Reason:</s-text>
                    <s-text tone="critical"><strong>{selectedReturn.reason}</strong></s-text>
                  </div>
                  
                  {/* Items List */}
                  {selectedReturn.items.map((item, idx) => (
                    <div key={idx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ fontWeight: "bold" }}>{item.name}</div>
                        <div style={{ fontSize: "12px", color: "#6d7175" }}>SKU: {item.sku}</div>
                      </div>
                      <div style={{ whiteSpace: "nowrap" }}>
                        {item.quantity} x ${item.price.toFixed(2)}
                      </div>
                    </div>
                  ))}
                </s-stack>
              </s-box>
            </div>

            {/* Notes */}
            {selectedReturn.customerNote && (
              <div>
                <h3 style={{ margin: "0 0 8px 0", fontSize: "14px", fontWeight: "bold", textTransform: "uppercase", color: "#6d7175" }}>Customer Note</h3>
                <s-box padding="base" background="subdued" borderRadius="base">
                  <s-text>{selectedReturn.customerNote}</s-text>
                </s-box>
              </div>
            )}

            {/* Action Buttons Panel */}
            <div>
              <h3 style={{ margin: "0 0 8px 0", fontSize: "14px", fontWeight: "bold", textTransform: "uppercase", color: "#6d7175" }}>Administrative Action</h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "4px" }}>
                {selectedReturn.status === "Pending" ? (
                  <>
                    <s-button variant="primary" onClick={() => handleUpdateStatus(selectedReturn.id, "Approved")}>
                      Approve Return
                    </s-button>
                    <s-button variant="secondary" tone="critical" onClick={() => handleUpdateStatus(selectedReturn.id, "Rejected")}>
                      Reject Return
                    </s-button>
                  </>
                ) : selectedReturn.status === "Approved" ? (
                  <>
                    <s-button variant="primary" onClick={() => handleUpdateStatus(selectedReturn.id, "In Transit")}>
                      Simulate Ship (In Transit)
                    </s-button>
                  </>
                ) : selectedReturn.status === "In Transit" ? (
                  <>
                    <s-button variant="primary" onClick={() => handleUpdateStatus(selectedReturn.id, "Received")}>
                      Mark Received at Warehouse
                    </s-button>
                  </>
                ) : selectedReturn.status === "Received" ? (
                  <>
                    <s-button variant="primary" onClick={() => handleUpdateStatus(selectedReturn.id, "Completed")}>
                      Process & Complete Refund
                    </s-button>
                  </>
                ) : (
                  <s-text tone="neutral">No outstanding actions. Return is closed.</s-text>
                )}
              </div>
            </div>

            {/* Timeline */}
            <div>
              <h3 style={{ margin: "0 0 8px 0", fontSize: "14px", fontWeight: "bold", textTransform: "uppercase", color: "#6d7175" }}>Activity History</h3>
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="base">
                  {selectedReturn.timeline.map((evt, idx) => (
                    <div key={idx} style={{ display: "flex", gap: "12px", borderLeft: "2px solid #e1e3e5", paddingLeft: "12px", position: "relative" }}>
                      {/* Node Bullet */}
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

      {/* Basic Hover Row Styling */}
      <style>{`
        .hover-row:hover {
          background-color: #f9fafb !important;
        }
      `}</style>

    </s-page>
  );
}
