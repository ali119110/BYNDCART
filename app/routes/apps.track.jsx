import { authenticate } from "../shopify.server";
import {
  normalizeShopDomain,
  resolvePortalStore,
} from "../services/portalAccess.server";
import { renderCustomerPortalPage } from "../services/customerPortalPage.server";

/** Shopify app proxy entry point: https://{store}/apps/track. */
export async function loader({ request }) {
  return handleTrackingRequest(request);
}

export async function action({ request }) {
  return handleTrackingRequest(request);
}

async function handleTrackingRequest(request) {
  let shop = null;

  // Try App Proxy authentication first
  try {
    await authenticate.public.appProxy(request);
  } catch {
    // Allows direct storefront or standalone preview
  }

  const url = new URL(request.url);

  shop = normalizeShopDomain(url.searchParams.get("shop"));

  if (!shop) {
    // If shop parameter is missing, try looking up the primary configured shop
    try {
      const { configuredShopDomain } =
        await import("../services/shopifyAdmin.server");

      shop = configuredShopDomain();
    } catch {
      // Ignored
    }
  }

  if (!shop) {
    return new Response("Store domain parameter is required to track order.", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  try {
    const resolved = await resolvePortalStore(shop);

    return renderCustomerPortalPage(request, {
      shopifyStoreId: resolved.shopifyStoreId,
      brandName:
        resolved.brandName ||
        resolved.shop.replace(/\.myshopify\.com$/i, "").toUpperCase(),
      actionPath: "/apps/track",
    });
  } catch (error) {
    console.error(
      "[TrackOrder] Failed to resolve store for track page:",
      error,
    );

    return new Response("Store tracking page is not available.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
