import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { normalizeShopDomain } from "../services/portalAccess.server";

/**
 * Shopify app proxy target for https://{store}/apps/returns.
 * Customers never use the admin session. Shopify signs the request, then we
 * open the portal for that shop.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.public.appProxy(request);
  const shop = normalizeShopDomain(new URL(request.url).searchParams.get("shop"));
  if (!shop) {
    throw new Response("Shopify did not include a store domain.", { status: 400 });
  }

  const portal = new URL("/portal", process.env.SHOPIFY_APP_URL || new URL(request.url).origin);
  portal.searchParams.set("shop", shop);
  return redirect(portal.toString());
}
