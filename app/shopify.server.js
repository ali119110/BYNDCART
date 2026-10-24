import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
// Current Shopify fulfillment mutations require merchant-managed fulfillment-order scopes.
// Union these with the configured scopes so an older Railway SCOPES variable cannot silently
// remove permissions needed to sync courier bookings into Shopify.
const DEFAULT_SHOPIFY_SCOPES = [
  "read_all_orders",
  "read_customers",
  "write_draft_orders",
  "write_inventory",
  "read_inventory",
  "read_orders",
  "write_orders",
  "write_fulfillments",
  "read_products",
  "write_products",
  "read_returns",
  "write_returns",
  "write_store_credit_account_transactions",
];
const REQUIRED_FULFILLMENT_SCOPES = [
  "read_merchant_managed_fulfillment_orders",
  "write_merchant_managed_fulfillment_orders",
];
const configuredScopes = (process.env.SCOPES || "")
  .split(",")
  .map((scope) => scope.trim())
  .filter(Boolean);
const shopifyScopes = Array.from(
  new Set([
    ...(configuredScopes.length ? configuredScopes : DEFAULT_SHOPIFY_SCOPES),
    ...REQUIRED_FULFILLMENT_SCOPES,
  ]),
);
const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: shopifyScopes,
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage:
    process.env.NODE_ENV === "test" || process.env.SKIP_AUTH === "true"
      ? {
          storeSession: async () => true,
          loadSession: async () => undefined,
          deleteSession: async () => true,
          deleteSessions: async () => true,
          findSessionsByShop: async () => [],
        }
      : new PrismaSessionStorage(prisma),
  distribution:
    process.env.SHOPIFY_APP_DISTRIBUTION === "SingleMerchant" ||
    process.env.SHOPIFY_APP_DISTRIBUTION === "Custom"
      ? AppDistribution.SingleMerchant
      : AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    afterAuth: async ({ session }) => {
      shopify.registerWebhooks({ session });
      const { registerStore } = await import("./services/store.server");

      await registerStore({
        shop: session.shop,
        accessToken: session.accessToken || "",
      });
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
