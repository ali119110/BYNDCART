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

// Mock prisma queries for offline testing
prisma.shopifyStore.findUnique = (async () => ({
  id: "store-1",
  shop: "byndcart-mock.myshopify.com",
})) as any;

prisma.storeSettings.findUnique = (async () => ({
  id: "setting-1",
  shopifyStoreId: "store-1",
  emailNotifications: true,
  createdAt: new Date(),
  updatedAt: new Date(),
})) as any;

prisma.shipmentTrack.upsert = (async (args: any) => ({
  id: "ship-uuid-100",
  shopifyStoreId: args.create.shopifyStoreId,
  shopifyOrderId: args.create.shopifyOrderId,
  orderNumber: args.create.orderNumber,
  type: args.create.type,
  courier: args.create.courier,
  trackingNumber: args.create.trackingNumber,
  labelUrl: args.create.labelUrl,
  status: args.create.status,
  createdAt: new Date(),
  updatedAt: new Date(),
})) as any;

prisma.returnRequest.findFirst = (async (args: any) => {
  if (args.where.id === "ret-123" && args.where.shopifyStoreId === "store-1") {
    return {
      id: "ret-123",
      shopifyStoreId: "store-1",
      orderNumber: "#1001",
      customerEmail: "user@example.com",
      status: "PENDING",
      adminNote: null,
    };
  }
  return null;
}) as any;

prisma.returnRequest.update = (async (args: any) => {
  return {
    id: args.where.id,
    shopifyStoreId: "store-1",
    orderNumber: "#1001",
    customerEmail: "user@example.com",
    status: args.data.status,
    adminNote: args.data.adminNote,
  };
}) as any;

prisma.returnItem.updateMany = (async () => ({ count: 1 })) as any;
prisma.auditLog.create = (async () => ({})) as any;

prisma.exchangeRequest.findFirst = (async (args: any) => {
  if (args.where.id === "ex-123" && args.where.shopifyStoreId === "store-1") {
    return {
      id: "ex-123",
      shopifyStoreId: "store-1",
      orderNumber: "#1001",
      customerEmail: "user@example.com",
      status: "PENDING",
    };
  }
  return null;
}) as any;

prisma.exchangeRequest.update = (async (args: any) => {
  return {
    id: args.where.id,
    shopifyStoreId: "store-1",
    orderNumber: "#1001",
    customerEmail: "user@example.com",
    status: args.data.status,
  };
}) as any;

prisma.backgroundJob.create = (async (args: any) => ({
  id: "job-uuid-123",
  shopifyStoreId: args.data.shopifyStoreId,
  type: args.data.type,
  payload: args.data.payload,
  status: args.data.status,
  attempts: 0,
  maxAttempts: args.data.maxAttempts || 3,
  runAt: args.data.runAt || new Date(),
})) as any;

prisma.backgroundJob.findFirst = (async () => ({
  id: "job-uuid-123",
  shopifyStoreId: "store-1",
  type: "WEBHOOK_PROCESS",
  payload: { topic: "orders/create", webhookPayload: {} },
  status: "PENDING",
  attempts: 0,
  maxAttempts: 3,
  runAt: new Date(),
})) as any;

prisma.backgroundJob.findUnique = (async () => ({
  id: "job-uuid-123",
  shopifyStoreId: "store-1",
  type: "WEBHOOK_PROCESS",
  payload: { topic: "orders/create" },
  status: "PENDING",
  attempts: 1,
  maxAttempts: 3,
  runAt: new Date(),
})) as any;

prisma.backgroundJob.update = (async (args: any) => ({
  id: args.where.id,
  shopifyStoreId: "store-1",
  type: "WEBHOOK_PROCESS",
  payload: { topic: "orders/create", webhookPayload: {} },
  status: args.data.status || "PROCESSING",
  attempts: args.data.attempts?.increment ? 1 : 0,
  maxAttempts: 3,
  runAt: new Date(),
})) as any;

prisma.order.upsert = (async () => ({})) as any;


test("Courier Integration - Neutral ICourierAdapter registry", async () => {
  const { CourierRegistry } = await import("../services/courier.server");
  const { registerShipmentTrack } = await import("../services/shipments.server");

  const adapter = CourierRegistry.get("TCS");
  assert.strictEqual(adapter.providerName, "TCS");

  const label = await adapter.generateReturnLabel({
    shopifyStoreId: "store-1",
    orderId: "gid://shopify/Order/1001",
    orderNumber: "#1001",
  });

  assert.strictEqual(label.success, true);
  assert.ok(label.trackingNumber.startsWith("77"));

  const shipment = await registerShipmentTrack({
    shopifyStoreId: "store-1",
    orderId: "gid://shopify/Order/1001",
    orderNumber: "#1001",
    type: "RETURN",
  });

  assert.strictEqual(shipment.success, true);
  assert.strictEqual(shipment.courier, "TCS");
});

test("State Machine - Return status transitions & graph enforcement", async () => {
  const { transitionReturnStatus } = await import("../services/stateMachine.server");

  // Valid transition PENDING -> APPROVED
  const res1 = await transitionReturnStatus({
    id: "ret-123",
    shopifyStoreId: "store-1",
    targetStatus: "APPROVED",
  });

  assert.strictEqual(res1.status, "APPROVED");

  // Invalid transition PENDING -> COMPLETED directly should throw
  await assert.rejects(
    async () => {
      await transitionReturnStatus({
        id: "ret-123",
        shopifyStoreId: "store-1",
        targetStatus: "COMPLETED",
      });
    },
    {
      message: /Invalid return status transition: cannot move from 'PENDING' to 'COMPLETED'/,
    }
  );
});

test("State Machine - Exchange status transitions", async () => {
  const { transitionExchangeStatus } = await import("../services/stateMachine.server");

  const res1 = await transitionExchangeStatus({
    id: "ex-123",
    shopifyStoreId: "store-1",
    targetStatus: "APPROVED",
  });

  assert.strictEqual(res1.status, "APPROVED");
});

test("Background Jobs & Worker Queue Architecture", async () => {
  const { enqueueJob, claimNextJob } = await import("../services/jobs.server");
  const { processNextJob } = await import("../worker.server");

  const job = await enqueueJob({
    shopifyStoreId: "store-1",
    type: "WEBHOOK_PROCESS",
    payload: { topic: "orders/create", webhookPayload: {} },
  });

  assert.strictEqual(job.id, "job-uuid-123");
  assert.strictEqual(job.type, "WEBHOOK_PROCESS");

  const claimed = await claimNextJob();
  assert.ok(claimed);

  const processed = await processNextJob();
  assert.strictEqual(processed, true);
});
