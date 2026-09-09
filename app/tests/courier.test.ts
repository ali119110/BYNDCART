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
  CourierRegistry,
  normalizeCourierStatus,
  saveMerchantCourierConfig,
  getStoreCourierConfigs,
  getDecryptedCourierCredentials,
  getDefaultMerchantCourier,
} from "../services/courier.server";
import {
  registerShipmentTrack,
  syncShipmentTrackingStatus,
  getStoreShipments,
} from "../services/shipments.server";

// Mock Database Stores
let mockConfigs: any[] = [];
let mockShipments: any[] = [];
let mockEvents: any[] = [];
let mockJobs: any[] = [];
let mockAuditLogs: any[] = [];

prisma.merchantCourierConfig.findUnique = (async (args: any) => {
  const storeId = args.where.shopifyStoreId_providerName?.shopifyStoreId;
  const provider = args.where.shopifyStoreId_providerName?.providerName;
  return mockConfigs.find((c) => c.shopifyStoreId === storeId && c.providerName === provider) || null;
}) as any;

prisma.merchantCourierConfig.findMany = (async (args: any) => {
  return mockConfigs.filter((c) => c.shopifyStoreId === args.where?.shopifyStoreId);
}) as any;

prisma.merchantCourierConfig.findFirst = (async (args: any) => {
  return (
    mockConfigs.find(
      (c) =>
        c.shopifyStoreId === args.where?.shopifyStoreId &&
        (args.where?.isDefaultReverse ? c.isDefaultReverse : true) &&
        (args.where?.isDefaultForward ? c.isDefaultForward : true) &&
        (args.where?.enabled ? c.enabled : true)
    ) || null
  );
}) as any;

prisma.merchantCourierConfig.updateMany = (async (args: any) => {
  mockConfigs.forEach((c) => {
    if (c.shopifyStoreId === args.where.shopifyStoreId) {
      if (args.data.isDefaultReverse !== undefined) c.isDefaultReverse = args.data.isDefaultReverse;
      if (args.data.isDefaultForward !== undefined) c.isDefaultForward = args.data.isDefaultForward;
    }
  });
  return { count: 1 };
}) as any;

prisma.merchantCourierConfig.upsert = (async (args: any) => {
  const storeId = args.where.shopifyStoreId_providerName.shopifyStoreId;
  const provider = args.where.shopifyStoreId_providerName.providerName;
  const idx = mockConfigs.findIndex((c) => c.shopifyStoreId === storeId && c.providerName === provider);

  if (idx >= 0) {
    mockConfigs[idx] = { ...mockConfigs[idx], ...args.update, updatedAt: new Date() };
    return mockConfigs[idx];
  } else {
    const newRec = {
      id: `cfg-uuid-${Date.now()}-${Math.random()}`,
      ...args.create,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockConfigs.push(newRec);
    return newRec;
  }
}) as any;

prisma.shipmentTrack.findFirst = (async (args: any) => {
  return (
    mockShipments.find(
      (s) =>
        s.shopifyStoreId === args.where?.shopifyStoreId &&
        s.shopifyOrderId === args.where?.shopifyOrderId &&
        s.type === args.where?.type
    ) || null
  );
}) as any;

prisma.shipmentTrack.findUnique = (async (args: any) => {
  const ship = mockShipments.find((s) => s.trackingNumber === args.where?.trackingNumber);
  if (!ship) return null;
  const events = mockEvents.filter((e) => e.shipmentTrackId === ship.id);
  return { ...ship, events };
}) as any;

prisma.shipmentTrack.upsert = (async (args: any) => {
  const trackNum = args.where.trackingNumber;
  const idx = mockShipments.findIndex((s) => s.trackingNumber === trackNum);

  if (idx >= 0) {
    mockShipments[idx] = { ...mockShipments[idx], ...args.update, updatedAt: new Date() };
    return mockShipments[idx];
  } else {
    const newShip = {
      id: `ship-uuid-${Date.now()}-${Math.random()}`,
      ...args.create,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockShipments.push(newShip);
    return newShip;
  }
}) as any;

prisma.shipmentTrack.update = (async (args: any) => {
  const idx = mockShipments.findIndex((s) => s.trackingNumber === args.where.trackingNumber);
  if (idx >= 0) {
    mockShipments[idx] = { ...mockShipments[idx], ...args.data, updatedAt: new Date() };
    return mockShipments[idx];
  }
  return null;
}) as any;

prisma.shipmentTrack.findMany = (async (args: any) => {
  const matches = mockShipments.filter((s) => s.shopifyStoreId === args.where?.shopifyStoreId);
  return matches.map((m) => ({ ...m, events: mockEvents.filter((e) => e.shipmentTrackId === m.id) }));
}) as any;

prisma.shipmentEvent.create = (async (args: any) => {
  const newEvt = { id: `evt-${Date.now()}-${Math.random()}`, ...args.data };
  mockEvents.push(newEvt);
  return newEvt;
}) as any;

prisma.backgroundJob.create = (async (args: any) => {
  const newJob = { id: `job-${Date.now()}-${Math.random()}`, ...args.data };
  mockJobs.push(newJob);
  return newJob;
}) as any;

prisma.auditLog.create = (async (args: any) => {
  mockAuditLogs.push(args.data);
  return args.data;
}) as any;

test("Multi-Courier Framework — All 6 Adapters Interface Implementation", async () => {
  const providers = ["POSTEX", "LEOPARDS", "TRAX", "TCS", "MNP", "CALLCOURIER"];

  for (const p of providers) {
    const adapter = CourierRegistry.get(p);
    assert.ok(adapter);
    assert.strictEqual(adapter.providerName, p);

    // Test reverse shipment
    const revResult = await adapter.createReverseShipment({
      shopifyStoreId: "store-1",
      orderId: "gid://shopify/Order/1001",
      orderNumber: "#1001",
    });
    assert.strictEqual(revResult.success, true);
    assert.ok(revResult.trackingNumber);

    // Test forward shipment
    const fwdResult = await adapter.createForwardShipment({
      shopifyStoreId: "store-1",
      orderId: "gid://shopify/Order/1002",
      orderNumber: "#1002",
    });
    assert.strictEqual(fwdResult.success, true);
    assert.ok(fwdResult.trackingNumber);

    // Test tracking
    const trackResult = await adapter.trackShipment(revResult.trackingNumber);
    assert.strictEqual(trackResult.trackingNumber, revResult.trackingNumber);
    assert.ok(trackResult.status);

    // Test cancel
    const cancelResult = await adapter.cancelShipment(revResult.trackingNumber);
    assert.strictEqual(cancelResult.success, true);

    // Test label
    if (adapter.getLabel) {
      const label = await adapter.getLabel(revResult.trackingNumber);
      assert.ok(label.labelUrl);
    }
  }
});

test("Multi-Courier Framework — Status Normalization", async () => {
  assert.strictEqual(normalizeCourierStatus("BOOKED"), "LABEL_CREATED");
  assert.strictEqual(normalizeCourierStatus("In Transit Hub"), "IN_TRANSIT");
  assert.strictEqual(normalizeCourierStatus("Out for delivery to customer"), "OUT_FOR_DELIVERY");
  assert.strictEqual(normalizeCourierStatus("Delivered successfully"), "DELIVERED");
  assert.strictEqual(normalizeCourierStatus("Cancelled by merchant"), "CANCELLED");
  assert.strictEqual(normalizeCourierStatus("Return Failed / Rejected"), "FAILED");
  assert.strictEqual(normalizeCourierStatus("UNRECOGNIZED_STATUS_XYZ"), "UNKNOWN");
});

test("Multi-Courier Framework — Encrypted Credentials & Cross-Merchant Isolation", async () => {
  mockConfigs = [];

  // Save config for store-1
  await saveMerchantCourierConfig("store-1", "POSTEX", {
    apiToken: "secret_postex_token_store1",
    accountNumber: "ACC-101",
    enabled: true,
    isDefaultReverse: true,
  });

  // Save config for store-2
  await saveMerchantCourierConfig("store-2", "POSTEX", {
    apiToken: "secret_postex_token_store2",
    accountNumber: "ACC-202",
    enabled: true,
  });

  // Verify store-1 config
  const credsStore1 = await getDecryptedCourierCredentials("store-1", "POSTEX");
  assert.ok(credsStore1);
  assert.strictEqual(credsStore1.apiToken, "secret_postex_token_store1");
  assert.strictEqual(credsStore1.accountNumber, "ACC-101");

  // Verify store-2 config (Cross-merchant isolation check)
  const credsStore2 = await getDecryptedCourierCredentials("store-2", "POSTEX");
  assert.ok(credsStore2);
  assert.strictEqual(credsStore2.apiToken, "secret_postex_token_store2");
  assert.strictEqual(credsStore2.accountNumber, "ACC-202");

  // UI Masking check
  const uiConfigs = await getStoreCourierConfigs("store-1");
  assert.strictEqual(uiConfigs[0].maskedToken, "••••••••ore1");
  assert.strictEqual(uiConfigs[0].isDefaultReverse, true);
});

test("Multi-Courier Framework — Connection Testing Valid vs Invalid Credentials", async () => {
  const adapter = CourierRegistry.get("POSTEX");

  // Missing token
  const testInvalid = await adapter.testConnection({
    shopifyStoreId: "store-1",
    config: { apiToken: "" },
  });
  assert.strictEqual(testInvalid.success, false);

  // Valid token
  const testValid = await adapter.testConnection({
    shopifyStoreId: "store-1",
    config: { apiToken: "valid_dummy_token" },
  });
  assert.strictEqual(testValid.success, true);
});

test("Multi-Courier Framework — Separate Reverse & Forward Courier Selection", async () => {
  mockConfigs = [];

  // Set PostEx as default reverse
  await saveMerchantCourierConfig("store-1", "POSTEX", {
    apiToken: "postex_key",
    enabled: true,
    isDefaultReverse: true,
  });

  // Set TCS as default forward
  await saveMerchantCourierConfig("store-1", "TCS", {
    apiToken: "tcs_key",
    enabled: true,
    isDefaultForward: true,
  });

  const revCourier = await getDefaultMerchantCourier("store-1", "REVERSE");
  assert.strictEqual(revCourier.providerName, "POSTEX");

  const fwdCourier = await getDefaultMerchantCourier("store-1", "FORWARD");
  assert.strictEqual(fwdCourier.providerName, "TCS");
});

test("Multi-Courier Framework — Duplicate Booking Idempotency Prevention", async () => {
  mockShipments = [];

  const res1 = await registerShipmentTrack({
    shopifyStoreId: "store-1",
    orderId: "gid://shopify/Order/777",
    orderNumber: "#777",
    courier: "TRAX",
    type: "RETURN",
  });

  assert.strictEqual(res1.success, true);
  const firstTracking = res1.trackingNumber;

  // Attempt duplicate booking for same order & type
  const res2 = await registerShipmentTrack({
    shopifyStoreId: "store-1",
    orderId: "gid://shopify/Order/777",
    orderNumber: "#777",
    courier: "TRAX",
    type: "RETURN",
  });

  assert.strictEqual(res2.success, true);
  assert.strictEqual(res2.trackingNumber, firstTracking);
  assert.strictEqual(mockShipments.length, 1); // No second record created
});

test("Multi-Courier Framework — Webhook Deduplication & Event Tracking", async () => {
  mockEvents = [];

  const res = await registerShipmentTrack({
    shopifyStoreId: "store-1",
    orderId: "gid://shopify/Order/888",
    orderNumber: "#888",
    courier: "LEOPARDS",
    type: "RETURN",
  });

  // Sync tracking status first time
  await syncShipmentTrackingStatus(res.trackingNumber);
  const countFirst = mockEvents.length;

  // Sync tracking status second time without status change (deduplicated)
  await syncShipmentTrackingStatus(res.trackingNumber);
  const countSecond = mockEvents.length;

  assert.strictEqual(countFirst, countSecond); // Event deduplicated
});

test("Multi-Courier Framework — Timeout & BackgroundJob Retry Queueing", async () => {
  mockJobs = [];

  // Create mock adapter that throws network timeout
  const failingAdapter = {
    providerName: "FAILCOURIER",
    displayName: "Failing Courier",
    description: "Throws timeout error",
    isLive: false,
    async testConnection() {
      return { success: false, message: "Timeout", isLive: false };
    },
    async createReverseShipment() {
      throw new Error("Network connection timeout to carrier API");
    },
    async createForwardShipment() {
      throw new Error("Network connection timeout to carrier API");
    },
    async generateReturnLabel() {
      return this.createReverseShipment();
    },


    async trackShipment() {
      return { trackingNumber: "FAIL", courierName: "FAILCOURIER", status: "FAILED" as const, updatedAt: new Date() };
    },
    async cancelShipment() {
      return { success: false };
    },
  };

  CourierRegistry.register(failingAdapter);

  await assert.rejects(
    async () => {
      await registerShipmentTrack({
        shopifyStoreId: "store-1",
        orderId: "gid://shopify/Order/999",
        orderNumber: "#999",
        courier: "FAILCOURIER",
        type: "RETURN",
      });
    },
    /Queued for retry/
  );

  assert.strictEqual(mockJobs.length, 1);
  assert.strictEqual(mockJobs[0].type, "COURIER_SHIPMENT_CREATE");
  assert.strictEqual(mockJobs[0].payload.providerName, "FAILCOURIER");
});
