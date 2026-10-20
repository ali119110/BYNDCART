import React, { useEffect, useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/app.exchanges";
import { requireTenantContext } from "../utils/tenant.server";
import { getExchangeRequests, updateExchangeStatus, approveExchangeWithDraftOrder, createExchangeRequest } from "../services/exchanges.server";
import { getCustomerRiskFlagsForEmails } from "../services/fraud.server";
import { assertRateLimit } from "../utils/rateLimit.server";
import { searchOrSyncOrders } from "../services/orders.server";
import { getShopifyStoreProducts } from "../services/products.server";
import prisma from "../db.server";

// ===== LOADER: Fetch exchanges and orders from database =====
export async function loader({ request }: Route.LoaderArgs) {
  const { shopifyStoreId, admin } = await requireTenantContext(request);

  try {
    const [exchanges, products] = await Promise.all([
      getExchangeRequests(shopifyStoreId),
      getShopifyStoreProducts({ shopifyStoreId, admin }),
    ]);
    const emails = exchanges.map((e: any) => e.customerEmail);
    const riskFlags = await getCustomerRiskFlagsForEmails(shopifyStoreId, emails);

    return { exchanges, orders: [], products, riskFlags: Object.fromEntries(riskFlags) };
  } catch (error) {
    console.error("Failed to fetch exchanges:", error);
    return { exchanges: [], orders: [], products: [], riskFlags: {} as Record<string, { flagged: boolean; reasons: string[] }> };
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

  if (actionType === "SEARCH_ORDERS") {
    const query = String(formData.get("query") || "").trim();
    if (query.length < 2) return { query, orders: [] };
    try {
      return { query, orders: await searchOrSyncOrders({ shopifyStoreId, admin, query }) };
    } catch (error) {
      console.error("[Manual Exchange] Shopify search failed:", error);
      return { query, orders: [], error: error instanceof Error ? error.message : "Shopify order search failed. Please try again." };
    }
  }

  if (actionType === "SEARCH_PRODUCTS") {
    return { products: await getShopifyStoreProducts({ shopifyStoreId, admin, query: String(formData.get("query") || "") }) };
  }

  // Manual creation creates a PENDING request only. Approval and warehouse
  // inspection drive the replacement-order timing configured in Settings.
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
      if (parsedItems.some((item: any) => !String(item.replacementVariantId || "").startsWith("gid://shopify/ProductVariant/"))) {
        return { error: "Select a valid Shopify product variant for every replacement item" };
      }

      // 1. Create exchange request record in database
      const exchangeRequest = await createExchangeRequest({
        shopifyStoreId,
        shopifyOrderId: order.shopifyOrderId,
        orderNumber: order.orderNumber,
        customerEmail: order.customerEmail || "",
        customerName: order.customerName || undefined,
        requestSource: "MERCHANT",
        reason: String(formData.get("reason") || "Merchant-created exchange"),
        customerNote: "Created manually by store merchant admin",
        adminNote: "Created manually via merchant dashboard",
        policyOverrideReason: String(formData.get("policyOverrideReason") || ""),
        items: parsedItems,
      });

      return { success: true, exchange: exchangeRequest, message: "Exchange request created as pending merchant review. No courier shipment was booked." };
    } catch (error) {
      console.error("Failed to create manual exchange:", error);
      return { error: String(error) };
    }
  }

  // Handle Status Updates
  const exchangeId = formData.get("exchangeId") as string;
  const newStatus = formData.get("status") as string;
  const newOrderNumber = formData.get("newOrderNumber") as string | null;
  const adminNote = String(formData.get("adminNote") || "").trim();

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
            newStatus as "PENDING" | "APPROVED" | "REJECTED" | "RECEIVED" | "INSPECTED" | "FULFILLED" | "COMPLETED" | "CANCELLED",
            undefined,
            newOrderNumber || undefined,
            undefined,
            admin,
            adminNote || undefined
          );

    return { success: true, exchange: updated };
  } catch (error) {
    console.error("Failed to update exchange:", error);
    return { error: String(error) };
  }
}

// ===== COMPONENT =====
export default function Exchanges() {
  const { exchanges: dbExchanges, products: initialProducts = [], riskFlags } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const orderSearchFetcher = useFetcher<typeof action>();
  const productSearchFetcher = useFetcher<typeof action>();
  const availableProducts = (productSearchFetcher.data as any)?.products ?? initialProducts;

  // Create Exchange Modal State
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [orderSearchQuery, setOrderSearchQuery] = useState("");
  const orderSearchResult = orderSearchFetcher.data as any;
  const activeSearchQuery = orderSearchQuery.trim();
  const availableOrders = activeSearchQuery.length >= 2 && orderSearchResult?.query === activeSearchQuery && Array.isArray(orderSearchResult.orders) ? orderSearchResult.orders : [];
  const isSearchingOrders = orderSearchFetcher.state !== "idle" && orderSearchFetcher.formData?.get("actionType") === "SEARCH_ORDERS";

  useEffect(() => {
    const query = orderSearchQuery.trim();
    if (query.length < 2) return;
    const timer = setTimeout(() => {
      orderSearchFetcher.submit({ actionType: "SEARCH_ORDERS", query }, { method: "post" });
    }, 350);
    return () => clearTimeout(timer);
  }, [orderSearchQuery]);
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [exchangeItems, setExchangeItems] = useState<
    Record<
      string,
      {
        originalQuantity: number;
        replacementTitle: string;
        replacementVariantId: string;
        replacementQuantity: number;
        replacementPrice: number;
        priceDifference: number;
      }
    >
  >({});
  const [isConfirmStep, setIsConfirmStep] = useState(false);
  const [policyOverrideReasonInput, setPolicyOverrideReasonInput] = useState("");
  const [exchangeReasonInput, setExchangeReasonInput] = useState("Size Mismatch");
  const formatBalance = (balance: number, currency = "USD") => balance > 0 ? `+${currency} ${balance.toFixed(2)} (Customer Balance Owed)` : balance < 0 ? `-${currency} ${Math.abs(balance).toFixed(2)} (Merchant refund/credit pending)` : `${currency} 0.00 (Even Exchange)`;

  // Selected Order for Modal
  const selectedOrder = availableOrders.find((o: any) => o.shopifyOrderId === selectedOrderId);
  const isSubmitting = fetcher.state !== "idle" && fetcher.formData?.get("actionType") === "CREATE_MANUAL_EXCHANGE";

  // Shopify search returns matching records; do not hide matches with a second client-side filter.
  const filteredOrders = availableOrders;

  const handleOrderSelect = (ord: any) => {
    setSelectedOrderId(ord.shopifyOrderId);
    setExchangeItems({});
    setIsConfirmStep(false);
    setPolicyOverrideReasonInput("");
    setExchangeReasonInput("Size Mismatch");
  };

  // Convert DB data to UI format
  const exchangesList = dbExchanges.map((exc: any) => ({
    id: exc.id,
    originalOrder: exc.orderNumber,
    currency: exc.currency || "USD",
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
    newOrderId: String(exc.newOrderId || "").startsWith("gid://shopify/Order/") ? exc.newOrderId : null,
    newOrderNumber: String(exc.newOrderId || "").startsWith("gid://shopify/Order/") ? exc.newOrderNumber : null,
    pendingReplacementDraft: String(exc.newOrderId || "").startsWith("gid://shopify/DraftOrder/"),
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
    timeline: (exc.auditHistory || []).map((entry: any) => ({
      status: entry.action,
      title: String(entry.action || "AUDIT EVENT").replaceAll("_", " "),
      description: entry.metadata ? JSON.stringify(entry.metadata) : "Recorded in audit history",
      date: new Date(entry.createdAt).toLocaleString(),
    })).concat((exc.auditHistory || []).length ? [] : [{
      status: exc.status,
      title: `Exchange ${exc.status}`,
      description: `Current status: ${exc.status}`,
      date: new Date(exc.updatedAt).toLocaleString(),
    }]),
  }));

  // Local state for interactive features
  const [selectedExchange, setSelectedExchange] = useState<(typeof exchangesList)[0] | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");

  const filteredExchanges = exchangesList.filter((item) => {
    const matchesSearch =
      item.originalOrder.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.customerEmail.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.id.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus = statusFilter === "All" || item.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const handleUpdateStatus = (id: string, newStatus: string) => {
    if (newStatus === "COMPLETED") {
      const confirmation = window.prompt("Confirm the replacement has been delivered. Add a note or reference:", "") || "";
      if (confirmation.trim().length < 2) return;
      fetcher.submit({ exchangeId: id, status: newStatus, adminNote: confirmation }, { method: "POST" });
      return;
    }
    fetcher.submit({ exchangeId: id, status: newStatus }, { method: "POST" });
  };

  const handleToggleItem = (lineItemId: string, defaultTitle: string) => {
    setExchangeItems((prev) => {
      const next = { ...prev };
      if (next[lineItemId]) {
        delete next[lineItemId];
      } else {
        next[lineItemId] = {
          originalQuantity: 1,
          replacementTitle: `${defaultTitle} (Replacement Variant)`,
          replacementVariantId: "",
          replacementQuantity: 1,
          replacementPrice: 0,
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
    setOrderSearchQuery("");
    setExchangeItems({});
    setIsConfirmStep(false);
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrder) return;

    const items = Object.entries(exchangeItems).map(([lineItemId, data]) => ({
      originalLineItemId: lineItemId,
      originalQuantity: Number(data.originalQuantity) || 1,
      replacementVariantId: data.replacementVariantId,
      replacementQuantity: Number(data.replacementQuantity) || 1,
      replacementTitle: data.replacementTitle || "Replacement Item",
      replacementPrice: Number(data.replacementPrice) || 0,
      originalPrice: Number(selectedOrder.lineItems.find((item: any) => item.lineItemId === lineItemId)?.price) || 0,
      priceDifference: (Number(data.replacementPrice) || 0) * (Number(data.replacementQuantity) || 1) - (Number(selectedOrder.lineItems.find((item: any) => item.lineItemId === lineItemId)?.price) || 0) * (Number(data.originalQuantity) || 1),
    }));

    fetcher.submit(
      {
        actionType: "CREATE_MANUAL_EXCHANGE",
        shopifyOrderId: selectedOrder.shopifyOrderId,
        reason: exchangeReasonInput,
        policyOverrideReason: policyOverrideReasonInput,
        items: JSON.stringify(items),
      },
      { method: "POST" }
    );
  };

  const isApproving = fetcher.state !== "idle" && fetcher.formData?.get("status") === "APPROVED";

  return (
    <div className="bc-page">
      <header className="bc-header">
        <div className="bc-page-bar">
          <div className="bc-header-copy">
            <p className="bc-eyebrow">REQUESTS</p>
            <h1>Exchange requests</h1>
            <p>Approve requests, receive and inspect the original item in Warehouse, then track the replacement order.</p>
          </div>
          <button type="button" className="bc-btn primary" onClick={() => setIsCreateModalOpen(true)}>
            Create exchange
          </button>
        </div>
      </header>

      <section className="bc-card bc-toolbar">
          <div className="bc-grow">
            <input
              type="text"
              placeholder="Search by order, customer, or email"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="All">All Statuses</option>
              <option value="PENDING">Pending</option>
              <option value="APPROVED">Approved</option>
              <option value="RECEIVED">Received at warehouse</option>
              <option value="INSPECTED">Inspected</option>
              <option value="FULFILLED">Fulfilled</option>
              <option value="COMPLETED">Completed</option>
              <option value="REJECTED">Rejected</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>
      </section>

      <section className="bc-table-wrap">
        {filteredExchanges.length === 0 ? (
          <div className="bc-empty-state">
            <strong>No exchange requests</strong>
            <p>Try another search or status.</p>
          </div>
        ) : (
          <div>
            <table className="bc-table">
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                  <th style={{ padding: "12px 16px", fontSize: "11.5px", color: "#64748b", textTransform: "uppercase" }}>Exchange ID</th>
                  <th style={{ padding: "12px 16px", fontSize: "11.5px", color: "#64748b", textTransform: "uppercase" }}>Original Order</th>
                  <th style={{ padding: "12px 16px", fontSize: "11.5px", color: "#64748b", textTransform: "uppercase" }}>Customer</th>
                  <th style={{ padding: "12px 16px", fontSize: "11.5px", color: "#64748b", textTransform: "uppercase" }}>Replacement Order</th>
                  <th style={{ padding: "12px 16px", fontSize: "11.5px", color: "#64748b", textTransform: "uppercase" }}>Status</th>
                  <th style={{ padding: "12px 16px", fontSize: "11.5px", color: "#64748b", textTransform: "uppercase" }}>Date</th>
                  <th style={{ padding: "12px 16px", fontSize: "11.5px", color: "#64748b", textTransform: "uppercase", textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredExchanges.map((exc) => (
                  <tr
                    key={exc.id}
                    onClick={() => setSelectedExchange(exc)}
                    style={{
                      borderBottom: "1px solid #f1f5f9",
                      cursor: "pointer",
                      backgroundColor: selectedExchange?.id === exc.id ? "#f8fafc" : "transparent",
                    }}
                  >
                    <td style={{ padding: "12px 16px", fontWeight: 700, color: "#0f172a" }}>#{exc.id.substring(0, 8)}</td>
                    <td style={{ padding: "12px 16px", fontWeight: 600 }}>{exc.originalOrder}</td>
                    <td style={{ padding: "12px 16px" }}>
                      <div style={{ fontWeight: 600, color: "#1e293b" }}>{exc.customerName}</div>
                      <div style={{ fontSize: "12px", color: "#64748b" }}>{exc.customerEmail}</div>
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      {exc.newOrderNumber ? (
                        <span style={{ fontWeight: 700, color: "#6366f1" }}>{exc.newOrderNumber}</span>
                      ) : (
                        <span style={{ color: "#64748b", fontSize: "12px" }}>{exc.status === "PENDING" ? "Pending approval" : exc.status === "INSPECTED" || exc.pendingReplacementDraft ? "Needs replacement retry" : "Created per workflow timing"}</span>
                      )}
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      <span
                        style={{
                          fontSize: "11.5px",
                          fontWeight: 700,
                          padding: "3px 10px",
                          borderRadius: "12px",
                          backgroundColor:
                            exc.status === "APPROVED" || exc.status === "COMPLETED" || exc.status === "FULFILLED"
                              ? "#dcfce7"
                              : exc.status === "PENDING"
                              ? "#fef3c7"
                              : "#fee2e2",
                          color:
                            exc.status === "APPROVED" || exc.status === "COMPLETED" || exc.status === "FULFILLED"
                              ? "#15803d"
                              : exc.status === "PENDING"
                              ? "#d97706"
                              : "#b91c1c",
                        }}
                      >
                        {exc.status}
                      </span>
                    </td>
                    <td style={{ padding: "12px 16px", fontSize: "13px", color: "#64748b" }}>{exc.date}</td>
                    <td style={{ padding: "12px 16px", textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: "flex", justifyContent: "flex-end", gap: "6px", flexWrap: "wrap" }}>
                        <button type="button" className="bc-btn" onClick={() => setSelectedExchange(exc)}>View</button>
                        {exc.status === "PENDING" ? <>
                          <button type="button" className="bc-btn primary" onClick={() => handleUpdateStatus(exc.id, "APPROVED")}>Approve</button>
                          <button type="button" className="bc-btn" onClick={() => handleUpdateStatus(exc.id, "REJECTED")}>Reject</button>
                        </> : null}
                        {exc.status === "FULFILLED" ? <button type="button" className="bc-btn primary" onClick={() => handleUpdateStatus(exc.id, "COMPLETED")}>Mark delivered</button> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Advanced Search Autocomplete Manual Exchange Modal */}
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
              width: "min(900px, calc(100vw - 24px))",
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
                {isConfirmStep ? "Confirm exchange request" : "Create Manual Exchange"}
              </h2>
              <button onClick={handleCloseModal} style={{ padding: "4px 10px", fontSize: "12px" }}>
                ✕ Close
              </button>
            </div>

            {fetcher.data?.error ? <p role="alert" style={{ color: "#b91c1c", background: "#fef2f2", padding: "10px 12px", borderRadius: "8px" }}>{fetcher.data.error}</p> : null}
            {fetcher.data?.success && fetcher.data?.message ? <p role="status" style={{ color: "#047857", background: "#ecfdf5", padding: "10px 12px", borderRadius: "8px" }}>{fetcher.data.message} You can close this panel when ready.</p> : null}
            <form onSubmit={handleCreateSubmit}>
              {!isConfirmStep ? (
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

                    {!selectedOrder && (
                      <div style={{ maxHeight: "280px", overflowY: "auto", overflowX: "hidden", border: "1px solid #e2e8f0", borderRadius: "10px", background: "#fff" }}>
                        {activeSearchQuery.length < 2 ? (
                          <div style={{ padding: "18px 14px", color: "#64748b", fontSize: "13px", textAlign: "center" }}>Start typing at least 2 characters to search Shopify orders. No orders are loaded until you search.</div>
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
                    {/* Selected Order Summary */}
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

                  {selectedOrder && (
                    <div style={{ display: "grid", gap: "12px" }}>
                      <div>
                        <label style={{ display: "block", fontWeight: 700, fontSize: "12.5px", marginBottom: "4px", color: "#475569" }}>Exchange reason</label>
                        <select value={exchangeReasonInput} onChange={(e) => setExchangeReasonInput(e.target.value)} style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: "8px" }}>
                          <option value="Size Mismatch">Size mismatch</option>
                          <option value="Defective / Damaged">Defective / damaged</option>
                          <option value="Wrong Item Received">Wrong item received</option>
                          <option value="Changed Mind">Changed mind</option>
                          <option value="Other">Other</option>
                        </select>
                      </div>
                      <div>
                      <label style={{ display: "block", fontWeight: 700, fontSize: "12.5px", marginBottom: "4px", color: "#475569" }}>
                        Policy override reason (only required if the order is outside policy)
                      </label>
                      <textarea
                        value={policyOverrideReasonInput}
                        onChange={(e) => setPolicyOverrideReasonInput(e.target.value)}
                        placeholder="Explain why this exchange should proceed despite policy eligibility..."
                        rows={2}
                        style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: "8px" }}
                      />
                      </div>
                    </div>
                  )}

                  {/* Product A -> Product B Diff Grid */}
                  {selectedOrder && (
                    <div>
                      <label style={{ display: "block", fontWeight: 700, fontSize: "13.5px", marginBottom: "8px", color: "#0f172a" }}>
                        Product A (Original) → Product B (Replacement Item) *
                      </label>
                      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        {((selectedOrder as any).lineItems || []).map((li: any) => {
                          const isSelected = Boolean(exchangeItems[li.lineItemId]);
                          const itemData = exchangeItems[li.lineItemId] || {};
                          const selectedProduct = availableProducts.find((product: any) => product.shopifyVariantId === itemData.replacementVariantId);

                          return (
                            <div
                              key={li.lineItemId}
                              style={{
                                border: isSelected ? "2px solid #10b981" : "1px solid #e2e8f0",
                                borderRadius: "12px",
                                padding: "16px",
                                backgroundColor: isSelected ? "#f0fdf4" : "#ffffff",
                              }}
                            >
                              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                                <input
                                  type="checkbox"
                                  id={`exc-item-${li.lineItemId}`}
                                  checked={isSelected}
                                  onChange={() => handleToggleItem(li.lineItemId, li.title)}
                                  style={{ width: "18px", height: "18px", cursor: "pointer" }}
                                />
                                {li.imageUrl ? <img src={li.imageUrl} alt={li.title || "Original product"} loading="lazy" style={{ width: "64px", height: "72px", objectFit: "cover", borderRadius: "8px", background: "#f1f2f3", flex: "0 0 auto" }} /> : <span aria-label="Product image unavailable" style={{ width: "64px", height: "72px", borderRadius: "8px", background: "#f1f2f3", flex: "0 0 auto" }} />}
                                <label htmlFor={`exc-item-${li.lineItemId}`} style={{ flex: 1, cursor: "pointer", minWidth: 0 }}>
                                  <div style={{ fontWeight: 650, fontSize: "14px", color: "#0f172a" }}>Original: {li.title}</div>
                                  <div style={{ fontSize: "12px", color: "#475569", marginTop: "3px" }}>{li.variantTitle && li.variantTitle !== "Default Title" ? `Current variant / size: ${li.variantTitle}` : "Current variant / size: not available"}{li.sku ? ` · SKU ${li.sku}` : ""}</div>
                                  <div style={{ fontWeight: 600, fontSize: "12px", color: "#0f172a", marginTop: "3px" }}>{selectedOrder.currency || "USD"} {Number(li.price).toFixed(2)} · Available quantity: {li.quantity}</div>
                                </label>
                              </div>

                              {isSelected && (
                                <div style={{ marginTop: "14px", paddingTop: "14px", borderTop: "1px solid #bbf7d0", display: "flex", flexDirection: "column", gap: "12px" }}>
                                  <div style={{ fontSize: "12px", fontWeight: 700, color: "#15803d", textTransform: "uppercase" }}>
                                    ⇄ Replacement Product B Details
                                  </div>
                                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: "10px" }}>
                                    <div>
                                      <label style={{ fontSize: "12px", fontWeight: 700, color: "#475569" }}>Qty to Return</label>
                                      <input
                                        type="number"
                                        min="1"
                                        max={li.quantity}
                                        value={itemData.originalQuantity}
                                        onChange={(e) => handleItemChange(li.lineItemId, "originalQuantity", parseInt(e.target.value) || 1)}
                                        style={{ width: "100%", padding: "6px 10px" }}
                                      />
                                    </div>
                                    <div>
                                      <label style={{ fontSize: "12px", fontWeight: 700, color: "#475569" }}>Search Replacement Product</label>
                                      <input type="search" placeholder="Search Shopify products by title or SKU" onChange={(e) => productSearchFetcher.submit({ actionType: "SEARCH_PRODUCTS", query: e.target.value }, { method: "post" })} style={{ width: "100%", padding: "6px 10px" }} />
                                      <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "240px", overflowY: "auto", marginTop: "8px" }}>
                                        {availableProducts.length === 0 ? (
                                          <span style={{ fontSize: "12px", color: "#64748b" }}>No Shopify products found for this store.</span>
                                        ) : availableProducts.map((product: any) => {
                                          const selected = itemData.replacementVariantId === product.shopifyVariantId;
                                          const variantLabel = [product.variantTitle, ...(product.options || []).map((option: any) => `${option.name}: ${option.value}`)].filter(Boolean).join(" · ");
                                          return (
                                            <button
                                              key={product.shopifyVariantId}
                                              type="button"
                                              onClick={() => {
                                                handleItemChange(li.lineItemId, "replacementVariantId", product.shopifyVariantId);
                                                handleItemChange(li.lineItemId, "replacementTitle", product.productTitle || product.title);
                                                handleItemChange(li.lineItemId, "replacementPrice", Number(product.price));
                                              }}
                                              style={{ display: "flex", gap: "10px", alignItems: "center", textAlign: "left", padding: "8px", borderRadius: "8px", border: selected ? "2px solid #10b981" : "1px solid #e2e8f0", background: selected ? "#f0fdf4" : "#fff", cursor: "pointer" }}
                                            >
                                              {product.imageUrl ? <img src={product.imageUrl} alt="" style={{ width: "48px", height: "48px", objectFit: "cover", borderRadius: "6px" }} /> : <span style={{ width: "48px", height: "48px", borderRadius: "6px", background: "#e2e8f0" }} />}
                                              <span style={{ minWidth: 0 }}>
                                                <strong style={{ display: "block", fontSize: "13px" }}>{product.productTitle || product.title}</strong>
                                                <span style={{ display: "block", fontSize: "12px", color: "#475569" }}>{variantLabel || "Default variant"}{product.sku ? ` · ${product.sku}` : ""}</span>
                                                <span style={{ display: "block", fontSize: "12px", fontWeight: 700, color: "#059669" }}>{selectedOrder.currency || "USD"} {Number(product.price).toFixed(2)}</span>
                                              </span>
                                            </button>
                                          );
                                        })}
                                      </div>
                                      {selectedProduct && <span style={{ fontSize: "12px", color: "#166534" }}>Selected: {selectedProduct.productTitle || selectedProduct.title} · {selectedOrder.currency || "USD"} {Number(selectedProduct.price).toFixed(2)}</span>}
                                    </div>
                                    <div>
                                      <label style={{ fontSize: "12px", fontWeight: 700, color: "#475569" }}>Replacement Quantity</label>
                                      <input
                                        type="number"
                                        min="1"
                                        value={itemData.replacementQuantity}
                                        onChange={(e) => handleItemChange(li.lineItemId, "replacementQuantity", parseInt(e.target.value) || 1)}
                                        style={{ width: "100%", padding: "6px 10px" }}
                                      />
                                    </div>
                                    <div>
                                      <label style={{ fontSize: "12px", fontWeight: 700, color: "#475569" }}>Exchange Balance ({selectedOrder.currency || "USD"})</label>
                                      <div style={{ padding: "8px 10px", fontWeight: 700 }}>{formatBalance(Number(itemData.replacementPrice || 0) * Number(itemData.replacementQuantity || 1) - Number(li.price || 0) * Number(itemData.originalQuantity || 1), selectedOrder.currency || "USD")}</div>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "12px" }}>
                    <button type="button" onClick={handleCloseModal}>Cancel</button>
                    <button
                      type="button"
                      disabled={!selectedOrder || Object.keys(exchangeItems).length === 0}
                      onClick={() => setIsConfirmStep(true)}
                      style={{
                        background: !selectedOrder || Object.keys(exchangeItems).length === 0 ? "#cbd5e1" : "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                        color: "#ffffff",
                        border: "none",
                        fontWeight: 600,
                        cursor: !selectedOrder || Object.keys(exchangeItems).length === 0 ? "not-allowed" : "pointer",
                      }}
                    >
                      Next: Review Confirmation →
                    </button>
                  </div>
                </div>
              ) : (
                /* Confirmation Screen */
                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <div style={{ backgroundColor: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "12px", padding: "18px" }}>
                    <div style={{ fontWeight: 700, fontSize: "15px", color: "#0f172a", marginBottom: "8px" }}>Exchange request summary</div>
                    <div style={{ fontSize: "13.5px" }}><strong>Original Order:</strong> {selectedOrder?.orderNumber}</div>
                    <div style={{ fontSize: "13.5px" }}><strong>Customer Email:</strong> {selectedOrder?.customerEmail || "N/A"}</div>
                    <div style={{ fontSize: "13.5px", color: "#475569" }}><strong>Approval:</strong> Pending merchant approval. The replacement order follows your configured timing after approval or warehouse inspection.</div>
                    <hr style={{ border: "none", borderTop: "1px solid #e2e8f0", margin: "12px 0" }} />
                    <div style={{ fontWeight: 700, fontSize: "13.5px", marginBottom: "8px" }}>Product Replacements (A → B):</div>
                    {Object.entries(exchangeItems).map(([lineItemId, data]) => {
                      const orig = (selectedOrder?.lineItems || []).find((l: any) => l.lineItemId === lineItemId);
                      return (
                        <div key={lineItemId} style={{ fontSize: "13px", paddingLeft: "12px", borderLeft: "3px solid #10b981", marginBottom: "8px" }}>
                          <div>Product A (Original): <strong>{data.originalQuantity}x {orig?.title || lineItemId}</strong></div>
                          <div>Product B (Replacement): <strong>{data.replacementQuantity}x {data.replacementTitle}</strong></div>
                          <div>Exchange Balance: <strong>{formatBalance(Number(data.replacementPrice || 0) * Number(data.replacementQuantity || 1) - Number(orig?.price || 0) * Number(data.originalQuantity || 1), selectedOrder?.currency || "USD")}</strong></div>
                        </div>
                      );
                    })}
                  </div>

                  <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
                    <button type="button" onClick={() => setIsConfirmStep(false)}>← Back to Edit</button>
                    <button
                      type="submit"
                      disabled={isSubmitting}
                      style={{
                        background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                        color: "#ffffff",
                        border: "none",
                        fontWeight: 700,
                        padding: "9px 18px",
                        cursor: isSubmitting ? "not-allowed" : "pointer",
                      }}
                    >
                      {isSubmitting ? "Creating request..." : "Create pending exchange request"}
                    </button>
                  </div>
                </div>
              )}
            </form>
          </div>
        </>
      )}

      {/* Slide-out Exchange Drawer */}
      {selectedExchange && (
        <>
          <div
            onClick={() => setSelectedExchange(null)}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              backgroundColor: "rgba(15, 23, 42, 0.4)",
              zIndex: 999,
            }}
          />

          <div
            style={{
              position: "fixed",
              top: 0,
              right: 0,
              width: "min(460px, 100%)",
              height: "100%",
              backgroundColor: "#ffffff",
              boxShadow: "-4px 0 20px rgba(0,0,0,0.15)",
              zIndex: 1000,
              padding: "24px",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: "20px",
              borderLeft: "1px solid #cbd5e1",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #e2e8f0", paddingBottom: "12px" }}>
              <div>
                <span style={{ fontSize: "12px", color: "#64748b", textTransform: "uppercase" }}>Exchange Request</span>
                <h2 style={{ fontSize: "18px", fontWeight: 700, margin: 0, fontFamily: "Outfit, sans-serif" }}>#{selectedExchange.id.substring(0, 10)}</h2>
              </div>
              <button onClick={() => setSelectedExchange(null)} style={{ padding: "4px 10px" }}>Close</button>
            </div>

            <div>
              <h3 style={{ fontSize: "13px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", margin: "0 0 8px 0" }}>Shopify Replacement Order</h3>
              <div style={{ background: "#f8fafc", padding: "12px", borderRadius: "8px", border: "1px solid #e2e8f0", fontSize: "13.5px" }}>
                <div><strong>Replacement order:</strong> {selectedExchange.newOrderNumber || "Not created yet"}</div>
                <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>{selectedExchange.newOrderId ? "Linked to Shopify Admin" : selectedExchange.pendingReplacementDraft ? "Draft exists; finalization is pending" : "Creation follows merchant approval / inspection settings"}</div>
              </div>
            </div>
            <div>
              <h3 style={{ fontSize: "13px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", margin: "0 0 8px 0" }}>Exchange items</h3>
              <div style={{ display: "grid", gap: 8 }}>{selectedExchange.items.map((item: any) => <div key={item.id} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 10, fontSize: 12 }}><strong>{item.replacementTitle || item.replacementVariantId}</strong><div>Original line item: {item.originalLineItemId}</div><div>Quantity: {item.originalQuantity} → {item.replacementQuantity}</div><div>Price difference: {formatBalance(Number(item.priceDifference || 0), selectedExchange.currency || "USD")}</div></div>)}</div>
            </div>
            <div>
              <h3 style={{ fontSize: "13px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", margin: "0 0 8px 0" }}>Full audit history</h3>
              <div style={{ display: "grid", gap: 12 }}>{selectedExchange.timeline.map((event: any, index: number) => <div key={`${event.title}-${index}`} style={{ borderLeft: "2px solid #cbd5e1", paddingLeft: 12 }}><strong style={{ fontSize: 12 }}>{event.title}</strong><div style={{ color: "#64748b", fontSize: 11, marginTop: 3 }}>{event.date}</div><p style={{ color: "#334155", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "5px 0 0" }}>{event.description}</p></div>)}</div>
            </div>
          </div>
        </>
      )}
      <style>{`
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
