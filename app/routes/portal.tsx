import { redirect } from "react-router";
import type { Route } from "./+types/portal";

/**
 * Legacy customer portal route.
 * Shoppers use the storefront app proxy (/apps/returns) or the hosted portal (/returns/:merchantSlug).
 * Any remaining access to /portal redirects to the merchant app or storefront proxy.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const shop = String(url.searchParams.get("shop") || "").trim().toLowerCase();

  if (/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    return redirect(`https://${shop}/apps/returns`);
  }

  return redirect("/app");
}

export default function DeprecatedPortalRedirect() {
  return null;
}
