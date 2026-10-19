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
  return mockConfigs.filter((c) => {
    if (args.where?.shopifyStoreId && c.shopifyStoreId !== args.where.shopifyStoreId) return false;
    if (args.where?.enabled === true && !c.enabled) return false;
    if (args.where?.isLive === true && !c.isLive) return false;
    if (args.where?.isDefaultReverse === true && !c.isDefaultReverse) return false;
    if (args.where?.isDefaultForward === true && !c.isDefaultForward) return false;
    return true;
  });
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
  const ship = mockShipments.find((s) => {
    if (args.where?.trackingNumber && s.trackingNumber !== args.where.trackingNumber) return false;
    if (args.where?.shopifyStoreId && s.shopifyStoreId !== args.where.shopifyStoreId) return false;
    if (args.where?.shopifyOrderId && s.shopifyOrderId !== args.where.shopifyOrderId) return false;
    if (args.where?.type && s.type !== args.where.type) return false;
    if (args.where?.id && s.id !== args.where.id) return false;
    return true;
  });
  if (!ship) return null;
  return { ...ship, events: ship.events || mockEvents.filter((event) => event.shipmentTrackId === ship.id) };
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

test("Courier registry offers only PostEx and Leopards", async () => {
  const registered = CourierRegistry.getRegisteredAdapters().map((adapter) => adapter.providerName).sort();
  assert.deepStrictEqual(registered, ["LEOPARDS", "POSTEX"]);
  assert.strictEqual(CourierRegistry.has("TCS"), false);
  assert.throws(() => CourierRegistry.get("TCS"), /Unsupported courier provider/);

  for (const provider of ["POSTEX", "LEOPARDS"]) {
    const adapter = CourierRegistry.get(provider);
    const reverse = await adapter.createReverseShipment({
      shopifyStoreId: "store-1",
      orderId: "gid://shopify/Order/1001",
      orderNumber: "#1001",
    });
    assert.strictEqual(reverse.success, false);
    assert.strictEqual(reverse.isLive, false);
    assert.strictEqual(reverse.trackingNumber, "");
    const forward = await adapter.createForwardShipment({
      shopifyStoreId: "store-1",
      orderId: "gid://shopify/Order/1002",
      orderNumber: "#1002",
    });
    assert.strictEqual(forward.success, false);
    assert.strictEqual(forward.isLive, false);
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
  assert.strictEqual(testValid.isLive, testValid.success);
  if (!testValid.success) {
    assert.ok(testValid.message.length > 0);
  }
});

test("Multi-Courier Framework — Separate Reverse & Forward Courier Selection", async () => {
  mockConfigs = [];

  await saveMerchantCourierConfig("store-1", "POSTEX", {
    apiToken: "postex_key",
    enabled: true,
    isLive: true,
    isDefaultReverse: true,
  });
  await saveMerchantCourierConfig("store-1", "LEOPARDS", {
    credentials: {
      apiKey: "leo-key",
      apiPassword: "leo-pass",
      warehouseCity: "Lahore",
      warehouseAddress: "12 Warehouse Road",
      warehouseContactName: "Store Desk",
      warehousePhone: "03001234567",
      warehouseEmail: "desk@store.com",
      defaultWeightGrams: "500",
    },
    enabled: true,
    isLive: true,
    isDefaultForward: true,
  });

  const revCourier = await getDefaultMerchantCourier("store-1", "REVERSE");
  assert.strictEqual(revCourier.providerName, "POSTEX");

  const fwdCourier = await getDefaultMerchantCourier("store-1", "FORWARD");
  assert.strictEqual(fwdCourier.providerName, "LEOPARDS");
});

test("Shipments reject a tracking number that the carrier API did not confirm", async () => {
  await assert.rejects(
    () => registerShipmentTrack({
      shopifyStoreId: "store-1",
      orderId: "gid://shopify/Order/777",
      orderNumber: "#777",
      courier: "POSTEX",
      trackingNumber: "TYPED-BY-HAND",
      type: "RETURN",
    }),
    /carrier API confirms the booking/,
  );
});

test("Duplicate booking is skipped when the order already has a shipment", async () => {
  mockShipments = [{
    id: "ship-existing",
    shopifyStoreId: "store-1",
    shopifyOrderId: "gid://shopify/Order/777",
    orderNumber: "#777",
    type: "RETURN",
    courier: "POSTEX",
    trackingNumber: "PE-EXISTING",
    labelUrl: "",
    status: "LABEL_CREATED",
  }];

  const res = await registerShipmentTrack({
    shopifyStoreId: "store-1",
    orderId: "gid://shopify/Order/777",
    orderNumber: "#777",
    courier: "POSTEX",
    type: "RETURN",
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.trackingNumber, "PE-EXISTING");
  assert.strictEqual(mockShipments.length, 1);
});

test("Tracking refresh requires verified store credentials", async () => {
  mockShipments = [{
    id: "ship-leo",
    shopifyStoreId: "store-without-courier",
    shopifyOrderId: "gid://shopify/Order/888",
    trackingNumber: "LEO-888",
    courier: "LEOPARDS",
    status: "LABEL_CREATED",
    events: [],
  }];
  await assert.rejects(
    () => syncShipmentTrackingStatus("LEO-888", "store-without-courier"),
    /credentials are disabled or unverified/,
  );
});

test("Multi-Courier Framework — Timeout & BackgroundJob Retry Queueing", async () => {
  mockJobs = [];

  // Create mock adapter that throws network timeout
  const failingAdapter = {
    providerName: "FAILCOURIER",
    displayName: "Failing Courier",
    description: "Throws timeout error",
    isLive: true,
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
  mockConfigs.push({
    shopifyStoreId: "store-1",
    providerName: "FAILCOURIER",
    encryptedApiToken: "plain-token-without-colon",
    enabled: true,
    isLive: true,
    accountNumber: null,
    additionalConfig: null,
  });

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
