process.env.SHOPIFY_API_KEY = "mock_api_key";
process.env.SHOPIFY_API_SECRET = "mock_api_secret";
process.env.SHOPIFY_APP_URL = "https://byndcart-mock.app";
process.env.SCOPES = "read_orders,write_returns";
process.env.DATABASE_URL = "postgresql://mock:mock@localhost:5432/mock";
process.env.NODE_ENV = "test";
import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db.server";
import {
  getStoreSubscription,
  checkUsageLimit,
  checkFeatureAccess,
  assertCanCreateReturn,
} from "../services/planGate.server";
import {
  getStorePlan,
  createAppSubscription,
  cancelAppSubscription,
  handleSubscriptionWebhook,
} from "../services/billing.server";
// In-Memory Mock Database Storage
let mockMerchants = [];
let mockStores = [];
let mockSubscriptions = [];
let mockReturnRequests = [];
let mockAuditLogs = [];

// Mock Prisma Methods
prisma.merchant.create = async (args) => {
  const m = {
    id: `merch-uuid-${Date.now()}-${Math.random()}`,
    ...args.data,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  mockMerchants.push(m);

  return m;
};

prisma.shopifyStore.create = async (args) => {
  const s = {
    id: `store-uuid-${Date.now()}-${Math.random()}`,
    ...args.data,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  mockStores.push(s);

  return s;
};

prisma.shopifyStore.findUnique = async (args) => {
  if (args.where.id) {
    return mockStores.find((s) => s.id === args.where.id) || null;
  }

  if (args.where.shop) {
    return mockStores.find((s) => s.shop === args.where.shop) || null;
  }

  return null;
};

prisma.billingSubscription.findUnique = async (args) => {
  if (args.where.shopifyStoreId) {
    return (
      mockSubscriptions.find(
        (sub) => sub.shopifyStoreId === args.where.shopifyStoreId,
      ) || null
    );
  }

  if (args.where.shopifySubscriptionId) {
    return (
      mockSubscriptions.find(
        (sub) => sub.shopifySubscriptionId === args.where.shopifySubscriptionId,
      ) || null
    );
  }

  return null;
};

prisma.billingSubscription.create = async (args) => {
  const sub = {
    id: `sub-uuid-${Date.now()}-${Math.random()}`,
    ...args.data,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  mockSubscriptions.push(sub);

  return sub;
};

prisma.billingSubscription.update = async (args) => {
  const idx = mockSubscriptions.findIndex(
    (sub) =>
      sub.id === args.where.id ||
      sub.shopifyStoreId === args.where.shopifyStoreId,
  );

  if (idx >= 0) {
    mockSubscriptions[idx] = {
      ...mockSubscriptions[idx],
      ...args.data,
      updatedAt: new Date(),
    };

    return mockSubscriptions[idx];
  }

  throw new Error("Subscription not found for update");
};

prisma.billingSubscription.upsert = async (args) => {
  const storeId = args.where.shopifyStoreId;
  const idx = mockSubscriptions.findIndex(
    (sub) => sub.shopifyStoreId === storeId,
  );

  if (idx >= 0) {
    mockSubscriptions[idx] = {
      ...mockSubscriptions[idx],
      ...args.update,
      updatedAt: new Date(),
    };

    return mockSubscriptions[idx];
  } else {
    const sub = {
      id: `sub-uuid-${Date.now()}-${Math.random()}`,
      shopifyStoreId: storeId,
      ...args.create,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockSubscriptions.push(sub);

    return sub;
  }
};

prisma.returnRequest.count = async (args) => {
  const storeId = args?.where?.shopifyStoreId;

  return mockReturnRequests.filter((r) => r.shopifyStoreId === storeId).length;
};

prisma.returnRequest.create = async (args) => {
  const req = {
    id: `ret-uuid-${Date.now()}-${Math.random()}`,
    ...args.data,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  mockReturnRequests.push(req);

  return req;
};

prisma.auditLog.create = async (args) => {
  const log = {
    id: `log-uuid-${Date.now()}-${Math.random()}`,
    ...args.data,
    createdAt: new Date(),
  };

  mockAuditLogs.push(log);

  return log;
};

// Helper to create test merchants & stores
async function createTestStore(shopName) {
  const merchant = await prisma.merchant.create({
    data: { name: `Merchant for ${shopName}` },
  });
  const store = await prisma.shopifyStore.create({
    data: {
      merchantId: merchant.id,
      shop: shopName,
    },
  });

  return { merchant, store };
}

test("Billing & PlanGate — Default Free Plan Creation", async () => {
  const { store } = await createTestStore(
    `test-billing-free-${Date.now()}.myshopify.com`,
  );
  const sub = await getStoreSubscription(store.id);

  assert.equal(sub.planCode, "FREE");
  assert.equal(sub.status, "ACTIVE");
  assert.equal(sub.monthlyReturnLimit, 15);
  const plan = await getStorePlan(store.id);

  assert.equal(plan.planCode, "FREE");
  assert.equal(plan.returnsLimit, 15);
  assert.equal(plan.usageCount, 0);
});
test("Billing & PlanGate — New Subscription Initiation", async () => {
  const { store } = await createTestStore(
    `test-billing-new-${Date.now()}.myshopify.com`,
  );
  const result = await createAppSubscription(
    store.id,
    "GROWTH",
    "https://test.myshopify.com/app/billing",
  );

  assert.equal(result.success, true);
  assert.equal(result.planCode, "GROWTH");
  assert.ok(result.confirmationUrl);
  const sub = await prisma.billingSubscription.findUnique({
    where: { shopifyStoreId: store.id },
  });

  assert.ok(sub);
  assert.equal(sub.planCode, "GROWTH");
  assert.equal(sub.monthlyReturnLimit, 500);
});
test("Billing & PlanGate — Existing Active Subscription Query", async () => {
  const { store } = await createTestStore(
    `test-billing-exist-${Date.now()}.myshopify.com`,
  );

  await prisma.billingSubscription.create({
    data: {
      shopifyStoreId: store.id,
      shopifySubscriptionId: "gid://shopify/AppSubscription/998877",
      name: "Pro Plan",
      planCode: "PRO",
      status: "ACTIVE",
      price: 99.0,
      monthlyReturnLimit: -1,
    },
  });
  const plan = await getStorePlan(store.id);

  assert.equal(plan.planCode, "PRO");
  assert.equal(plan.status, "ACTIVE");
  assert.equal(plan.isUnlimited, true);
  assert.equal(plan.price, 99.0);
  const hasPriority = await checkFeatureAccess(store.id, "PRIORITY_SUPPORT");

  assert.equal(hasPriority, true);
});
test("Billing & PlanGate — Subscription Cancellation", async () => {
  const { store } = await createTestStore(
    `test-billing-cancel-${Date.now()}.myshopify.com`,
  );

  await prisma.billingSubscription.create({
    data: {
      shopifyStoreId: store.id,
      shopifySubscriptionId: "gid://shopify/AppSubscription/112233",
      name: "Basic Plan",
      planCode: "BASIC",
      status: "ACTIVE",
      price: 19.0,
      monthlyReturnLimit: 100,
    },
  });
  const cancelResult = await cancelAppSubscription(store.id);

  assert.equal(cancelResult.success, true);
  assert.equal(cancelResult.status, "CANCELLED");
  const sub = await prisma.billingSubscription.findUnique({
    where: { shopifyStoreId: store.id },
  });

  assert.equal(sub?.status, "CANCELLED");
  const usage = await checkUsageLimit(store.id);

  // Cancelled status restricts limit to Free plan (15)
  assert.equal(usage.limit, 15);
});
test("Billing & PlanGate — Duplicate Billing Request Idempotency", async () => {
  const { store } = await createTestStore(
    `test-billing-idempotent-${Date.now()}.myshopify.com`,
  );

  await prisma.billingSubscription.create({
    data: {
      shopifyStoreId: store.id,
      shopifySubscriptionId: "gid://shopify/AppSubscription/555444",
      name: "Basic Plan",
      planCode: "BASIC",
      status: "ACTIVE",
      price: 19.0,
      monthlyReturnLimit: 100,
    },
  });
  // Re-requesting the exact same active plan
  const secondReq = await createAppSubscription(
    store.id,
    "BASIC",
    "https://test.myshopify.com/app/billing",
  );

  assert.equal(secondReq.success, true);
  assert.equal(secondReq.status, "ACTIVE");
  assert.equal(secondReq.message, "Already subscribed to Basic Plan");
});
test("Billing & PlanGate — Monthly Return Usage Limit Enforcement", async () => {
  const { store } = await createTestStore(
    `test-billing-limit-${Date.now()}.myshopify.com`,
  );

  // Free plan has limit of 15
  await getStoreSubscription(store.id);

  // Insert 15 return requests in current month
  for (let i = 1; i <= 15; i++) {
    await prisma.returnRequest.create({
      data: {
        shopifyStoreId: store.id,
        shopifyOrderId: `gid://shopify/Order/ord_${i}`,
        orderNumber: `#${1000 + i}`,
        customerEmail: `customer${i}@example.com`,
        status: "APPROVED",
      },
    });
  }

  const usage = await checkUsageLimit(store.id);

  assert.equal(usage.usageCount, 15);
  assert.equal(usage.allowed, false);
  // 16th return request must be rejected by assertCanCreateReturn()
  await assert.rejects(
    async () => {
      await assertCanCreateReturn(store.id);
    },
    (err) => {
      return (
        err.code === "PLAN_USAGE_LIMIT_EXCEEDED" ||
        err.message.includes("Plan usage limit reached")
      );
    },
  );
});
test("Billing & PlanGate — Expired Subscription Fallback", async () => {
  const { store } = await createTestStore(
    `test-billing-expired-${Date.now()}.myshopify.com`,
  );
  const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // Yesterday

  await prisma.billingSubscription.create({
    data: {
      shopifyStoreId: store.id,
      shopifySubscriptionId: "gid://shopify/AppSubscription/expired_999",
      name: "Growth Plan",
      planCode: "GROWTH",
      status: "ACTIVE",
      price: 49.0,
      monthlyReturnLimit: 500,
      currentPeriodEnd: pastDate,
    },
  });
  const sub = await getStoreSubscription(store.id);

  assert.equal(sub.status, "EXPIRED");
  const usage = await checkUsageLimit(store.id);

  assert.equal(usage.limit, 15); // Fallback to Free limit
});
test("Billing & PlanGate — Cross-Merchant Tenant Isolation", async () => {
  const { store: storeA } = await createTestStore(
    `test-tenant-a-${Date.now()}.myshopify.com`,
  );
  const { store: storeB } = await createTestStore(
    `test-tenant-b-${Date.now()}.myshopify.com`,
  );

  await createAppSubscription(storeA.id, "PRO", "http://storea.com");
  await createAppSubscription(storeB.id, "BASIC", "http://storeb.com");
  const planA = await getStorePlan(storeA.id);
  const planB = await getStorePlan(storeB.id);

  assert.equal(planA.planCode, "PRO");
  assert.equal(planB.planCode, "BASIC");
  assert.notEqual(planA.shopifyStoreId, planB.shopifyStoreId);
});
test("Billing & PlanGate — Webhook Processing (APP_SUBSCRIPTIONS_UPDATE)", async () => {
  const shopName = `test-billing-webhook-${Date.now()}.myshopify.com`;
  const { store } = await createTestStore(shopName);
  const webhookPayload = {
    app_subscription: {
      admin_graphql_api_id: "gid://shopify/AppSubscription/wh_776655",
      name: "Growth Plan",
      status: "ACTIVE",
    },
  };
  const result = await handleSubscriptionWebhook(shopName, webhookPayload);

  assert.ok(result);
  assert.equal(result.planCode, "GROWTH");
  assert.equal(result.status, "ACTIVE");
  assert.equal(
    result.shopifySubscriptionId,
    "gid://shopify/AppSubscription/wh_776655",
  );
});
