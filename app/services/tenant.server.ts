import { authenticate } from "../shopify.server";
import { getStoreByShop } from "./store.server";

export interface TenantContext {
  shop: string;
  shopifyStoreId: string;
  merchantId: string;
  session: any;
  accessToken?: string;
  admin?: any;
}

/**
 * Validates request authentication and retrieves store and merchant context.
 * Throws clean responses for unauthorized (401) or unregistered (404) merchants.
 */
export async function requireTenantContext(request: Request): Promise<TenantContext> {
  if (process.env.SKIP_AUTH === "true" && process.env.NODE_ENV !== "test") {
    return {
      shop: "mock-store.myshopify.com",
      shopifyStoreId: "mock-store-id",
      merchantId: "mock-merchant-id",
      session: { shop: "mock-store.myshopify.com", accessToken: "mock-access-token" },
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
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  // Resolve matching tenant store and merchant configuration
  const store = await getStoreByShop(session.shop);
  if (!store) {
    throw new Response(
      JSON.stringify({
        success: false,
        error: {
          message: `Tenant store ${session.shop} is not registered in BYNDCART database.`,
          code: "TENANT_NOT_FOUND",
        },
      }),
      { status: 404, headers: { "Content-Type": "application/json" } }
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

