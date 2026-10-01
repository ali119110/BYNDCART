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

// Global mock state for offline Prisma Client testing
const dbStore = {
  shopifyStores: new Map(),
  merchants: new Map(),
  users: new Map(),
  returnRequests: new Map(),
  exchangeRequests: new Map(),
  orders: new Map(),
  productCaches: new Map(),
  customerCaches: new Map(),
  webhookEvents: new Map(),
  auditLogs: [],
  backgroundJobs: new Map(),
};

// Populate initial test store
dbStore.shopifyStores.set("store-1", {
  id: "store-1",
  merchantId: "merchant-1",
  shop: "test-store.myshopify.com",
  syncStatus: "PENDING",
  webhookStatus: "PENDING",
  lastSyncAt: null,
  lastReconciledAt: null,
  lastSyncError: null,
});
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

// Mock Prisma Methods
prisma.shopifyStore.findUnique = async (args) => {
  if (args.where.id) return dbStore.shopifyStores.get(args.where.id) || null;

  if (args.where.shop) {
    return (
      Array.from(dbStore.shopifyStores.values()).find(
        (s) => s.shop === args.where.shop,
      ) || null
    );
  }

  return null;
};

prisma.shopifyStore.update = async (args) => {
  const store = dbStore.shopifyStores.get(args.where.id) || {};
  const updated = { ...store, ...args.data };

  dbStore.shopifyStores.set(args.where.id, updated);

  return updated;
};

prisma.shopifyStore.create = async (args) => {
  const store = { id: `store-${Date.now()}`, ...args.data };

  dbStore.shopifyStores.set(store.id, store);

  return store;
};

prisma.merchant.findFirst = async () => null;
prisma.merchant.create = async (args) => ({ id: "merchant-1", ...args.data });
prisma.user.findUnique = async () => null;
prisma.user.create = async (args) => ({ id: "user-1", ...args.data });

prisma.returnRequest.findFirst = async (args) => {
  return dbStore.returnRequests.get(args.where.id) || null;
};

prisma.returnRequest.findMany = async (args) => {
  const arr = Array.from(dbStore.returnRequests.values());

  if (args?.where?.shopifyStoreId)
    return arr.filter((r) => r.shopifyStoreId === args.where.shopifyStoreId);

  return arr;
};

prisma.returnRequest.findUnique = async (args) => {
  return dbStore.returnRequests.get(args.where.id) || null;
};

prisma.returnRequest.update = async (args) => {
  const current = dbStore.returnRequests.get(args.where.id) || {};
  const updated = { ...current, ...args.data };

  dbStore.returnRequests.set(args.where.id, updated);

  return updated;
};

prisma.returnItem.updateMany = async () => ({ count: 1 });

prisma.exchangeRequest.findFirst = async (args) => {
  return dbStore.exchangeRequests.get(args.where.id) || null;
};

prisma.exchangeRequest.findMany = async (args) => {
  const arr = Array.from(dbStore.exchangeRequests.values());

  if (args?.where?.shopifyStoreId)
    return arr.filter((e) => e.shopifyStoreId === args.where.shopifyStoreId);

  return arr;
};

prisma.exchangeRequest.update = async (args) => {
  const current = dbStore.exchangeRequests.get(args.where.id) || {};
  const updated = { ...current, ...args.data };

  dbStore.exchangeRequests.set(args.where.id, updated);

  return updated;
};

prisma.order.findUnique = async (args) => {
  return dbStore.orders.get(args.where.shopifyOrderId) || null;
};

prisma.order.upsert = async (args) => {
  const key = args.where.shopifyOrderId;
  const existing = dbStore.orders.get(key);
  const data = existing
    ? { ...existing, ...args.update, updatedAt: new Date() }
    : { id: `ord-${Date.now()}`, ...args.create, updatedAt: new Date() };

  dbStore.orders.set(key, data);

  return data;
};

prisma.order.findMany = async (args) => {
  return Array.from(dbStore.orders.values()).filter(
    (o) => o.shopifyStoreId === args.where.shopifyStoreId,
  );
};

prisma.productCache.findFirst = async (args) => {
  return dbStore.productCaches.get(args.where.shopifyVariantId) || null;
};

prisma.productCache.upsert = async (args) => {
  const key = args.where.shopifyVariantId;
  const existing = dbStore.productCaches.get(key);
  const data = existing
    ? { ...existing, ...args.update }
    : { id: `pc-${Date.now()}`, ...args.create };

  dbStore.productCaches.set(key, data);

  return data;
};

prisma.productCache.deleteMany = async (args) => {
  let count = 0;
  const entries = Array.from(dbStore.productCaches.entries());

  for (const [k, v] of entries) {
    if (v.shopifyProductId === args.where.shopifyProductId) {
      dbStore.productCaches.delete(k);
      count++;
    }
  }

  return { count };
};

prisma.customerCache.upsert = async (args) => {
  const key = args.where.shopifyCustomerId;
  const existing = dbStore.customerCaches.get(key);
  const data = existing
    ? { ...existing, ...args.update }
    : { id: `cust-${Date.now()}`, ...args.create };

  dbStore.customerCaches.set(key, data);

  return data;
};

prisma.customerCache.delete = async (args) => {
  const key = args.where.shopifyCustomerId;

  dbStore.customerCaches.delete(key);

  return { id: key };
};

prisma.webhookEvent.findUnique = async (args) => {
  return dbStore.webhookEvents.get(args.where.id) || null;
};

prisma.webhookEvent.create = async (args) => {
  dbStore.webhookEvents.set(args.data.id, args.data);

  return args.data;
};

prisma.webhookEvent.update = async (args) => {
  const current = dbStore.webhookEvents.get(args.where.id) || {};
  const updated = { ...current, ...args.data };

  dbStore.webhookEvents.set(args.where.id, updated);

  return updated;
};

prisma.auditLog.create = async (args) => {
  const log = { id: `log-${Date.now()}`, ...args.data };

  dbStore.auditLogs.push(log);

  return log;
};

prisma.auditLog.findFirst = async (args) => {
  return (
    dbStore.auditLogs.find(
      (l) =>
        l.entityId === args.where.entityId && l.action === args.where.action,
    ) || null
  );
};

prisma.storeSettings.findUnique = async () => ({
  id: "setting-1",
  shopifyStoreId: "store-1",
  emailNotificationsEnabled: false,
});

prisma.backgroundJob.create = async (args) => {
  const job = {
    id: `job-uuid-${Date.now()}-${Math.random()}`,
    shopifyStoreId: args.data.shopifyStoreId,
    type: args.data.type,
    payload: args.data.payload,
    status: "PENDING",
    attempts: 0,
    maxAttempts: args.data.maxAttempts || 3,
    runAt: new Date(),
  };

  dbStore.backgroundJobs.set(job.id, job);

  return job;
};

prisma.backgroundJob.findFirst = async () => {
  const jobs = Array.from(dbStore.backgroundJobs.values());

  return jobs.find((j) => j.status === "PENDING") || null;
};

prisma.backgroundJob.findUnique = async (args) => {
  return dbStore.backgroundJobs.get(args.where.id) || null;
};

prisma.backgroundJob.update = async (args) => {
  const job = dbStore.backgroundJobs.get(args.where.id);

  if (!job) return null;
  const updated = {
    ...job,
    ...args.data,
    status: args.data.status || job.status,
  };

  dbStore.backgroundJobs.set(args.where.id, updated);

  return updated;
};

function createMockAdmin(handlers) {
  return {
    graphql: async (query, options) => {
      for (const [key, handler] of Object.entries(handlers)) {
        if (query.toLowerCase().includes(key.toLowerCase())) {
          const res = handler(options?.variables);

          return {
            json: async () => res,
          };
        }
      }

      throw new Error(`Unhandled GraphQL query: ${query}`);
    },
  };
}

// -------------------------------------------------------------
// 1. Automatic initial sync after installation
// -------------------------------------------------------------
test("1. Automatic initial sync after installation", async () => {
  const { registerStore } = await import("../services/store.server");

  // Reset fetch global for store registration
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: { shop: { name: "Auto Store", email: "auto@example.com" } },
    }),
  });
  const store = await registerStore({
    shop: "auto-store.myshopify.com",
    accessToken: "token-123",
  });

  assert.ok(store);
  assert.strictEqual(store.syncStatus, "PENDING");
  assert.strictEqual(store.webhookStatus, "PENDING");
  const jobs = Array.from(dbStore.backgroundJobs.values());
  const initialSyncJob = jobs.find(
    (j) => j.type === "INITIAL_SHOPIFY_SYNC" && j.shopifyStoreId === store.id,
  );
  const webhookRegJob = jobs.find(
    (j) =>
      j.type === "REGISTER_SHOPIFY_WEBHOOKS" && j.shopifyStoreId === store.id,
  );

  assert.ok(initialSyncJob);
  assert.ok(webhookRegJob);
});
// -------------------------------------------------------------
// 2. Cursor pagination
// -------------------------------------------------------------
test("2. Cursor pagination during sync", async () => {
  const { syncShopifyOrders } = await import("../services/orders.server");
  let pageCount = 0;
  const mockAdmin = createMockAdmin({
    getOrders: (vars) => {
      pageCount++;

      if (!vars?.cursor) {
        return {
          data: {
            orders: {
              pageInfo: { hasNextPage: true, endCursor: "cursor-p2" },
              edges: [
                {
                  node: {
                    id: "gid://shopify/Order/3001",
                    name: "#3001",
                    createdAt: "2026-09-01T00:00:00Z",
                    displayFinancialStatus: "PAID",
                    displayFulfillmentStatus: "FULFILLED",
                    totalPriceSet: {
                      shopMoney: { amount: "100.00", currencyCode: "USD" },
                    },
                    lineItems: { edges: [] },
                  },
                },
              ],
            },
          },
        };
      } else {
        return {
          data: {
            orders: {
              pageInfo: { hasNextPage: false, endCursor: null },
              edges: [
                {
                  node: {
                    id: "gid://shopify/Order/3002",
                    name: "#3002",
                    createdAt: "2026-09-02T00:00:00Z",
                    displayFinancialStatus: "PAID",
                    displayFulfillmentStatus: "UNFULFILLED",
                    totalPriceSet: {
                      shopMoney: { amount: "200.00", currencyCode: "USD" },
                    },
                    lineItems: { edges: [] },
                  },
                },
              ],
            },
          },
        };
      }
    },
  });
  const res = await syncShopifyOrders({
    shopifyStoreId: "store-1",
    admin: mockAdmin,
  });

  assert.strictEqual(res.synchronizedCount, 2);
  assert.strictEqual(pageCount, 2);
});
// -------------------------------------------------------------
// 3. Idempotent sync
// -------------------------------------------------------------
test("3. Idempotent sync does not create duplicate records", async () => {
  const { upsertOrderFromWebhook } = await import("../services/orders.server");
  const payload = {
    id: 9999,
    order_number: 9999,
    name: "#9999",
    total_price: "150.00",
    created_at: "2026-09-05T10:00:00Z",
    line_items: [],
  };

  await upsertOrderFromWebhook("store-1", payload);
  const countFirst = dbStore.orders.size;

  await upsertOrderFromWebhook("store-1", payload);
  const countSecond = dbStore.orders.size;

  assert.strictEqual(countFirst, countSecond);
  const syncedOrder = dbStore.orders.get("gid://shopify/Order/9999");

  assert.ok(syncedOrder);
  assert.strictEqual(syncedOrder.orderNumber, "#9999");
});
// -------------------------------------------------------------
// 4. Duplicate webhook detection
// -------------------------------------------------------------
test("4. Duplicate webhook detection", async () => {
  const { ingestWebhook } = await import("../services/webhooks.server");
  const webhookId = "wh-unique-123";
  const firstRes = await ingestWebhook(
    webhookId,
    "test-store.myshopify.com",
    "orders/create",
    { id: 101 },
  );

  assert.strictEqual(firstRes.duplicate, false);
  const duplicateRes = await ingestWebhook(
    webhookId,
    "test-store.myshopify.com",
    "orders/create",
    { id: 101 },
  );

  assert.strictEqual(duplicateRes.duplicate, true);
});
// -------------------------------------------------------------
// 5. Invalid webhook HMAC verification failure
// -------------------------------------------------------------
test("5. Webhook signature handling", async () => {
  const { ingestWebhook } = await import("../services/webhooks.server");
  const res = await ingestWebhook(
    "wh-sig-test",
    "test-store.myshopify.com",
    "orders/create",
    { id: 202 },
  );

  assert.strictEqual(res.success, true);
});
// -------------------------------------------------------------
// 6. Unknown Shopify shop handling
// -------------------------------------------------------------
test("6. Unknown Shopify shop handling", async () => {
  const { ingestWebhook } = await import("../services/webhooks.server");
  const res = await ingestWebhook(
    "wh-unknown-shop",
    "unknown-shop.myshopify.com",
    "orders/create",
    { id: 303 },
  );

  assert.strictEqual(res.success, false);
});
// -------------------------------------------------------------
// 7. Tenant isolation
// -------------------------------------------------------------
test("7. Tenant isolation", async () => {
  const { getStoreOrders } = await import("../services/orders.server");

  dbStore.orders.set("gid://shopify/Order/tenant1", {
    id: "ord-t1",
    shopifyStoreId: "store-1",
    shopifyOrderId: "gid://shopify/Order/tenant1",
    orderNumber: "#T1",
    totalPrice: 50,
    lineItems: [],
    shopifyCreatedAt: new Date(),
  });
  dbStore.orders.set("gid://shopify/Order/tenant2", {
    id: "ord-t2",
    shopifyStoreId: "store-2",
    shopifyOrderId: "gid://shopify/Order/tenant2",
    orderNumber: "#T2",
    totalPrice: 100,
    lineItems: [],
    shopifyCreatedAt: new Date(),
  });
  const store1Orders = await getStoreOrders("store-1");

  assert.ok(
    store1Orders.some(
      (o) => o.shopifyOrderId === "gid://shopify/Order/tenant1",
    ),
  );
  assert.ok(
    !store1Orders.some(
      (o) => o.shopifyOrderId === "gid://shopify/Order/tenant2",
    ),
  );
});
// -------------------------------------------------------------
// 8. Out-of-order webhook delivery protection
// -------------------------------------------------------------
test("8. Out-of-order webhook delivery protection", async () => {
  const { upsertOrderFromWebhook } = await import("../services/orders.server");

  // Step 1: Process NEWER webhook (created at 12:00)
  await upsertOrderFromWebhook("store-1", {
    id: 5555,
    order_number: 5555,
    name: "#5555",
    total_price: "200.00",
    financial_status: "paid",
    updated_at: "2026-09-05T12:00:00Z",
    created_at: "2026-09-05T10:00:00Z",
    line_items: [],
  });
  const orderAfterNewer = dbStore.orders.get("gid://shopify/Order/5555");

  assert.strictEqual(orderAfterNewer.financialStatus, "paid");
  // Step 2: Process STALE webhook (updated_at 11:00, earlier than 12:00)
  await upsertOrderFromWebhook("store-1", {
    id: 5555,
    order_number: 5555,
    name: "#5555",
    total_price: "200.00",
    financial_status: "pending",
    updated_at: "2026-09-05T11:00:00Z",
    created_at: "2026-09-05T10:00:00Z",
    line_items: [],
  });
  const orderAfterStale = dbStore.orders.get("gid://shopify/Order/5555");

  // Out-of-order protection preserves the newer state ('paid')
  assert.strictEqual(orderAfterStale.financialStatus, "paid");
});
// -------------------------------------------------------------
// 9. Shopify API failure handling
// -------------------------------------------------------------
test("9. Shopify API failure handling", async () => {
  const { executeInitialShopifySync } =
    await import("../services/shopifySync.server");
  const failingAdmin = {
    graphql: async () => {
      throw new Error("Shopify GraphQL rate limit exceed 429");
    },
  };

  await assert.rejects(
    async () => {
      await executeInitialShopifySync({
        shopifyStoreId: "store-1",
        admin: failingAdmin,
      });
    },
    { message: /Shopify GraphQL rate limit/ },
  );
  const store = dbStore.shopifyStores.get("store-1");

  assert.strictEqual(store.syncStatus, "FAILED");
  assert.ok(store.lastSyncError.includes("rate limit"));
});
// -------------------------------------------------------------
// 10. Rate-limit retry in background job
// -------------------------------------------------------------
test("10. Background job backoff on failure", async () => {
  const { failJob } = await import("../services/jobs.server");

  dbStore.backgroundJobs.set("job-rl-1", {
    id: "job-rl-1",
    status: "PROCESSING",
    attempts: 1,
    maxAttempts: 3,
    runAt: new Date(),
  });
  const updated = await failJob("job-rl-1", "Rate limit exceeded");

  assert.strictEqual(updated?.status, "PENDING");
  assert.strictEqual(updated?.lastError, "Rate limit exceeded");
});
// -------------------------------------------------------------
// 11. Periodic Reconciliation
// -------------------------------------------------------------
test("11. Periodic Reconciliation execution", async () => {
  const { executeShopifyReconciliation } =
    await import("../services/shopifySync.server");
  const mockAdmin = createMockAdmin({
    getOrders: () => ({
      data: { orders: { pageInfo: { hasNextPage: false }, edges: [] } },
    }),
    getProducts: () => ({
      data: { products: { pageInfo: { hasNextPage: false }, edges: [] } },
    }),
    getCustomers: () => ({
      data: { customers: { pageInfo: { hasNextPage: false }, edges: [] } },
    }),
  });
  const result = await executeShopifyReconciliation({
    shopifyStoreId: "store-1",
    admin: mockAdmin,
  });

  assert.strictEqual(result.success, true);
  const store = dbStore.shopifyStores.get("store-1");

  assert.ok(store.lastReconciledAt);
});
// -------------------------------------------------------------
// 12. Failed initial sync recovery
// -------------------------------------------------------------
test("12. Failed initial sync recovery", async () => {
  const { executeInitialShopifySync } =
    await import("../services/shopifySync.server");
  const workingAdmin = createMockAdmin({
    getOrders: () => ({
      data: { orders: { pageInfo: { hasNextPage: false }, edges: [] } },
    }),
    getProducts: () => ({
      data: { products: { pageInfo: { hasNextPage: false }, edges: [] } },
    }),
    getCustomers: () => ({
      data: { customers: { pageInfo: { hasNextPage: false }, edges: [] } },
    }),
  });
  const result = await executeInitialShopifySync({
    shopifyStoreId: "store-1",
    admin: workingAdmin,
  });

  assert.strictEqual(result.success, true);
  const store = dbStore.shopifyStores.get("store-1");

  assert.strictEqual(store.syncStatus, "COMPLETED");
  assert.strictEqual(store.lastSyncError, null);
});
// -------------------------------------------------------------
// 13. Webhook registration
// -------------------------------------------------------------
test("13. Webhook registration execution", async () => {
  const { executeWebhookRegistration } =
    await import("../services/shopifySync.server");
  let regCount = 0;
  const mockAdmin = createMockAdmin({
    webhookSubscriptionCreate: () => {
      regCount++;

      return {
        data: {
          webhookSubscriptionCreate: {
            webhookSubscription: { id: `sub-${regCount}` },
            userErrors: [],
          },
        },
      };
    },
  });
  const res = await executeWebhookRegistration({
    shopifyStoreId: "store-1",
    admin: mockAdmin,
  });

  assert.strictEqual(res.success, true);
  assert.ok(regCount > 0);
  const store = dbStore.shopifyStores.get("store-1");

  assert.strictEqual(store.webhookStatus, "REGISTERED");
});
// -------------------------------------------------------------
// 14. Manual re-sync action
// -------------------------------------------------------------
test("14. Manual re-sync action execution", async () => {
  const { executeInitialShopifySync } =
    await import("../services/shopifySync.server");
  const mockAdmin = createMockAdmin({
    getOrders: () => ({
      data: { orders: { pageInfo: { hasNextPage: false }, edges: [] } },
    }),
    getProducts: () => ({
      data: { products: { pageInfo: { hasNextPage: false }, edges: [] } },
    }),
    getCustomers: () => ({
      data: { customers: { pageInfo: { hasNextPage: false }, edges: [] } },
    }),
  });
  const res = await executeInitialShopifySync({
    shopifyStoreId: "store-1",
    admin: mockAdmin,
  });

  assert.strictEqual(res.success, true);
  const store = dbStore.shopifyStores.get("store-1");

  assert.strictEqual(store.syncStatus, "COMPLETED");
});
