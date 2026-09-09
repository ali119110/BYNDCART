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

// Global mock state for offline Prisma Client testing
const dbStore: Record<string, any> = {
  returnRequests: new Map<string, any>(),
  exchangeRequests: new Map<string, any>(),
  auditLogs: [] as any[],
  backgroundJobs: new Map<string, any>(),
};

// Populate initial return and exchange records
dbStore.returnRequests.set("ret-100", {
  id: "ret-100",
  shopifyStoreId: "store-1",
  shopifyOrderId: "gid://shopify/Order/1001",
  orderNumber: "#1001",
  customerEmail: "shopper@example.pk",
  status: "PENDING",
  refundAmount: 3000,
  shopifyReturnId: null,
  shopifyRefundId: null,
  items: [
    {
      id: "item-1",
      shopifyLineItemId: "gid://shopify/LineItem/1",
      quantity: 1,
      reason: "SIZE_TOO_SMALL",
    },
  ],
});

dbStore.exchangeRequests.set("ex-100", {
  id: "ex-100",
  shopifyStoreId: "store-1",
  shopifyOrderId: "gid://shopify/Order/1002",
  orderNumber: "#1002",
  customerEmail: "shopper@example.pk",
  status: "PENDING",
  newOrderId: null,
  newOrderNumber: null,
  items: [
    {
      id: "ex-item-1",
      originalLineItemId: "gid://shopify/LineItem/2",
      originalQuantity: 1,
      replacementVariantId: "gid://shopify/ProductVariant/20",
      replacementQuantity: 1,
    },
  ],
});

prisma.returnRequest.findFirst = (async (args: any) => {
  return dbStore.returnRequests.get(args.where.id) || null;
}) as any;

prisma.returnRequest.findUnique = (async (args: any) => {
  return dbStore.returnRequests.get(args.where.id) || null;
}) as any;

prisma.returnRequest.update = (async (args: any) => {
  const current = dbStore.returnRequests.get(args.where.id) || {};
  const updated = { ...current, ...args.data };
  dbStore.returnRequests.set(args.where.id, updated);
  return updated;
}) as any;

prisma.returnItem.updateMany = (async () => ({ count: 1 })) as any;

prisma.exchangeRequest.findFirst = (async (args: any) => {
  return dbStore.exchangeRequests.get(args.where.id) || null;
}) as any;

prisma.exchangeRequest.update = (async (args: any) => {
  const current = dbStore.exchangeRequests.get(args.where.id) || {};
  const updated = { ...current, ...args.data };
  dbStore.exchangeRequests.set(args.where.id, updated);
  return updated;
}) as any;

prisma.auditLog.create = (async (args: any) => {
  const log = { id: `log-${Date.now()}`, ...args.data };
  dbStore.auditLogs.push(log);
  return log;
}) as any;

prisma.auditLog.findFirst = (async (args: any) => {
  return dbStore.auditLogs.find(
    (l: any) => l.entityId === args.where.entityId && l.action === args.where.action
  ) || null;
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
  const jobs = Array.from(dbStore.backgroundJobs.values()) as any[];
  return jobs.find((j: any) => j.status === "PENDING") || null;
}) as any;

prisma.backgroundJob.findUnique = (async (args: any) => {
  return dbStore.backgroundJobs.get(args.where.id) || null;
}) as any;

prisma.backgroundJob.update = (async (args: any) => {
  const job = dbStore.backgroundJobs.get(args.where.id);
  if (!job) return null;
  const updated = { ...job, ...args.data, status: args.data.status || job.status };
  dbStore.backgroundJobs.set(args.where.id, updated);
  return updated;
}) as any;

// Helper to create mock GraphQL admin client
function createMockAdmin(handlers: Record<string, (vars: any) => any>) {
  return {
    graphql: async (query: string, options?: any) => {
      for (const [key, handler] of Object.entries(handlers)) {
        if (query.includes(key)) {
          return {
            json: async () => handler(options?.variables),
          };
        }
      }
      throw new Error(`Unhandled GraphQL query: ${query}`);
    },
  };
}

test("Shopify Sync - returnCreate execution & persistence", async () => {
  const { executeShopifyReturnCreate } = await import("../services/shopifySync.server");

  let graphqlCalled = false;
  const mockAdmin = createMockAdmin({
    returnCreate: (vars) => {
      graphqlCalled = true;
      assert.strictEqual(vars.returnInput.orderId, "gid://shopify/Order/1001");
      return {
        data: {
          returnCreate: {
            return: {
              id: "gid://shopify/Return/999111",
              name: "#1001-R1",
              status: "OPEN",
            },
            userErrors: [],
          },
        },
      };
    },
  });

  const result = await executeShopifyReturnCreate({
    shopifyStoreId: "store-1",
    entityId: "ret-100",
    admin: mockAdmin,
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.shopifyReturnId, "gid://shopify/Return/999111");
  assert.strictEqual(result.idempotent, false);
  assert.strictEqual(graphqlCalled, true);

  const updatedReq = dbStore.returnRequests.get("ret-100");
  assert.strictEqual(updatedReq.shopifyReturnId, "gid://shopify/Return/999111");
});

test("Shopify Sync - returnCreate Idempotency", async () => {
  const { executeShopifyReturnCreate } = await import("../services/shopifySync.server");

  let graphqlCalled = false;
  const mockAdmin = createMockAdmin({
    returnCreate: () => {
      graphqlCalled = true;
      return {};
    },
  });

  // Second execution when shopifyReturnId is already present in DB
  const result = await executeShopifyReturnCreate({
    shopifyStoreId: "store-1",
    entityId: "ret-100",
    admin: mockAdmin,
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.shopifyReturnId, "gid://shopify/Return/999111");
  assert.strictEqual(result.idempotent, true);
  assert.strictEqual(graphqlCalled, false); // Must skip GraphQL API call
});

test("Shopify Sync - refundCreate execution & persistence", async () => {
  const { executeShopifyRefundCreate } = await import("../services/shopifySync.server");

  let graphqlCalled = false;
  const mockAdmin = createMockAdmin({
    refundCreate: (vars) => {
      graphqlCalled = true;
      assert.strictEqual(vars.input.orderId, "gid://shopify/Order/1001");
      return {
        data: {
          refundCreate: {
            refund: {
              id: "gid://shopify/Refund/888222",
              totalRefundedSet: { shopMoney: { amount: "3000.00", currencyCode: "PKR" } },
            },
            userErrors: [],
          },
        },
      };
    },
  });

  const result = await executeShopifyRefundCreate({
    shopifyStoreId: "store-1",
    entityId: "ret-100",
    admin: mockAdmin,
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.shopifyRefundId, "gid://shopify/Refund/888222");
  assert.strictEqual(result.idempotent, false);
  assert.strictEqual(graphqlCalled, true);

  const updatedReq = dbStore.returnRequests.get("ret-100");
  assert.strictEqual(updatedReq.shopifyRefundId, "gid://shopify/Refund/888222");
});

test("Shopify Sync - inventoryAdjustQuantities execution", async () => {
  const { executeShopifyInventoryAdjust } = await import("../services/shopifySync.server");

  let graphqlCalled = false;
  const mockAdmin = createMockAdmin({
    getLocations: () => ({
      data: { locations: { edges: [{ node: { id: "gid://shopify/Location/555" } }] } },
    }),
    inventoryAdjustQuantities: (vars) => {
      graphqlCalled = true;
      assert.strictEqual(vars.input.reason, "return_restock");
      return {
        data: {
          inventoryAdjustQuantities: {
            inventoryAdjustmentGroup: { id: "grp-1", reason: "return_restock", changes: [] },
            userErrors: [],
          },
        },
      };
    },
  });

  const result = await executeShopifyInventoryAdjust({
    shopifyStoreId: "store-1",
    entityId: "ret-100",
    admin: mockAdmin,
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.idempotent, false);
  assert.strictEqual(graphqlCalled, true);
});

test("Shopify Sync - draftOrderCreate execution for exchange replacement", async () => {
  const { executeShopifyDraftOrderCreate } = await import("../services/shopifySync.server");

  let graphqlCalled = false;
  const mockAdmin = createMockAdmin({
    draftOrderCreate: (vars) => {
      graphqlCalled = true;
      assert.strictEqual(vars.input.lineItems[0].variantId, "gid://shopify/ProductVariant/20");
      return {
        data: {
          draftOrderCreate: {
            draftOrder: {
              id: "gid://shopify/DraftOrder/777333",
              name: "#D1002",
              totalPrice: "0.00",
            },
            userErrors: [],
          },
        },
      };
    },
  });

  const result = await executeShopifyDraftOrderCreate({
    shopifyStoreId: "store-1",
    entityId: "ex-100",
    admin: mockAdmin,
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.draftOrderId, "gid://shopify/DraftOrder/777333");
  assert.strictEqual(result.draftOrderName, "#D1002");
  assert.strictEqual(result.idempotent, false);
  assert.strictEqual(graphqlCalled, true);

  const updatedEx = dbStore.exchangeRequests.get("ex-100");
  assert.strictEqual(updatedEx.newOrderId, "gid://shopify/DraftOrder/777333");
  assert.strictEqual(updatedEx.newOrderNumber, "#D1002");
  // Original Order ID preserved
  assert.strictEqual(updatedEx.shopifyOrderId, "gid://shopify/Order/1002");
});

test("Shopify Sync - GraphQL userErrors explicit handling", async () => {
  const { executeShopifyReturnCreate } = await import("../services/shopifySync.server");

  // Create a separate return request for userError test
  dbStore.returnRequests.set("ret-err", {
    id: "ret-err",
    shopifyStoreId: "store-1",
    shopifyOrderId: "gid://shopify/Order/1009",
    orderNumber: "#1009",
    customerEmail: "user@example.pk",
    status: "PENDING",
    shopifyReturnId: null,
    items: [],
  });

  const mockAdmin = createMockAdmin({
    returnCreate: () => ({
      data: {
        returnCreate: {
          return: null,
          userErrors: [
            { field: ["orderId"], message: "Order is not fulfilled", code: "UNFULFILLED" },
          ],
        },
      },
    }),
  });

  await assert.rejects(
    async () => {
      await executeShopifyReturnCreate({
        shopifyStoreId: "store-1",
        entityId: "ret-err",
        admin: mockAdmin,
      });
    },
    {
      message: /Shopify returnCreate userErrors: orderId: Order is not fulfilled/,
    }
  );
});

test("Shopify Sync - API Failure & State Machine Background Job Enqueueing", async () => {
  const { transitionReturnStatus } = await import("../services/stateMachine.server");

  dbStore.returnRequests.set("ret-fail", {
    id: "ret-fail",
    shopifyStoreId: "store-1",
    shopifyOrderId: "gid://shopify/Order/2001",
    orderNumber: "#2001",
    customerEmail: "user2@example.pk",
    status: "PENDING",
    shopifyReturnId: null,
    items: [],
  });

  const failingAdmin = {
    graphql: async () => {
      throw new Error("Network connection timeout to Shopify GraphQL Endpoint");
    },
  };

  // State machine transition to APPROVED with network failure enqueues background job
  const updated = await transitionReturnStatus({
    id: "ret-fail",
    shopifyStoreId: "store-1",
    targetStatus: "APPROVED",
    admin: failingAdmin,
  });

  assert.strictEqual(updated.status, "APPROVED");

  const enqueuedJobs = Array.from(dbStore.backgroundJobs.values()) as any[];
  const retryJob = enqueuedJobs.find((j: any) => j.type === "SHOPIFY_RETURN_CREATE");
  assert.ok(retryJob);
  assert.strictEqual(retryJob.payload.returnRequestId, "ret-fail");
});

test("Shopify Sync - Background Worker Retry Execution", async () => {
  const { processNextJob } = await import("../worker.server");

  const processed = await processNextJob();
  assert.strictEqual(processed, true);
});
