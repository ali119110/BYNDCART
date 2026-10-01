import db from "../db.server";

export async function getAnalytics(shopifyStoreId, filters = {}) {
  const dateFilter =
    filters.startDate || filters.endDate
      ? {
          createdAt: {
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
    refundAgg,
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
    db.returnRequest.aggregate({
      where: { shopifyStoreId, status: "COMPLETED", ...dateFilter },
      _sum: { refundAmount: true },
    }),
    // Monthly trend: last 6 months, returns vs exchanges, via raw SQL
    // (Prisma groupBy can't truncate dates to month natively)
    db.$queryRaw`
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
    // Top returned products: join ReturnItem -> ReturnRequest -> Order,
    // then unpack the matching line item from Order.lineItems JSON to get
    // the product title (line item ids are unique gids, no variant lookup
    // needed). Orders only exist once webhooks/GraphQL sync has run, so
    // this returns [] until then.
    db.$queryRaw`
      SELECT
        li->>'lineItemId' AS line_item_id,
        li->>'title' AS title,
        COUNT(*)::int AS return_count
      FROM "ReturnItem" ri
      JOIN "ReturnRequest" rr
        ON rr.id = ri."returnRequestId"
        AND rr."shopifyStoreId" = ${shopifyStoreId}
      JOIN "Order" o
        ON o."shopifyOrderId" = rr."shopifyOrderId"
        AND o."shopifyStoreId" = ${shopifyStoreId}
      CROSS JOIN LATERAL jsonb_array_elements(o."lineItems") AS li
      WHERE li->>'lineItemId' = ri."shopifyLineItemId"
      GROUP BY li->>'lineItemId', li->>'title'
      ORDER BY return_count DESC
      LIMIT 10;
    `,
  ]);
  const totalRequests = totalReturns + totalExchanges;
  const returnRate =
    totalRequests === 0 ? 0 : (totalReturns / totalRequests) * 100;
  const exchangeRate =
    totalRequests === 0 ? 0 : (totalExchanges / totalRequests) * 100;
  const totalReasonCount = returnsByReason.reduce(
    (sum, r) => sum + r._count._all,
    0,
  );
  const totalRefunded = Number(refundAgg._sum.refundAmount ?? 0);
  const revenueFromExchanges = Number(
    exchangePriceAgg._sum.priceDifference ?? 0,
  );
  // "Revenue retained" = money kept via exchanges instead of paid out as refunds
  const revenueRetained = revenueFromExchanges >= 0 ? revenueFromExchanges : 0;

  return {
    summary: {
      totalReturns,
      totalExchanges,
      totalRequests,
      returnRate: Number(returnRate.toFixed(1)),
      exchangeRate: Number(exchangeRate.toFixed(1)),
      totalRefunded,
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
      lineItemId: p.line_item_id,
      title: p.title ?? "Unknown Product",
      returnCount: Number(p.return_count),
    })),
  };
}

/**
 * Generates CSV string of all return and exchange financial audit records for a tenant store.
 */
export async function exportFinancialCSV(shopifyStoreId) {
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
  const shipmentMap = new Map();

  for (const s of shipments) {
    shipmentMap.set(s.orderNumber, {
      courier: s.courier,
      trackingNumber: s.trackingNumber,
    });
  }

  const rows = [];

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
    const shipInfo = shipmentMap.get(r.orderNumber) || {
      courier: "TCS",
      trackingNumber: "N/A",
    };

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
    const totalItemVal = e.items.reduce(
      (sum, item) => sum + Number(item.priceDifference),
      0,
    );
    const shipInfo = shipmentMap.get(e.orderNumber) || {
      courier: "TCS",
      trackingNumber: "N/A",
    };

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

  return rows
    .map((row) =>
      row.map((field) => `"${String(field).replace(/"/g, '""')}"`).join(","),
    )
    .join("\n");
}
