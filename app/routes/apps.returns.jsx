import { authenticate } from "../shopify.server";
import {
  normalizeShopDomain,
  resolvePortalStore,
} from "../services/portalAccess.server";
import { renderCustomerPortalPage } from "../services/customerPortalPage.server";

/** Shopify app proxy entry point: https://{store}/apps/returns. */
export async function loader({ request }) {
  return renderStorefrontProxy(request);
}

export async function action({ request }) {
  return renderStorefrontProxy(request);
}

async function renderStorefrontProxy(request) {
  await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = normalizeShopDomain(url.searchParams.get("shop"));

  if (!shop) {
    return new Response("Shopify did not include a valid store domain.", {
      status: 400,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  try {
    const resolved = await resolvePortalStore(shop);

    return renderCustomerPortalPage(request, {
      shopifyStoreId: resolved.shopifyStoreId,
      brandName:
        resolved.brandName ||
        resolved.shop.replace(/\.myshopify\.com$/i, "").toUpperCase(),
      actionPath: "/apps/returns",
    });
  } catch (error) {
    console.error(
      "[CustomerPortal] Storefront proxy resolution failed:",
      error,
    );

    return new Response("This store's returns portal is not configured yet.", {
      status: 404,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
}
