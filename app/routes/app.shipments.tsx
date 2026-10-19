import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import prisma from "../db.server";
import { requireTenantContext } from "../services/tenant.server";
import { getStoreShipments, registerShipmentTrack } from "../services/shipments.server";
import { CourierRegistry } from "../services/courier.server";

const SHIPMENT_TYPES = ["RETURN", "EXCHANGE", "FORWARD"] as const;
type ShipmentType = (typeof SHIPMENT_TYPES)[number];

function normalizeOrderNumber(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function validateHttpUrl(value: string) {
  if (!value.trim()) return "";
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("Label URL must be a valid http or https URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Label URL must start with http:// or https://.");
  }
  return parsed.toString();
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopifyStoreId } = await requireTenantContext(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("search") || "";
  const type = url.searchParams.get("type") || "All";
  const shipments = await getStoreShipments(shopifyStoreId, { search, type });
  const availableCouriers = CourierRegistry.getRegisteredAdapters();
  return { shipments, search, type, availableCouriers };
};

/**
 * This screen records a manually confirmed airway bill. It must not book a courier shipment.
 * Live booking is initiated by the relevant return/exchange workflow, never by this form.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return { success: false, error: "Method not allowed." };
  }

  const { shopifyStoreId } = await requireTenantContext(request);
  const formData = await request.formData();
  const orderNumber = normalizeOrderNumber(String(formData.get("orderNumber") || ""));
  const trackingNumber = String(formData.get("trackingNumber") || "").trim();
  const courier = String(formData.get("courier") || "").trim().toUpperCase();
  const rawType = String(formData.get("type") || "RETURN").toUpperCase();

  if (!orderNumber) return { success: false, error: "Enter the Shopify order number." };
  if (!trackingNumber) return { success: false, error: "Enter the airway bill / tracking number confirmed by the courier." };
  if (!CourierRegistry.has(courier)) return { success: false, error: "Choose a supported courier." };
  if (!SHIPMENT_TYPES.includes(rawType as ShipmentType)) {
    return { success: false, error: "Choose a valid shipment type." };
  }

  let labelUrl = "";
  try {
    labelUrl = validateHttpUrl(String(formData.get("labelUrl") || ""));
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Invalid label URL." };
  }

  // Only use a real, tenant-owned Shopify order. Never fabricate a Shopify Order GID.
  const orderCandidates = Array.from(new Set([orderNumber, orderNumber.slice(1)].filter(Boolean)));
  const order = await prisma.order.findFirst({
    where: {
      shopifyStoreId,
      OR: orderCandidates.map((candidate) => ({
        orderNumber: { equals: candidate, mode: "insensitive" as const },
      })),
    },
    select: { shopifyOrderId: true, orderNumber: true },
  });

  if (!order) {
    return {
      success: false,
      error: `Order ${orderNumber} was not found in BYNDCART for this store. Sync the Shopify order first, then record its airway bill.`,
    };
  }

  try {
    const shipment = await registerShipmentTrack({
      shopifyStoreId,
      orderId: order.shopifyOrderId,
      orderNumber: order.orderNumber,
      courier,
      trackingNumber,
      labelUrl,
      type: rawType as ShipmentType,
    });

    return {
      success: true,
      message: `Airway bill ${trackingNumber} was recorded for ${order.orderNumber}. The shipment status starts at Label created until a carrier status is confirmed.`,
      shipment,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to record the airway bill.",
    };
  }
};

export default function Shipments() {
  const { shipments, search, type, availableCouriers } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<any>();
  const isSubmitting = fetcher.state !== "idle";

  const handleSearchChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("search", value);
    else next.delete("search");
    setSearchParams(next);
  };

  const handleTypeChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value !== "All") next.set("type", value);
    else next.delete("type");
    setSearchParams(next);
  };

  const result = fetcher.data;

  return (
    <div className="bc-page bc-shipments-page">
      <header className="bc-header">
        <div className="bc-header-copy">
          <p className="bc-eyebrow">LOGISTICS</p>
          <h1>Shipments</h1>
          <p>Review shipment records and add an airway bill after a courier confirms the booking.</p>
        </div>
      </header>

      {result?.message && <div className="bc-note ok" role="status">{result.message}</div>}
      {result?.error && <div className="bc-note bad" role="alert">{result.error}</div>}

      <section className="bc-card bc-toolbar bc-shipments-toolbar">
        <label className="bc-grow">
          <span className="bc-field-label">Search shipments</span>
          <input
            type="search"
            placeholder="Order number, shipment ID, or tracking number"
            defaultValue={search}
            onChange={(event) => handleSearchChange(event.target.value)}
          />
        </label>
        <label className="bc-type-filter">
          <span className="bc-field-label">Shipment type</span>
          <select value={type} onChange={(event) => handleTypeChange(event.target.value)}>
            <option value="All">All types</option>
            <option value="RETURN">Return</option>
            <option value="EXCHANGE">Exchange / replacement</option>
            <option value="FORWARD">Forward</option>
          </select>
        </label>
      </section>

      <section className="bc-card bc-manual-awb-card">
        <div className="bc-section-heading">
          <div>
            <h2 className="bc-title">Record a confirmed airway bill</h2>
            <p className="bc-muted">Use this form only after you have booked the parcel directly with the courier. BYNDCART will not book another shipment from this form.</p>
          </div>
          <span className="bc-badge warn">Manual entry</span>
        </div>
        <fetcher.Form method="post" className="bc-inline-form bc-awb-form">
          <label>
            Shopify order number
            <input type="text" name="orderNumber" placeholder="#1005" required />
          </label>
          <label>
            Airway bill / tracking number
            <input type="text" name="trackingNumber" placeholder="Courier-confirmed CN / AWB" required />
          </label>
          <label>
            Courier
            <select name="courier" required defaultValue="">
              <option value="" disabled>Select courier</option>
              {availableCouriers.map((courier) => (
                <option key={courier.providerName} value={courier.providerName}>{courier.displayName}</option>
              ))}
            </select>
          </label>
          <label>
            Shipment type
            <select name="type" defaultValue="RETURN" required>
              <option value="RETURN">Return / inbound</option>
              <option value="EXCHANGE">Exchange / replacement</option>
              <option value="FORWARD">Forward</option>
            </select>
          </label>
          <label className="bc-awb-label-url">
            Label URL <span className="bc-hint">Optional; use an HTTP or HTTPS link from the courier.</span>
            <input type="url" name="labelUrl" placeholder="https://courier.example/label/…" />
          </label>
          <div className="bc-awb-submit">
            <button type="submit" className="bc-btn primary" disabled={isSubmitting}>
              {isSubmitting ? "Recording airway bill…" : "Record airway bill"}
            </button>
          </div>
        </fetcher.Form>
      </section>

      <section className="bc-table-wrap bc-shipments-table-wrap">
        {shipments.length === 0 ? (
          <div className="bc-empty-state">
            <strong>No shipments yet</strong>
            <p>Once a courier confirms a booking, record its airway bill above. You can also clear the filters.</p>
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
              {shipments.map((shipment) => (
                <tr key={shipment.id}>
                  <td><code>{shipment.id.slice(0, 8)}</code></td>
                  <td>{shipment.orderNumber}</td>
                  <td><span className="bc-badge">{shipment.type}</span></td>
                  <td>{shipment.courier}</td>
                  <td><code>{shipment.trackingNumber}</code></td>
                  <td>
                    <span className={shipment.status === "DELIVERED" ? "bc-badge ok" : shipment.status === "FAILED" || shipment.status === "CANCELLED" ? "bc-badge bad" : "bc-badge warn"}>
                      {shipment.status.replaceAll("_", " ")}
                    </span>
                  </td>
                  <td>
                    {shipment.labelUrl ? (
                      <a className="bc-text-link" href={shipment.labelUrl} target="_blank" rel="noopener noreferrer">Open label</a>
                    ) : "—"}
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
