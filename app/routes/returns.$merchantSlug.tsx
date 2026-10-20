import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { resolvePortalStoreBySlug } from "../services/portalAccess.server";
import { renderCustomerPortalPage } from "../services/customerPortalPage.server";

/**
 * Hosted merchant-specific customer portal, e.g. /returns/fear.
 * The tenant comes only from the registered path slug; submitted form fields
 * cannot choose a shopifyStoreId.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  return renderForMerchant(request, params.merchantSlug);
}

export async function action({ request, params }: ActionFunctionArgs) {
  return renderForMerchant(request, params.merchantSlug);
}

async function renderForMerchant(request: Request, merchantSlug: string | undefined) {
  try {
    const resolved = await resolvePortalStoreBySlug(merchantSlug);
    const actionPath = new URL(request.url).pathname;
    return renderCustomerPortalPage(request, {
      shopifyStoreId: resolved.shopifyStoreId,
      brandName: resolved.brandName,
      actionPath,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "";
    const notFound = errorMessage === "Invalid customer portal URL." || errorMessage === "This customer portal could not be found.";
    if (!notFound) console.error("[CustomerPortal] Failed to resolve hosted merchant portal:", error);
    const status = notFound ? 404 : 500;
    const message = notFound
      ? "This store's returns portal could not be found. Please check the link provided by the store."
      : "We're having trouble loading this returns portal right now. Please try again shortly.";
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Portal unavailable</title><style>body{font-family:system-ui,sans-serif;background:#f6f7f9;color:#142033;margin:0}main{max-width:560px;margin:12vh auto;padding:28px;background:#fff;border:1px solid #e4e8ee;border-radius:16px}h1{font-size:22px}p{line-height:1.55;color:#5c6779}</style></head><body><main><h1>Returns portal unavailable</h1><p>${escapeHtml(message)}</p></main></body></html>`,
      {
        status,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      },
    );
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] || char));
}
