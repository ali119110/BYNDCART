// Set mock environment variables before loading shopify.server or other dependencies
process.env.SHOPIFY_API_KEY = "mock_api_key";
process.env.SHOPIFY_API_SECRET = "mock_api_secret";
process.env.SHOPIFY_APP_URL = "https://byndcart-mock.app";
process.env.APP_URL = "https://byndcart-mock.app";
process.env.HOST = "https://byndcart-mock.app";
process.env.SCOPES = "read_orders,write_returns";
process.env.DATABASE_URL = "postgresql://mock:mock@localhost:5432/mock";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert";

// Mock prisma queries before loading shopify.server or any service
import prisma from "../db.server";

prisma.session.count = (async () => 0) as any;
prisma.session.findUnique = (async () => null) as any;
prisma.session.findMany = (async () => []) as any;
prisma.session.create = (async () => null) as any;
prisma.session.update = (async () => null) as any;
prisma.session.deleteMany = (async () => null) as any;

prisma.shopifyStore.findUnique = (async () => null) as any;
prisma.shopifyStore.findFirst = (async () => null) as any;

prisma.user.findUnique = (async () => null) as any;
prisma.user.create = (async () => null) as any;
prisma.auditLog.create = (async () => null) as any;

// Import validation utilities
import * as validation from "../utils/validation";

// Import API contract utilities
import {
  successResponse,
  errorResponse,
  validationError,
  authError,
  notFoundError,
} from "../services/api.server";

test("Validation Helpers - String validator", () => {
  const emailValidator = validation.string({ email: true });
  
  // Valid email
  const res1 = emailValidator("test@byndcart.com", "email");
  assert.strictEqual(res1.success, true);
  if (res1.success) {
    assert.strictEqual(res1.data, "test@byndcart.com");
  }

  // Invalid email
  const res2 = emailValidator("invalid-email", "email");
  assert.strictEqual(res2.success, false);
  if (!res2.success) {
    assert.strictEqual(res2.errors[0].message, "Invalid email format");
    assert.strictEqual(res2.errors[0].path, "email");
  }

  // Length constraints
  const minLengthValidator = validation.string({ min: 5 });
  const res3 = minLengthValidator("abc", "shortText");
  assert.strictEqual(res3.success, false);
  if (!res3.success) {
    assert.strictEqual(res3.errors[0].message, "String must be at least 5 characters long");
  }
});

test("Validation Helpers - Object shape validator", () => {
  const schema = validation.object({
    orderId: validation.string({ min: 1 }),
    quantity: validation.number({ min: 1 }),
    email: validation.string({ email: true }),
  });

  const validPayload = {
    orderId: "gid://shopify/Order/123",
    quantity: 2,
    email: "customer@example.com",
  };

  const res1 = schema(validPayload);
  assert.strictEqual(res1.success, true);

  const invalidPayload = {
    orderId: "", // Too short
    quantity: 0,  // Under min
    email: "not-an-email",
  };

  const res2 = schema(invalidPayload);
  assert.strictEqual(res2.success, false);
  if (!res2.success) {
    assert.strictEqual(res2.errors.length, 3);
  }
});

test("API Response Utilities - Success response contract", () => {
  const data = { id: "123", status: "PENDING" };
  const res = successResponse(data, "Created return");
  
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("application/json"));
});

test("API Response Utilities - Error responses", () => {
  const res1 = authError();
  assert.strictEqual(res1.status, 401);

  const res2 = notFoundError("Return request not found");
  assert.strictEqual(res2.status, 404);

  const res3 = validationError([{ path: "qty", message: "Invalid value" }]);
  assert.strictEqual(res3.status, 400);
});

test("Tenant Resolution - Valid request context", async () => {
  const shopifyModule = await import("../shopify.server");
  const shopify = shopifyModule.default;
  const { requireTenantContext } = await import("../services/tenant.server");

  // Mock shopify.authenticate.admin
  const originalAdminAuth = shopify.authenticate.admin;
  shopify.authenticate.admin = async () => {
    return {
      session: {
        shop: "byndcart-test.myshopify.com",
        accessToken: "mock-token-123",
      },
    } as any;
  };

  // Mock prisma.shopifyStore.findUnique
  prisma.shopifyStore.findUnique = (async (args: any) => {
    if (args.where.shop === "byndcart-test.myshopify.com") {
      return {
        id: "store-uuid-456",
        merchantId: "merchant-uuid-789",
        shop: args.where.shop,
        merchant: { id: "merchant-uuid-789", name: "Mock Merchant" },
      };
    }
    return null;
  }) as any;

  try {
    const request = new Request("https://byndcart-mock.app/app/returns");
    const context = await requireTenantContext(request);
    
    assert.strictEqual(context.shop, "byndcart-test.myshopify.com");
    assert.strictEqual(context.shopifyStoreId, "store-uuid-456");
    assert.strictEqual(context.merchantId, "merchant-uuid-789");
  } finally {
    // Restore mocks
    shopify.authenticate.admin = originalAdminAuth;
    prisma.shopifyStore.findUnique = (async () => null) as any;
  }
});

test("Tenant Resolution - Unauthenticated session rejection", async () => {
  const shopifyModule = await import("../shopify.server");
  const shopify = shopifyModule.default;
  const { requireTenantContext } = await import("../services/tenant.server");

  const originalAdminAuth = shopify.authenticate.admin;
  shopify.authenticate.admin = async () => {
    return {
      session: null, // Simulate no active shopify session
    } as any;
  };

  try {
    const request = new Request("https://byndcart-mock.app/app/returns");
    await requireTenantContext(request);
    assert.fail("Should have thrown Response error for unauthenticated session");
  } catch (error: any) {
    assert.ok(error instanceof Response);
    assert.strictEqual(error.status, 401);
  } finally {
    shopify.authenticate.admin = originalAdminAuth;
  }
});
