process.env.SHOPIFY_API_KEY = "mock_api_key";
process.env.SHOPIFY_API_SECRET = "mock_api_secret";
process.env.SHOPIFY_APP_URL = "https://byndcart-mock.app";
process.env.DATABASE_URL = "postgresql://mock:mock@localhost:5432/mock";
process.env.NODE_ENV = "test";
import test from "node:test";
import assert from "node:assert";
import { normalizeShopDomain } from "../utils/shopDomain";
import { normalizePortalSlug } from "../services/portalAccess.server";
import { buildCustomerPortalUrl } from "../services/settings.server";

test("Portal shop domain accepts only a myshopify domain", () => {
  assert.strictEqual(
    normalizeShopDomain(" Demo-Store.myshopify.com "),
    "demo-store.myshopify.com",
  );
  assert.strictEqual(
    normalizeShopDomain("https://demo-store.myshopify.com"),
    null,
  );
  assert.strictEqual(normalizeShopDomain("demo-store.com"), null);
  assert.strictEqual(normalizeShopDomain(""), null);
});
test("Hosted portal URL is built only from a safe slug and the public app origin", () => {
  const previous = process.env.CUSTOMER_PORTAL_BASE_URL;

  process.env.CUSTOMER_PORTAL_BASE_URL =
    "https://byndcart-production-23f7.up.railway.app";
  assert.strictEqual(normalizePortalSlug(" Fear "), "fear");
  assert.strictEqual(normalizePortalSlug("fear.com"), null);
  assert.strictEqual(
    buildCustomerPortalUrl("fear"),
    "https://byndcart-production-23f7.up.railway.app/returns/fear",
  );
  assert.strictEqual(buildCustomerPortalUrl("../admin"), null);
  process.env.CUSTOMER_PORTAL_BASE_URL = previous;
});
