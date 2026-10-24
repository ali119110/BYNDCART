import { useEffect, useRef, useState } from "react";
import { Form, useFetcher, useLoaderData, useSearchParams } from "react-router";
import prisma from "../db.server";
import { requireTenantContext } from "../services/tenant.server";
import { assertPermission } from "../services/permissions.server";
import { fulfillOrderInShopify } from "../services/booking.server";
import {
  cancelShipmentTrack,
  getStoreShipments,
  syncShipmentTrackingStatus,
  syncAllActiveShipments,
} from "../services/shipments.server";
import {
  CourierRegistry,
  getDecryptedCourierCredentials,
} from "../services/courier.server";

const ACTIVE_SHIPMENT_STATUSES = [
  "LABEL_CREATED",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
];

function normalizeShipmentOrderNumber(value) {
  return String(value || "")
    .trim()
    .replace(/^#/, "")
    .toUpperCase();
}

function shipmentOrderNumberVariants(value) {
  const raw = String(value || "").trim();
  const withoutHash = raw.replace(/^#/, "");

  return Array.from(
    new Set(
      [raw, withoutHash, withoutHash ? `#${withoutHash}` : ""].filter(Boolean),
    ),
  );
}

/** Server-side guard shared by automatic and manual Shopify fulfillment sync. */
async function getEligibleFulfillmentShipment(shopifyStoreId, shipmentId) {
  const shipment = await prisma.shipmentTrack.findFirst({
    where: {
      id: shipmentId,
      shopifyStoreId,
      type: { in: ["FORWARD", "EXCHANGE"] },
      status: { in: [...ACTIVE_SHIPMENT_STATUSES] },
      warehouseIntakes: { none: {} },
    },
    select: {
      id: true,
      shopifyOrderId: true,
      orderNumber: true,
      courier: true,
      trackingNumber: true,
      type: true,
      exchangeRequestId: true,
    },
  });

  if (!shipment) {
    throw new Error(
      "Only active outbound shipments that have not been received at the warehouse can be synced to Shopify.",
    );
  }

  if (shipment.type === "EXCHANGE") {
    const numberVariants = shipmentOrderNumberVariants(shipment.orderNumber);
    const exchange = shipment.exchangeRequestId
      ? await prisma.exchangeRequest.findFirst({
          where: { id: shipment.exchangeRequestId, shopifyStoreId },
          select: {
            id: true,
            orderNumber: true,
            newOrderNumber: true,
            shopifyOrderId: true,
            newOrderId: true,
          },
        })
      : await prisma.exchangeRequest.findFirst({
          where: {
            shopifyStoreId,
            OR: [
              { orderNumber: { in: numberVariants } },
              { newOrderNumber: { in: numberVariants } },
              { shopifyOrderId: shipment.shopifyOrderId },
              { newOrderId: shipment.shopifyOrderId },
            ],
          },
          select: {
            id: true,
            orderNumber: true,
            newOrderNumber: true,
            shopifyOrderId: true,
            newOrderId: true,
          },
        });
    const isReplacementOrder = Boolean(
      exchange &&
      normalizeShipmentOrderNumber(exchange.newOrderNumber) ===
        normalizeShipmentOrderNumber(shipment.orderNumber) &&
      exchange.newOrderId &&
      exchange.newOrderId === shipment.shopifyOrderId,
    );

    if (!isReplacementOrder) {
      throw new Error(
        "This exchange shipment is inbound or its replacement Shopify order cannot be verified. Fulfillment sync was skipped.",
      );
    }
  }

  return shipment;
}

export const loader = async ({ request }) => {
  const { shopifyStoreId } = await requireTenantContext(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("search") || "";
  const type = url.searchParams.get("type") || "All";
  const rawStatus = (url.searchParams.get("status") || "ALL").toUpperCase();
  const statusFilter = ["ALL", "ACTIVE", "COMPLETED"].includes(rawStatus)
    ? rawStatus
    : "ALL";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const storedShipments = await getStoreShipments(shopifyStoreId, {
    search,
    type,
    statusFilter,
    page,
    pageSize: 10,
  });
  const shipmentIds = storedShipments
    .map((shipment) => String(shipment.id))
    .filter(Boolean);
  const exchangeIds = Array.from(
    new Set(
      storedShipments
        .map((shipment) => shipment.exchangeRequestId)
        .filter(Boolean),
    ),
  );
  const exchangeNumberVariants = Array.from(
    new Set(
      storedShipments
        .filter((shipment) => shipment.type === "EXCHANGE")
        .flatMap((shipment) =>
          shipmentOrderNumberVariants(shipment.orderNumber),
        ),
    ),
  );
  const exchangeOr = [];

  if (exchangeIds.length) exchangeOr.push({ id: { in: exchangeIds } });

  if (exchangeNumberVariants.length) {
    exchangeOr.push(
      { orderNumber: { in: exchangeNumberVariants } },
      { newOrderNumber: { in: exchangeNumberVariants } },
    );
  }

  const exchanges = exchangeOr.length
    ? await prisma.exchangeRequest.findMany({
        where: { shopifyStoreId, OR: exchangeOr },
        select: {
          id: true,
          orderNumber: true,
          newOrderNumber: true,
          shopifyOrderId: true,
          newOrderId: true,
        },
      })
    : [];
  const exchangeMap = new Map(
    exchanges.map((exchange) => [exchange.id, exchange]),
  );
  const warehouseIntakes = shipmentIds.length
    ? await prisma.warehouseIntake.findMany({
        where: { shopifyStoreId, shipmentTrackId: { in: shipmentIds } },
        select: { shipmentTrackId: true },
      })
    : [];
  const warehouseReceivedIds = new Set(
    warehouseIntakes.map((intake) => intake.shipmentTrackId).filter(Boolean),
  );
  const shipments = storedShipments.map((shipment) => {
    const shipmentOrderKey = normalizeShipmentOrderNumber(shipment.orderNumber);
    const exchange =
      (shipment.exchangeRequestId
        ? exchangeMap.get(shipment.exchangeRequestId)
        : null) ||
      exchanges.find(
        (candidate) =>
          normalizeShipmentOrderNumber(candidate.orderNumber) ===
            shipmentOrderKey ||
          normalizeShipmentOrderNumber(candidate.newOrderNumber) ===
            shipmentOrderKey ||
          candidate.shopifyOrderId === shipment.shopifyOrderId ||
          candidate.newOrderId === shipment.shopifyOrderId,
      ) ||
      null;
    const isInboundExchange =
      shipment.type === "EXCHANGE" &&
      Boolean(exchange) &&
      shipmentOrderKey === normalizeShipmentOrderNumber(exchange.orderNumber);
    const isOutboundReplacement =
      shipment.type === "EXCHANGE" &&
      Boolean(exchange) &&
      shipmentOrderKey ===
        normalizeShipmentOrderNumber(exchange.newOrderNumber);
    const warehouseReceived = warehouseReceivedIds.has(shipment.id);
    const active = ACTIVE_SHIPMENT_STATUSES.includes(
      String(shipment.status).toUpperCase(),
    );
    const replacementOrderLinkValid =
      isOutboundReplacement &&
      Boolean(exchange.newOrderId) &&
      exchange.newOrderId === shipment.shopifyOrderId;
    const canSyncShopifyFulfillment =
      !warehouseReceived &&
      active &&
      (shipment.type === "FORWARD" || replacementOrderLinkValid);
    const flowLabel =
      shipment.type === "RETURN"
        ? "Inbound return"
        : shipment.type === "EXCHANGE"
          ? isInboundExchange
            ? "Inbound exchange"
            : isOutboundReplacement
              ? "Outbound replacement"
              : "Exchange direction unverified"
          : "Outbound delivery";

    return {
      ...shipment,
      flowLabel,
      warehouseReceived,
      displayStatus: warehouseReceived
        ? "RECEIVED AT WAREHOUSE"
        : shipment.status,
      canSyncShopifyFulfillment,
      canRefreshTracking: !warehouseReceived && active,
      canGenerateLoadSheet:
        shipment.courier === "POSTEX" && !warehouseReceived && active,
      canCancel:
        !warehouseReceived &&
        active &&
        (CourierRegistry.has(shipment.courier)
          ? CourierRegistry.get(shipment.courier).supportsCancellation !== false
          : false),
      supportsCancellation: CourierRegistry.has(shipment.courier)
        ? CourierRegistry.get(shipment.courier).supportsCancellation !== false
        : false,
    };
  });
  const pagination = storedShipments.pagination || {
    page,
    pageSize: 10,
    totalCount: shipments.length,
    totalPages: Math.max(1, Math.ceil(shipments.length / 10)),
  };

  return { shipments, search, type, statusFilter, pagination };
};

export const action = async ({ request }) => {
  if (request.method !== "POST")
    return { success: false, error: "Method not allowed." };
  const { shopifyStoreId, session, admin } =
    await requireTenantContext(request);
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
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Active shipment sync failed.",
        intent,
      };
    }
  }

  if (intent === "AUTO_SYNC_SHOPIFY_FULFILLMENTS") {
    try {
      await assertPermission(shopifyStoreId, session, "shipments");
      let requestedIds;

      try {
        requestedIds = JSON.parse(String(formData.get("shipmentIds") || "[]"));
      } catch {
        throw new Error(
          "Automatic fulfillment sync received an invalid shipment list.",
        );
      }

      if (!Array.isArray(requestedIds))
        throw new Error(
          "Automatic fulfillment sync received an invalid shipment list.",
        );
      const ids = Array.from(
        new Set(
          requestedIds.map((id) => String(id || "").trim()).filter(Boolean),
        ),
      ).slice(0, 10);
      const results = [];

      for (const id of ids) {
        try {
          const shipment = await getEligibleFulfillmentShipment(
            shopifyStoreId,
            id,
          );
          const result = await fulfillOrderInShopify(
            admin,
            shipment.shopifyOrderId,
            shipment.courier,
            shipment.trackingNumber,
          );

          results.push({
            shipmentId: id,
            success: result.success,
            message: result.success
              ? `Shopify fulfillment is synced for ${shipment.orderNumber}.`
              : result.error || "Shopify fulfillment could not be synced.",
          });
        } catch (error) {
          results.push({
            shipmentId: id,
            success: false,
            message:
              error instanceof Error
                ? error.message
                : "Shopify fulfillment sync failed.",
          });
        }
      }

      const syncedCount = results.filter((result) => result.success).length;
      const failedCount = results.length - syncedCount;

      return {
        success: failedCount === 0,
        intent,
        results,
        message: `Automatic Shopify fulfillment sync: ${syncedCount} of ${results.length} eligible outbound shipment(s) synced.${failedCount ? ` ${failedCount} require review; failed rows retain a manual retry action.` : ""}`,
      };
    } catch (error) {
      return {
        success: false,
        intent,
        results: [],
        error:
          error instanceof Error
            ? error.message
            : "Automatic Shopify fulfillment sync failed.",
      };
    }
  }

  const shipmentId = String(formData.get("shipmentId") || "");

  if (!shipmentId)
    return { success: false, error: "Shipment ID is required.", intent };

  if (intent === "GENERATE_POSTEX_LOAD_SHEET") {
    const shipment = await prisma.shipmentTrack.findFirst({
      where: { id: shipmentId, shopifyStoreId, courier: "POSTEX" },
      select: {
        trackingNumber: true,
        orderNumber: true,
        status: true,
        warehouseIntakes: { select: { id: true }, take: 1 },
      },
    });

    if (!shipment)
      return new Response("PostEx shipment not found for this store.", {
        status: 404,
      });

    if (
      shipment.warehouseIntakes.length ||
      !ACTIVE_SHIPMENT_STATUSES.includes(shipment.status)
    ) {
      return new Response(
        "Load sheets are only available for active shipments that have not been received at the warehouse.",
        { status: 409 },
      );
    }

    const credentials = await getDecryptedCourierCredentials(
      shopifyStoreId,
      "POSTEX",
    );
    const token = String(
      credentials?.apiToken || credentials?.credentials?.apiToken || "",
    ).trim();

    if (!token || credentials?.isLive !== true)
      return new Response(
        "PostEx credentials are missing, disabled, or unverified.",
        { status: 409 },
      );
    let upstream;

    try {
      upstream = await fetch(
        "https://api.postex.pk/services/integration/api/order/v2/generate-load-sheet",
        {
          method: "POST",
          headers: {
            token,
            "Content-Type": "application/json",
            Accept: "application/pdf",
          },
          body: JSON.stringify({ trackingNumbers: [shipment.trackingNumber] }),
        },
      );
    } catch {
      return new Response(
        "PostEx could not be reached while generating the load sheet.",
        { status: 502 },
      );
    }

    const contentType = upstream.headers.get("content-type") || "";
    const pdfBytes = await upstream.arrayBuffer();
    const pdfSignature = new TextDecoder().decode(pdfBytes.slice(0, 4));

    if (!upstream.ok || pdfSignature !== "%PDF") {
      const detail = new TextDecoder().decode(pdfBytes.slice(0, 1000)).trim();

      return new Response(
        detail ||
          `PostEx did not return a PDF load sheet (HTTP ${upstream.status}).`,
        { status: 502 },
      );
    }

    try {
      await syncShipmentTrackingStatus(shipment.trackingNumber, shopifyStoreId);
    } catch {
      /* tracking can be refreshed separately */
    }

    const safeOrder =
      shipment.orderNumber.replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 50) ||
      "shipment";

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
      await assertPermission(shopifyStoreId, session, "shipments");
      const shipment = await getEligibleFulfillmentShipment(
        shopifyStoreId,
        shipmentId,
      );
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
        where: {
          id: shipmentId,
          shopifyStoreId,
          status: { in: [...ACTIVE_SHIPMENT_STATUSES] },
          warehouseIntakes: { none: {} },
        },
        select: { trackingNumber: true },
      });

      if (!shipment)
        throw new Error(
          "Tracking refresh is only available for active shipments that have not been received at the warehouse.",
        );
      const result = await syncShipmentTrackingStatus(
        shipment.trackingNumber,
        shopifyStoreId,
      );

      return {
        success: true,
        intent,
        message: `Tracking refreshed: ${result.status.replaceAll("_", " ")}.`,
        shipmentId,
      };
    }

    if (intent === "CANCEL_SHIPMENT") {
      const result = await cancelShipmentTrack(shopifyStoreId, shipmentId);

      return { success: true, intent, message: result.message, shipmentId };
    }

    return { success: false, error: "Invalid shipment action.", intent };
  } catch (error) {
    if (error instanceof Response) throw error;

    return {
      success: false,
      error: error instanceof Error ? error.message : "Shipment action failed.",
      intent,
      shipmentId,
    };
  }
};

/**
 * Shipment register with Active/Completed filtering, server-side pagination, API-based tracking refresh,
 * cancellation, and PostEx PDF actions.
 */
export default function Shipments() {
  const { shipments, search, type, statusFilter, pagination } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const actionFetcher = useFetcher();
  const autoSyncFetcher = useFetcher();
  const lastAutoSyncKey = useRef("");
  const [syncedShipmentIds, setSyncedShipmentIds] = useState([]);
  const autoSyncIds = shipments
    .filter((shipment) => shipment.canSyncShopifyFulfillment)
    .map((shipment) => shipment.id);
  const autoSyncKey = autoSyncIds.join(",");

  useEffect(() => {
    if (lastAutoSyncKey.current === autoSyncKey) return;
    lastAutoSyncKey.current = autoSyncKey;

    if (autoSyncIds.length) {
      autoSyncFetcher.submit(
        {
          intent: "AUTO_SYNC_SHOPIFY_FULFILLMENTS",
          shipmentIds: JSON.stringify(autoSyncIds),
        },
        { method: "post" },
      );
    }
  }, [autoSyncKey, autoSyncFetcher]);
  useEffect(() => {
    const results = autoSyncFetcher.data?.results;

    if (Array.isArray(results)) {
      const succeeded = results
        .filter((result) => result.success)
        .map((result) => result.shipmentId);

      if (succeeded.length)
        setSyncedShipmentIds((current) =>
          Array.from(new Set([...current, ...succeeded])),
        );
    }
  }, [autoSyncFetcher.data]);
  useEffect(() => {
    const result = actionFetcher.data;

    if (
      result?.success &&
      result.intent === "SYNC_SHOPIFY_FULFILLMENT" &&
      result.shipmentId
    ) {
      setSyncedShipmentIds((current) =>
        Array.from(new Set([...current, result.shipmentId])),
      );
    }
  }, [actionFetcher.data]);

  const handleSearchChange = (value) => {
    const next = new URLSearchParams(searchParams);

    if (value) next.set("search", value);
    else next.delete("search");
    next.set("page", "1");
    setSearchParams(next);
  };

  const handleTypeChange = (value) => {
    const next = new URLSearchParams(searchParams);

    if (value !== "All") next.set("type", value);
    else next.delete("type");
    next.set("page", "1");
    setSearchParams(next);
  };

  const handleStatusChange = (status) => {
    const next = new URLSearchParams(searchParams);

    if (status !== "ALL") next.set("status", status);
    else next.delete("status");
    next.set("page", "1");
    setSearchParams(next);
  };

  const handlePageChange = (newPage) => {
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
          <p>
            Outbound Shopify fulfillments sync automatically when this page
            opens. Received inbound shipments need no further tracking actions.
          </p>
        </div>
      </header>

      <section className="bc-note" role="note">
        BYNDCART records shipments only after a registered courier API confirms
        a carrier-generated tracking number. PostEx, Leopards, DHL Express,
        FedEx, and TCS have adapters; exact label, tracking, cancellation, and
        reverse-shipment capabilities depend on each supplied carrier contract
        and verified store credentials. Manual airway-bill entry is disabled.
      </section>

      {actionFetcher.data?.message && (
        <div
          className={`bc-note ${actionFetcher.data.success ? "ok" : "bad"}`}
          role={actionFetcher.data.success ? "status" : "alert"}
        >
          {actionFetcher.data.message}
        </div>
      )}
      {actionFetcher.data?.error && (
        <div className="bc-note bad" role="alert">
          {actionFetcher.data.error}
        </div>
      )}
      {autoSyncFetcher.data?.message && (
        <div
          className={`bc-note ${autoSyncFetcher.data.success ? "ok" : "warn"}`}
          role="status"
        >
          {autoSyncFetcher.data.message}
        </div>
      )}
      {autoSyncFetcher.data?.error && (
        <div className="bc-note warn" role="status">
          Automatic fulfillment sync could not complete:{" "}
          {autoSyncFetcher.data.error}
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
          <select
            value={type}
            onChange={(event) => handleTypeChange(event.target.value)}
          >
            <option value="All">All types</option>
            <option value="RETURN">Return</option>
            <option value="EXCHANGE">Exchange / replacement</option>
            <option value="FORWARD">Forward</option>
          </select>
        </label>
        <div className="bc-filter-field">
          <span className="bc-field-label">Delivery status</span>
          <div
            className="bc-range-filter"
            role="group"
            aria-label="Filter shipments by delivery status"
          >
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
            <button
              type="submit"
              className="bc-btn"
              disabled={actionFetcher.state !== "idle"}
            >
              {actionFetcher.state !== "idle"
                ? "Syncing…"
                : "Sync active tracking"}
            </button>
          </actionFetcher.Form>
        </div>
      </section>

      <section className="bc-table-wrap bc-shipments-table-wrap">
        {shipments.length === 0 ? (
          <div className="bc-empty-state">
            <strong>No confirmed shipments match your filter</strong>
            <p>
              Once an enabled courier API accepts an order and returns a
              tracking number, BYNDCART records it automatically. Try switching
              filters or clearing your search.
            </p>
          </div>
        ) : (
          <>
            <table className="bc-table">
              <thead>
                <tr>
                  <th>Shipment</th>
                  <th>Order</th>
                  <th>Flow / direction</th>
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
                    <td>
                      <code>{shipment.id.slice(0, 8)}</code>
                    </td>
                    <td>{shipment.orderNumber}</td>
                    <td>
                      <span className="bc-badge">{shipment.flowLabel}</span>
                    </td>
                    <td>{shipment.courier}</td>
                    <td>
                      <code>{shipment.trackingNumber}</code>
                    </td>
                    <td>
                      <span
                        className={
                          shipment.warehouseReceived ||
                          shipment.status === "DELIVERED"
                            ? "bc-badge ok"
                            : shipment.status === "FAILED" ||
                                shipment.status === "CANCELLED"
                              ? "bc-badge bad"
                              : "bc-badge warn"
                        }
                      >
                        {shipment.displayStatus.replaceAll("_", " ")}
                      </span>
                    </td>
                    <td>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.25rem",
                        }}
                      >
                        {shipment.labelUrl ? (
                          <a
                            className="bc-text-link"
                            href={shipment.labelUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Carrier label
                          </a>
                        ) : shipment.courier === "POSTEX" ? (
                          <a
                            className="bc-text-link"
                            href={`/app/shipments-label?trackingNumber=${encodeURIComponent(shipment.trackingNumber)}`}
                          >
                            Download invoice
                          </a>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <div className="bc-shipment-row-actions">
                        {shipment.canSyncShopifyFulfillment &&
                          !syncedShipmentIds.includes(shipment.id) && (
                            <actionFetcher.Form method="post">
                              <input
                                type="hidden"
                                name="intent"
                                value="SYNC_SHOPIFY_FULFILLMENT"
                              />
                              <input
                                type="hidden"
                                name="shipmentId"
                                value={shipment.id}
                              />
                              <button
                                type="submit"
                                className="bc-btn"
                                disabled={
                                  actionFetcher.state !== "idle" ||
                                  autoSyncFetcher.state !== "idle"
                                }
                              >
                                {autoSyncFetcher.state !== "idle" &&
                                autoSyncIds.includes(shipment.id)
                                  ? "Syncing Shopify…"
                                  : actionFetcher.state !== "idle" &&
                                      actionFetcher.formData?.get("intent") ===
                                        "SYNC_SHOPIFY_FULFILLMENT" &&
                                      actionFetcher.formData?.get(
                                        "shipmentId",
                                      ) === shipment.id
                                    ? "Syncing Shopify…"
                                    : "Retry Shopify fulfillment"}
                              </button>
                            </actionFetcher.Form>
                          )}
                        {shipment.canGenerateLoadSheet && (
                          <Form method="post" target="_blank">
                            <input
                              type="hidden"
                              name="intent"
                              value="GENERATE_POSTEX_LOAD_SHEET"
                            />
                            <input
                              type="hidden"
                              name="shipmentId"
                              value={shipment.id}
                            />
                            <button type="submit" className="bc-btn">
                              Generate load sheet
                            </button>
                          </Form>
                        )}
                        {shipment.canRefreshTracking && (
                          <actionFetcher.Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="REFRESH_TRACKING"
                            />
                            <input
                              type="hidden"
                              name="shipmentId"
                              value={shipment.id}
                            />
                            <button
                              type="submit"
                              className="bc-btn"
                              disabled={actionFetcher.state !== "idle"}
                            >
                              Refresh tracking
                            </button>
                          </actionFetcher.Form>
                        )}
                        {shipment.canCancel && (
                          <actionFetcher.Form
                            method="post"
                            onSubmit={(event) => {
                              if (
                                typeof window !== "undefined" &&
                                !window.confirm(
                                  `Ask ${shipment.courier} to cancel tracking ${shipment.trackingNumber}?`,
                                )
                              )
                                event.preventDefault();
                            }}
                          >
                            <input
                              type="hidden"
                              name="intent"
                              value="CANCEL_SHIPMENT"
                            />
                            <input
                              type="hidden"
                              name="shipmentId"
                              value={shipment.id}
                            />
                            <button
                              type="submit"
                              className="bc-btn"
                              disabled={actionFetcher.state !== "idle"}
                            >
                              Cancel shipment
                            </button>
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
                  Showing {(pagination.page - 1) * pagination.pageSize + 1}–
                  {Math.min(
                    pagination.page * pagination.pageSize,
                    pagination.totalCount,
                  )}{" "}
                  of {pagination.totalCount} shipments
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
