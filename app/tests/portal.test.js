process.env.SHOPIFY_API_KEY = "mock_api_key";
process.env.SHOPIFY_API_SECRET = "mock_api_secret";
process.env.SHOPIFY_APP_URL = "https://byndcart-mock.app";
process.env.SCOPES = "read_orders,write_returns";
process.env.DATABASE_URL = "postgresql://mock:mock@localhost:5432/mock";
process.env.NODE_ENV = "test";
import test from "node:test";
import assert from "node:assert";
import prisma from "../db.server";
import { createCustomerSessionToken } from "../services/otp.server";

prisma.$transaction = async (cb) => {
  return await cb(prisma);
};

// Mock prisma queries for portal testing
prisma.billingSubscription = {
  findUnique: async (args) => ({
    id: "sub-1",
    shopifyStoreId: args?.where?.shopifyStoreId || "store-1",
    name: "Free Plan",
    planCode: "FREE",
    status: "ACTIVE",
    price: 0,
    monthlyReturnLimit: 15,
  }),
  create: async (args) => ({ ...args.data }),
  update: async (args) => ({ ...args.data }),
  upsert: async (args) => ({ ...args.create }),
};
prisma.storeSettings.findUnique = async () => ({
  id: "setting-1",
  shopifyStoreId: "store-1",
  returnWindowDays: 30,
  restockingFeePercent: 10,
  exchangeWindowDays: 30,
  exchangeShippingCost: 200,
  notificationEmail: "merchant@byndcart.pk",
  emailNotificationsEnabled: true,
  fraudFlagReturnCount: 5,
  fraudFlagWindowDays: 30,
  fraudFlagWindowCount: 3,
});

prisma.order.findFirst = async (args) => {
  if (args.where.shopifyStoreId === "store-1") {
    return {
      id: "ord-uuid-101",
      shopifyStoreId: "store-1",
      shopifyOrderId: "gid://shopify/Order/1001",
      orderNumber: "#1001",
      customerEmail: "shopper@example.pk",
      customerName: "Tariq Mahmood",
      totalPrice: 5000,
      currency: "PKR",
      lineItems: [
        {
          lineItemId: "gid://shopify/LineItem/1",
          variantId: "gid://shopify/ProductVariant/10",
          title: "Kurta Shirt XL",
          quantity: 1,
          price: 3000,
        },
      ],
      shopifyCreatedAt: new Date(),
    };
  }

  return null;
};

prisma.returnRequest.count = async () => 0;
prisma.returnRequest.create = async (args) => ({
  id: "ret-uuid-201",
  shopifyStoreId: args.data.shopifyStoreId,
  shopifyOrderId: args.data.shopifyOrderId,
  orderNumber: args.data.orderNumber,
  customerEmail: args.data.customerEmail,
  status: "PENDING",
  createdAt: new Date(),
});
prisma.returnRequest.findUnique = async () => ({
  id: "ret-uuid-201",
  items: [],
});
prisma.returnRequest.update = async () => ({});
prisma.returnItem.createMany = async () => ({ count: 1 });
prisma.auditLog.create = async () => ({});
prisma.shipmentTrack.upsert = async (args) => ({
  id: "ship-uuid-301",
  trackingNumber: args.create.trackingNumber,
  status: "LABEL_CREATED",
});
test("Portal Service - Order Lookup & Eligibility Check with Verified Session", async () => {
  const { lookupShopperOrder } = await import("../services/portal.server");
  const sessionToken = createCustomerSessionToken({
    shopifyStoreId: "store-1",
    orderNumber: "#1001",
    customerEmail: "shopper@example.pk",
  });
  const result = await lookupShopperOrder("store-1", sessionToken);

  assert.strictEqual(result.eligible, true);
  assert.strictEqual(result.order.orderNumber, "#1001");
  assert.strictEqual(result.order.totalPrice, 5000);
});
test("Portal Service - Submit Shopper Return with PKR Restocking Fee Math & Verified Session", async () => {
  const { submitShopperReturn } = await import("../services/portal.server");
  const sessionToken = createCustomerSessionToken({
    shopifyStoreId: "store-1",
    orderNumber: "#1001",
    customerEmail: "shopper@example.pk",
  });
  const res = await submitShopperReturn({
    shopifyStoreId: "store-1",
    shopifyOrderId: "gid://shopify/Order/1001",
    orderNumber: "#1001",
    customerEmail: "shopper@example.pk",
    customerName: "Tariq Mahmood",
    courier: "TCS",
    reason: "Size Mismatch",
    sessionToken,
    items: [
      {
        shopifyLineItemId: "gid://shopify/LineItem/1",
        quantity: 1,
        reason: "Size Mismatch",
        price: 3000,
      },
    ],
  });

  assert.strictEqual(res.success, true);
  assert.ok(res.trackingNumber.startsWith("77"));
  assert.strictEqual(res.summaryPKR.totalItemValue, 3000);
  assert.strictEqual(res.summaryPKR.restockingFeeDeduction, 300); // 10% of 3000
  assert.strictEqual(res.summaryPKR.pickupFeeDeduction, 250); // TCS fee
  assert.strictEqual(res.summaryPKR.netRefundAmount, 2450); // 3000 - 300 - 250
});
