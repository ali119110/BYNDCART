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
  return list.find((shipment) => {
    if (args.where.shopifyStoreId && shipment.shopifyStoreId !== args.where.shopifyStoreId) return false;
    if (args.where.trackingNumber && shipment.trackingNumber !== args.where.trackingNumber) return false;
    if (args.where.returnRequestId && shipment.returnRequestId !== args.where.returnRequestId) return false;
    if (args.where.exchangeRequestId && shipment.exchangeRequestId !== args.where.exchangeRequestId) return false;
    return true;
  }) || null;
}) as any;

prisma.shipmentTrack.create = (async (args: any) => {
  const shipment = { id: `ship-${Date.now()}`, ...args.data };
  dbStore.shipmentTracks.set(shipment.trackingNumber, shipment);
  return shipment;
}) as any;

prisma.shipmentTrack.update = (async (args: any) => {
  for (const [key, shipment] of dbStore.shipmentTracks.entries()) {
    if (shipment.id === args.where.id) {
      const updated = { ...shipment, ...args.data };
      dbStore.shipmentTracks.set(key, updated);
      return updated;
    }
  }
  return { id: args.where.id, ...args.data };
}) as any;

(prisma as any).shipmentEvent = {
  findFirst: async () => null,
  create: async (args: any) => ({ id: `event-${Date.now()}`, ...args.data }),
};

(prisma as any).refundRecord = {
  findFirst: async () => null,
  create: async (args: any) => ({ id: `refund-${Date.now()}`, ...args.data }),
};

prisma.returnItem.findMany = (async (args: any) => {
  const request = dbStore.returnRequests.get(args.where.returnRequestId);
  return request?.items || [];
}) as any;

prisma.returnItem.update = (async (args: any) => {
  for (const request of dbStore.returnRequests.values()) {
    const item = request.items?.find((row: any) => row.id === args.where.id);
    if (item) Object.assign(item, args.data);
  }
  return args.data;
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
  const request = dbStore.returnRequests.get(args.where.id) || null;
  if (!request) return null;
  if (args.where.shopifyStoreId && request.shopifyStoreId !== args.where.shopifyStoreId) return null;
  return request;
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
  return list.find((intake) => {
    if (args.where.id && intake.id !== args.where.id) return false;
    if (args.where.shopifyStoreId && intake.shopifyStoreId !== args.where.shopifyStoreId) return false;
    if (args.where.scannedAwb && intake.scannedAwb !== args.where.scannedAwb) return false;
    if (args.where.returnRequestId && intake.returnRequestId !== args.where.returnRequestId) return false;
    if (args.where.status?.in && !args.where.status.in.includes(intake.status)) return false;
    if (typeof args.where.status === "string" && intake.status !== args.where.status) return false;
    return true;
  }) || null;
}) as any;

prisma.warehouseIntake.update = (async (args: any) => {
  const current = dbStore.warehouseIntakes.get(args.where.id) || {};
  const updated = { ...current, ...args.data };
  dbStore.warehouseIntakes.set(args.where.id, updated);
  return updated;
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
  const intake = dbStore.warehouseIntakes.get(args.data.warehouseIntakeId);
  if (intake) intake.inspections = [...(intake.inspections || []), insp];
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
  refundExecutionMode: "MANUAL",
  restockingFeePercent: 0,
  exchangeReplacementTiming: "AFTER_INSPECTION",
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

test("Warehouse Service - Receives an approved return from the customer airway bill", async () => {
  const { receiveInboundRequest } = await import("../services/warehouse.server");
  const res = await receiveInboundRequest({
    shopifyStoreId: "store-1",
    requestType: "RETURN",
    requestId: "ret-100",
    scannedAwb: "771234567890",
    receivedByUserId: "user-operator-1",
  });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.idempotent, false);
  assert.strictEqual(dbStore.returnRequests.get("ret-100").status, "RECEIVED");
  assert.strictEqual(dbStore.shipmentTracks.get("771234567890").status, "DELIVERED");
});

test("Warehouse Service - Rejects an unknown request for this store", async () => {
  const { receiveInboundRequest } = await import("../services/warehouse.server");
  await assert.rejects(
    () => receiveInboundRequest({
      shopifyStoreId: "store-1",
      requestType: "RETURN",
      requestId: "missing-request",
      scannedAwb: "UNKNOWN-AWB-99999",
    }),
    /not found for this store/,
  );
});

test("Warehouse Service - Rejects cross-merchant receiving", async () => {
  const { receiveInboundRequest } = await import("../services/warehouse.server");
  dbStore.returnRequests.set("ret-cross-tenant", {
    id: "ret-cross-tenant",
    shopifyStoreId: "other-merchant-store-99",
    shopifyOrderId: "gid://shopify/Order/9999",
    orderNumber: "#9999",
    status: "APPROVED",
    items: [],
  });
  await assert.rejects(
    () => receiveInboundRequest({
      shopifyStoreId: "store-1",
      requestType: "RETURN",
      requestId: "ret-cross-tenant",
      scannedAwb: "779999999999",
    }),
    /not found for this store/,
  );
});

test("Warehouse Service - Inspection records every condition and waits for a manual refund", async () => {
  const { receiveInboundRequest, completeWarehouseInspection } = await import("../services/warehouse.server");
  dbStore.returnRequests.set("ret-inspect", {
    id: "ret-inspect",
    shopifyStoreId: "store-1",
    shopifyOrderId: "gid://shopify/Order/1001",
    orderNumber: "#1001",
    customerEmail: "shopper@example.pk",
    status: "APPROVED",
    refundAmount: 3000,
    items: [{ id: "item-inspect", shopifyLineItemId: "gid://shopify/LineItem/10", quantity: 2, status: "PENDING" }],
  });
  const received = await receiveInboundRequest({
    shopifyStoreId: "store-1",
    requestType: "RETURN",
    requestId: "ret-inspect",
    scannedAwb: "771111111111",
  });
  const res = await completeWarehouseInspection({
    shopifyStoreId: "store-1",
    intakeId: received.intake.id,
    items: [{
      shopifyLineItemId: "gid://shopify/LineItem/10",
      receivedQuantity: 1,
      condition: "RESTOCKABLE",
      inspectionNotes: "One unit can be restocked",
      sku: "SKU-SK-XL",
      title: "Designer Shalwar Kameez XL",
    }],
  });
  assert.strictEqual(res.success, true);
  assert.strictEqual(dbStore.returnRequests.get("ret-inspect").status, "REFUND_PENDING");
  assert.ok(dbStore.auditLogs.some((entry) => entry.action === "RETURN_MANUAL_REFUND_PENDING"));
});

test("Warehouse Service - Duplicate receiving prevention (Idempotency)", async () => {
  const { receiveInboundRequest } = await import("../services/warehouse.server");
  dbStore.returnRequests.set("ret-idem", {
    id: "ret-idem",
    shopifyStoreId: "store-1",
    shopifyOrderId: "gid://shopify/Order/1001",
    orderNumber: "#1001",
    status: "APPROVED",
    items: [],
  });
  const first = await receiveInboundRequest({
    shopifyStoreId: "store-1",
    requestType: "RETURN",
    requestId: "ret-idem",
    scannedAwb: "772222222222",
  });
  const second = await receiveInboundRequest({
    shopifyStoreId: "store-1",
    requestType: "RETURN",
    requestId: "ret-idem",
    scannedAwb: "772222222222",
  });
  assert.strictEqual(first.idempotent, false);
  assert.strictEqual(second.success, true);
  assert.strictEqual(second.idempotent, true);
});

test("Warehouse Service - Shopify inventory failure is audited and does not book a courier", async () => {
  const { receiveInboundRequest, completeWarehouseInspection } = await import("../services/warehouse.server");
  dbStore.returnRequests.set("ret-inv-fail", {
    id: "ret-inv-fail",
    shopifyStoreId: "store-1",
    shopifyOrderId: "gid://shopify/Order/3001",
    orderNumber: "#3001",
    customerEmail: "shopper3@example.pk",
    status: "APPROVED",
    refundAmount: 1000,
    items: [{ id: "item-fail", shopifyLineItemId: "gid://shopify/LineItem/30", quantity: 1, status: "PENDING" }],
  });
  dbStore.orders.set("gid://shopify/Order/3001", {
    shopifyStoreId: "store-1",
    shopifyOrderId: "gid://shopify/Order/3001",
    lineItems: [{ lineItemId: "gid://shopify/LineItem/30", quantity: 1, price: 1000 }],
  });
  const received = await receiveInboundRequest({
    shopifyStoreId: "store-1",
    requestType: "RETURN",
    requestId: "ret-inv-fail",
    scannedAwb: "773333333333",
  });
  const inspected = await completeWarehouseInspection({
    shopifyStoreId: "store-1",
    intakeId: received.intake.id,
    items: [{ shopifyLineItemId: "gid://shopify/LineItem/30", receivedQuantity: 1, condition: "RESTOCKABLE" }],
  });
  assert.strictEqual(inspected.success, true);
  assert.ok(dbStore.auditLogs.some((entry) => entry.action === "SHOPIFY_INVENTORY_RESTOCK_FAILED" && entry.entityId === "ret-inv-fail"));
  assert.strictEqual(dbStore.backgroundJobs.size, 0);
});
