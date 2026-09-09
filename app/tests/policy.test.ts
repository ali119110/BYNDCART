process.env.SHOPIFY_API_KEY = "mock_api_key";
process.env.SHOPIFY_API_SECRET = "mock_api_secret";
process.env.SHOPIFY_APP_URL = "https://byndcart-mock.app";
process.env.SCOPES = "read_orders,write_returns";
process.env.DATABASE_URL = "postgresql://mock:mock@localhost:5432/mock";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert";

import prisma from "../db.server";
import {
  checkReturnEligibility,
  saveReturnPolicyRule,
  getReturnPolicyRule,
} from "../services/policyEngine.server";
import { submitShopperReturn } from "../services/portal.server";
import { createCustomerSessionToken } from "../services/otp.server";

// Mock Database Storage
let mockRules: any[] = [];
let mockOrders: any[] = [];
let mockReturnRequests: any[] = [];
let mockExchangeRequests: any[] = [];
let mockAuditLogs: any[] = [];
let mockSubscriptions: any[] = [];

(prisma as any).billingSubscription = {
  findUnique: async (args: any) => {
    return mockSubscriptions.find((s) => s.shopifyStoreId === args.where.shopifyStoreId) || null;
  },
  create: async (args: any) => {
    const sub = { id: `sub-${Date.now()}`, ...args.data };
    mockSubscriptions.push(sub);
    return sub;
  },
  update: async (args: any) => ({ ...args.data }),
  upsert: async (args: any) => {
    const sub = { id: `sub-${Date.now()}`, shopifyStoreId: args.where.shopifyStoreId, ...args.create };
    mockSubscriptions.push(sub);
    return sub;
  },
};

prisma.returnPolicyRule.findUnique = (async (args: any) => {
  return mockRules.find((r) => r.shopifyStoreId === args.where.shopifyStoreId) || null;
}) as any;

prisma.returnPolicyRule.upsert = (async (args: any) => {
  const storeId = args.where.shopifyStoreId;
  const idx = mockRules.findIndex((r) => r.shopifyStoreId === storeId);
  if (idx >= 0) {
    mockRules[idx] = { ...mockRules[idx], ...args.update, updatedAt: new Date() };
    return mockRules[idx];
  } else {
    const newRule = {
      id: `rule-uuid-${Date.now()}-${Math.random()}`,
      shopifyStoreId: storeId,
      ...args.create,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockRules.push(newRule);
    return newRule;
  }
}) as any;

prisma.returnPolicyRule.create = (async (args: any) => {
  const newRule = {
    id: `rule-uuid-${Date.now()}-${Math.random()}`,
    ...args.data,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  mockRules.push(newRule);
  return newRule;
}) as any;

prisma.order.findFirst = (async (args: any) => {
  const storeId = args.where.shopifyStoreId;
  const ordNum = args.where.orderNumber?.equals;

  return (
    mockOrders.find(
      (o) =>
        o.shopifyStoreId === storeId &&
        (ordNum ? o.orderNumber.toLowerCase() === ordNum.toLowerCase() : true)
    ) || null
  );
}) as any;

prisma.returnRequest.count = (async (args: any) => {
  const storeId = args?.where?.shopifyStoreId;
  return mockReturnRequests.filter((r) => !storeId || r.shopifyStoreId === storeId).length;
}) as any;

prisma.returnRequest.findFirst = (async (args: any) => {
  const storeId = args.where.shopifyStoreId;
  const ordNum = args.where.orderNumber;
  return (
    mockReturnRequests.find(
      (r) =>
        r.shopifyStoreId === storeId &&
        r.orderNumber === ordNum &&
        (args.where.status?.not ? r.status !== args.where.status.not : true)
    ) || null
  );
}) as any;

prisma.exchangeRequest.findFirst = (async (args: any) => {
  const storeId = args.where.shopifyStoreId;
  const ordNum = args.where.orderNumber;
  return (
    mockExchangeRequests.find(
      (e) =>
        e.shopifyStoreId === storeId &&
        e.orderNumber === ordNum &&
        (args.where.status?.not ? e.status !== args.where.status.not : true)
    ) || null
  );
}) as any;

prisma.auditLog.create = (async (args: any) => {
  mockAuditLogs.push(args.data);
  return args.data;
}) as any;

prisma.storeSettings.findUnique = (async () => ({
  id: "setting-1",
  shopifyStoreId: "store-1",
  returnWindowDays: 30,
  restockingFeePercent: 10,
})) as any;

prisma.returnRequest.create = (async (args: any) => ({
  id: "ret-new-1",
  shopifyStoreId: args.data.shopifyStoreId,
  orderNumber: args.data.orderNumber,
  customerEmail: args.data.customerEmail,
  status: "PENDING",
})) as any;

prisma.returnRequest.update = (async () => ({})) as any;
prisma.shipmentTrack.upsert = (async () => ({ trackingNumber: "77000111" })) as any;

test("Return Policy Engine — Valid Return Check", async () => {
  mockRules = [];
  mockOrders = [];
  mockReturnRequests = [];
  mockExchangeRequests = [];

  mockOrders.push({
    id: "ord-1",
    shopifyStoreId: "store-1",
    shopifyOrderId: "gid://shopify/Order/1001",
    orderNumber: "#1001",
    customerEmail: "valid@example.pk",
    shopifyCreatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days old
  });

  const res = await checkReturnEligibility({
    shopifyStoreId: "store-1",
    orderNumber: "#1001",
    customerEmail: "valid@example.pk",
    requestType: "RETURN",
    requestedItems: [
      {
        shopifyLineItemId: "gid://shopify/LineItem/1",
        quantity: 1,
        sku: "SHIRT-M",
        category: "Apparel",
      },
    ],
  });

  assert.strictEqual(res.eligible, true);
  assert.strictEqual(res.reasonCode, "ELIGIBLE");
  assert.strictEqual(res.itemResults[0].eligible, true);
});

test("Return Policy Engine — Return Window Expiry", async () => {
  mockRules = [];
  mockOrders = [];

  await saveReturnPolicyRule("store-1", { returnWindowDays: 14 });

  mockOrders.push({
    id: "ord-2",
    shopifyStoreId: "store-1",
    shopifyOrderId: "gid://shopify/Order/1002",
    orderNumber: "#1002",
    customerEmail: "old@example.pk",
    shopifyCreatedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000), // 20 days old
  });

  const res = await checkReturnEligibility({
    shopifyStoreId: "store-1",
    orderNumber: "#1002",
    customerEmail: "old@example.pk",
    requestType: "RETURN",
  });

  assert.strictEqual(res.eligible, false);
  assert.strictEqual(res.reasonCode, "WINDOW_EXPIRED");
  assert.ok(res.message.includes("exceeding the store's 14-day"));
});

test("Return Policy Engine — Excluded Product / SKU Check", async () => {
  mockRules = [];
  mockOrders = [];

  await saveReturnPolicyRule("store-1", {
    excludedSkus: ["FINAL-SALE-SKU"],
    excludedProductIds: ["gid://shopify/Product/999"],
  });

  mockOrders.push({
    id: "ord-3",
    shopifyStoreId: "store-1",
    shopifyOrderId: "gid://shopify/Order/1003",
    orderNumber: "#1003",
    customerEmail: "sku@example.pk",
    shopifyCreatedAt: new Date(),
  });

  const resSku = await checkReturnEligibility({
    shopifyStoreId: "store-1",
    orderNumber: "#1003",
    customerEmail: "sku@example.pk",
    requestedItems: [
      { shopifyLineItemId: "li-1", quantity: 1, sku: "FINAL-SALE-SKU" },
    ],
  });

  assert.strictEqual(resSku.eligible, false);
  assert.strictEqual(resSku.reasonCode, "EXCLUDED_SKU");

  const resProd = await checkReturnEligibility({
    shopifyStoreId: "store-1",
    orderNumber: "#1003",
    customerEmail: "sku@example.pk",
    requestedItems: [
      { shopifyLineItemId: "li-2", quantity: 1, productId: "gid://shopify/Product/999" },
    ],
  });

  assert.strictEqual(resProd.eligible, false);
  assert.strictEqual(resProd.reasonCode, "EXCLUDED_PRODUCT");
});

test("Return Policy Engine — Excluded Category Check", async () => {
  mockRules = [];
  mockOrders = [];

  await saveReturnPolicyRule("store-1", {
    excludedCategories: ["Lingerie", "Clearance"],
  });

  mockOrders.push({
    id: "ord-4",
    shopifyStoreId: "store-1",
    orderNumber: "#1004",
    customerEmail: "cat@example.pk",
    shopifyCreatedAt: new Date(),
  });

  const res = await checkReturnEligibility({
    shopifyStoreId: "store-1",
    orderNumber: "#1004",
    customerEmail: "cat@example.pk",
    requestedItems: [
      { shopifyLineItemId: "li-3", quantity: 1, category: "Lingerie" },
    ],
  });

  assert.strictEqual(res.eligible, false);
  assert.strictEqual(res.reasonCode, "EXCLUDED_CATEGORY");
});

test("Return Policy Engine — Sale / Discounted Item Restriction", async () => {
  mockRules = [];
  mockOrders = [];

  await saveReturnPolicyRule("store-1", { allowSaleItems: false });

  mockOrders.push({
    id: "ord-5",
    shopifyStoreId: "store-1",
    orderNumber: "#1005",
    customerEmail: "sale@example.pk",
    shopifyCreatedAt: new Date(),
  });

  const res = await checkReturnEligibility({
    shopifyStoreId: "store-1",
    orderNumber: "#1005",
    customerEmail: "sale@example.pk",
    requestedItems: [
      { shopifyLineItemId: "li-4", quantity: 1, isSaleItem: true, price: 1500, originalPrice: 3000 },
    ],
  });

  assert.strictEqual(res.eligible, false);
  assert.strictEqual(res.reasonCode, "SALE_ITEMS_EXCLUDED");
});

test("Return Policy Engine — Maximum Return Quantity Limit", async () => {
  mockRules = [];
  mockOrders = [];

  await saveReturnPolicyRule("store-1", { maxReturnQuantity: 3 });

  mockOrders.push({
    id: "ord-6",
    shopifyStoreId: "store-1",
    orderNumber: "#1006",
    customerEmail: "qty@example.pk",
    shopifyCreatedAt: new Date(),
  });

  const res = await checkReturnEligibility({
    shopifyStoreId: "store-1",
    orderNumber: "#1006",
    customerEmail: "qty@example.pk",
    requestedItems: [
      { shopifyLineItemId: "li-5", quantity: 5 }, // 5 items exceeds 3 max limit
    ],
  });

  assert.strictEqual(res.eligible, false);
  assert.strictEqual(res.reasonCode, "MAX_QUANTITY_EXCEEDED");
});

test("Return Policy Engine — Exchanges Disabled Toggle", async () => {
  mockRules = [];
  mockOrders = [];

  await saveReturnPolicyRule("store-1", { exchangesAllowed: false });

  mockOrders.push({
    id: "ord-7",
    shopifyStoreId: "store-1",
    orderNumber: "#1007",
    customerEmail: "ex@example.pk",
    shopifyCreatedAt: new Date(),
  });

  const res = await checkReturnEligibility({
    shopifyStoreId: "store-1",
    orderNumber: "#1007",
    customerEmail: "ex@example.pk",
    requestType: "EXCHANGE",
  });

  assert.strictEqual(res.eligible, false);
  assert.strictEqual(res.reasonCode, "EXCHANGES_DISABLED");
});

test("Return Policy Engine — Previous Return Request Restriction", async () => {
  mockRules = [];
  mockOrders = [];
  mockReturnRequests = [];

  await saveReturnPolicyRule("store-1", { preventPreviousReturns: true });

  mockOrders.push({
    id: "ord-8",
    shopifyStoreId: "store-1",
    orderNumber: "#1008",
    customerEmail: "prev@example.pk",
    shopifyCreatedAt: new Date(),
  });

  // Active return already exists
  mockReturnRequests.push({
    id: "ret-existing",
    shopifyStoreId: "store-1",
    orderNumber: "#1008",
    status: "PENDING",
  });

  const res = await checkReturnEligibility({
    shopifyStoreId: "store-1",
    orderNumber: "#1008",
    customerEmail: "prev@example.pk",
  });

  assert.strictEqual(res.eligible, false);
  assert.strictEqual(res.reasonCode, "PREVIOUS_RETURN_EXISTS");
});

test("Return Policy Engine — Cross-Merchant Tenant Access Prevention", async () => {
  mockRules = [];
  mockOrders = [];

  mockOrders.push({
    id: "ord-9",
    shopifyStoreId: "store-1",
    orderNumber: "#1009",
    customerEmail: "cross@example.pk",
    shopifyCreatedAt: new Date(),
  });

  // Attempt to query store-1 order using store-2 tenant context
  const res = await checkReturnEligibility({
    shopifyStoreId: "store-2",
    orderNumber: "#1009",
    customerEmail: "cross@example.pk",
  });

  assert.strictEqual(res.eligible, false);
  assert.strictEqual(res.reasonCode, "ORDER_NOT_FOUND");
});

test("Return Policy Engine — Server-Side Frontend Bypass Attempt Blocking", async () => {
  mockRules = [];
  mockOrders = [];
  mockReturnRequests = [];

  await saveReturnPolicyRule("store-1", { returnWindowDays: 7 });

  mockOrders.push({
    id: "ord-10",
    shopifyStoreId: "store-1",
    shopifyOrderId: "gid://shopify/Order/1010",
    orderNumber: "#1010",
    customerEmail: "hacker@example.pk",
    shopifyCreatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days old (expired)
  });

  const validToken = createCustomerSessionToken({
    shopifyStoreId: "store-1",
    orderNumber: "#1010",
    customerEmail: "hacker@example.pk",
  });

  // Direct HTTP action call attempting to bypass frontend policy checks
  await assert.rejects(
    async () => {
      await submitShopperReturn({
        shopifyStoreId: "store-1",
        shopifyOrderId: "gid://shopify/Order/1010",
        orderNumber: "#1010",
        customerEmail: "hacker@example.pk",
        reason: "Direct API Bypass",
        sessionToken: validToken,
        items: [{ shopifyLineItemId: "li-10", quantity: 1, reason: "Bypass", price: 2000 }],
      });
    },
    /Policy Rejection \(WINDOW_EXPIRED\)/
  );
});
