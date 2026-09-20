import { authenticate } from "../shopify.server";
import { getStoreByShop } from "./store.server";

/**
 * Validates request authentication and retrieves store and merchant context.
 * Throws clean responses for unauthorized (401) or unregistered (404) merchants.
 */
export async function requireTenantContext(request) {
  if (process.env.SKIP_AUTH === "true" && process.env.NODE_ENV !== "test") {
    return {
      shop: "mock-store.myshopify.com",
      shopifyStoreId: "mock-store-id",
      merchantId: "mock-merchant-id",
      session: {
        shop: "mock-store.myshopify.com",
        accessToken: "mock-access-token",
      },
      accessToken: "mock-access-token",
      admin: null,
    };
  }

  // Derive shop name and session from authenticated Shopify request
  const adminContext = await authenticate.admin(request);
  const { session, admin } = adminContext;

  if (!session || !session.shop) {
    throw new Response(
      JSON.stringify({
        success: false,
        error: {
          message: "Unauthenticated request. Shopify session required.",
          code: "UNAUTHENTICATED",
        },
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  // Resolve matching tenant store and merchant configuration
  let store = await getStoreByShop(session.shop);

  if (!store) {
    // On-the-fly Auto-Provisioning: create tenant record for newly installed/authenticated stores
    try {
      const { registerStore } = await import("./store.server");

      await registerStore({
        shop: session.shop,
        accessToken: session.accessToken || "",
      });
      store = await getStoreByShop(session.shop);
    } catch (err) {
      console.error(
        `[requireTenantContext] Error during store auto-provisioning for ${session.shop}:`,
        err,
      );
    }
  }

  if (!store) {
    throw new Response(
      JSON.stringify({
        success: false,
        error: {
          message: `Tenant store ${session.shop} is not registered in BYNDCART database.`,
          code: "TENANT_NOT_FOUND",
        },
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  return {
    shop: session.shop,
    shopifyStoreId: store.id,
    merchantId: store.merchantId,
    session,
    accessToken: session.accessToken,
    admin,
  };
}
