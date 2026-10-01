import React, { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { requireTenantContext } from "../utils/tenant.server";
import { getStoreOrders, syncShopifyOrders } from "../services/orders.server";

export async function loader({ request }) {
  const { shopifyStoreId } = await requireTenantContext(request);
  const orders = await getStoreOrders(shopifyStoreId);

  return { orders };
}

export async function action({ request }) {
  const { shopifyStoreId, admin } = await requireTenantContext(request);
  const result = await syncShopifyOrders({ shopifyStoreId, admin });

  return result;
}

export default function Orders() {
  const { orders } = useLoaderData();
  const fetcher = useFetcher();
  const [searchQuery, setSearchQuery] = useState("");
  const isSyncing = fetcher.state !== "idle";
  const filteredOrders = orders.filter((order) => {
    const q = searchQuery.toLowerCase();

    return (
      order.orderNumber.toLowerCase().includes(q) ||
      (order.customerName ?? "").toLowerCase().includes(q) ||
      (order.customerEmail ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <s-page heading="Shopify Orders">
      <div style={{ marginBottom: "16px" }}>
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <input
            type="text"
            placeholder="Search by order number or customer name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
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

      <s-box
        padding="base"
        borderWidth="base"
        borderRadius="base"
        background="subdued"
      >
        {filteredOrders.length === 0 ? (
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
              <s-heading>No Orders Found</s-heading>
              <s-paragraph tone="neutral">
                {orders.length === 0
                  ? "No orders found. Orders sync automatically from Shopify upon app installation."
                  : "We couldn't find any orders matching your search query."}
              </s-paragraph>
            </div>
          </s-stack>
        ) : (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              textAlign: "left",
            }}
          >
            <thead>
              <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                <th style={{ padding: "12px 8px" }}>
                  <s-text tone="neutral">Order</s-text>
                </th>
                <th style={{ padding: "12px 8px" }}>
                  <s-text tone="neutral">Customer</s-text>
                </th>
                <th style={{ padding: "12px 8px" }}>
                  <s-text tone="neutral">Items Purchased</s-text>
                </th>
                <th style={{ padding: "12px 8px" }}>
                  <s-text tone="neutral">Order Value</s-text>
                </th>
                <th style={{ padding: "12px 8px" }}>
                  <s-text tone="neutral">Return Status</s-text>
                </th>
                <th style={{ padding: "12px 8px" }}>
                  <s-text tone="neutral">Exchange Status</s-text>
                </th>
                <th style={{ padding: "12px 8px" }}>
                  <s-text tone="neutral">Date</s-text>
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredOrders.map((order) => (
                <tr
                  key={order.id}
                  style={{ borderBottom: "1px solid #f1f2f3" }}
                >
                  <td style={{ padding: "12px 8px" }}>
                    <strong>{order.orderNumber}</strong>
                  </td>
                  <td style={{ padding: "12px 8px" }}>
                    <div style={{ fontWeight: "bold" }}>
                      {order.customerName ?? "—"}
                    </div>
                    <div style={{ fontSize: "12px", color: "#6d7175" }}>
                      {order.customerEmail ?? ""}
                    </div>
                  </td>
                  <td style={{ padding: "12px 8px" }}>
                    {order.lineItems
                      .map((li) => `${li.title} (x${li.quantity})`)
                      .join(", ")}
                  </td>
                  <td style={{ padding: "12px 8px" }}>
                    ${order.totalPrice.toFixed(2)}
                  </td>
                  <td style={{ padding: "12px 8px" }}>
                    <s-text
                      tone={
                        order.returnStatus === "None" ? "neutral" : "warning"
                      }
                    >
                      {order.returnStatus}
                    </s-text>
                  </td>
                  <td style={{ padding: "12px 8px" }}>
                    <s-text
                      tone={
                        order.exchangeStatus === "None" ? "neutral" : "warning"
                      }
                    >
                      {order.exchangeStatus}
                    </s-text>
                  </td>
                  <td style={{ padding: "12px 8px" }}>
                    {new Date(order.shopifyCreatedAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </s-box>
    </s-page>
  );
}
