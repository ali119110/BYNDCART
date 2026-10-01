import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { requireTenantContext } from "../services/tenant.server";
import {
  getStoreShipments,
  registerShipmentTrack,
} from "../services/shipments.server";
import { CourierRegistry } from "../services/courier.server";

export const loader = async ({ request }) => {
  const { shopifyStoreId } = await requireTenantContext(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("search") || "";
  const type = url.searchParams.get("type") || "All";
  const shipments = await getStoreShipments(shopifyStoreId, { search, type });
  const availableCouriers = CourierRegistry.getRegisteredAdapters();

  return { shipments, search, type, availableCouriers };
};

export const action = async ({ request }) => {
  const { shopifyStoreId } = await requireTenantContext(request);
  const formData = await request.formData();
  const orderNumber =
    formData.get("orderNumber") ||
    `#${Math.floor(1000 + Math.random() * 9000)}`;
  const courier = formData.get("courier") || "STANDARD";
  const type = formData.get("type") || "RETURN";
  const result = await registerShipmentTrack({
    shopifyStoreId,
    orderId: `gid://shopify/Order/${Date.now()}`,
    orderNumber,
    courier,
    type,
  });

  return { success: true, shipment: result };
};

export default function Shipments() {
  const { shipments, search, type, availableCouriers } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state !== "idle";

  const handleSearchChange = (value) => {
    const newParams = new URLSearchParams(searchParams);

    if (value) {
      newParams.set("search", value);
    } else {
      newParams.delete("search");
    }

    setSearchParams(newParams);
  };

  const handleTypeChange = (value) => {
    const newParams = new URLSearchParams(searchParams);

    if (value !== "All") {
      newParams.set("type", value);
    } else {
      newParams.delete("type");
    }

    setSearchParams(newParams);
  };

  return (
    <s-page heading="Reverse & Forward Logistics Tracking">
      <div
        style={{
          marginBottom: "16px",
          display: "flex",
          gap: "12px",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ flex: "1" }}>
          <input
            type="text"
            placeholder="Search by Shipment ID, Order #, or Tracking #..."
            defaultValue={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            style={{
              width: "100%",
              padding: "8px 12px",
              border: "1px solid #c9cccf",
              borderRadius: "4px",
              fontSize: "14px",
            }}
          />
        </div>
        <div>
          <select
            value={type}
            onChange={(e) => handleTypeChange(e.target.value)}
            style={{
              padding: "8px 12px",
              border: "1px solid #c9cccf",
              borderRadius: "4px",
              fontSize: "14px",
            }}
          >
            <option value="All">All Types</option>
            <option value="FORWARD">Forward Shipment</option>
            <option value="RETURN">Return Shipment</option>
            <option value="EXCHANGE">Exchange Shipment</option>
          </select>
        </div>
      </div>

      {/* Manual Return Label Generation Card */}
      <div style={{ marginBottom: "16px" }}>
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <s-stack direction="block" gap="base">
            <s-heading>Generate Return Shipping Label</s-heading>
            <fetcher.Form
              method="post"
              style={{
                display: "flex",
                gap: "12px",
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <input
                type="text"
                name="orderNumber"
                placeholder="Order Number (e.g. #1005)"
                required
                style={{
                  padding: "8px 12px",
                  border: "1px solid #c9cccf",
                  borderRadius: "4px",
                  fontSize: "14px",
                }}
              />
              <select
                name="courier"
                style={{
                  padding: "8px 12px",
                  border: "1px solid #c9cccf",
                  borderRadius: "4px",
                  fontSize: "14px",
                }}
              >
                {availableCouriers.map((c) => (
                  <option key={c.providerName} value={c.providerName}>
                    {c.displayName}
                  </option>
                ))}
              </select>
              <select
                name="type"
                style={{
                  padding: "8px 12px",
                  border: "1px solid #c9cccf",
                  borderRadius: "4px",
                  fontSize: "14px",
                }}
              >
                <option value="RETURN">Return Label</option>
                <option value="EXCHANGE">Exchange Label</option>
                <option value="FORWARD">Forward Label</option>
              </select>
              <s-button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Generating Label..." : "Generate Label"}
              </s-button>
            </fetcher.Form>
          </s-stack>
        </s-box>
      </div>

      <s-box
        padding="base"
        borderWidth="base"
        borderRadius="base"
        background="subdued"
      >
        {shipments.length === 0 ? (
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
              <s-heading>No Shipments Recorded</s-heading>
              <s-paragraph tone="neutral">
                Generate a return label above or clear filters.
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
                  <s-text tone="neutral">Shipment ID</s-text>
                </th>
                <th style={{ padding: "12px 8px" }}>
                  <s-text tone="neutral">Order</s-text>
                </th>
                <th style={{ padding: "12px 8px" }}>
                  <s-text tone="neutral">Type</s-text>
                </th>
                <th style={{ padding: "12px 8px" }}>
                  <s-text tone="neutral">Courier</s-text>
                </th>
                <th style={{ padding: "12px 8px" }}>
                  <s-text tone="neutral">Tracking Number</s-text>
                </th>
                <th style={{ padding: "12px 8px" }}>
                  <s-text tone="neutral">Status</s-text>
                </th>
                <th style={{ padding: "12px 8px" }}>
                  <s-text tone="neutral">Action</s-text>
                </th>
              </tr>
            </thead>
            <tbody>
              {shipments.map((ship) => (
                <tr key={ship.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                  <td style={{ padding: "12px 8px" }}>
                    <strong>{ship.id.slice(0, 8)}...</strong>
                  </td>
                  <td style={{ padding: "12px 8px" }}>{ship.orderNumber}</td>
                  <td style={{ padding: "12px 8px" }}>
                    <s-badge
                      tone={
                        ship.type === "FORWARD"
                          ? "info"
                          : ship.type === "RETURN"
                            ? "critical"
                            : "success"
                      }
                    >
                      {ship.type}
                    </s-badge>
                  </td>
                  <td style={{ padding: "12px 8px" }}>
                    <strong>{ship.courier}</strong>
                  </td>
                  <td style={{ padding: "12px 8px" }}>
                    <span style={{ fontFamily: "monospace" }}>
                      {ship.trackingNumber}
                    </span>
                  </td>
                  <td style={{ padding: "12px 8px" }}>
                    <s-badge
                      tone={ship.status === "DELIVERED" ? "success" : "warning"}
                    >
                      {ship.status}
                    </s-badge>
                  </td>
                  <td style={{ padding: "12px 8px" }}>
                    {ship.labelUrl ? (
                      <a
                        href={ship.labelUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ textDecoration: "none", color: "#005bd3" }}
                      >
                        Download Label
                      </a>
                    ) : (
                      "-"
                    )}
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
