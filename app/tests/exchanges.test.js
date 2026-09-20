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
  createExchangeRequest,
  getExchangeRequestById,
  updateExchangeStatus,
} from "../services/exchanges.server";
import { executeShopifyDraftOrderCreate } from "../services/shopifySync.server";
// In-Memory Mock Database Storage
let mockMerchants = [];
let mockStores = [];
let mockRules = [];
let mockSubscriptions = [];
let mockOrders = [];
let mockExchangeRequests = [];
let mockExchangeItems = [];
let mockShipments = [];
let mockAuditLogs = [];
let mockJobs = [];
let mockLogs = [];

prisma.merchant = {
  create: async (args) => {
    const m = {
      id: `merch-${Date.now()}-${Math.random()}`,
      ...args.data,
      createdAt: new Date(),
    };

    mockMerchants.push(m);

    return m;
  },
};
prisma.shopifyStore = {
  create: async (args) => {
    const s = {
      id: `store-${Date.now()}-${Math.random()}`,
      ...args.data,
      createdAt: new Date(),
    };

    mockStores.push(s);

    return s;
  },
  findUnique: async (args) => {
    if (args.where.id)
      return mockStores.find((s) => s.id === args.where.id) || null;
    if (args.where.shop)
      return mockStores.find((s) => s.shop === args.where.shop) || null;

    return null;
  },
};
prisma.billingSubscription = {
  findUnique: async (args) => {
    return (
      mockSubscriptions.find(
        (s) => s.shopifyStoreId === args?.where?.shopifyStoreId,
      ) || {
        id: "sub-1",
        shopifyStoreId: args?.where?.shopifyStoreId || "store-1",
        name: "Free Plan",
        planCode: "FREE",
        status: "ACTIVE",
        monthlyReturnLimit: 15,
      }
    );
  },
  create: async (args) => ({ ...args.data }),
  update: async (args) => ({ ...args.data }),
  upsert: async (args) => ({ ...args.create }),
};
prisma.returnPolicyRule = {
  findUnique: async (args) => {
    return (
      mockRules.find((r) => r.shopifyStoreId === args?.where?.shopifyStoreId) ||
      null
    );
  },
  upsert: async (args) => ({ ...args.create }),
};
prisma.order = {
  findFirst: async (args) => {
    const storeId = args.where.shopifyStoreId;

    return (
      mockOrders.find(
        (o) =>
          o.shopifyStoreId === storeId &&
          o.shopifyOrderId === args.where.shopifyOrderId,
      ) || {
        id: "ord-101",
        shopifyStoreId: storeId,
        shopifyOrderId: args.where.shopifyOrderId || "gid://shopify/Order/1001",
        orderNumber: "#1001",
        customerEmail: "customer@example.pk",
        customerName: "Imran Khan",
        totalPrice: 5000,
        currency: "PKR",
        lineItems: [],
        shopifyCreatedAt: new Date(),
      }
    );
  },
};
prisma.returnRequest = {
  findFirst: async () => null,
  count: async () => 0,
};
prisma.exchangeRequest = {
  create: async (args) => {
    const req = {
      id: `ex-${Date.now()}-${Math.random()}`,
      ...args.data,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockExchangeRequests.push(req);

    return req;
  },
  findMany: async (args) => {
    const storeId = args?.where?.shopifyStoreId;

    return mockExchangeRequests
      .filter((e) => e.shopifyStoreId === storeId)
      .map((e) => ({
        ...e,
        items: mockExchangeItems.filter((i) => i.exchangeRequestId === e.id),
      }));
  },
  findFirst: async (args) => {
    const id = args?.where?.id;
    const storeId = args?.where?.shopifyStoreId;
    const req = mockExchangeRequests.find(
      (e) => e.id === id && (!storeId || e.shopifyStoreId === storeId),
    );

    if (!req) return null;

    return {
      ...req,
      items: mockExchangeItems.filter((i) => i.exchangeRequestId === req.id),
    };
  },
  findUnique: async (args) => {
    const id = args?.where?.id;
    const req = mockExchangeRequests.find((e) => e.id === id);

    if (!req) return null;

    return {
      ...req,
      items: mockExchangeItems.filter((i) => i.exchangeRequestId === req.id),
    };
  },
  update: async (args) => {
    const idx = mockExchangeRequests.findIndex((e) => e.id === args.where.id);

    if (idx >= 0) {
      mockExchangeRequests[idx] = {
        ...mockExchangeRequests[idx],
        ...args.data,
        updatedAt: new Date(),
      };

      return {
        ...mockExchangeRequests[idx],
        items: mockExchangeItems.filter(
          (i) => i.exchangeRequestId === args.where.id,
        ),
      };
    }

    throw new Error("Exchange request not found");
  },
};
prisma.exchangeItem = {
  createMany: async (args) => {
    for (const item of args.data) {
      mockExchangeItems.push({
        id: `item-${Date.now()}-${Math.random()}`,
        ...item,
      });
    }

    return { count: args.data.length };
  },
};
prisma.shipmentTrack = {
  findFirst: async (args) => {
    if (args?.where?.exchangeRequestId) {
      return (
        mockShipments.find(
          (s) => s.exchangeRequestId === args.where.exchangeRequestId,
        ) || null
      );
    }

    return null;
  },
  findUnique: async (args) => {
    return (
      mockShipments.find(
        (s) => s.trackingNumber === args.where.trackingNumber,
      ) || null
    );
  },
  upsert: async (args) => {
    const trackNum = args.where.trackingNumber;
    const idx = mockShipments.findIndex((s) => s.trackingNumber === trackNum);

    if (idx >= 0) {
      mockShipments[idx] = {
        ...mockShipments[idx],
        ...args.update,
        updatedAt: new Date(),
      };

      return mockShipments[idx];
    } else {
      const ship = {
        id: `ship-${Date.now()}-${Math.random()}`,
        ...args.create,
        createdAt: new Date(),
      };

      mockShipments.push(ship);

      return ship;
    }
  },
};
prisma.shipmentEvent = {
  create: async (args) => ({ id: `event-${Date.now()}`, ...args.data }),
};
prisma.auditLog = {
  create: async (args) => {
    const log = {
      id: `log-${Date.now()}`,
      ...args.data,
      createdAt: new Date(),
    };

    mockAuditLogs.push(log);

    return log;
  },
};
prisma.backgroundJob = {
  create: async (args) => {
    const job = {
      id: `job-${Date.now()}`,
      ...args.data,
      createdAt: new Date(),
    };

    mockJobs.push(job);

    return job;
  },
};
prisma.notificationLog = {
  findUnique: async () => null,
  create: async (args) => ({ id: `nlog-${Date.now()}`, ...args.data }),
  upsert: async (args) => ({ id: `nlog-${Date.now()}`, ...args.create }),
  update: async () => ({}),
};
prisma.notificationTemplate = {
  findUnique: async () => null,
};
prisma.merchantCourierConfig = {
  findUnique: async () => null,
  findMany: async () => [],
};
prisma.$transaction = async (cb) => cb(prisma);

// Helper to create test store
async function createTestStore(shopName) {
  const merchant = await prisma.merchant.create({
    data: { name: `Merchant for ${shopName}` },
  });
  const store = await prisma.shopifyStore.create({
    data: { merchantId: merchant.id, shop: shopName },
  });

  return { merchant, store };
}

test("Exchange Lifecycle — Request Creation with Policy Check & PlanGate", async () => {
  const { store } = await createTestStore(
    `ex-create-${Date.now()}.myshopify.com`,
  );
  const exchange = await createExchangeRequest({
    shopifyStoreId: store.id,
    shopifyOrderId: "gid://shopify/Order/1001",
    orderNumber: "#1001",
    customerEmail: "shopper@example.pk",
    customerName: "Tariq Mahmood",
    items: [
      {
        originalLineItemId: "gid://shopify/LineItem/1",
        originalQuantity: 1,
        originalPrice: 3000,
        replacementVariantId: "gid://shopify/ProductVariant/20",
        replacementQuantity: 1,
        replacementPrice: 3500,
        replacementTitle: "Kurta Shirt XXL",
      },
    ],
  });

  assert.ok(exchange);
  assert.equal(exchange.orderNumber, "#1001");
  assert.equal(exchange.status, "PENDING");
  assert.equal(exchange.items.length, 1);
  assert.equal(Number(exchange.items[0].priceDifference), 500); // 3500 - 3000 = +500 higher price
});
test("Exchange Lifecycle — Duplicate Replacement Order Idempotency Prevention", async () => {
  const { store } = await createTestStore(
    `ex-idem-${Date.now()}.myshopify.com`,
  );
  const exchange = await createExchangeRequest({
    shopifyStoreId: store.id,
    shopifyOrderId: "gid://shopify/Order/1002",
    orderNumber: "#1002",
    customerEmail: "shopper2@example.pk",
    items: [
      {
        originalLineItemId: "gid://shopify/LineItem/2",
        originalQuantity: 1,
        replacementVariantId: "gid://shopify/ProductVariant/22",
        replacementQuantity: 1,
      },
    ],
  });

  // Manually attach newOrderId (simulating completed draft order creation)
  await prisma.exchangeRequest.update({
    where: { id: exchange.id },
    data: {
      newOrderId: "gid://shopify/DraftOrder/888",
      newOrderNumber: "#DRAFT-888",
    },
  });
  // Re-executing executeShopifyDraftOrderCreate must return idempotent: true without calling API
  const result = await executeShopifyDraftOrderCreate({
    shopifyStoreId: store.id,
    entityId: exchange.id,
  });

  assert.equal(result.success, true);
  assert.equal(result.idempotent, true);
  assert.equal(result.draftOrderId, "gid://shopify/DraftOrder/888");
});
test("Exchange Lifecycle — Price Difference Calculations (Same, Higher, Lower Price)", async () => {
  const { store } = await createTestStore(
    `ex-pricediff-${Date.now()}.myshopify.com`,
  );
  // Same price exchange
  const samePriceEx = await createExchangeRequest({
    shopifyStoreId: store.id,
    shopifyOrderId: "gid://shopify/Order/1003",
    orderNumber: "#1003",
    customerEmail: "shopper3@example.pk",
    items: [
      {
        originalLineItemId: "gid://shopify/LineItem/3",
        originalQuantity: 1,
        originalPrice: 2000,
        replacementVariantId: "gid://shopify/ProductVariant/30",
        replacementQuantity: 1,
        replacementPrice: 2000,
      },
    ],
  });

  assert.equal(Number(samePriceEx.items[0].priceDifference), 0);
  // Lower price exchange (store owes partial credit)
  const lowerPriceEx = await createExchangeRequest({
    shopifyStoreId: store.id,
    shopifyOrderId: "gid://shopify/Order/1004",
    orderNumber: "#1004",
    customerEmail: "shopper4@example.pk",
    items: [
      {
        originalLineItemId: "gid://shopify/LineItem/4",
        originalQuantity: 1,
        originalPrice: 4000,
        replacementVariantId: "gid://shopify/ProductVariant/40",
        replacementQuantity: 1,
        replacementPrice: 3000,
      },
    ],
  });

  assert.equal(Number(lowerPriceEx.items[0].priceDifference), -1000);
});
test("Exchange Lifecycle — Premature Completion Rejection", async () => {
  const { store } = await createTestStore(
    `ex-premature-${Date.now()}.myshopify.com`,
  );
  const exchange = await createExchangeRequest({
    shopifyStoreId: store.id,
    shopifyOrderId: "gid://shopify/Order/1005",
    orderNumber: "#1005",
    customerEmail: "shopper5@example.pk",
    items: [
      {
        originalLineItemId: "gid://shopify/LineItem/5",
        originalQuantity: 1,
        replacementVariantId: "gid://shopify/ProductVariant/50",
        replacementQuantity: 1,
      },
    ],
  });

  // Attempting direct PENDING -> COMPLETED must throw state machine error
  await assert.rejects(
    async () => {
      await updateExchangeStatus(exchange.id, store.id, "COMPLETED");
    },
    (err) => {
      return err.message.includes("Invalid exchange status transition");
    },
  );
});
test("Exchange Lifecycle — Outbound Forward Courier Shipment Booking", async () => {
  const { store } = await createTestStore(
    `ex-forward-ship-${Date.now()}.myshopify.com`,
  );
  const exchange = await createExchangeRequest({
    shopifyStoreId: store.id,
    shopifyOrderId: "gid://shopify/Order/1006",
    orderNumber: "#1006",
    customerEmail: "shopper6@example.pk",
    items: [
      {
        originalLineItemId: "gid://shopify/LineItem/6",
        originalQuantity: 1,
        replacementVariantId: "gid://shopify/ProductVariant/60",
        replacementQuantity: 1,
      },
    ],
  });
  // Approving exchange triggers forward shipment registration
  const approved = await updateExchangeStatus(
    exchange.id,
    store.id,
    "APPROVED",
  );

  assert.equal(approved.status, "APPROVED");
  const forwardShipment = await prisma.shipmentTrack.findFirst({
    where: { exchangeRequestId: exchange.id, type: "FORWARD" },
  });

  assert.ok(forwardShipment);
  assert.equal(forwardShipment.type, "FORWARD");
  assert.ok(forwardShipment.trackingNumber);
});
test("Exchange Lifecycle — Replacement Delivery & Final Exchange Completion", async () => {
  const { store } = await createTestStore(
    `ex-complete-${Date.now()}.myshopify.com`,
  );
  const exchange = await createExchangeRequest({
    shopifyStoreId: store.id,
    shopifyOrderId: "gid://shopify/Order/1007",
    orderNumber: "#1007",
    customerEmail: "shopper7@example.pk",
    items: [
      {
        originalLineItemId: "gid://shopify/LineItem/7",
        originalQuantity: 1,
        replacementVariantId: "gid://shopify/ProductVariant/70",
        replacementQuantity: 1,
      },
    ],
  });

  // PENDING -> APPROVED -> FULFILLED -> COMPLETED
  await updateExchangeStatus(exchange.id, store.id, "APPROVED");
  await updateExchangeStatus(exchange.id, store.id, "FULFILLED");
  const completed = await updateExchangeStatus(
    exchange.id,
    store.id,
    "COMPLETED",
  );

  assert.equal(completed.status, "COMPLETED");
  const auditLog = mockAuditLogs.find(
    (a) =>
      a.entityId === exchange.id &&
      a.action === "EXCHANGE_STATUS_TRANSITION_COMPLETED",
  );

  assert.ok(auditLog);
});
test("Exchange Lifecycle — Cross-Merchant Tenant Isolation", async () => {
  const { store: storeA } = await createTestStore(
    `ex-tenant-a-${Date.now()}.myshopify.com`,
  );
  const { store: storeB } = await createTestStore(
    `ex-tenant-b-${Date.now()}.myshopify.com`,
  );
  const exA = await createExchangeRequest({
    shopifyStoreId: storeA.id,
    shopifyOrderId: "gid://shopify/Order/A100",
    orderNumber: "#A100",
    customerEmail: "a@example.com",
    items: [
      {
        originalLineItemId: "gid://shopify/LineItem/A1",
        originalQuantity: 1,
        replacementVariantId: "gid://shopify/ProductVariant/A2",
        replacementQuantity: 1,
      },
    ],
  });
  // Store B trying to query Store A exchange by ID returns null
  const crossQuery = await getExchangeRequestById(exA.id, storeB.id);

  assert.equal(crossQuery, null);
  // Store B trying to transition Store A exchange throws error
  await assert.rejects(
    async () => {
      await updateExchangeStatus(exA.id, storeB.id, "APPROVED");
    },
    (err) => err.message.includes("not found for store"),
  );
});
