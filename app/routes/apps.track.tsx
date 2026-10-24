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
  let proxyShop: string | null = null;

  // A tracking page must resolve its own merchant from Shopify App Proxy authentication
  // or the signed ?shop parameter. Never fall back to one globally configured shop: that
  // can accidentally display the wrong merchant's branding or shipment data on multi-tenant installs.
  try {
    const proxyAuth = await authenticate.public.appProxy(request);
    proxyShop = normalizeShopDomain(
      (proxyAuth as any)?.session?.shop
      || (proxyAuth as any)?.shop
      || null,
    );
  } catch {
    // Standalone/direct previews can use the explicit shop parameter below.
  }

  const url = new URL(request.url);
  const explicitShop = normalizeShopDomain(url.searchParams.get("shop"));
  const shop = proxyShop || explicitShop;

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
