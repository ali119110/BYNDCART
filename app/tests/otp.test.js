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
  requestCustomerOTP,
  verifyCustomerOTP,
  hashOTP,
  createCustomerSessionToken,
  verifyCustomerSessionToken,
  clearRateLimits,
} from "../services/otp.server";
import {
  lookupShopperOrder,
  submitShopperReturn,
} from "../services/portal.server";
// Mock Database Storage for OTP tests
let mockOtpStore = [];
let mockAuditLogs = [];

prisma.order.findFirst = async (args) => {
  if (
    args.where.shopifyStoreId === "store-1" &&
    args.where.orderNumber.equals === "#1001" &&
    args.where.customerEmail.equals === "shopper@example.pk"
  ) {
    return {
      id: "ord-1001",
      shopifyStoreId: "store-1",
      shopifyOrderId: "gid://shopify/Order/1001",
      orderNumber: "#1001",
      customerEmail: "shopper@example.pk",
      customerName: "Shopper One",
      totalPrice: 4000,
      currency: "PKR",
      lineItems: [
        {
          lineItemId: "gid://shopify/LineItem/101",
          variantId: "gid://shopify/ProductVariant/201",
          title: "Embroidered Kurti - M",
          quantity: 1,
          price: 4000,
        },
      ],
      shopifyCreatedAt: new Date(),
    };
  }

  return null;
};

prisma.customerOTP.updateMany = async (args) => {
  mockOtpStore.forEach((rec) => {
    if (
      rec.shopifyStoreId === args.where.shopifyStoreId &&
      rec.orderNumber === args.where.orderNumber &&
      rec.destination === args.where.destination &&
      rec.verified === false
    ) {
      rec.expiresAt = args.data.expiresAt;
    }
  });

  return { count: 1 };
};

prisma.customerOTP.create = async (args) => {
  const newRec = {
    id: `otp-uuid-${Date.now()}-${Math.random()}`,
    ...args.data,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  mockOtpStore.push(newRec);

  return newRec;
};

prisma.customerOTP.findFirst = async (args) => {
  const matching = mockOtpStore.filter((rec) => {
    if (
      args.where.shopifyStoreId &&
      rec.shopifyStoreId !== args.where.shopifyStoreId
    )
      return false;
    if (args.where.orderNumber && rec.orderNumber !== args.where.orderNumber)
      return false;
    if (args.where.destination && rec.destination !== args.where.destination)
      return false;
    if (
      args.where.verified !== undefined &&
      rec.verified !== args.where.verified
    )
      return false;
    if (
      args.where.expiresAt?.gt &&
      new Date(rec.expiresAt).getTime() <=
        new Date(args.where.expiresAt.gt).getTime()
    )
      return false;

    return true;
  });

  return matching.length > 0 ? matching[matching.length - 1] : null;
};

prisma.customerOTP.update = async (args) => {
  const rec = mockOtpStore.find((r) => r.id === args.where.id);

  if (rec) {
    if (args.data.verified !== undefined) rec.verified = args.data.verified;
    if (args.data.attempts?.increment)
      rec.attempts += args.data.attempts.increment;
  }

  return rec;
};

prisma.auditLog.create = async (args) => {
  mockAuditLogs.push(args.data);

  return args.data;
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
});
prisma.returnRequest.create = async (args) => ({
  id: "ret-1001",
  shopifyStoreId: args.data.shopifyStoreId,
  shopifyOrderId: args.data.shopifyOrderId,
  orderNumber: args.data.orderNumber,
  customerEmail: args.data.customerEmail,
  status: "PENDING",
  createdAt: new Date(),
});
prisma.returnRequest.update = async () => ({});
prisma.returnItem.createMany = async () => ({ count: 1 });
prisma.shipmentTrack.upsert = async (args) => ({
  id: "ship-1",
  trackingNumber: "777000111",
});
test("OTP & Security — Request OTP & Anti-Enumeration", async () => {
  clearRateLimits();
  mockOtpStore = [];
  mockAuditLogs = [];
  // Request for valid order
  const resValid = await requestCustomerOTP(
    "store-1",
    "#1001",
    "shopper@example.pk",
  );

  assert.strictEqual(resValid.success, true);
  assert.ok(resValid.message.includes("a verification code has been sent"));
  assert.strictEqual(mockOtpStore.length, 1);
  // Request for non-existent order (same response message to prevent enumeration)
  const resInvalid = await requestCustomerOTP(
    "store-1",
    "#9999",
    "hacker@example.pk",
  );

  assert.strictEqual(resInvalid.success, true);
  assert.ok(resInvalid.message.includes("a verification code has been sent"));
  // OTP store should not increase for invalid order
  assert.strictEqual(mockOtpStore.length, 1);
});
test("OTP & Security — Valid OTP Verification & Session Generation", async () => {
  clearRateLimits();
  mockOtpStore = [];
  // Setup predictable OTP
  const rawCode = "654321";

  mockOtpStore.push({
    id: "otp-valid-1",
    shopifyStoreId: "store-1",
    orderNumber: "#1001",
    destination: "shopper@example.pk",
    otpHash: hashOTP(rawCode),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    attempts: 0,
    maxAttempts: 3,
    verified: false,
  });
  const res = await verifyCustomerOTP(
    "store-1",
    "#1001",
    "shopper@example.pk",
    rawCode,
  );

  assert.strictEqual(res.success, true);
  assert.ok(res.sessionToken);
  assert.strictEqual(res.orderNumber, "#1001");
  // Verify DB record updated to verified
  const rec = mockOtpStore.find((r) => r.id === "otp-valid-1");

  assert.strictEqual(rec.verified, true);
});
test("OTP & Security — Invalid OTP Rejection & Failed Attempt Counter", async () => {
  clearRateLimits();
  mockOtpStore = [];
  mockOtpStore.push({
    id: "otp-invalid-1",
    shopifyStoreId: "store-1",
    orderNumber: "#1001",
    destination: "shopper@example.pk",
    otpHash: hashOTP("123456"),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    attempts: 0,
    maxAttempts: 3,
    verified: false,
  });
  const res = await verifyCustomerOTP(
    "store-1",
    "#1001",
    "shopper@example.pk",
    "999999",
  );

  assert.strictEqual(res.success, false);
  assert.ok(res.error?.includes("2 attempts remaining"));
  const rec = mockOtpStore.find((r) => r.id === "otp-invalid-1");

  assert.strictEqual(rec.attempts, 1);
});
test("OTP & Security — Expired OTP Rejection", async () => {
  clearRateLimits();
  mockOtpStore = [];
  mockOtpStore.push({
    id: "otp-expired-1",
    shopifyStoreId: "store-1",
    orderNumber: "#1001",
    destination: "shopper@example.pk",
    otpHash: hashOTP("112233"),
    expiresAt: new Date(Date.now() - 1000), // Expired 1 second ago
    attempts: 0,
    maxAttempts: 3,
    verified: false,
  });
  const res = await verifyCustomerOTP(
    "store-1",
    "#1001",
    "shopper@example.pk",
    "112233",
  );

  assert.strictEqual(res.success, false);
  assert.ok(res.error?.includes("invalid or has expired"));
});
test("OTP & Security — Reused OTP Rejection", async () => {
  clearRateLimits();
  mockOtpStore = [];
  mockOtpStore.push({
    id: "otp-reused-1",
    shopifyStoreId: "store-1",
    orderNumber: "#1001",
    destination: "shopper@example.pk",
    otpHash: hashOTP("445566"),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    attempts: 0,
    maxAttempts: 3,
    verified: true, // Already used once
  });
  const res = await verifyCustomerOTP(
    "store-1",
    "#1001",
    "shopper@example.pk",
    "445566",
  );

  assert.strictEqual(res.success, false);
  assert.ok(res.error?.includes("invalid or has expired"));
});
test("OTP & Security — Maximum Verification Attempts Lockout", async () => {
  clearRateLimits();
  mockOtpStore = [];
  mockOtpStore.push({
    id: "otp-max-1",
    shopifyStoreId: "store-1",
    orderNumber: "#1001",
    destination: "shopper@example.pk",
    otpHash: hashOTP("888888"),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    attempts: 3, // Already reached max
    maxAttempts: 3,
    verified: false,
  });
  const res = await verifyCustomerOTP(
    "store-1",
    "#1001",
    "shopper@example.pk",
    "888888",
  );

  assert.strictEqual(res.success, false);
  assert.ok(res.error?.includes("Maximum verification attempts exceeded"));
});
test("OTP & Security — OTP Request Rate Limiting", async () => {
  clearRateLimits();
  // Make 3 requests (allowed)
  await requestCustomerOTP("store-1", "#1001", "shopper@example.pk");
  await requestCustomerOTP("store-1", "#1001", "shopper@example.pk");
  await requestCustomerOTP("store-1", "#1001", "shopper@example.pk");
  // 4th request should throw rate limit error
  await assert.rejects(async () => {
    await requestCustomerOTP("store-1", "#1001", "shopper@example.pk");
  }, /Too many OTP requests/);
});
test("OTP & Security — Verification Attempt Rate Limiting", async () => {
  clearRateLimits();
  mockOtpStore = [];
  mockOtpStore.push({
    id: "otp-ratelimit-verify",
    shopifyStoreId: "store-1",
    orderNumber: "#1001",
    destination: "shopper@example.pk",
    otpHash: hashOTP("000000"),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    attempts: 0,
    maxAttempts: 10,
    verified: false,
  });

  // Make 5 verification attempts
  for (let i = 0; i < 5; i++) {
    await verifyCustomerOTP("store-1", "#1001", "shopper@example.pk", "111111");
  }

  // 6th verification attempt should be blocked by rate limiter
  await assert.rejects(async () => {
    await verifyCustomerOTP("store-1", "#1001", "shopper@example.pk", "111111");
  }, /Too many failed verification attempts/);
});
test("OTP & Security — Session Token Verification & Expiry", async () => {
  const validToken = createCustomerSessionToken({
    shopifyStoreId: "store-1",
    orderNumber: "#1001",
    customerEmail: "shopper@example.pk",
    durationMinutes: 15,
  });
  const parsedValid = verifyCustomerSessionToken(
    validToken,
    "store-1",
    "#1001",
  );

  assert.ok(parsedValid);
  assert.strictEqual(parsedValid.orderNumber, "#1001");
  // Expired Token (negative duration)
  const expiredToken = createCustomerSessionToken({
    shopifyStoreId: "store-1",
    orderNumber: "#1001",
    customerEmail: "shopper@example.pk",
    durationMinutes: -1,
  });
  const parsedExpired = verifyCustomerSessionToken(
    expiredToken,
    "store-1",
    "#1001",
  );

  assert.strictEqual(parsedExpired, null);
});
test("OTP & Security — Cross-Merchant Access Prevention", async () => {
  const store1Token = createCustomerSessionToken({
    shopifyStoreId: "store-1",
    orderNumber: "#1001",
    customerEmail: "shopper@example.pk",
  });
  // Attempt to use store-1 token to access store-2
  const parsedCross = verifyCustomerSessionToken(
    store1Token,
    "store-2",
    "#1001",
  );

  assert.strictEqual(parsedCross, null);
  // Unauthenticated order lookup with store-2 should fail
  await assert.rejects(async () => {
    await lookupShopperOrder("store-2", store1Token);
  }, /Unauthorized access/);
});
test("OTP & Security — Changing Order Number After Authentication Prevention", async () => {
  const tokenForOrder1001 = createCustomerSessionToken({
    shopifyStoreId: "store-1",
    orderNumber: "#1001",
    customerEmail: "shopper@example.pk",
  });
  // Attempting to verify token for order #9999 should fail
  const parsedTampered = verifyCustomerSessionToken(
    tokenForOrder1001,
    "store-1",
    "#9999",
  );

  assert.strictEqual(parsedTampered, null);
  // Attempting to submit return for order #9999 using #1001 token should fail
  await assert.rejects(async () => {
    await submitShopperReturn({
      shopifyStoreId: "store-1",
      shopifyOrderId: "gid://shopify/Order/9999",
      orderNumber: "#9999",
      customerEmail: "shopper@example.pk",
      reason: "Hacking attempt",
      sessionToken: tokenForOrder1001,
      items: [],
    });
  }, /Unauthorized return submission/);
});
test("OTP & Security — Unauthorized Return & Exchange Submission Prevention", async () => {
  // Invalid session token
  await assert.rejects(async () => {
    await submitShopperReturn({
      shopifyStoreId: "store-1",
      shopifyOrderId: "gid://shopify/Order/1001",
      orderNumber: "#1001",
      customerEmail: "shopper@example.pk",
      reason: "Test",
      sessionToken: "invalid.fake.token",
      items: [],
    });
  }, /Unauthorized return submission/);
  // Unauthenticated order lookup without token
  await assert.rejects(async () => {
    await lookupShopperOrder("store-1", "");
  }, /Unauthorized access/);
});
