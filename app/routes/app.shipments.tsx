import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useFetcher, useLoaderData, useSearchParams } from "react-router";
import prisma from "../db.server";
import { requireTenantContext } from "../services/tenant.server";
import { cancelShipmentTrack, getStoreShipments, syncShipmentTrackingStatus } from "../services/shipments.server";
import { getDecryptedCourierCredentials } from "../services/courier.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopifyStoreId } = await requireTenantContext(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("search") || "";
  const type = url.searchParams.get("type") || "All";
  const shipments = await getStoreShipments(shopifyStoreId, { search, type });
  return { shipments, search, type };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return { success: false, error: "Method not allowed." };
  const { shopifyStoreId } = await requireTenantContext(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const shipmentId = String(formData.get("shipmentId") || "");
  if (!shipmentId) return { success: false, error: "Shipment ID is required.", intent };

  if (intent === "GENERATE_POSTEX_LOAD_SHEET") {
    const shipment = await prisma.shipmentTrack.findFirst({
      where: { id: shipmentId, shopifyStoreId, courier: "POSTEX" },
      select: { trackingNumber: true, orderNumber: true },
    });
    if (!shipment) return new Response("PostEx shipment not found for this store.", { status: 404 });
    const credentials = await getDecryptedCourierCredentials(shopifyStoreId, "POSTEX");
    const token = String(credentials?.apiToken || credentials?.credentials?.apiToken || "").trim();
    if (!token || credentials?.isLive !== true) return new Response("PostEx credentials are missing, disabled, or unverified.", { status: 409 });
    let upstream: Response;
    try {
      upstream = await fetch("https://api.postex.pk/services/integration/api/order/v2/generate-load-sheet", {
        method: "POST",
        headers: { token, "Content-Type": "application/json", Accept: "application/pdf" },
        body: JSON.stringify({ trackingNumbers: [shipment.trackingNumber] }),
      });
    } catch {
      return new Response("PostEx could not be reached while generating the load sheet.", { status: 502 });
    }
    const contentType = upstream.headers.get("content-type") || "";
    const pdfBytes = await upstream.arrayBuffer();
    const pdfSignature = new TextDecoder().decode(pdfBytes.slice(0, 4));
    if (!upstream.ok || pdfSignature !== "%PDF") {
      const detail = new TextDecoder().decode(pdfBytes.slice(0, 1000)).trim();
      return new Response(detail || `PostEx did not return a PDF load sheet (HTTP ${upstream.status}).`, { status: 502 });
    }
    try { await syncShipmentTrackingStatus(shipment.trackingNumber, shopifyStoreId); } catch { /* tracking can be refreshed separately */ }
    const safeOrder = shipment.orderNumber.replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 50) || "shipment";
    return new Response(pdfBytes, {
      status: 200,
      headers: {
        "Content-Type": contentType || "application/pdf",
        "Content-Disposition": `attachment; filename="PostEx-Load-Sheet-${safeOrder}.pdf"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  try {
    if (intent === "REFRESH_TRACKING") {
      const shipment = await prisma.shipmentTrack.findFirst({
        where: { id: shipmentId, shopifyStoreId },
        select: { trackingNumber: true },
      });
      if (!shipment) throw new Error("Shipment not found for this store.");
      const result = await syncShipmentTrackingStatus(shipment.trackingNumber, shopifyStoreId);
      return { success: true, intent, message: `Tracking refreshed: ${result.status.replaceAll("_", " ")}.`, shipmentId };
    }
    if (intent === "CANCEL_SHIPMENT") {
      const result = await cancelShipmentTrack(shopifyStoreId, shipmentId);
      return { success: true, intent, message: result.message, shipmentId };
    }
    return { success: false, error: "Invalid shipment action.", intent };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Shipment action failed.", intent, shipmentId };
  }
};

/**
 * Shipment register with API-based tracking refresh, cancellation, and PostEx PDF actions.
 * No manual airway-bill/tracking-number input is exposed.
 */
export default function Shipments() {
  const { shipments, search, type } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const actionFetcher = useFetcher<typeof action>();

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

  return (
    <div className="bc-page bc-shipments-page">
      <header className="bc-header">
        <div className="bc-header-copy">
          <p className="bc-eyebrow">LOGISTICS</p>
          <h1>Shipments</h1>
          <p>View carrier-created tracking numbers, refresh their live status, download documents, and request cancellation through the courier API.</p>
        </div>
      </header>

      <section className="bc-note" role="note">
        BYNDCART records shipments only from PostEx or Leopards API responses. Manual airway-bill entry is disabled. PostEx may initially return an order status of UnBooked after assigning a tracking number.
      </section>
      {actionFetcher.data?.message && <div className={`bc-note ${actionFetcher.data.success ? "ok" : "bad"}`} role={actionFetcher.data.success ? "status" : "alert"}>{actionFetcher.data.message}</div>}
      {actionFetcher.data?.error && <div className="bc-note bad" role="alert">{actionFetcher.data.error}</div>}

      <section className="bc-card bc-toolbar bc-shipments-toolbar">
        <label className="bc-grow">
          <span className="bc-field-label">Search shipments</span>
          <input
            type="search"
            placeholder="Order number, shipment ID, or tracking number"
            value={search}
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

      <section className="bc-table-wrap bc-shipments-table-wrap">
        {shipments.length === 0 ? (
          <div className="bc-empty-state">
            <strong>No confirmed shipments yet</strong>
            <p>Once an enabled courier API accepts an order and returns a tracking number, BYNDCART records it automatically. Check Courier settings and the booking result if you expected one.</p>
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
                <th>Actions</th>
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
                    ) : shipment.courier === "POSTEX" ? (
                      <a className="bc-text-link" href={`/app/shipments-label?trackingNumber=${encodeURIComponent(shipment.trackingNumber)}`}>Download invoice</a>
                    ) : "—"}
                  </td>
                  <td>
                    <div className="bc-shipment-row-actions">
                      {shipment.courier === "POSTEX" && shipment.status !== "CANCELLED" && shipment.status !== "DELIVERED" && (
                        <Form method="post" target="_blank">
                          <input type="hidden" name="intent" value="GENERATE_POSTEX_LOAD_SHEET" />
                          <input type="hidden" name="shipmentId" value={shipment.id} />
                          <button type="submit" className="bc-btn">Generate load sheet</button>
                        </Form>
                      )}
                      <actionFetcher.Form method="post">
                        <input type="hidden" name="intent" value="REFRESH_TRACKING" />
                        <input type="hidden" name="shipmentId" value={shipment.id} />
                        <button type="submit" className="bc-btn" disabled={actionFetcher.state !== "idle"}>Refresh tracking</button>
                      </actionFetcher.Form>
                      {!(["DELIVERED", "CANCELLED"].includes(shipment.status)) && (
                        <actionFetcher.Form method="post" onSubmit={(event: any) => {
                          if (typeof window !== "undefined" && !window.confirm(`Ask ${shipment.courier} to cancel tracking ${shipment.trackingNumber}?`)) event.preventDefault();
                        }}>
                          <input type="hidden" name="intent" value="CANCEL_SHIPMENT" />
                          <input type="hidden" name="shipmentId" value={shipment.id} />
                          <button type="submit" className="bc-btn" disabled={actionFetcher.state !== "idle"}>Cancel shipment</button>
                        </actionFetcher.Form>
                      )}
                    </div>
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
