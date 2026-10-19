import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { requireTenantContext } from "../services/tenant.server";
import { getStoreShipments, registerShipmentTrack } from "../services/shipments.server";
import { CourierRegistry } from "../services/courier.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopifyStoreId } = await requireTenantContext(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("search") || "";
  const type = url.searchParams.get("type") || "All";

  const shipments = await getStoreShipments(shopifyStoreId, { search, type });
  const availableCouriers = CourierRegistry.getRegisteredAdapters();

  return { shipments, search, type, availableCouriers };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shopifyStoreId } = await requireTenantContext(request);
  const formData = await request.formData();
  const orderNumber = (formData.get("orderNumber") as string) || `#${Math.floor(1000 + Math.random() * 9000)}`;
  const courier = (formData.get("courier") as string) || "STANDARD";
  const type = (formData.get("type") as "RETURN" | "FORWARD" | "EXCHANGE") || "RETURN";

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
  const { shipments, search, type, availableCouriers } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher();

  const isSubmitting = fetcher.state !== "idle";

  const handleSearchChange = (value: string) => {
    const newParams = new URLSearchParams(searchParams);
    if (value) {
      newParams.set("search", value);
    } else {
      newParams.delete("search");
    }
    setSearchParams(newParams);
  };

  const handleTypeChange = (value: string) => {
    const newParams = new URLSearchParams(searchParams);
    if (value !== "All") {
      newParams.set("type", value);
    } else {
      newParams.delete("type");
    }
    setSearchParams(newParams);
  };

  return (
    <div className="bc-page">
      <header className="bc-header">
        <div className="bc-header-copy">
          <p className="bc-eyebrow">LOGISTICS</p>
          <h1>Shipments</h1>
          <p>Track return, exchange, and forward parcels, and record a label when the courier confirms one.</p>
        </div>
      </header>

      <section className="bc-card bc-toolbar">
        <div className="bc-grow">
          <input
            type="text"
            placeholder="Search by shipment, order, or tracking number"
            defaultValue={search}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
        </div>
        <select value={type} onChange={(e) => handleTypeChange(e.target.value)}>
          <option value="All">All types</option>
          <option value="FORWARD">Forward</option>
          <option value="RETURN">Return</option>
          <option value="EXCHANGE">Exchange</option>
        </select>
      </section>

      <section className="bc-card">
        <h2 className="bc-title">Record a shipping label</h2>
        <p className="bc-muted">This saves the label only after the courier confirms the booking.</p>
        <fetcher.Form method="post" className="bc-inline-form">
          <input type="text" name="orderNumber" placeholder="Order number, for example #1005" required />
          <select name="courier">
            {availableCouriers.map((c) => (
              <option key={c.providerName} value={c.providerName}>{c.displayName}</option>
            ))}
          </select>
          <select name="type">
            <option value="RETURN">Return label</option>
            <option value="EXCHANGE">Exchange label</option>
            <option value="FORWARD">Forward label</option>
          </select>
          <button type="submit" className="bc-btn primary" disabled={isSubmitting}>
            {isSubmitting ? "Saving..." : "Save label"}
          </button>
        </fetcher.Form>
      </section>

      <section className="bc-table-wrap">
        {shipments.length === 0 ? (
          <div className="bc-empty-state">
            <strong>No shipments yet</strong>
            <p>Record a label above, or clear the filters.</p>
          </div>
        ) : (
          <table className="bc-table">
            <thead>
              <tr>
                <th>Shipment</th>
                <th>Order</th>
                <th>Type</th>
                <th>Courier</th>
                <th>Tracking</th>
                <th>Status</th>
                <th>Label</th>
              </tr>
            </thead>
            <tbody>
              {shipments.map((ship) => (
                <tr key={ship.id}>
                  <td>{ship.id.slice(0, 8)}</td>
                  <td>{ship.orderNumber}</td>
                  <td><span className="bc-badge">{ship.type}</span></td>
                  <td>{ship.courier}</td>
                  <td>{ship.trackingNumber}</td>
                  <td><span className={ship.status === "DELIVERED" ? "bc-badge ok" : ship.status === "FAILED" ? "bc-badge bad" : "bc-badge warn"}>{ship.status}</span></td>
                  <td>
                    {ship.labelUrl ? (
                      <a className="bc-text-link" href={ship.labelUrl} target="_blank" rel="noreferrer">Download</a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
