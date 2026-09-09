process.env.SHOPIFY_API_KEY = "mock_api_key";
process.env.SHOPIFY_API_SECRET = "mock_api_secret";
process.env.SHOPIFY_APP_URL = "https://byndcart-mock.app";
process.env.SCOPES = "read_orders,write_returns";
process.env.DATABASE_URL = "postgresql://mock:mock@localhost:5432/mock";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert";

import prisma from "../db.server";

prisma.$transaction = (async (cb: any) => {
  return await cb(prisma);
}) as any;

// Mock in-memory database store for warehouse testing
const dbStore = {
  shipmentTracks: new Map<string, any>(),
  returnRequests: new Map<string, any>(),
  warehouseIntakes: new Map<string, any>(),
  itemInspections: new Map<string, any>(),
  auditLogs: [] as any[],
  backgroundJobs: new Map<string, any>(),
  orders: new Map<string, any>(),
};

// Seed initial test data
dbStore.shipmentTracks.set("771234567890", {
  id: "ship-100",
  shopifyStoreId: "store-1",
  shopifyOrderId: "gid://shopify/Order/1001",
  orderNumber: "#1001",
  type: "RETURN",
  courier: "TCS",
  trackingNumber: "771234567890",
  status: "IN_TRANSIT",
  returnRequestId: "ret-100",
});

dbStore.shipmentTracks.set("779999999999", {
  id: "ship-cross-tenant",
  shopifyStoreId: "other-merchant-store-99",
  shopifyOrderId: "gid://shopify/Order/9999",
  orderNumber: "#9999",
  type: "RETURN",
  courier: "LEOPARDS",
  trackingNumber: "779999999999",
  status: "IN_TRANSIT",
  returnRequestId: "ret-cross-tenant",
});

dbStore.returnRequests.set("ret-100", {
  id: "ret-100",
  shopifyStoreId: "store-1",
  shopifyOrderId: "gid://shopify/Order/1001",
  orderNumber: "#1001",
  customerEmail: "shopper@example.pk",
  customerName: "Tariq Mahmood",
  status: "APPROVED",
  reason: "Size Mismatch",
  refundAmount: 3000,
  items: [
    {
      id: "item-100",
      returnRequestId: "ret-100",
      shopifyLineItemId: "gid://shopify/LineItem/10",
      quantity: 2,
      reason: "SIZE_TOO_SMALL",
      status: "PENDING",
    },
  ],
});

dbStore.orders.set("gid://shopify/Order/1001", {
  shopifyStoreId: "store-1",
  shopifyOrderId: "gid://shopify/Order/1001",
  orderNumber: "#1001",
  lineItems: [
    {
      lineItemId: "gid://shopify/LineItem/10",
      variantId: "gid://shopify/ProductVariant/50",
      title: "Designer Shalwar Kameez XL",
      sku: "SKU-SK-XL",
      quantity: 2,
      price: 1500,
    },
  ],
});

prisma.shipmentTrack.findUnique = (async (args: any) => {
  return dbStore.shipmentTracks.get(args.where.trackingNumber) || null;
}) as any;

prisma.shipmentTrack.findFirst = (async (args: any) => {
  const list = Array.from(dbStore.shipmentTracks.values());
  return (
    list.find(
      (s) =>
        s.shopifyStoreId === args.where.shopifyStoreId &&
        s.trackingNumber.toLowerCase() === args.where.trackingNumber?.equals?.toLowerCase()
    ) || null
  );
}) as any;

prisma.shipmentTrack.updateMany = (async (args: any) => {
  for (const item of dbStore.shipmentTracks.values()) {
    if (item.id === args.where.id) {
      item.status = args.data.status;
    }
  }
  return { count: 1 };
}) as any;

prisma.returnRequest.findFirst = (async (args: any) => {
  return dbStore.returnRequests.get(args.where.id) || null;
}) as any;

prisma.returnRequest.update = (async (args: any) => {
  const current = dbStore.returnRequests.get(args.where.id) || {};
  const updated = { ...current, ...args.data };
  dbStore.returnRequests.set(args.where.id, updated);
  return updated;
}) as any;

prisma.returnItem.updateMany = (async () => ({ count: 1 })) as any;

prisma.order.findFirst = (async (args: any) => {
  return dbStore.orders.get(args.where.shopifyOrderId) || null;
}) as any;

prisma.warehouseIntake.findFirst = (async (args: any) => {
  const list = Array.from(dbStore.warehouseIntakes.values());
  return (
    list.find(
      (w) =>
        w.shopifyStoreId === args.where.shopifyStoreId &&
        w.returnRequestId === args.where.returnRequestId
    ) || null
  );
}) as any;

prisma.warehouseIntake.findMany = (async (args: any) => {
  return Array.from(dbStore.warehouseIntakes.values()).filter(
    (w) => w.shopifyStoreId === args.where.shopifyStoreId
  );
}) as any;

prisma.warehouseIntake.create = (async (args: any) => {
  const intake = {
    id: `intake-uuid-${Date.now()}`,
    ...args.data,
    receivedAt: new Date(),
    inspections: [],
  };
  dbStore.warehouseIntakes.set(intake.id, intake);
  return intake;
}) as any;

prisma.itemInspection.create = (async (args: any) => {
  const insp = { id: `insp-uuid-${Date.now()}`, ...args.data };
  dbStore.itemInspections.set(insp.id, insp);
  return insp;
}) as any;

prisma.itemInspection.updateMany = (async (args: any) => {
  for (const insp of dbStore.itemInspections.values()) {
    if (insp.warehouseIntakeId === args.where.warehouseIntakeId) {
      insp.restockedInShopify = args.data.restockedInShopify;
    }
  }
  return { count: 1 };
}) as any;

prisma.shopifyStore.findUnique = (async () => ({
  id: "store-1",
  shop: "byndcart-mock.myshopify.com",
})) as any;

prisma.auditLog.create = (async (args: any) => {
  const log = { id: `log-${Date.now()}`, ...args.data };
  dbStore.auditLogs.push(log);
  return log;
}) as any;

prisma.auditLog.findFirst = (async (args: any) => {
  return (
    dbStore.auditLogs.find(
      (l: any) => l.entityId === args.where.entityId && l.action === args.where.action
    ) || null
  );
}) as any;

prisma.storeSettings.findUnique = (async () => ({
  id: "setting-1",
  shopifyStoreId: "store-1",
  emailNotificationsEnabled: false,
})) as any;

prisma.backgroundJob.create = (async (args: any) => {
  const job = {
    id: `job-uuid-${Date.now()}`,
    shopifyStoreId: args.data.shopifyStoreId,
    type: args.data.type,
    payload: args.data.payload,
    status: "PENDING",
    attempts: 0,
    maxAttempts: 3,
    runAt: new Date(),
  };
  dbStore.backgroundJobs.set(job.id, job);
  return job;
}) as any;

prisma.backgroundJob.findFirst = (async () => {
  return Array.from(dbStore.backgroundJobs.values()).find((j: any) => j.status === "PENDING") || null;
}) as any;

prisma.backgroundJob.findUnique = (async (args: any) => {
  return dbStore.backgroundJobs.get(args.where.id) || null;
}) as any;

prisma.backgroundJob.update = (async (args: any) => {
  const job = dbStore.backgroundJobs.get(args.where.id);
  if (!job) return null;
  const updated = { ...job, ...args.data };
  dbStore.backgroundJobs.set(args.where.id, updated);
  return updated;
}) as any;

// Helper to construct mock admin client
function createMockAdmin(inventoryHandler?: (vars: any) => any) {
  return {
    graphql: async (query: string, options?: any) => {
      if (query.includes("getLocations")) {
        return {
          json: async () => ({
            data: { locations: { edges: [{ node: { id: "gid://shopify/Location/100" } }] } },
          }),
        };
      }
      if (query.includes("refundCreate")) {
        return {
          json: async () => ({
            data: {
              refundCreate: {
                refund: { id: "gid://shopify/Refund/100" },
                userErrors: [],
              },
            },
          }),
        };
      }
      if (query.includes("inventoryAdjustQuantities")) {
        if (inventoryHandler) return { json: async () => inventoryHandler(options?.variables) };
        return {
          json: async () => ({
            data: {
              inventoryAdjustQuantities: {
                inventoryAdjustmentGroup: { id: "grp-1", reason: "return_restock", changes: [] },
                userErrors: [],
              },
            },
          }),
        };
      }
      return { json: async () => ({ data: {} }) };
    },
  };
}

test("Warehouse Service - Valid AWB lookup", async () => {
  const { lookupInboundShipmentByAwb } = await import("../services/warehouse.server");

  const res = await lookupInboundShipmentByAwb("store-1", "771234567890");
  assert.strictEqual(res.found, true);
  assert.strictEqual(res.alreadyReceived, false);
  assert.strictEqual(res.shipment?.trackingNumber, "771234567890");
  assert.strictEqual(res.returnRequest?.orderNumber, "#1001");
  assert.strictEqual(res.returnRequest?.items[0].sku, "SKU-SK-XL");
});

test("Warehouse Service - Invalid AWB lookup handling", async () => {
  const { lookupInboundShipmentByAwb } = await import("../services/warehouse.server");

  const res = await lookupInboundShipmentByAwb("store-1", "UNKNOWN-AWB-99999");
  assert.strictEqual(res.found, false);
  assert.strictEqual(res.alreadyReceived, false);
});

test("Warehouse Service - Rejects cross-merchant shipment scan", async () => {
  const { lookupInboundShipmentByAwb } = await import("../services/warehouse.server");

  await assert.rejects(
    async () => {
      await lookupInboundShipmentByAwb("store-1", "779999999999");
    },
    {
      message: /Cross-merchant shipment scan rejected: tracking number '779999999999' belongs to a different merchant store/,
    }
  );
});

test("Warehouse Service - Process intake with RESTOCKABLE, DAMAGED, and DISCARD conditions", async () => {
  const { processWarehouseIntake } = await import("../services/warehouse.server");

  const mockAdmin = createMockAdmin();

  const res = await processWarehouseIntake({
    shopifyStoreId: "store-1",
    returnRequestId: "ret-100",
    shipmentTrackId: "ship-100",
    scannedAwb: "771234567890",
    receivedByUserId: "user-operator-1",
    notes: "Package intake verified in Karachi warehouse",
    admin: mockAdmin,
    inspections: [
      {
        returnItemId: "item-100",
        shopifyLineItemId: "gid://shopify/LineItem/10",
        title: "Designer Shalwar Kameez XL",
        sku: "SKU-SK-XL",
        expectedQuantity: 2,
        receivedQuantity: 1,
        condition: "RESTOCKABLE",
        inspectionNotes: "1 unit in pristine tag condition",
      },
      {
        returnItemId: "item-100",
        shopifyLineItemId: "gid://shopify/LineItem/10",
        title: "Designer Shalwar Kameez XL",
        sku: "SKU-SK-XL",
        expectedQuantity: 2,
        receivedQuantity: 1,
        condition: "DAMAGED",
        inspectionNotes: "1 unit torn fabric",
      },
    ],
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.returnStatus, "COMPLETED");
  assert.strictEqual(res.inventoryRestocked, true);
  assert.strictEqual(res.idempotent, false);

  const shipment = dbStore.shipmentTracks.get("771234567890");
  assert.strictEqual(shipment.status, "DELIVERED");

  const updatedReturn = dbStore.returnRequests.get("ret-100");
  assert.strictEqual(updatedReturn.status, "COMPLETED");
});

test("Warehouse Service - Duplicate receiving prevention (Idempotency)", async () => {
  const { processWarehouseIntake } = await import("../services/warehouse.server");

  const res = await processWarehouseIntake({
    shopifyStoreId: "store-1",
    returnRequestId: "ret-100",
    scannedAwb: "771234567890",
    inspections: [
      {
        shopifyLineItemId: "gid://shopify/LineItem/10",
        expectedQuantity: 2,
        receivedQuantity: 2,
        condition: "RESTOCKABLE",
      },
    ],
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.idempotent, true);
});

test("Warehouse Service - Shopify inventory failure enqueues retryable BackgroundJob", async () => {
  const { processWarehouseIntake } = await import("../services/warehouse.server");

  dbStore.returnRequests.set("ret-inv-fail", {
    id: "ret-inv-fail",
    shopifyStoreId: "store-1",
    shopifyOrderId: "gid://shopify/Order/3001",
    orderNumber: "#3001",
    customerEmail: "shopper3@example.pk",
    status: "APPROVED",
    items: [],
  });

  const failingAdmin = {
    graphql: async () => {
      throw new Error("Shopify inventory API timeout");
    },
  };

  const res = await processWarehouseIntake({
    shopifyStoreId: "store-1",
    returnRequestId: "ret-inv-fail",
    scannedAwb: "773333333333",
    admin: failingAdmin,
    inspections: [
      {
        shopifyLineItemId: "gid://shopify/LineItem/30",
        expectedQuantity: 1,
        receivedQuantity: 1,
        condition: "RESTOCKABLE",
      },
    ],
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.inventoryRestocked, false);

  const enqueued = Array.from(dbStore.backgroundJobs.values()) as any[];
  const invJob = enqueued.find((j: any) => j.type === "SHOPIFY_INVENTORY_ADJUST");
  assert.ok(invJob);
  assert.strictEqual(invJob.payload.returnRequestId, "ret-inv-fail");
});

test("Warehouse Service - Worker retry execution for inventory adjust job", async () => {
  const { processNextJob } = await import("../worker.server");

  const processed = await processNextJob();
  assert.strictEqual(processed, true);
});
