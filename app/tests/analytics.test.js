process.env.SHOPIFY_API_KEY = "mock_api_key";
process.env.SHOPIFY_API_SECRET = "mock_api_secret";
process.env.SHOPIFY_APP_URL = "https://byndcart-mock.app";
process.env.SCOPES = "read_orders,write_returns";
process.env.DATABASE_URL = "postgresql://mock:mock@localhost:5432/mock";
process.env.NODE_ENV = "test";
import test from "node:test";
import assert from "node:assert";
import prisma from "../db.server";

prisma.$transaction = async (cb) => {
  return await cb(prisma);
};

// Mock prisma queries for offline testing
prisma.storeSettings.findUnique = async () => ({
  id: "setting-1",
  shopifyStoreId: "store-1",
  returnWindowDays: 14,
  restockingFeePercent: 15,
  exchangeWindowDays: 14,
  exchangeShippingCost: 250,
  notificationEmail: "merchant@byndcart.pk",
  emailNotificationsEnabled: true,
  fraudFlagReturnCount: 2,
  fraudFlagWindowDays: 14,
  fraudFlagWindowCount: 1,
});
prisma.storeSettings.upsert = async (args) => ({
  id: "setting-1",
  shopifyStoreId: args.where.shopifyStoreId,
  ...args.update,
});
prisma.returnRequest.count = async () => 5;
prisma.exchangeRequest.count = async () => 2;
prisma.returnRequest.groupBy = async () => [
  { status: "COMPLETED", _count: { _all: 3 } },
  { status: "PENDING", _count: { _all: 2 } },
];
prisma.exchangeRequest.groupBy = async () => [
  { status: "COMPLETED", _count: { _all: 2 } },
];
prisma.exchangeItem.aggregate = async () => ({
  _sum: { priceDifference: 1500 },
});
prisma.returnRequest.aggregate = async () => ({
  _sum: { refundAmount: 12500 },
});

prisma.$queryRaw = async (query) => {
  // Check if raw query is for monthly trend or top returned products
  const str = String(query);

  if (str.includes("generate_series")) {
    return [
      { month: "Jan", returns_count: BigInt(2), exchanges_count: BigInt(1) },
      { month: "Feb", returns_count: BigInt(3), exchanges_count: BigInt(1) },
    ];
  }

  return [
    {
      line_item_id: "gid://shopify/LineItem/1",
      title: "Embroidered Kurti",
      return_count: BigInt(4),
    },
  ];
};

prisma.returnRequest.findMany = async () => [
  {
    id: "ret-uuid-1",
    shopifyStoreId: "store-1",
    shopifyOrderId: "gid://shopify/Order/1001",
    orderNumber: "#1001",
    customerEmail: "shopper@example.pk",
    status: "COMPLETED",
    reason: "Size Mismatch",
    refundAmount: 5000,
    items: [{ id: "item-1" }],
    createdAt: new Date(),
  },
];
prisma.exchangeRequest.findMany = async () => [
  {
    id: "ex-uuid-1",
    shopifyStoreId: "store-1",
    shopifyOrderId: "gid://shopify/Order/1002",
    orderNumber: "#1002",
    customerEmail: "shopper2@example.pk",
    status: "COMPLETED",
    items: [{ id: "ex-item-1", priceDifference: 500 }],
    createdAt: new Date(),
  },
];
prisma.shipmentTrack.findMany = async () => [
  {
    orderNumber: "#1001",
    courier: "TCS",
    trackingNumber: "7712345678",
  },
];
test("Settings Service - Update Fraud & Abuse Thresholds", async () => {
  const { updateSettings } = await import("../services/settings.server");
  const updated = await updateSettings("store-1", {
    fraudFlagReturnCount: 2,
    fraudFlagWindowDays: 14,
    fraudFlagWindowCount: 1,
  });

  assert.strictEqual(updated.fraudFlagReturnCount, 2);
  assert.strictEqual(updated.fraudFlagWindowDays, 14);
  assert.strictEqual(updated.fraudFlagWindowCount, 1);
});
test("Customer Risk Service - Dynamic Custom Threshold Evaluation", async () => {
  const { getCustomerRiskFlag } = await import("../services/fraud.server");
  const flag = await getCustomerRiskFlag("store-1", "shopper@example.pk");

  assert.strictEqual(flag.flagged, true);
  assert.ok(flag.reasons.some((r) => r.includes("threshold: 2")));
});
test("Analytics Service - Get Store Financial Metrics in PKR", async () => {
  const { getAnalytics } = await import("../services/analytics.server");
  const analytics = await getAnalytics("store-1");

  assert.strictEqual(analytics.summary.totalReturns, 5);
  assert.strictEqual(analytics.summary.totalExchanges, 2);
  assert.strictEqual(analytics.summary.totalRefunded, 12500);
  assert.strictEqual(analytics.summary.revenueFromExchanges, 1500);
  assert.strictEqual(
    analytics.topReturnedProducts[0].title,
    "Embroidered Kurti",
  );
});
test("Analytics Service - Export Financial Ledger CSV", async () => {
  const { exportFinancialCSV } = await import("../services/analytics.server");
  const csv = await exportFinancialCSV("store-1");

  assert.ok(csv.includes('"Request ID","Type","Order Number"'));
  assert.ok(csv.includes('"ret-uuid-1","RETURN","#1001"'));
  assert.ok(csv.includes('"ex-uuid-1","EXCHANGE","#1002"'));
  assert.ok(csv.includes('"TCS"'));
});
