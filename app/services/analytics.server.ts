import db from "../db.server";

export interface AnalyticsFilters {
  startDate?: Date;
  endDate?: Date;
}

export async function getAnalytics(shopifyStoreId: string, filters: AnalyticsFilters = {}) {
  const dateFilter =
    filters.startDate || filters.endDate
      ? {
          createdAt: {
            ...(filters.startDate ? { gte: filters.startDate } : {}),
            ...(filters.endDate ? { lte: filters.endDate } : {}),
          },
        }
      : {};
  // Cash-flow totals are filtered by the time the refund was confirmed, not when
  // the return request was opened. This keeps the KPI tied to the actual event.
  const confirmedRefundDateFilter =
    filters.startDate || filters.endDate
      ? {
          confirmedAt: {
            ...(filters.startDate ? { gte: filters.startDate } : {}),
            ...(filters.endDate ? { lte: filters.endDate } : {}),
          },
        }
      : {};

  const [
    totalReturns,
    totalExchanges,
    returnsByStatus,
    exchangesByStatus,
    returnsByReason,
    exchangePriceAgg,
    confirmedRefundsByCurrencyRaw,
    unitReturnMetricsRaw,
    monthlyTrendRaw,
    topReturnedProductsRaw,
  ] = await Promise.all([
    db.returnRequest.count({ where: { shopifyStoreId, ...dateFilter } }),
    db.exchangeRequest.count({ where: { shopifyStoreId, ...dateFilter } }),
    db.returnRequest.groupBy({
      by: ["status"],
      where: { shopifyStoreId, ...dateFilter },
      _count: { _all: true },
    }),
    db.exchangeRequest.groupBy({
      by: ["status"],
      where: { shopifyStoreId, ...dateFilter },
      _count: { _all: true },
    }),
    db.returnRequest.groupBy({
      by: ["reason"],
      where: { shopifyStoreId, ...dateFilter },
      _count: { _all: true },
      orderBy: { _count: { reason: "desc" } },
      take: 5,
    }),
    db.exchangeItem.aggregate({
      where: {
        exchangeRequest: { shopifyStoreId, status: "COMPLETED", ...dateFilter },
      },
      _sum: { priceDifference: true },
    }),
    db.refundRecord.groupBy({
      by: ["currency"],
      where: { shopifyStoreId, status: "CONFIRMED", ...confirmedRefundDateFilter },
      _sum: { amount: true },
    }),
    // Match warehouse-confirmed returned units to the same order cohort as sold units.
    // Return requests can be created after the order period, so the numerator is
    // based on the order's date cohort, not the return request's createdAt.
    db.$queryRaw<{ sold_units: number; received_return_units: number }[]> `
      WITH cohort_orders AS (
        SELECT o."shopifyOrderId", o."lineItems"
        FROM "Order" o
        WHERE o."shopifyStoreId" = ${shopifyStoreId}
          AND COALESCE(o."fulfillmentStatus", '') <> 'CANCELLED'
          AND (${filters.startDate ? filters.startDate : new Date(0)} <= o."shopifyCreatedAt")
          AND (${filters.endDate ? filters.endDate : new Date("2100-01-01")} >= o."shopifyCreatedAt")
      ),
      sold_units AS (
        SELECT COALESCE(SUM(GREATEST(
          CASE
            WHEN (li->>'quantity') ~ '^[0-9]+$' THEN (li->>'quantity')::int
            ELSE 0
          END,
          0
        )), 0)::int AS sold_units
        FROM cohort_orders co
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(co."lineItems") = 'array' THEN co."lineItems"
            ELSE '[]'::jsonb
          END
        ) AS li
      ),
      received_return_units AS (
        SELECT COALESCE(SUM(GREATEST(ri.quantity, 0)), 0)::int AS received_return_units
        FROM "ReturnItem" ri
        JOIN "ReturnRequest" rr
          ON rr.id = ri."returnRequestId"
          AND rr."shopifyStoreId" = ${shopifyStoreId}
          AND rr.status NOT IN ('CANCELLED', 'REJECTED')
        JOIN cohort_orders co ON co."shopifyOrderId" = rr."shopifyOrderId"
        WHERE ri.status IN ('RECEIVED', 'INSPECTED')
      )
      SELECT sold_units.sold_units, received_return_units.received_return_units
      FROM sold_units CROSS JOIN received_return_units;
    `,
    // Monthly trend: last 6 months, returns vs exchanges, via raw SQL
    // (Prisma groupBy can't truncate dates to month natively)
    db.$queryRaw<{ month: string; returns_count: bigint; exchanges_count: bigint }[]>`
      SELECT
        to_char(month_series, 'Mon') AS month,
        COALESCE(r.count, 0) AS returns_count,
        COALESCE(e.count, 0) AS exchanges_count
      FROM generate_series(
        date_trunc('month', now()) - interval '5 months',
        date_trunc('month', now()),
        interval '1 month'
      ) AS month_series
      LEFT JOIN (
        SELECT date_trunc('month', "createdAt") AS month, COUNT(*) AS count
        FROM "ReturnRequest"
        WHERE "shopifyStoreId" = ${shopifyStoreId}
        GROUP BY 1
      ) r ON r.month = month_series
      LEFT JOIN (
        SELECT date_trunc('month', "createdAt") AS month, COUNT(*) AS count
        FROM "ExchangeRequest"
        WHERE "shopifyStoreId" = ${shopifyStoreId}
        GROUP BY 1
      ) e ON e.month = month_series
      ORDER BY month_series ASC;
    `,
    // Product / SKU performance uses the same order cohort as the unit-rate KPI.
    // The numerator is warehouse-confirmed received/inspected units; request volume
    // is also shown to reveal products with high return demand but low receipt rates.
    db.$queryRaw<{
      product_key: string;
      title: string;
      sku: string | null;
      sold_units: number;
      requested_units: number;
      received_units: number;
      unit_return_rate: number | null;
    }[]>`
      WITH cohort_orders AS (
        SELECT o."shopifyOrderId", o."lineItems"
        FROM "Order" o
        WHERE o."shopifyStoreId" = ${shopifyStoreId}
          AND COALESCE(o."fulfillmentStatus", '') <> 'CANCELLED'
          AND (${filters.startDate ? filters.startDate : new Date(0)} <= o."shopifyCreatedAt")
          AND (${filters.endDate ? filters.endDate : new Date("2100-01-01")} >= o."shopifyCreatedAt")
      ),
      sold_lines AS (
        SELECT
          NULLIF(TRIM(li->>'lineItemId'), '') AS line_item_id,
          COALESCE(
            NULLIF(TRIM(li->>'sku'), ''),
            NULLIF(TRIM(li->>'variantId'), ''),
            NULLIF(TRIM(li->>'productId'), ''),
            NULLIF(TRIM(li->>'lineItemId'), '')
          ) AS product_key,
          COALESCE(NULLIF(TRIM(li->>'title'), ''), 'Unknown Product') AS title,
          NULLIF(TRIM(li->>'sku'), '') AS sku,
          GREATEST(
            CASE WHEN (li->>'quantity') ~ '^[0-9]+$' THEN (li->>'quantity')::int ELSE 0 END,
            0
          ) AS units_sold
        FROM cohort_orders co
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(co."lineItems") = 'array' THEN co."lineItems" ELSE '[]'::jsonb END
        ) AS li
        WHERE NULLIF(TRIM(li->>'lineItemId'), '') IS NOT NULL
      ),
      sold_products AS (
        SELECT product_key, MAX(title) AS title, MAX(sku) AS sku, SUM(units_sold)::int AS sold_units
        FROM sold_lines
        GROUP BY product_key
      ),
      return_products AS (
        SELECT
          sl.product_key,
          SUM(GREATEST(ri.quantity, 0))::int AS requested_units,
          SUM(CASE
            WHEN ri.status IN ('RECEIVED', 'INSPECTED') THEN GREATEST(ri.quantity, 0)
            ELSE 0
          END)::int AS received_units
        FROM "ReturnItem" ri
        JOIN "ReturnRequest" rr
          ON rr.id = ri."returnRequestId"
          AND rr."shopifyStoreId" = ${shopifyStoreId}
          AND rr.status NOT IN ('CANCELLED', 'REJECTED')
        JOIN cohort_orders co ON co."shopifyOrderId" = rr."shopifyOrderId"
        JOIN sold_lines sl ON sl.line_item_id = ri."shopifyLineItemId"
        GROUP BY sl.product_key
      )
      SELECT
        sp.product_key,
        sp.title,
        sp.sku,
        sp.sold_units,
        COALESCE(rp.requested_units, 0)::int AS requested_units,
        COALESCE(rp.received_units, 0)::int AS received_units,
        CASE
          WHEN sp.sold_units > 0
          THEN ROUND(COALESCE(rp.received_units, 0)::numeric / sp.sold_units::numeric * 100, 1)::float8
          ELSE NULL
        END AS unit_return_rate
      FROM sold_products sp
      LEFT JOIN return_products rp ON rp.product_key = sp.product_key
      WHERE COALESCE(rp.requested_units, 0) > 0 OR COALESCE(rp.received_units, 0) > 0
      ORDER BY COALESCE(rp.received_units, 0) DESC, COALESCE(rp.requested_units, 0) DESC, sp.title ASC
      LIMIT 5;
    `,
  ]);

  const totalRequests = totalReturns + totalExchanges;
  const orderedUnits = Number(unitReturnMetricsRaw[0]?.sold_units ?? 0);
  const receivedReturnUnits = Number(unitReturnMetricsRaw[0]?.received_return_units ?? 0);
  // This is a warehouse-confirmed unit rate for the selected order cohort. A
  // complete Order sync and accurate ReturnItem statuses are required.
  const returnRequestShare = totalRequests === 0 ? 0 : (totalReturns / totalRequests) * 100;
  const exchangeRequestShare = totalRequests === 0 ? 0 : (totalExchanges / totalRequests) * 100;

  // Reason shares use all return requests in the selected period as the denominator,
  // including requests with an unspecified reason, rather than only the top five groups.
  const totalReasonCount = totalReturns;
  const confirmedRefundsByCurrency = confirmedRefundsByCurrencyRaw.map((row) => ({
    currency: row.currency || "UNKNOWN",
    amount: Number(row._sum.amount ?? 0),
  }));
  const totalRefunded = confirmedRefundsByCurrency.find((row) => row.currency === "PKR")?.amount ?? 0;
  const revenueFromExchanges = Number(exchangePriceAgg._sum.priceDifference ?? 0);
  // "Revenue retained" = money kept via exchanges instead of paid out as refunds
  const revenueRetained = revenueFromExchanges >= 0 ? revenueFromExchanges : 0;

  return {
    summary: {
      totalReturns,
      totalExchanges,
      totalRequests,
      returnRequestShare: Number(returnRequestShare.toFixed(1)),
      exchangeRequestShare: Number(exchangeRequestShare.toFixed(1)),
      orderedUnits,
      receivedReturnUnits,
      unitReturnRate: orderedUnits > 0 ? Number(((receivedReturnUnits / orderedUnits) * 100).toFixed(1)) : null,
      totalRefunded,
      confirmedRefundsByCurrency,
      revenueFromExchanges,
      revenueRetained,
    },
    returnsByStatus: returnsByStatus.map((r) => ({
      status: r.status,
      count: r._count._all,
    })),
    exchangesByStatus: exchangesByStatus.map((e) => ({
      status: e.status,
      count: e._count._all,
    })),
    returnReasons: returnsByReason.map((r) => ({
      reason: r.reason ?? "Unspecified",
      count: r._count._all,
      percent:
        totalReasonCount === 0
          ? "0%"
          : `${((r._count._all / totalReasonCount) * 100).toFixed(0)}%`,
    })),
    monthlyTrend: monthlyTrendRaw.map((m) => ({
      month: m.month,
      returnsCount: Number(m.returns_count),
      exchangesCount: Number(m.exchanges_count),
    })),
    topReturnedProducts: topReturnedProductsRaw.map((p) => ({
      productKey: p.product_key,
      title: p.title ?? "Unknown Product",
      sku: p.sku,
      orderedUnits: Number(p.sold_units),
      requestedUnits: Number(p.requested_units),
      receivedUnits: Number(p.received_units),
      unitReturnRate: p.unit_return_rate == null ? null : Number(p.unit_return_rate),
    })),
  };
}

/**
 * Generates CSV string of all return and exchange financial audit records for a tenant store.
 */
export async function exportFinancialCSV(shopifyStoreId: string): Promise<string> {
  const [returns, exchanges, shipments] = await Promise.all([
    db.returnRequest.findMany({
      where: { shopifyStoreId },
      include: { items: true },
      orderBy: { createdAt: "desc" },
    }),
    db.exchangeRequest.findMany({
      where: { shopifyStoreId },
      include: { items: true },
      orderBy: { createdAt: "desc" },
    }),
    db.shipmentTrack.findMany({
      where: { shopifyStoreId },
    }),
  ]);

  const shipmentMap = new Map<string, { courier: string; trackingNumber: string }>();
  for (const s of shipments) {
    shipmentMap.set(s.orderNumber, { courier: s.courier, trackingNumber: s.trackingNumber });
  }

  const rows: string[][] = [];
  rows.push([
    "Request ID",
    "Type",
    "Order Number",
    "Customer Email",
    "Status",
    "Reason",
    "Item Count",
    "Total Value (PKR)",
    "Restocking Fee (PKR)",
    "Pickup Fee (PKR)",
    "Net Refund Amount (PKR)",
    "Courier",
    "Tracking CN",
    "Created At",
  ]);

  for (const r of returns) {
    const totalItemVal = r.refundAmount ? Number(r.refundAmount) : 0;
    const restockingFee = Math.round(totalItemVal * 0.1);
    const pickupFee = 250;
    const netRefund = Math.max(0, totalItemVal - restockingFee - pickupFee);
    const shipInfo = shipmentMap.get(r.orderNumber) || { courier: "TCS", trackingNumber: "N/A" };

    rows.push([
      r.id,
      "RETURN",
      r.orderNumber,
      r.customerEmail,
      r.status,
      r.reason || "Size Mismatch",
      String(r.items.length || 1),
      String(totalItemVal),
      String(restockingFee),
      String(pickupFee),
      String(netRefund),
      shipInfo.courier,
      shipInfo.trackingNumber,
      r.createdAt.toISOString(),
    ]);
  }

  for (const e of exchanges) {
    const totalItemVal = e.items.reduce((sum, item) => sum + Number(item.priceDifference), 0);
    const shipInfo = shipmentMap.get(e.orderNumber) || { courier: "TCS", trackingNumber: "N/A" };

    rows.push([
      e.id,
      "EXCHANGE",
      e.orderNumber,
      e.customerEmail,
      e.status,
      "Exchange Request",
      String(e.items.length || 1),
      String(Math.abs(totalItemVal)),
      "0",
      "200",
      String(totalItemVal),
      shipInfo.courier,
      shipInfo.trackingNumber,
      e.createdAt.toISOString(),
    ]);
  }

  return rows.map((row) => row.map((field) => `"${String(field).replace(/"/g, '""')}"`).join(",")).join("\n");
}

