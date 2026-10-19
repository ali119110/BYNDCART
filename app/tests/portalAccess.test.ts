process.env.SHOPIFY_API_KEY = "mock_api_key";
process.env.SHOPIFY_API_SECRET = "mock_api_secret";
process.env.SHOPIFY_APP_URL = "https://byndcart-mock.app";
process.env.DATABASE_URL = "postgresql://mock:mock@localhost:5432/mock";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert";
import { normalizeShopDomain } from "../utils/shopDomain";

test("Portal shop domain accepts only a myshopify domain", () => {
  assert.strictEqual(normalizeShopDomain(" Demo-Store.myshopify.com "), "demo-store.myshopify.com");
  assert.strictEqual(normalizeShopDomain("https://demo-store.myshopify.com"), null);
  assert.strictEqual(normalizeShopDomain("demo-store.com"), null);
  assert.strictEqual(normalizeShopDomain(""), null);
});
