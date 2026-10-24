import React from "react";
import { useLoaderData, useSearchParams, Link, useRevalidator } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requireTenantContext } from "../utils/tenant.server";
import prisma from "../db.server";

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function dateKeyStartInTimeZone(value: string, timeZone: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const targetMidnightUtc = Date.UTC(year, month - 1, day);
  if (new Date(targetMidnightUtc).toISOString().slice(0, 10) !== value) return null;

  // Convert calendar midnight in the dashboard user's timezone into UTC.
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let guess = targetMidnightUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(guess))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    const displayedAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const offsetMs = displayedAsUtc - guess;
    const corrected = targetMidnightUtc - offsetMs;
    if (corrected === guess) break;
    guess = corrected;
  }
  return new Date(guess);
}

function nextDateKey(value: string): string | null {
  const parsed = dateKeyStartInTimeZone(value, "UTC");
  if (!parsed) return null;
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { shopifyStoreId, admin } = await requireTenantContext(request);
    const url = new URL(request.url);
    const requestedRange = url.searchParams.get("range") || "30d";
    const range = ["7d", "30d", "90d", "all", "custom"].includes(requestedRange) ? requestedRange : "30d";
    const customFrom = url.searchParams.get("from") || "";
    const customTo = url.searchParams.get("to") || "";
    const requestedTimeZone = url.searchParams.get("tz") || "UTC";
    const timeZone = isValidTimeZone(requestedTimeZone) ? requestedTimeZone : "UTC";

    let startDate: Date | undefined;
    let endExclusiveDate: Date | undefined;
    let dateRangeError: string | null = null;
    const now = new Date();

    if (range === "custom") {
      const candidateStart = dateKeyStartInTimeZone(customFrom, timeZone);
      const nextDayAfterTo = nextDateKey(customTo);
      const candidateEnd = nextDayAfterTo ? dateKeyStartInTimeZone(nextDayAfterTo, timeZone) : null;
      if (candidateStart && candidateEnd && customFrom <= customTo) {
        startDate = candidateStart;
        endExclusiveDate = candidateEnd;
      } else {
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        endExclusiveDate = now;
        dateRangeError = "Choose a valid start and end date. The dashboard is temporarily showing the last 30 days.";
      }
    } else if (range === "7d" || range === "30d" || range === "90d") {
      const days = Number(range.slice(0, -1));
      startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      endExclusiveDate = now;
    }

    const requestDateFilter = startDate || endExclusiveDate
      ? { createdAt: { ...(startDate ? { gte: startDate } : {}), ...(endExclusiveDate ? { lt: endExclusiveDate } : {}) } }
      : {};
    const receivedDateFilter = startDate || endExclusiveDate
      ? { receivedAt: { ...(startDate ? { gte: startDate } : {}), ...(endExclusiveDate ? { lt: endExclusiveDate } : {}) } }
      : {};
    const staleBefore = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const unsettledCodStatuses = ["EXPECTED", "IMPORTED", "DISPUTED"];

    const store = await prisma.shopifyStore.findUnique({
      where: { id: shopifyStoreId },
      select: {
        shop: true,
        syncStatus: true,
        lastSyncAt: true,
        lastSyncError: true,
        webhookStatus: true,
        lastReconciledAt: true,
      },
    });

    // Resolve a friendly Shopify shop name without blocking database queries.
    // If Shopify is temporarily unavailable, safely fall back to the tenant's store domain.
    const identityPromise: Promise<{ name: string; domain: string }> = admin
      ? admin.graphql("query DashboardShopIdentity { shop { name primaryDomain { url } } }")
          .then(async (response: any) => {
            const payload = await response.json();
            const shop = payload?.data?.shop;
            return {
              name: typeof shop?.name === "string" && shop.name.trim() ? shop.name.trim() : (store?.shop ?? "Connected Store"),
              domain: typeof shop?.primaryDomain?.url === "string" && shop.primaryDomain.url.trim() ? shop.primaryDomain.url.trim() : (store?.shop ?? ""),
            };
          })
          .catch(() => ({ name: store?.shop ?? "Connected Store", domain: store?.shop ?? "" }))
      : Promise.resolve({ name: store?.shop ?? "Connected Store", domain: store?.shop ?? "" });

    const queryPromise = Promise.all([
      prisma.returnRequest.count({ where: { shopifyStoreId, ...requestDateFilter } }),
      prisma.exchangeRequest.count({ where: { shopifyStoreId, ...requestDateFilter } }),
      prisma.exchangeRequest.count({
        where: { shopifyStoreId, status: { in: ["APPROVED", "RECEIVED"] }, ...requestDateFilter },
      }),
      prisma.exchangeRequest.count({
        where: { shopifyStoreId, newOrderId: { not: null }, ...requestDateFilter },
      }),
      prisma.warehouseIntake.count({
        where: {
          shopifyStoreId,
          returnRequestId: { not: null },
          status: { in: ["RECEIVED", "INSPECTED"] },
          ...receivedDateFilter,
        },
      }),
      prisma.returnRequest.findMany({
        where: { shopifyStoreId, ...requestDateFilter },
        take: 5,
        orderBy: { createdAt: "desc" },
      }),
      prisma.exchangeRequest.findMany({
        where: { shopifyStoreId, ...requestDateFilter },
        take: 5,
        orderBy: { createdAt: "desc" },
        include: { items: true },
      }),
      // Live queues deliberately ignore the historical date filter. Grouping related
      // states reduces the dashboard's concurrent database round-trips.
      prisma.shipmentTrack.groupBy({
        by: ["status"],
        where: { shopifyStoreId },
        _count: { _all: true },
      }),
      prisma.warehouseIntake.count({ where: { shopifyStoreId, status: "RECEIVED" } }),
      prisma.refundRecord.groupBy({
        by: ["status", "currency"],
        where: { shopifyStoreId },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prisma.shipmentTrack.count({
        where: {
          shopifyStoreId,
          status: { in: ["IN_TRANSIT", "OUT_FOR_DELIVERY"] },
          updatedAt: { lt: staleBefore },
        },
      }),
      prisma.codSettlement.groupBy({
        by: ["status"],
        where: { shopifyStoreId },
        _count: { _all: true },
        _sum: { expectedAmount: true },
      }),
      prisma.backgroundJob.count({ where: { shopifyStoreId, status: "FAILED" } }),
      prisma.webhookEvent.count({ where: { shopifyStoreId, processed: false } }),
      prisma.returnRequest.groupBy({
        by: ["status"],
        where: { shopifyStoreId },
        _count: { _all: true },
      }),
      prisma.exchangeRequest.groupBy({
        by: ["status"],
        where: { shopifyStoreId },
        _count: { _all: true },
      }),
      prisma.shipmentTrack.groupBy({
        by: ["courier", "status"],
        where: { shopifyStoreId, ...requestDateFilter },
        _count: { _all: true },
        orderBy: { courier: "asc" },
      }),
    ]);

    const [rows, identity] = await Promise.all([queryPromise, identityPromise]);
    const [
      returnsCount,
      exchangesCount,
      incomingExchanges,
      replacementOrderRequests,
      returnIntake,
      recentReturnsDb,
      recentExchangesDb,
      shipmentStatusRaw,
      awaitingInspection,
      refundFinancialRaw,
      staleShipments,
      codSnapshotRaw,
      failedJobs,
      unprocessedWebhooks,
      returnLifecycleRaw,
      exchangeLifecycleRaw,
      courierSnapshotRaw,
    ] = rows;

    const countForStatus = (entries: { status: string; _count: { _all: number } }[], status: string) =>
      entries.find((entry) => entry.status === status)?._count._all ?? 0;
    const pendingReturns = countForStatus(returnLifecycleRaw, "PENDING");
    const pendingExchanges = countForStatus(exchangeLifecycleRaw, "PENDING");
    const returnsAwaitingInboundParcel = countForStatus(returnLifecycleRaw, "APPROVED");
    const exchangesAwaitingInboundParcel = countForStatus(exchangeLifecycleRaw, "APPROVED");
    const inTransit = countForStatus(shipmentStatusRaw, "IN_TRANSIT") + countForStatus(shipmentStatusRaw, "OUT_FOR_DELIVERY");
    const failedShipments = countForStatus(shipmentStatusRaw, "FAILED");
    const bookedParcels = countForStatus(shipmentStatusRaw, "LABEL_CREATED");
    const pendingRefunds = refundFinancialRaw
      .filter((entry) => entry.status === "PENDING")
      .reduce((sum, entry) => sum + entry._count._all, 0);
    const failedRefunds = refundFinancialRaw
      .filter((entry) => entry.status === "FAILED")
      .reduce((sum, entry) => sum + entry._count._all, 0);
    const pendingRefundAmountPkr = refundFinancialRaw
      .filter((entry) => entry.status === "PENDING" && entry.currency === "PKR")
      .reduce((sum, entry) => sum + Number(entry._sum.amount ?? 0), 0);
    const unreconciledCodRows = codSnapshotRaw.filter((entry) => unsettledCodStatuses.includes(entry.status));
    const unreconciledCodCount = unreconciledCodRows.reduce((sum, entry) => sum + entry._count._all, 0);
    const unreconciledCodAmount = unreconciledCodRows.reduce((sum, entry) => sum + Number(entry._sum.expectedAmount ?? 0), 0);
    const disputedCod = countForStatus(codSnapshotRaw, "DISPUTED");

    const summarizeLifecycle = (entries: typeof returnLifecycleRaw) =>
      entries
        .map((entry) => ({ status: entry.status, count: entry._count._all }))
        .sort((a, b) => b.count - a.count);

    const courierMap = new Map<string, {
      courier: string;
      total: number;
      inTransit: number;
      delivered: number;
      failed: number;
      labelCreated: number;
      other: number;
    }>();
    for (const entry of courierSnapshotRaw) {
      const courier = entry.courier || "Unknown courier";
      const summary = courierMap.get(courier) ?? {
        courier,
        total: 0,
        inTransit: 0,
        delivered: 0,
        failed: 0,
        labelCreated: 0,
        other: 0,
      };
      const count = entry._count._all;
      summary.total += count;
      if (entry.status === "IN_TRANSIT" || entry.status === "OUT_FOR_DELIVERY") summary.inTransit += count;
      else if (entry.status === "DELIVERED") summary.delivered += count;
      else if (entry.status === "FAILED") summary.failed += count;
      else if (entry.status === "LABEL_CREATED") summary.labelCreated += count;
      else summary.other += count;
      courierMap.set(courier, summary);
    }
    const courierSnapshot = Array.from(courierMap.values()).sort((a, b) => b.total - a.total).slice(0, 8);

    return {
      shop: identity.name,
      shopDomain: identity.domain,
      range,
      customFrom,
      customTo,
      timeZone,
      dateRangeError,
      dataAvailable: true,
      health: {
        syncStatus: store?.syncStatus ?? "UNKNOWN",
        lastSyncAt: store?.lastSyncAt?.toISOString() ?? null,
        hasSyncError: Boolean(store?.lastSyncError),
        webhookStatus: store?.webhookStatus ?? "UNKNOWN",
        lastReconciledAt: store?.lastReconciledAt?.toISOString() ?? null,
        failedJobs,
        unprocessedWebhooks,
      },
      metrics: {
        returnsCount,
        exchangesCount,
        incomingExchanges,
        replacementOrderRequests,
        returnIntake,
      },
      lifecycle: {
        returns: summarizeLifecycle(returnLifecycleRaw),
        exchanges: summarizeLifecycle(exchangeLifecycleRaw),
      },
      courierSnapshot,
      operations: {
        pendingReturns,
        pendingExchanges,
        returnsAwaitingInboundParcel,
        exchangesAwaitingInboundParcel,
        failedRefunds,
        inTransit,
        awaitingInspection,
        pendingRefunds,
        pendingRefundAmountPkr,
        failedShipments,
        bookedParcels,
        staleShipments,
        unreconciledCodCount,
        unreconciledCodAmount,
        disputedCod,
      },
      recentReturns: recentReturnsDb.map((r) => ({
        id: r.id,
        orderNumber: r.orderNumber,
        customerName: r.customerName || r.customerEmail,
        status: r.status,
        date: r.createdAt.toISOString(),
      })),
      recentExchanges: recentExchangesDb.map((e) => ({
        id: e.id,
        orderNumber: e.orderNumber,
        customerName: e.customerName || e.customerEmail,
        replacementTitle: e.items?.[0]?.replacementTitle || (e.items?.length > 1 ? e.items.length + " replacement items" : "Replacement item not specified"),
        status: e.status,
        date: e.createdAt.toISOString(),
      })),
    };
  } catch (error) {
    console.error("[Dashboard Loader] Error:", error);
    return {
      shop: "Connected Store",
      shopDomain: "",
      range: "30d",
      customFrom: "",
      customTo: "",
      timeZone: "UTC",
      dateRangeError: null,
      dataAvailable: false,
      health: {
        syncStatus: "UNKNOWN",
        lastSyncAt: null,
        hasSyncError: false,
        webhookStatus: "UNKNOWN",
        lastReconciledAt: null,
        failedJobs: 0,
        unprocessedWebhooks: 0,
      },
      metrics: {
        returnsCount: 0,
        exchangesCount: 0,
        incomingExchanges: 0,
        replacementOrderRequests: 0,
        returnIntake: 0,
      },
      lifecycle: { returns: [], exchanges: [] },
      courierSnapshot: [],
      operations: {
        pendingReturns: 0,
        pendingExchanges: 0,
        returnsAwaitingInboundParcel: 0,
        exchangesAwaitingInboundParcel: 0,
        failedRefunds: 0,
        inTransit: 0,
        awaitingInspection: 0,
        pendingRefunds: 0,
        pendingRefundAmountPkr: 0,
        failedShipments: 0,
        bookedParcels: 0,
        staleShipments: 0,
        unreconciledCodCount: 0,
        unreconciledCodAmount: 0,
        disputedCod: 0,
      },
      recentReturns: [],
      recentExchanges: [],
    };
  }
}

function getStatusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  const normalized = String(status || "").toUpperCase();

  if (["COMPLETED", "APPROVED", "RECEIVED", "DELIVERED", "REFUNDED", "RESOLVED", "FULFILLED"].includes(normalized)) {
    return "success";
  }
  if (["PENDING", "IN_PROGRESS", "PROCESSING", "UNDER_REVIEW", "RETURN_IN_PROGRESS", "OPEN"].includes(normalized)) {
    return "warning";
  }
  if (["FAILED", "REJECTED", "CANCELLED", "CANCELED", "ERROR"].includes(normalized)) {
    return "danger";
  }
  return "neutral";
}

export default function Dashboard() {
  const loaderData = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const shop = loaderData?.shop ?? "Connected Store";
  const shopDomain = loaderData?.shopDomain ?? "";
  const currentRange = loaderData?.range ?? "30d";
  const revalidator = useRevalidator();
  const dataAvailable = loaderData?.dataAvailable !== false;
  const dateRangeError = loaderData?.dateRangeError ?? null;
  const [customFrom, setCustomFrom] = React.useState(loaderData?.customFrom ?? "");
  const [customTo, setCustomTo] = React.useState(loaderData?.customTo ?? "");
  const [dateInputError, setDateInputError] = React.useState<string | null>(null);
  React.useEffect(() => {
    setCustomFrom(loaderData?.customFrom ?? "");
    setCustomTo(loaderData?.customTo ?? "");
    setDateInputError(null);
  }, [loaderData?.customFrom, loaderData?.customTo]);
  const metrics = loaderData?.metrics ?? {
    returnsCount: 0,
    exchangesCount: 0,
    incomingExchanges: 0,
    replacementOrderRequests: 0,
    returnIntake: 0,
  };
  const operations = loaderData?.operations ?? {
    pendingReturns: 0,
    pendingExchanges: 0,
    returnsAwaitingInboundParcel: 0,
    exchangesAwaitingInboundParcel: 0,
    failedRefunds: 0,
    inTransit: 0,
    awaitingInspection: 0,
    pendingRefunds: 0,
    pendingRefundAmountPkr: 0,
    failedShipments: 0,
    bookedParcels: 0,
    staleShipments: 0,
    unreconciledCodCount: 0,
    unreconciledCodAmount: 0,
    disputedCod: 0,
  };
  const lifecycle = loaderData?.lifecycle ?? { returns: [], exchanges: [] };
  const courierSnapshot = loaderData?.courierSnapshot ?? [];
  const health = loaderData?.health ?? {
    syncStatus: "UNKNOWN",
    lastSyncAt: null,
    hasSyncError: false,
    webhookStatus: "UNKNOWN",
    lastReconciledAt: null,
    failedJobs: 0,
    unprocessedWebhooks: 0,
  };

  const withRangeContext = (href: string) => {
    const [pathname, query = ""] = href.split("?");
    const params = new URLSearchParams(query);
    ["range", "from", "to", "tz"].forEach((key) => {
      const value = searchParams.get(key);
      if (value) params.set(key, value);
    });
    const suffix = params.toString();
    return suffix ? pathname + "?" + suffix : pathname;
  };

  const formatMoneyPkr = (value: number) =>
    dataAvailable ? "Rs. " + value.toLocaleString("en-PK", { maximumFractionDigits: 2 }) : "—";

  const attentionItems = [
    { label: "Failed shipments", count: operations.failedShipments, detail: "Carrier status needs review", to: withRangeContext("/app/shipments"), priority: 1 },
    { label: "COD disputes", count: operations.disputedCod, detail: "Settlement values do not match", to: withRangeContext("/app/reconciliation"), priority: 1 },
    { label: "Failed refunds", count: operations.failedRefunds, detail: "A refund record is marked failed", to: withRangeContext("/app/refunds"), priority: 1 },
    { label: "Stale tracking", count: operations.staleShipments, detail: "No shipment update for 48+ hours", to: withRangeContext("/app/shipments"), priority: 2 },
    { label: "Refunds awaiting confirmation", count: operations.pendingRefunds, detail: "Confirm only after checking payment evidence", to: withRangeContext("/app/refunds"), priority: 2 },
    { label: "Return parcels not yet received", count: operations.returnsAwaitingInboundParcel, detail: "Approved returns awaiting inbound receipt", to: withRangeContext("/app/returns"), priority: 2 },
    { label: "Exchange parcels not yet received", count: operations.exchangesAwaitingInboundParcel, detail: "Approved exchanges awaiting inbound receipt", to: withRangeContext("/app/exchanges"), priority: 2 },
    { label: "Warehouse inspection", count: operations.awaitingInspection, detail: "Received parcels awaiting inspection", to: withRangeContext("/app/warehouse"), priority: 2 },
    { label: "Returns awaiting review", count: operations.pendingReturns, detail: "Return requests still pending", to: withRangeContext("/app/returns"), priority: 3 },
    { label: "Exchanges awaiting review", count: operations.pendingExchanges, detail: "Exchange requests still pending", to: withRangeContext("/app/exchanges"), priority: 3 },
  ].filter((item) => Number(item.count) > 0).sort((a, b) => a.priority - b.priority);
  const recentReturns = loaderData?.recentReturns ?? [];
  const recentExchanges = loaderData?.recentExchanges ?? [];

  const handleRangeChange = (range: string) => {
    const next = new URLSearchParams(searchParams);
    if (range === "30d") next.delete("range");
    else next.set("range", range);

    if (range !== "custom") {
      next.delete("from");
      next.delete("to");
      next.delete("tz");
      setCustomFrom("");
      setCustomTo("");
      setDateInputError(null);
    }
    setSearchParams(next);
  };

  const applyCustomRange = () => {
    if (!customFrom || !customTo) {
      setDateInputError("Select both a start date and an end date.");
      return;
    }
    if (customFrom > customTo) {
      setDateInputError("The start date must be on or before the end date.");
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.set("range", "custom");
    next.set("from", customFrom);
    next.set("to", customTo);
    next.set("tz", Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    setDateInputError(null);
    setSearchParams(next);
  };

  const formatCount = (value: number) => dataAvailable ? value.toLocaleString("en-PK") : "—";

  return (
    <main className="bc-page bc-dashboard">
      <header className="bc-dashboard-header">
        <div className="bc-dashboard-header-copy">
          <h1>Dashboard</h1>
          <p>Monitor reverse logistics, manage open requests, and keep fulfilment moving.</p>
        </div>

        <div className="bc-dashboard-controls">
          <div className="bc-dashboard-filter-stack">
            <div className="bc-range-filter" role="group" aria-label="Date range filter">
              {[
                { id: "7d", label: "7 days" },
                { id: "30d", label: "30 days" },
                { id: "90d", label: "90 days" },
                { id: "all", label: "All time" },
                { id: "custom", label: "Custom" },
              ].map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`bc-range-btn ${currentRange === option.id ? "active" : ""}`}
                  onClick={() => handleRangeChange(option.id)}
                  aria-pressed={currentRange === option.id}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {currentRange === "custom" && (
              <div className="bc-custom-date-filter">
                <label className="bc-custom-date-field">
                  <span>From</span>
                  <input type="date" value={customFrom} max={customTo || undefined} onChange={(event) => { setCustomFrom(event.target.value); setDateInputError(null); }} />
                </label>
                <label className="bc-custom-date-field">
                  <span>To</span>
                  <input type="date" value={customTo} min={customFrom || undefined} onChange={(event) => { setCustomTo(event.target.value); setDateInputError(null); }} />
                </label>
                <button type="button" className="bc-custom-date-apply" onClick={applyCustomRange}>Apply</button>
              </div>
            )}
            {(dateInputError || dateRangeError) && currentRange === "custom" && (
              <p className="bc-dashboard-date-error" role="alert">{dateInputError || dateRangeError}</p>
            )}
          </div>

          <div className="bc-dashboard-store" title={shopDomain || shop}>
            <span className="bc-store-avatar" aria-hidden="true">
              {String(shop || "S").trim().slice(0, 1).toUpperCase() || "S"}
            </span>
            <span className="bc-store-copy">
              <span className="bc-store-label">CONNECTED STORE</span>
              <strong>{shop}</strong>
              <span className="bc-store-domain">{shopDomain}</span>
            </span>
          </div>
        </div>
      </header>



      {!dataAvailable && (
        <section className="bc-dashboard-data-error" role="alert">
          <strong>Dashboard data could not be loaded.</strong>
          <p>Metrics are hidden instead of showing misleading zeros. Retry loading the dashboard; if the issue continues, contact support.</p>
          <button type="button" className="bc-btn" onClick={() => revalidator.revalidate()}>Retry</button>
        </section>
      )}

      {/* KPI Cards: Linked to relevant operational pages */}
      <section className="bc-dashboard-section" aria-labelledby="bc-overview-title">
        <div className="bc-dashboard-section-heading">
          <div>
            <h2 id="bc-overview-title">Overview</h2>
            <p>Request counts use the selected creation-date range. The operational queue below shows current outstanding work.</p>
          </div>
        </div>

        <div className="bc-kpi-grid">
          <Link to={withRangeContext("/app/returns")} className="bc-kpi-card bc-kpi-link">
            <div className="bc-kpi-card-top">
              <span className="bc-kpi-label">Return requests</span>
            </div>
            <p className="bc-kpi-value">{formatCount(metrics.returnsCount)}</p>
            <span className="bc-kpi-sub">View returns</span>
          </Link>

          <Link to={withRangeContext("/app/exchanges")} className="bc-kpi-card bc-kpi-link">
            <div className="bc-kpi-card-top">
              <span className="bc-kpi-label">Exchange requests</span>
            </div>
            <p className="bc-kpi-value">{formatCount(metrics.exchangesCount)}</p>
            <span className="bc-kpi-sub">View exchanges</span>
          </Link>

          <Link to={withRangeContext("/app/warehouse")} className="bc-kpi-card bc-kpi-link">
            <div className="bc-kpi-card-top">
              <span className="bc-kpi-label">Incoming exchanges</span>
            </div>
            <p className="bc-kpi-value">{formatCount(metrics.incomingExchanges)}</p>
            <span className="bc-kpi-sub">Approved or received requests created in this range</span>
          </Link>

          <Link to={withRangeContext("/app/exchanges")} className="bc-kpi-card bc-kpi-link">
            <div className="bc-kpi-card-top">
              <span className="bc-kpi-label">Replacement order linked</span>
            </div>
            <p className="bc-kpi-value">{formatCount(metrics.replacementOrderRequests)}</p>
            <span className="bc-kpi-sub">Requests with a replacement order recorded</span>
          </Link>

          <Link to={withRangeContext("/app/warehouse?tab=RETURNS&filter=WAREHOUSE")} className="bc-kpi-card bc-kpi-link">
            <div className="bc-kpi-card-top">
              <span className="bc-kpi-label">Return intake</span>
            </div>
            <p className="bc-kpi-value">{formatCount(metrics.returnIntake)}</p>
            <span className="bc-kpi-sub">Return parcels received during the selected period</span>
          </Link>
        </div>
      </section>

      {/* Prioritized action center */}
      <section className="bc-dashboard-section" aria-labelledby="bc-attention-title">
        <div className="bc-dashboard-section-heading">
          <div>
            <h2 id="bc-attention-title">Needs attention</h2>
            <p>Prioritized items that may need an action now.</p>
          </div>
          <span className="bc-dashboard-section-tag">{dataAvailable ? attentionItems.length + " active" : "Unavailable"}</span>
        </div>
        {!dataAvailable ? (
          <div className="bc-empty-state"><strong>Action queue unavailable</strong><p>Retry loading dashboard data to see current work.</p></div>
        ) : attentionItems.length === 0 ? (
          <div className="bc-empty-state"><strong>No urgent items detected</strong><p>There are no open failed-shipment, COD-dispute, stale-tracking, pending-refund, or review queues right now.</p></div>
        ) : (
          <div className="bc-attention-list">
            {attentionItems.map((item) => (
              <Link key={item.label} to={item.to} className={item.priority === 1 ? "bc-attention-row is-critical" : "bc-attention-row"}>
                <span className="bc-attention-copy">
                  <strong>{item.label}</strong>
                  <span>{item.detail}</span>
                </span>
                <span className="bc-attention-count">{formatCount(item.count)}</span>
                <span className="bc-attention-open">Open <span aria-hidden="true">→</span></span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Operational Queue */}
      <section className="bc-dashboard-section" aria-labelledby="bc-operations-title">
        <div className="bc-dashboard-section-heading">
          <div>
            <h2 id="bc-operations-title">Live operational queues</h2>
            <p>Current backlog; these counts are not limited by the selected date range.</p>
          </div>
        </div>

        <div className="bc-ops-grid">
          <Link className="bc-ops-card" to={withRangeContext("/app/shipments")}>
            <span className="bc-ops-label">Labels created · awaiting first scan</span>
            <span className="bc-ops-value">{formatCount(operations.bookedParcels)}</span>
          </Link>
          <Link className={`bc-ops-card ${operations.pendingReturns > 0 ? "has-attention" : ""}`} to={withRangeContext("/app/returns")}>
            <span className="bc-ops-label">Pending returns</span>
            <span className="bc-ops-value">{formatCount(operations.pendingReturns)}</span>
          </Link>
          <Link className={`bc-ops-card ${operations.pendingExchanges > 0 ? "has-attention" : ""}`} to={withRangeContext("/app/exchanges")}>
            <span className="bc-ops-label">Pending exchanges</span>
            <span className="bc-ops-value">{formatCount(operations.pendingExchanges)}</span>
          </Link>
          <Link className="bc-ops-card" to={withRangeContext("/app/shipments?type=All")}>
            <span className="bc-ops-label">Parcels in transit</span>
            <span className="bc-ops-value">{formatCount(operations.inTransit)}</span>
          </Link>
          <Link className="bc-ops-card" to="/app/warehouse">
            <span className="bc-ops-label">Awaiting inspection</span>
            <span className="bc-ops-value">{formatCount(operations.awaitingInspection)}</span>
          </Link>
          <Link className={`bc-ops-card ${operations.pendingRefunds > 0 ? "has-attention" : ""}`} to={withRangeContext("/app/refunds")}>
            <span className="bc-ops-label">Refunds pending</span>
            <span className="bc-ops-value">{formatCount(operations.pendingRefunds)}</span>
          </Link>
          <Link className={`bc-ops-card ${operations.failedShipments > 0 ? "has-error" : ""}`} to={withRangeContext("/app/shipments")}>
            <span className="bc-ops-label">Failed shipments</span>
            <span className="bc-ops-value">{formatCount(operations.failedShipments)}</span>
          </Link>
          <Link className={operations.unreconciledCodCount > 0 ? "bc-ops-card has-attention" : "bc-ops-card"} to={withRangeContext("/app/reconciliation")}>
            <span className="bc-ops-label">COD awaiting reconciliation</span>
            <span className="bc-ops-value">{formatCount(operations.unreconciledCodCount)}</span>
          </Link>
          <Link className={operations.staleShipments > 0 ? "bc-ops-card has-attention" : "bc-ops-card"} to={withRangeContext("/app/shipments")}>
            <span className="bc-ops-label">Tracking stale 48+ hours</span>
            <span className="bc-ops-value">{formatCount(operations.staleShipments)}</span>
          </Link>
        </div>
      </section>

      {/* Financial exposure and settlement risk */}
      <section className="bc-dashboard-section" aria-labelledby="bc-money-title">
        <div className="bc-dashboard-section-heading">
          <div>
            <h2 id="bc-money-title">Money needing follow-up</h2>
            <p>Amounts are shown only where the record explicitly stores PKR; other currencies are not converted.</p>
          </div>
        </div>
        <div className="bc-money-grid">
          <Link className="bc-money-card" to={withRangeContext("/app/refunds")}>
            <span className="bc-kpi-label">Refund records pending</span>
            <strong>{formatCount(operations.pendingRefunds)}</strong>
            <span className="bc-money-amount">{formatMoneyPkr(operations.pendingRefundAmountPkr)}</span>
            <span className="bc-money-caption">Pending amount in PKR only · not confirmed paid</span>
          </Link>
          <Link className="bc-money-card" to={withRangeContext("/app/reconciliation")}>
            <span className="bc-kpi-label">Unreconciled COD records</span>
            <strong>{formatCount(operations.unreconciledCodCount)}</strong>
            <span className="bc-money-amount">{formatMoneyPkr(operations.unreconciledCodAmount)}</span>
            <span className="bc-money-caption">Total expected amount across expected, imported and disputed records</span>
          </Link>
          <Link className="bc-money-card" to={withRangeContext("/app/reconciliation")}>
            <span className="bc-kpi-label">COD disputes</span>
            <strong>{formatCount(operations.disputedCod)}</strong>
            <span className="bc-money-caption">Reconcile against courier and bank evidence</span>
          </Link>
        </div>
      </section>

      {/* Data freshness and integration health */}
      <section className="bc-dashboard-section" aria-labelledby="bc-health-title">
        <div className="bc-dashboard-section-heading">
          <div>
            <h2 id="bc-health-title">Data and integration health</h2>
            <p>Freshness indicators help distinguish zero activity from delayed integrations.</p>
          </div>
        </div>
        <div className="bc-health-grid">
          <article className="bc-health-card">
            <span className="bc-kpi-label">Shopify sync</span>
            <strong className="bc-health-value">{dataAvailable ? health.syncStatus : "Unavailable"}</strong>
            <span className={health.hasSyncError || health.syncStatus === "FAILED" ? "bc-health-status is-problem" : "bc-health-status"}>
              {health.hasSyncError || health.syncStatus === "FAILED" ? "Sync error reported" : "Status reported by BYNDCART"}
            </span>
            <span className="bc-health-detail">Last successful sync: {health.lastSyncAt ? new Date(health.lastSyncAt).toLocaleString() : "Not recorded"}</span>
          </article>
          <article className="bc-health-card">
            <span className="bc-kpi-label">Webhook registration</span>
            <strong className="bc-health-value">{dataAvailable ? health.webhookStatus : "Unavailable"}</strong>
            <span className={health.webhookStatus === "FAILED" || health.unprocessedWebhooks > 0 ? "bc-health-status is-problem" : "bc-health-status"}>
              {health.webhookStatus === "FAILED" ? "Registration issue reported" : health.unprocessedWebhooks > 0 ? "Unprocessed events need review" : "Registration status"}
            </span>
            <span className="bc-health-detail">Unprocessed webhook events: {formatCount(health.unprocessedWebhooks)}</span>
          </article>
          <article className="bc-health-card">
            <span className="bc-kpi-label">Background jobs</span>
            <strong className="bc-health-value">{formatCount(health.failedJobs)}</strong>
            <span className={health.failedJobs > 0 ? "bc-health-status is-problem" : "bc-health-status"}>{health.failedJobs > 0 ? "Failed jobs need review" : "No failed jobs recorded"}</span>
            <span className="bc-health-detail">Last COD reconciliation: {health.lastReconciledAt ? new Date(health.lastReconciledAt).toLocaleString() : "Not recorded"}</span>
          </article>
        </div>
      </section>

      {/* Current request lifecycle */}
      <section className="bc-dashboard-section" aria-labelledby="bc-lifecycle-title">
        <div className="bc-dashboard-section-heading">
          <div>
            <h2 id="bc-lifecycle-title">Request lifecycle</h2>
            <p>Current stage snapshot across all open and completed requests; use it to spot work accumulating at a stage.</p>
          </div>
        </div>
        <div className="bc-lifecycle-grid">
          <article className="bc-health-card">
            <div className="bc-lifecycle-heading">
              <h3>Returns by stage</h3>
              <Link className="bc-text-link" to={withRangeContext("/app/returns")}>View returns</Link>
            </div>
            {!dataAvailable ? (
              <p className="bc-muted">Lifecycle data unavailable.</p>
            ) : lifecycle.returns.length === 0 ? (
              <p className="bc-muted">No return requests recorded yet.</p>
            ) : (
              <div className="bc-lifecycle-rows">
                {lifecycle.returns.map((stage: { status: string; count: number }) => (
                  <div className="bc-lifecycle-row" key={stage.status}>
                    <span>{stage.status.replaceAll("_", " ")}</span>
                    <strong>{formatCount(stage.count)}</strong>
                  </div>
                ))}
              </div>
            )}
          </article>
          <article className="bc-health-card">
            <div className="bc-lifecycle-heading">
              <h3>Exchanges by stage</h3>
              <Link className="bc-text-link" to={withRangeContext("/app/exchanges")}>View exchanges</Link>
            </div>
            {!dataAvailable ? (
              <p className="bc-muted">Lifecycle data unavailable.</p>
            ) : lifecycle.exchanges.length === 0 ? (
              <p className="bc-muted">No exchange requests recorded yet.</p>
            ) : (
              <div className="bc-lifecycle-rows">
                {lifecycle.exchanges.map((stage: { status: string; count: number }) => (
                  <div className="bc-lifecycle-row" key={stage.status}>
                    <span>{stage.status.replaceAll("_", " ")}</span>
                    <strong>{formatCount(stage.count)}</strong>
                  </div>
                ))}
              </div>
            )}
          </article>
        </div>
      </section>

      {/* Courier shipment snapshot */}
      <section className="bc-dashboard-section" aria-labelledby="bc-courier-title">
        <div className="bc-dashboard-section-heading">
          <div>
            <h2 id="bc-courier-title">Courier snapshot</h2>
            <p>Bookings created in the selected period, grouped by their latest stored status. Carrier data can lag based on integration coverage.</p>
          </div>
          <Link className="bc-text-link" to={withRangeContext("/app/shipments")}>View shipments</Link>
        </div>
        {!dataAvailable ? (
          <div className="bc-empty-state"><strong>Courier data unavailable</strong><p>Retry loading dashboard data to view courier statuses.</p></div>
        ) : courierSnapshot.length === 0 ? (
          <div className="bc-empty-state"><strong>No shipment records in this period</strong><p>Shipment status summaries appear here after bookings are recorded.</p></div>
        ) : (
          <div className="bc-dashboard-table-wrap">
            <table className="bc-dashboard-table bc-courier-snapshot-table">
              <thead>
                <tr>
                  <th scope="col">Courier</th>
                  <th scope="col">Shipments</th>
                  <th scope="col">In transit</th>
                  <th scope="col">Delivered</th>
                  <th scope="col">Failed</th>
                  <th scope="col">Awaiting first scan</th>
                </tr>
              </thead>
              <tbody>
                {courierSnapshot.map((row: { courier: string; total: number; inTransit: number; delivered: number; failed: number; labelCreated: number }) => (
                  <tr key={row.courier}>
                    <td><span className="bc-table-primary">{row.courier}</span></td>
                    <td>{formatCount(row.total)}</td>
                    <td>{formatCount(row.inTransit)}</td>
                    <td>{formatCount(row.delivered)}</td>
                    <td><span className={row.failed > 0 ? "bc-status-badge bc-status-danger" : "bc-status-badge bc-status-neutral"}>{formatCount(row.failed)}</span></td>
                    <td>{formatCount(row.labelCreated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Recent Activity */}
      <section className="bc-dashboard-section" aria-labelledby="bc-activity-title">
        <div className="bc-dashboard-section-heading">
          <div>
            <h2 id="bc-activity-title">Recent activity</h2>
            <p>Latest return and exchange requests.</p>
          </div>
        </div>

        <div className="bc-activity-grid">
          <section className="bc-activity-card" aria-labelledby="bc-recent-returns-title">
            <header className="bc-activity-card-header">
              <div>
                <h3 id="bc-recent-returns-title">Recent returns</h3>
                <p>Latest return requests</p>
              </div>
              <Link className="bc-text-link" to={withRangeContext("/app/returns")}>View all</Link>
            </header>

            {!dataAvailable ? (
              <div className="bc-empty-state"><strong>Activity unavailable</strong><p>Could not load return activity.</p></div>
            ) : recentReturns.length === 0 ? (
              <div className="bc-empty-state">
                <strong>No returns in this period</strong>
                <p>Return requests created during the selected date range will appear here.</p>
              </div>
            ) : (
              <div className="bc-dashboard-table-wrap">
                <table className="bc-dashboard-table">
                  <thead>
                    <tr>
                      <th scope="col">Order</th>
                      <th scope="col">Customer</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="bc-date-cell">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentReturns.map((item) => (
                      <tr key={item.id}>
                        <td><span className="bc-table-primary">{item.orderNumber || "—"}</span></td>
                        <td><span className="bc-table-secondary" title={item.customerName || "—"}>{item.customerName || "—"}</span></td>
                        <td><span className={`bc-status-badge bc-status-${getStatusTone(item.status)}`}>{item.status}</span></td>
                        <td className="bc-date-cell"><span className="bc-table-date">{new Date(item.date).toLocaleDateString()}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="bc-activity-card" aria-labelledby="bc-recent-exchanges-title">
            <header className="bc-activity-card-header">
              <div>
                <h3 id="bc-recent-exchanges-title">Recent exchanges</h3>
                <p>Latest exchange requests</p>
              </div>
              <Link className="bc-text-link" to={withRangeContext("/app/exchanges")}>View all</Link>
            </header>

            {!dataAvailable ? (
              <div className="bc-empty-state"><strong>Activity unavailable</strong><p>Could not load exchange activity.</p></div>
            ) : recentExchanges.length === 0 ? (
              <div className="bc-empty-state">
                <strong>No exchanges in this period</strong>
                <p>Exchange requests created during the selected date range will appear here.</p>
              </div>
            ) : (
              <div className="bc-dashboard-table-wrap">
                <table className="bc-dashboard-table">
                  <thead>
                    <tr>
                      <th scope="col">Order</th>
                      <th scope="col">Replacement</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="bc-date-cell">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentExchanges.map((item) => (
                      <tr key={item.id}>
                        <td><span className="bc-table-primary">{item.orderNumber || "—"}</span></td>
                        <td><span className="bc-table-secondary" title={item.replacementTitle || "—"}>{item.replacementTitle || "—"}</span></td>
                        <td><span className={`bc-status-badge bc-status-${getStatusTone(item.status)}`}>{item.status}</span></td>
                        <td className="bc-date-cell"><span className="bc-table-date">{new Date(item.date).toLocaleDateString()}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}
