import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { normalizeShopDomain, resolvePortalStore } from "../services/portalAccess.server";
import { renderTrackPageHtml } from "../services/trackPage.server";

/** Shopify app proxy entry point: https://{store}/apps/track. */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleTrackingRequest(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return handleTrackingRequest(request);
}

async function handleTrackingRequest(request: Request) {
  let shop: string | null = null;
  let proxyAuthenticated = false;

  // Use the shop returned by verified Shopify App Proxy authentication. Never use a
  // merchant-supplied query parameter to select the tenant on a production request.
  try {
    const proxyContext = await authenticate.public.appProxy(request);
    proxyAuthenticated = true;
    shop = normalizeShopDomain(
      (proxyContext as any)?.session?.shop
        || (proxyContext as any)?.shop
        || null,
    );
  } catch {
    // Direct access is only permitted in non-production development/preview sessions.
  }

  const url = new URL(request.url);
  if (!shop && process.env.NODE_ENV !== "production" && !proxyAuthenticated) {
    shop = normalizeShopDomain(url.searchParams.get("shop"));
  }

  if (!shop) {
    return new Response("Store domain parameter is required to track order.", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  try {
    const resolved = await resolvePortalStore(shop);
    return renderTrackPageHtml(
      request,
      resolved.shopifyStoreId,
      resolved.brandName || resolved.shop.replace(/\.myshopify\.com$/i, "").toUpperCase(),
    );
  } catch (error) {
    console.error("[TrackOrder] Failed to resolve store for track page:", error);
    return new Response("Store tracking page is not available.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
