import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useFetcher, useLoaderData, useSearchParams } from "react-router";
import prisma from "../db.server";
import { requireTenantContext } from "../services/tenant.server";
import { assertPermission } from "../services/permissions.server";
import { fulfillOrderInShopify } from "../services/booking.server";
import { cancelShipmentTrack, getStoreShipments, syncShipmentTrackingStatus, syncAllActiveShipments } from "../services/shipments.server";
import { CourierRegistry, getDecryptedCourierCredentials } from "../services/courier.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopifyStoreId } = await requireTenantContext(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("search") || "";
  const type = url.searchParams.get("type") || "All";
  const rawStatus = (url.searchParams.get("status") || "ALL").toUpperCase();
  const statusFilter = (["ALL", "ACTIVE", "COMPLETED"].includes(rawStatus) ? rawStatus : "ALL") as "ALL" | "ACTIVE" | "COMPLETED";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));

  const storedShipments = await getStoreShipments(shopifyStoreId, {
    search,
    type,
    statusFilter,
    page,
    pageSize: 10,
  });

  const shipments = storedShipments.map((shipment: any) => ({
    ...shipment,
    supportsCancellation: CourierRegistry.has(shipment.courier)
      ? CourierRegistry.get(shipment.courier).supportsCancellation !== false
      : false,
  }));

  const pagination = (storedShipments as any).pagination || {
    page,
    pageSize: 10,
    totalCount: shipments.length,
    totalPages: Math.max(1, Math.ceil(shipments.length / 10)),
  };

  return { shipments, search, type, statusFilter, pagination };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return { success: false, error: "Method not allowed." };
  const { shopifyStoreId, session, admin } = await requireTenantContext(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "SYNC_ACTIVE") {
    try {
      const result = await syncAllActiveShipments(shopifyStoreId);
      return {
        success: true,
        intent,
        message: `Synchronized ${result.syncedCount} of ${result.total} active shipments with courier APIs.`,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Active shipment sync failed.", intent };
    }
  }

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
    if (intent === "SYNC_SHOPIFY_FULFILLMENT") {
      await assertPermission(shopifyStoreId, session, "settings");
      const shipment = await prisma.shipmentTrack.findFirst({
        where: {
          id: shipmentId,
          shopifyStoreId,
          type: { in: ["FORWARD", "EXCHANGE"] },
          status: { notIn: ["FAILED", "CANCELLED"] },
        },
        select: {
          id: true,
          shopifyOrderId: true,
          orderNumber: true,
          courier: true,
          trackingNumber: true,
          type: true,
        },
      });
      if (!shipment) {
        throw new Error("Eligible forward/replacement shipment not found for this store. Returns are never used to fulfill the original order.");
      }

      const fulfillment = await fulfillOrderInShopify(
        admin,
        shipment.shopifyOrderId,
        shipment.courier,
        shipment.trackingNumber,
      );
      if (!fulfillment.success) {
        throw new Error(
          `Courier booking ${shipment.trackingNumber} is still saved. Shopify fulfillment sync failed: ${fulfillment.error || "Unknown Shopify error."} No new carrier booking was created.`,
        );
      }

      return {
        success: true,
        intent,
        message: `Shopify fulfillment synced for ${shipment.orderNumber} using ${shipment.courier} tracking ${shipment.trackingNumber}.`,
        shipmentId,
      };
    }

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
 * Shipment register with Active/Completed filtering, server-side pagination, API-based tracking refresh,
 * cancellation, and PostEx PDF actions.
 */
export default function Shipments() {
  const { shipments, search, type, statusFilter, pagination } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const actionFetcher = useFetcher<typeof action>();

  const handleSearchChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("search", value);
    else next.delete("search");
    next.set("page", "1");
    setSearchParams(next);
  };

  const handleTypeChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value !== "All") next.set("type", value);
    else next.delete("type");
    next.set("page", "1");
    setSearchParams(next);
  };

  const handleStatusChange = (status: "ALL" | "ACTIVE" | "COMPLETED") => {
    const next = new URLSearchParams(searchParams);
    if (status !== "ALL") next.set("status", status);
    else next.delete("status");
    next.set("page", "1");
    setSearchParams(next);
  };

  const handlePageChange = (newPage: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(newPage));
    setSearchParams(next);
  };

  return (
    <div className="bc-page bc-shipments-page">
      <header className="bc-header">
        <div className="bc-header-copy">
          <p className="bc-eyebrow">LOGISTICS</p>
          <h1>Shipments</h1>
          <p>View carrier-created tracking numbers, refresh live courier statuses, download documents, and request cancellation.</p>
        </div>
      </header>

      <section className="bc-note" role="note">
        BYNDCART records shipments only after a registered courier API confirms a carrier-generated tracking number. PostEx, Leopards, DHL Express, FedEx, and TCS have adapters; exact label, tracking, cancellation, and reverse-shipment capabilities depend on each supplied carrier contract and verified store credentials. Manual airway-bill entry is disabled.
      </section>

      {actionFetcher.data?.message && (
        <div className={`bc-note ${actionFetcher.data.success ? "ok" : "bad"}`} role={actionFetcher.data.success ? "status" : "alert"}>
          {actionFetcher.data.message}
        </div>
      )}
      {actionFetcher.data?.error && (
        <div className="bc-note bad" role="alert">
          {actionFetcher.data.error}
        </div>
      )}

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
        <div className="bc-filter-field">
          <span className="bc-field-label">Delivery status</span>
          <div className="bc-range-filter" role="group" aria-label="Filter shipments by delivery status">
            <button
              type="button"
              className={`bc-range-btn ${statusFilter === "ALL" ? "active" : ""}`}
              onClick={() => handleStatusChange("ALL")}
            >
              All
            </button>
            <button
              type="button"
              className={`bc-range-btn ${statusFilter === "ACTIVE" ? "active" : ""}`}
              onClick={() => handleStatusChange("ACTIVE")}
            >
              Active
            </button>
            <button
              type="button"
              className={`bc-range-btn ${statusFilter === "COMPLETED" ? "active" : ""}`}
              onClick={() => handleStatusChange("COMPLETED")}
            >
              Completed
            </button>
          </div>
        </div>
        <div className="bc-sync-action-wrap">
          <span className="bc-field-label">&nbsp;</span>
          <actionFetcher.Form method="post">
            <input type="hidden" name="intent" value="SYNC_ACTIVE" />
            <button type="submit" className="bc-btn" disabled={actionFetcher.state !== "idle"}>
              {actionFetcher.state !== "idle" ? "Syncing…" : "Sync active tracking"}
            </button>
          </actionFetcher.Form>
        </div>
      </section>

      <section className="bc-table-wrap bc-shipments-table-wrap">
        {shipments.length === 0 ? (
          <div className="bc-empty-state">
            <strong>No confirmed shipments match your filter</strong>
            <p>Once an enabled courier API accepts an order and returns a tracking number, BYNDCART records it automatically. Try switching filters or clearing your search.</p>
          </div>
        ) : (
          <>
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
                {shipments.map((shipment: any) => (
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
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                        <a className="bc-text-link" href={`/app/awb?ids=${shipment.id}`} target="_blank" rel="noopener noreferrer">Print AWB</a>
                        {shipment.labelUrl ? (
                          <a className="bc-text-link" href={shipment.labelUrl} target="_blank" rel="noopener noreferrer">Carrier label</a>
                        ) : shipment.courier === "POSTEX" ? (
                          <a className="bc-text-link" href={`/app/shipments-label?trackingNumber=${encodeURIComponent(shipment.trackingNumber)}`}>Download invoice</a>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <div className="bc-shipment-row-actions">
                        {["FORWARD", "EXCHANGE"].includes(shipment.type) && !["FAILED", "CANCELLED"].includes(shipment.status) && (
                          <actionFetcher.Form method="post">
                            <input type="hidden" name="intent" value="SYNC_SHOPIFY_FULFILLMENT" />
                            <input type="hidden" name="shipmentId" value={shipment.id} />
                            <button type="submit" className="bc-btn" disabled={actionFetcher.state !== "idle"}>
                              {actionFetcher.state !== "idle" && actionFetcher.formData?.get("intent") === "SYNC_SHOPIFY_FULFILLMENT" && actionFetcher.formData?.get("shipmentId") === shipment.id
                                ? "Syncing Shopify…"
                                : "Sync Shopify fulfillment"}
                            </button>
                          </actionFetcher.Form>
                        )}
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
                        {!(["DELIVERED", "CANCELLED"].includes(shipment.status)) && shipment.supportsCancellation && (
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

            {pagination.totalPages > 1 && (
              <div className="bc-pager bc-shipments-pager">
                <span className="bc-pager-info">
                  Showing {(pagination.page - 1) * pagination.pageSize + 1}–{Math.min(pagination.page * pagination.pageSize, pagination.totalCount)} of {pagination.totalCount} shipments
                </span>
                <div className="bc-pager-actions">
                  <button
                    type="button"
                    className="bc-btn"
                    disabled={pagination.page <= 1}
                    onClick={() => handlePageChange(pagination.page - 1)}
                  >
                    Previous
                  </button>
                  <span className="bc-pager-current">
                    Page {pagination.page} of {pagination.totalPages}
                  </span>
                  <button
                    type="button"
                    className="bc-btn"
                    disabled={pagination.page >= pagination.totalPages}
                    onClick={() => handlePageChange(pagination.page + 1)}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
