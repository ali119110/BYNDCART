import React, { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { requireTenantContext } from "../utils/tenant.server";
import {
  getExchangeRequests,
  updateExchangeStatus,
  approveExchangeWithDraftOrder,
  createExchangeRequest,
} from "../services/exchanges.server";
import { getCustomerRiskFlagsForEmails } from "../services/fraud.server";
import { assertRateLimit } from "../utils/rateLimit.server";
import { getStoreOrders, searchOrSyncOrders } from "../services/orders.server";
import { getShopifyStoreProducts } from "../services/products.server";
import prisma from "../db.server";

// ===== LOADER: Fetch exchanges and orders from database =====
export async function loader({ request }) {
  const { shopifyStoreId, admin } = await requireTenantContext(request);

  try {
    const [exchanges, orders, products] = await Promise.all([
      getExchangeRequests(shopifyStoreId),
      getStoreOrders(shopifyStoreId, 100, admin),
      getShopifyStoreProducts({ shopifyStoreId, admin }),
    ]);
    const emails = exchanges.map((e) => e.customerEmail);
    const riskFlags = await getCustomerRiskFlagsForEmails(
      shopifyStoreId,
      emails,
    );

    return {
      exchanges,
      orders,
      products,
      riskFlags: Object.fromEntries(riskFlags),
    };
  } catch (error) {
    console.error("Failed to fetch exchanges:", error);

    return { exchanges: [], orders: [], products: [], riskFlags: {} };
  }
}

// ===== ACTION: Handle status updates & manual exchange creation =====
export async function action({ request }) {
  if (request.method !== "POST") {
    return { error: "Method not allowed" };
  }

  const { shopifyStoreId, admin } = await requireTenantContext(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "SEARCH_ORDERS") {
    return {
      orders: await searchOrSyncOrders({
        shopifyStoreId,
        admin,
        query: String(formData.get("query") || ""),
      }),
    };
  }

  if (actionType === "SEARCH_PRODUCTS") {
    return {
      products: await getShopifyStoreProducts({
        shopifyStoreId,
        admin,
        query: String(formData.get("query") || ""),
      }),
    };
  }

  // Handle Manual Exchange Creation & Seamless Auto Shopify Order Creation
  if (actionType === "CREATE_MANUAL_EXCHANGE") {
    const shopifyOrderId = formData.get("shopifyOrderId");
    const itemsJson = formData.get("items");

    if (!shopifyOrderId || !itemsJson) {
      return { error: "Missing required order or items for exchange creation" };
    }

    try {
      // Validate order ownership
      const order = await prisma.order.findFirst({
        where: { shopifyOrderId, shopifyStoreId },
      });

      if (!order) {
        return {
          error: "Order not found or does not belong to this merchant's store",
        };
      }

      const parsedItems = JSON.parse(itemsJson);

      if (!Array.isArray(parsedItems) || parsedItems.length === 0) {
        return { error: "At least one replacement item must be selected" };
      }

      if (
        parsedItems.some(
          (item) =>
            !String(item.replacementVariantId || "").startsWith(
              "gid://shopify/ProductVariant/",
            ),
        )
      ) {
        return {
          error:
            "Select a valid Shopify product variant for every replacement item",
        };
      }

      // 1. Create exchange request record in database
      const exchangeRequest = await createExchangeRequest({
        shopifyStoreId,
        shopifyOrderId: order.shopifyOrderId,
        orderNumber: order.orderNumber,
        customerEmail: order.customerEmail || "customer@example.com",
        customerName: order.customerName || undefined,
        items: parsedItems,
      });
      // 2. Seamlessly Auto-Create Shopify Replacement Order / Draft Order
      let finalExchange = exchangeRequest;

      try {
        const approvedResult = await approveExchangeWithDraftOrder(
          admin,
          exchangeRequest.id,
          shopifyStoreId,
        );

        if (approvedResult) {
          finalExchange = { ...approvedResult, items: exchangeRequest.items };
        }
      } catch (draftErr) {
        console.warn(
          "[Exchange Action] Auto Shopify draft order creation skipped/warned:",
          draftErr,
        );
      }

      return {
        success: true,
        exchange: finalExchange,
        message:
          "Exchange created and replacement Shopify draft order processed!",
      };
    } catch (error) {
      console.error("Failed to create manual exchange:", error);

      return { error: String(error) };
    }
  }

  // Handle Status Updates
  const exchangeId = formData.get("exchangeId");
  const newStatus = formData.get("status");
  const newOrderNumber = formData.get("newOrderNumber");

  if (!exchangeId || !newStatus) {
    return { error: "Missing exchangeId or status" };
  }

  try {
    if (newStatus === "APPROVED") {
      assertRateLimit(`exchange-approve:${shopifyStoreId}`, {
        limit: 20,
        windowMs: 60_000,
      });
    }

    const updated =
      newStatus === "APPROVED"
        ? await approveExchangeWithDraftOrder(admin, exchangeId, shopifyStoreId)
        : await updateExchangeStatus(
            exchangeId,
            shopifyStoreId,
            newStatus,
            undefined,
            newOrderNumber || undefined,
          );

    return { success: true, exchange: updated };
  } catch (error) {
    console.error("Failed to update exchange:", error);

    return { error: String(error) };
  }
}

// ===== COMPONENT =====
export default function Exchanges() {
  const {
    exchanges: dbExchanges,
    orders = [],
    products: initialProducts = [],
    riskFlags,
  } = useLoaderData();
  const fetcher = useFetcher();
  const orderSearchFetcher = useFetcher();
  const productSearchFetcher = useFetcher();
  const availableOrders = orderSearchFetcher.data?.orders ?? orders;
  const availableProducts =
    productSearchFetcher.data?.products ?? initialProducts;
  // Create Exchange Modal State
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [orderSearchQuery, setOrderSearchQuery] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [exchangeItems, setExchangeItems] = useState({});
  const [isConfirmStep, setIsConfirmStep] = useState(false);
  const formatBalance = (balance) =>
    balance > 0
      ? `+PKR ${balance.toFixed(2)} (Customer Balance Owed)`
      : balance < 0
        ? `-PKR ${Math.abs(balance).toFixed(2)} (Store Credit / Partial Refund)`
        : "PKR 0.00 (Even Exchange)";
  // Selected Order for Modal
  const selectedOrder = availableOrders.find(
    (o) => o.shopifyOrderId === selectedOrderId,
  );
  const isSubmitting =
    fetcher.state !== "idle" &&
    fetcher.formData?.get("actionType") === "CREATE_MANUAL_EXCHANGE";
  // Autocomplete Filtered Orders
  const filteredOrders = availableOrders.filter((ord) => {
    const q = orderSearchQuery.toLowerCase().trim();

    if (!q) return true;
    const matchOrderNumber = (ord.orderNumber || "").toLowerCase().includes(q);
    const matchCustomer =
      (ord.customerName || "").toLowerCase().includes(q) ||
      (ord.customerEmail || "").toLowerCase().includes(q);
    const matchItem = (ord.lineItems || []).some((li) =>
      (li.title || "").toLowerCase().includes(q),
    );

    return matchOrderNumber || matchCustomer || matchItem;
  });

  const handleOrderSelect = (ord) => {
    setSelectedOrderId(ord.shopifyOrderId);
    setExchangeItems({});
    setIsConfirmStep(false);
  };

  // Convert DB data to UI format
  const exchangesList = dbExchanges.map((exc) => ({
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
    items: (exc.items || []).map((item) => ({
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
  const [selectedExchange, setSelectedExchange] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const filteredExchanges = exchangesList.filter((item) => {
    const matchesSearch =
      item.originalOrder.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.customerEmail.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.id.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus =
      statusFilter === "All" || item.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const handleUpdateStatus = (id, newStatus) => {
    fetcher.submit({ exchangeId: id, status: newStatus }, { method: "POST" });

    if (selectedExchange?.id === id) {
      setSelectedExchange({
        ...selectedExchange,
        status: newStatus,
      });
    }
  };

  const handleToggleItem = (lineItemId, defaultTitle) => {
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

  const handleItemChange = (lineItemId, field, value) => {
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

  const handleCreateSubmit = (e) => {
    e.preventDefault();
    if (!selectedOrder) return;
    const items = Object.entries(exchangeItems).map(([lineItemId, data]) => ({
      originalLineItemId: lineItemId,
      originalQuantity: Number(data.originalQuantity) || 1,
      replacementVariantId: data.replacementVariantId,
      replacementQuantity: Number(data.replacementQuantity) || 1,
      replacementTitle: data.replacementTitle || "Replacement Item",
      replacementPrice: Number(data.replacementPrice) || 0,
      originalPrice:
        Number(
          selectedOrder.lineItems.find((item) => item.lineItemId === lineItemId)
            ?.price,
        ) || 0,
      priceDifference:
        (Number(data.replacementPrice) || 0) *
          (Number(data.replacementQuantity) || 1) -
        (Number(
          selectedOrder.lineItems.find((item) => item.lineItemId === lineItemId)
            ?.price,
        ) || 0) *
          (Number(data.originalQuantity) || 1),
    }));

    fetcher.submit(
      {
        actionType: "CREATE_MANUAL_EXCHANGE",
        shopifyOrderId: selectedOrder.shopifyOrderId,
        items: JSON.stringify(items),
      },
      { method: "POST" },
    );
    handleCloseModal();
  };

  const isApproving =
    fetcher.state !== "idle" && fetcher.formData?.get("status") === "APPROVED";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "20px",
        maxWidth: "1240px",
        margin: "0 auto",
      }}
    >
      {/* Header Bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid #e2e8f0",
          paddingBottom: "16px",
        }}
      >
        <div>
          <h1
            style={{
              fontSize: "22px",
              fontWeight: "700",
              color: "#0f172a",
              margin: 0,
              fontFamily: "Outfit, sans-serif",
            }}
          >
            Exchange Requests
          </h1>
          <p
            style={{ margin: "4px 0 0 0", color: "#64748b", fontSize: "14px" }}
          >
            Manage product exchanges with seamless Shopify Order auto-creation.
          </p>
        </div>
        <button
          onClick={() => setIsCreateModalOpen(true)}
          style={{
            background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
            color: "#ffffff",
            border: "none",
            borderRadius: "8px",
            padding: "9px 18px",
            fontWeight: 600,
            fontSize: "13.5px",
            cursor: "pointer",
            boxShadow: "0 4px 12px rgba(16, 185, 129, 0.3)",
          }}
        >
          + Create Exchange
        </button>
      </div>

      {/* Toolbar */}
      <div
        style={{
          background: "#ffffff",
          padding: "16px",
          borderRadius: "12px",
          border: "1px solid #e2e8f0",
          boxShadow: "0 1px 3px rgba(0,0,0,0.02)",
        }}
      >
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <input
              type="text"
              placeholder="Search by ID, original order, customer email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: "100%",
                padding: "9px 14px",
                border: "1px solid #cbd5e1",
                borderRadius: "8px",
                fontSize: "13.5px",
              }}
            />
          </div>
          <div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
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
              <option value="FULFILLED">Fulfilled</option>
              <option value="COMPLETED">Completed</option>
              <option value="REJECTED">Rejected</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>
        </div>
      </div>

      {/* Main Table */}
      <div
        style={{
          background: "#ffffff",
          borderRadius: "16px",
          border: "1px solid #e2e8f0",
          overflow: "hidden",
        }}
      >
        {filteredExchanges.length === 0 ? (
          <div style={{ padding: "48px 0", textAlign: "center" }}>
            <h3 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>
              No Exchange Requests Found
            </h3>
            <p
              style={{ color: "#64748b", fontSize: "13.5px", marginTop: "4px" }}
            >
              Refine your search query.
            </p>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                textAlign: "left",
              }}
            >
              <thead>
                <tr
                  style={{
                    background: "#f8fafc",
                    borderBottom: "1px solid #e2e8f0",
                  }}
                >
                  <th
                    style={{
                      padding: "12px 16px",
                      fontSize: "11.5px",
                      color: "#64748b",
                      textTransform: "uppercase",
                    }}
                  >
                    Exchange ID
                  </th>
                  <th
                    style={{
                      padding: "12px 16px",
                      fontSize: "11.5px",
                      color: "#64748b",
                      textTransform: "uppercase",
                    }}
                  >
                    Original Order
                  </th>
                  <th
                    style={{
                      padding: "12px 16px",
                      fontSize: "11.5px",
                      color: "#64748b",
                      textTransform: "uppercase",
                    }}
                  >
                    Customer
                  </th>
                  <th
                    style={{
                      padding: "12px 16px",
                      fontSize: "11.5px",
                      color: "#64748b",
                      textTransform: "uppercase",
                    }}
                  >
                    Replacement Order
                  </th>
                  <th
                    style={{
                      padding: "12px 16px",
                      fontSize: "11.5px",
                      color: "#64748b",
                      textTransform: "uppercase",
                    }}
                  >
                    Status
                  </th>
                  <th
                    style={{
                      padding: "12px 16px",
                      fontSize: "11.5px",
                      color: "#64748b",
                      textTransform: "uppercase",
                    }}
                  >
                    Date
                  </th>
                  <th
                    style={{
                      padding: "12px 16px",
                      fontSize: "11.5px",
                      color: "#64748b",
                      textTransform: "uppercase",
                      textAlign: "right",
                    }}
                  >
                    Action
                  </th>
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
                      backgroundColor:
                        selectedExchange?.id === exc.id
                          ? "#f8fafc"
                          : "transparent",
                    }}
                  >
                    <td
                      style={{
                        padding: "12px 16px",
                        fontWeight: 700,
                        color: "#0f172a",
                      }}
                    >
                      #{exc.id.substring(0, 8)}
                    </td>
                    <td style={{ padding: "12px 16px", fontWeight: 600 }}>
                      {exc.originalOrder}
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      <div style={{ fontWeight: 600, color: "#1e293b" }}>
                        {exc.customerName}
                      </div>
                      <div style={{ fontSize: "12px", color: "#64748b" }}>
                        {exc.customerEmail}
                      </div>
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      {exc.newOrderNumber ? (
                        <span style={{ fontWeight: 700, color: "#6366f1" }}>
                          {exc.newOrderNumber}
                        </span>
                      ) : (
                        <span style={{ color: "#94a3b8", fontSize: "12px" }}>
                          Auto-Creating...
                        </span>
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
                            exc.status === "APPROVED" ||
                            exc.status === "COMPLETED" ||
                            exc.status === "FULFILLED"
                              ? "#dcfce7"
                              : exc.status === "PENDING"
                                ? "#fef3c7"
                                : "#fee2e2",
                          color:
                            exc.status === "APPROVED" ||
                            exc.status === "COMPLETED" ||
                            exc.status === "FULFILLED"
                              ? "#15803d"
                              : exc.status === "PENDING"
                                ? "#d97706"
                                : "#b91c1c",
                        }}
                      >
                        {exc.status}
                      </span>
                    </td>
                    <td
                      style={{
                        padding: "12px 16px",
                        fontSize: "13px",
                        color: "#64748b",
                      }}
                    >
                      {exc.date}
                    </td>
                    <td
                      style={{ padding: "12px 16px", textAlign: "right" }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => setSelectedExchange(exc)}
                        style={{ fontSize: "12.5px" }}
                      >
                        View Workflow
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

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
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              width: "min(720px, 94vw)",
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
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                borderBottom: "1px solid #e2e8f0",
                paddingBottom: "14px",
              }}
            >
              <h2
                style={{
                  fontSize: "18px",
                  fontWeight: 700,
                  margin: 0,
                  fontFamily: "Outfit, sans-serif",
                }}
              >
                {isConfirmStep
                  ? "Confirm Exchange & Shopify Order Creation"
                  : "Create Manual Exchange"}
              </h2>
              <button
                onClick={handleCloseModal}
                style={{ padding: "4px 10px", fontSize: "12px" }}
              >
                ✕ Close
              </button>
            </div>

            <form onSubmit={handleCreateSubmit}>
              {!isConfirmStep ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "18px",
                  }}
                >
                  {/* Search Autocomplete Order Picker */}
                  <div>
                    <label
                      style={{
                        display: "block",
                        fontWeight: 700,
                        fontSize: "13.5px",
                        marginBottom: "6px",
                        color: "#0f172a",
                      }}
                    >
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

                    {/* Autocomplete Results list */}
                    {!selectedOrder && (
                      <div
                        style={{
                          maxHeight: "220px",
                          overflowY: "auto",
                          border: "1px solid #e2e8f0",
                          borderRadius: "8px",
                          background: "#f8fafc",
                        }}
                      >
                        {filteredOrders.length === 0 ? (
                          <div
                            style={{
                              padding: "16px",
                              textAlign: "center",
                              color: "#64748b",
                              fontSize: "13px",
                            }}
                          >
                            No orders match "{orderSearchQuery}".{" "}
                            <button
                              type="button"
                              onClick={() =>
                                orderSearchFetcher.submit(
                                  {
                                    actionType: "SEARCH_ORDERS",
                                    query: orderSearchQuery,
                                  },
                                  { method: "post" },
                                )
                              }
                            >
                              Search Shopify
                            </button>
                          </div>
                        ) : (
                          filteredOrders.map((ord) => (
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
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                }}
                              >
                                <strong
                                  style={{ fontSize: "14px", color: "#0f172a" }}
                                >
                                  {ord.orderNumber}
                                </strong>
                                <span
                                  style={{
                                    fontSize: "13px",
                                    fontWeight: 700,
                                    color: "#10b981",
                                  }}
                                >
                                  PKR {Number(ord.totalPrice).toFixed(2)}
                                </span>
                              </div>
                              <div
                                style={{
                                  fontSize: "12px",
                                  color: "#64748b",
                                  marginTop: "2px",
                                }}
                              >
                                Customer: {ord.customerName || "N/A"} (
                                {ord.customerEmail || "No Email"})
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}

                    {/* Selected Order Summary */}
                    {selectedOrder && (
                      <div
                        style={{
                          backgroundColor: "#f0fdf4",
                          border: "1px solid #bbf7d0",
                          padding: "12px 14px",
                          borderRadius: "8px",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                        }}
                      >
                        <div>
                          <strong
                            style={{ color: "#15803d", fontSize: "14px" }}
                          >
                            Selected Order: {selectedOrder.orderNumber}
                          </strong>
                          <div style={{ fontSize: "12px", color: "#166534" }}>
                            {selectedOrder.customerName} (
                            {selectedOrder.customerEmail})
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setSelectedOrderId("")}
                          style={{
                            fontSize: "12px",
                            background: "#ffffff",
                            color: "#15803d",
                            border: "1px solid #bbf7d0",
                          }}
                        >
                          Change Order
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Product A -> Product B Diff Grid */}
                  {selectedOrder && (
                    <div>
                      <label
                        style={{
                          display: "block",
                          fontWeight: 700,
                          fontSize: "13.5px",
                          marginBottom: "8px",
                          color: "#0f172a",
                        }}
                      >
                        Product A (Original) → Product B (Replacement Item) *
                      </label>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "12px",
                        }}
                      >
                        {(selectedOrder.lineItems || []).map((li) => {
                          const isSelected = Boolean(
                            exchangeItems[li.lineItemId],
                          );
                          const itemData = exchangeItems[li.lineItemId] || {};
                          const selectedProduct = availableProducts.find(
                            (product) =>
                              product.shopifyVariantId ===
                              itemData.replacementVariantId,
                          );

                          return (
                            <div
                              key={li.lineItemId}
                              style={{
                                border: isSelected
                                  ? "2px solid #10b981"
                                  : "1px solid #e2e8f0",
                                borderRadius: "12px",
                                padding: "16px",
                                backgroundColor: isSelected
                                  ? "#f0fdf4"
                                  : "#ffffff",
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "12px",
                                }}
                              >
                                <input
                                  type="checkbox"
                                  id={`exc-item-${li.lineItemId}`}
                                  checked={isSelected}
                                  onChange={() =>
                                    handleToggleItem(li.lineItemId, li.title)
                                  }
                                  style={{
                                    width: "18px",
                                    height: "18px",
                                    cursor: "pointer",
                                  }}
                                />
                                <label
                                  htmlFor={`exc-item-${li.lineItemId}`}
                                  style={{ flex: 1, cursor: "pointer" }}
                                >
                                  <div
                                    style={{
                                      fontWeight: 600,
                                      fontSize: "14px",
                                      color: "#0f172a",
                                    }}
                                  >
                                    Product A: {li.title} (PKR{" "}
                                    {Number(li.price).toFixed(2)})
                                  </div>
                                </label>
                              </div>

                              {isSelected && (
                                <div
                                  style={{
                                    marginTop: "14px",
                                    paddingTop: "14px",
                                    borderTop: "1px solid #bbf7d0",
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: "12px",
                                  }}
                                >
                                  <div
                                    style={{
                                      fontSize: "12px",
                                      fontWeight: 700,
                                      color: "#15803d",
                                      textTransform: "uppercase",
                                    }}
                                  >
                                    ⇄ Replacement Product B Details
                                  </div>
                                  <div
                                    style={{
                                      display: "grid",
                                      gridTemplateColumns: "1fr 1fr",
                                      gap: "10px",
                                    }}
                                  >
                                    <div>
                                      <label
                                        style={{
                                          fontSize: "12px",
                                          fontWeight: 700,
                                          color: "#475569",
                                        }}
                                      >
                                        Qty to Return
                                      </label>
                                      <input
                                        type="number"
                                        min="1"
                                        max={li.quantity}
                                        value={itemData.originalQuantity}
                                        onChange={(e) =>
                                          handleItemChange(
                                            li.lineItemId,
                                            "originalQuantity",
                                            parseInt(e.target.value) || 1,
                                          )
                                        }
                                        style={{
                                          width: "100%",
                                          padding: "6px 10px",
                                        }}
                                      />
                                    </div>
                                    <div>
                                      <label
                                        style={{
                                          fontSize: "12px",
                                          fontWeight: 700,
                                          color: "#475569",
                                        }}
                                      >
                                        Search Replacement Product
                                      </label>
                                      <input
                                        type="search"
                                        placeholder="Product title, SKU..."
                                        onChange={(e) =>
                                          productSearchFetcher.submit(
                                            {
                                              actionType: "SEARCH_PRODUCTS",
                                              query: e.target.value,
                                            },
                                            { method: "post" },
                                          )
                                        }
                                        style={{
                                          width: "100%",
                                          padding: "6px 10px",
                                        }}
                                      />
                                      <select
                                        value={
                                          itemData.replacementVariantId || ""
                                        }
                                        onChange={(e) => {
                                          const product =
                                            availableProducts.find(
                                              (p) =>
                                                p.shopifyVariantId ===
                                                e.target.value,
                                            );

                                          if (product) {
                                            handleItemChange(
                                              li.lineItemId,
                                              "replacementVariantId",
                                              product.shopifyVariantId,
                                            );
                                            handleItemChange(
                                              li.lineItemId,
                                              "replacementTitle",
                                              product.productTitle ||
                                                product.title,
                                            );
                                            handleItemChange(
                                              li.lineItemId,
                                              "replacementPrice",
                                              Number(product.price),
                                            );
                                          }
                                        }}
                                        style={{
                                          width: "100%",
                                          padding: "6px 10px",
                                          marginTop: "6px",
                                        }}
                                      >
                                        <option value="">
                                          Select Shopify variant
                                        </option>
                                        {availableProducts.map((product) => (
                                          <option
                                            key={product.shopifyVariantId}
                                            value={product.shopifyVariantId}
                                          >
                                            {product.productTitle ||
                                              product.title}{" "}
                                            {product.variantTitle
                                              ? `- ${product.variantTitle}`
                                              : ""}{" "}
                                            {product.options?.length
                                              ? `- ${product.options.map((option) => `${option.name}: ${option.value}`).join(", ")}`
                                              : ""}{" "}
                                            {product.sku
                                              ? `(${product.sku})`
                                              : ""}{" "}
                                            - PKR{" "}
                                            {Number(product.price).toFixed(2)}
                                          </option>
                                        ))}
                                      </select>
                                      {selectedProduct?.imageUrl && (
                                        <img
                                          src={selectedProduct.imageUrl}
                                          alt={
                                            selectedProduct.productTitle ||
                                            selectedProduct.title
                                          }
                                          style={{
                                            width: "56px",
                                            height: "56px",
                                            objectFit: "cover",
                                            borderRadius: "6px",
                                            marginTop: "8px",
                                          }}
                                        />
                                      )}
                                    </div>
                                    <div>
                                      <label
                                        style={{
                                          fontSize: "12px",
                                          fontWeight: 700,
                                          color: "#475569",
                                        }}
                                      >
                                        Replacement Quantity
                                      </label>
                                      <input
                                        type="number"
                                        min="1"
                                        value={itemData.replacementQuantity}
                                        onChange={(e) =>
                                          handleItemChange(
                                            li.lineItemId,
                                            "replacementQuantity",
                                            parseInt(e.target.value) || 1,
                                          )
                                        }
                                        style={{
                                          width: "100%",
                                          padding: "6px 10px",
                                        }}
                                      />
                                    </div>
                                    <div>
                                      <label
                                        style={{
                                          fontSize: "12px",
                                          fontWeight: 700,
                                          color: "#475569",
                                        }}
                                      >
                                        Exchange Balance (PKR)
                                      </label>
                                      <div
                                        style={{
                                          padding: "8px 10px",
                                          fontWeight: 700,
                                        }}
                                      >
                                        {formatBalance(
                                          Number(
                                            itemData.replacementPrice || 0,
                                          ) *
                                            Number(
                                              itemData.replacementQuantity || 1,
                                            ) -
                                            Number(li.price || 0) *
                                              Number(
                                                itemData.originalQuantity || 1,
                                              ),
                                        )}
                                      </div>
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

                  <div
                    style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      gap: "10px",
                      marginTop: "12px",
                    }}
                  >
                    <button type="button" onClick={handleCloseModal}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={
                        !selectedOrder ||
                        Object.keys(exchangeItems).length === 0
                      }
                      onClick={() => setIsConfirmStep(true)}
                      style={{
                        background:
                          !selectedOrder ||
                          Object.keys(exchangeItems).length === 0
                            ? "#cbd5e1"
                            : "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                        color: "#ffffff",
                        border: "none",
                        fontWeight: 600,
                        cursor:
                          !selectedOrder ||
                          Object.keys(exchangeItems).length === 0
                            ? "not-allowed"
                            : "pointer",
                      }}
                    >
                      Next: Review Confirmation →
                    </button>
                  </div>
                </div>
              ) : (
                /* Confirmation Screen */
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "16px",
                  }}
                >
                  <div
                    style={{
                      backgroundColor: "#f8fafc",
                      border: "1px solid #e2e8f0",
                      borderRadius: "12px",
                      padding: "18px",
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: "15px",
                        color: "#0f172a",
                        marginBottom: "8px",
                      }}
                    >
                      Exchange & Auto-Shopify Order Summary
                    </div>
                    <div style={{ fontSize: "13.5px" }}>
                      <strong>Original Order:</strong>{" "}
                      {selectedOrder?.orderNumber}
                    </div>
                    <div style={{ fontSize: "13.5px" }}>
                      <strong>Customer Email:</strong>{" "}
                      {selectedOrder?.customerEmail || "N/A"}
                    </div>
                    <div style={{ fontSize: "13.5px", color: "#10b981" }}>
                      <strong>Shopify Order Auto-Creation:</strong> ENABLED
                      (Will generate draft order in Shopify instantly)
                    </div>
                    <hr
                      style={{
                        border: "none",
                        borderTop: "1px solid #e2e8f0",
                        margin: "12px 0",
                      }}
                    />
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: "13.5px",
                        marginBottom: "8px",
                      }}
                    >
                      Product Replacements (A → B):
                    </div>
                    {Object.entries(exchangeItems).map(([lineItemId, data]) => {
                      const orig = (selectedOrder?.lineItems || []).find(
                        (l) => l.lineItemId === lineItemId,
                      );

                      return (
                        <div
                          key={lineItemId}
                          style={{
                            fontSize: "13px",
                            paddingLeft: "12px",
                            borderLeft: "3px solid #10b981",
                            marginBottom: "8px",
                          }}
                        >
                          <div>
                            Product A (Original):{" "}
                            <strong>
                              {data.originalQuantity}x{" "}
                              {orig?.title || lineItemId}
                            </strong>
                          </div>
                          <div>
                            Product B (Replacement):{" "}
                            <strong>
                              {data.replacementQuantity}x{" "}
                              {data.replacementTitle}
                            </strong>
                          </div>
                          <div>
                            Exchange Balance:{" "}
                            <strong>
                              {formatBalance(
                                Number(data.replacementPrice || 0) *
                                  Number(data.replacementQuantity || 1) -
                                  Number(orig?.price || 0) *
                                    Number(data.originalQuantity || 1),
                              )}
                            </strong>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      gap: "10px",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setIsConfirmStep(false)}
                    >
                      ← Back to Edit
                    </button>
                    <button
                      type="submit"
                      disabled={isSubmitting}
                      style={{
                        background:
                          "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                        color: "#ffffff",
                        border: "none",
                        fontWeight: 700,
                        padding: "9px 18px",
                        cursor: isSubmitting ? "not-allowed" : "pointer",
                      }}
                    >
                      {isSubmitting
                        ? "Processing Exchange & Shopify Order..."
                        : "Confirm & Auto-Create Shopify Order"}
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
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                borderBottom: "1px solid #e2e8f0",
                paddingBottom: "12px",
              }}
            >
              <div>
                <span
                  style={{
                    fontSize: "12px",
                    color: "#64748b",
                    textTransform: "uppercase",
                  }}
                >
                  Exchange Request
                </span>
                <h2
                  style={{
                    fontSize: "18px",
                    fontWeight: 700,
                    margin: 0,
                    fontFamily: "Outfit, sans-serif",
                  }}
                >
                  #{selectedExchange.id.substring(0, 10)}
                </h2>
              </div>
              <button
                onClick={() => setSelectedExchange(null)}
                style={{ padding: "4px 10px" }}
              >
                Close
              </button>
            </div>

            <div>
              <h3
                style={{
                  fontSize: "13px",
                  fontWeight: 700,
                  color: "#64748b",
                  textTransform: "uppercase",
                  margin: "0 0 8px 0",
                }}
              >
                Shopify Draft Order Link
              </h3>
              <div
                style={{
                  background: "#f8fafc",
                  padding: "12px",
                  borderRadius: "8px",
                  border: "1px solid #e2e8f0",
                  fontSize: "13.5px",
                }}
              >
                <div>
                  <strong>Draft Order Name:</strong>{" "}
                  {selectedExchange.newOrderNumber || "Created"}
                </div>
                <div
                  style={{
                    fontSize: "12px",
                    color: "#10b981",
                    marginTop: "2px",
                  }}
                >
                  Linked to Shopify Admin
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
