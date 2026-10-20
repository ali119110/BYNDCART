import { redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/portal";
import { resolvePortalStore } from "../services/portalAccess.server";

/**
 * Legacy customer portal. Shoppers use the storefront app proxy.
 * The embedded admin screen only shows the store link.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const embedded = url.searchParams.get("embedded") === "1";
  if (embedded) {
    const { shop } = await resolvePortalStore(url.searchParams.get("shop"));
    return { embedded: true as const, storefrontUrl: `https://${shop}/apps/returns` };
  }

  const shop = String(url.searchParams.get("shop") || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    return new Response("Open Returns and Exchanges from the Shopify storefront so the store can be verified.", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return redirect(`https://${shop}/apps/returns`);
}

export default function LegacyPortalRedirect() {
  const loaderData = useLoaderData<typeof loader>();
  if (loaderData && typeof loaderData === "object" && "embedded" in loaderData && loaderData.embedded) {
    return (
      <div style={{ maxWidth: "640px", margin: "40px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ background: "#fff", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "24px" }}>
          <h1 style={{ fontSize: "22px", margin: "0 0 8px" }}>Customer returns stay on your store</h1>
          <p style={{ color: "#5c5f62", marginTop: 0 }}>
            Shoppers should not use this admin screen. Add the store link to the footer. It opens on the store website.
          </p>
          <p style={{ fontFamily: "monospace", wordBreak: "break-all" }}>{loaderData.storefrontUrl}</p>
          <a href={loaderData.storefrontUrl} target="_top">Open the store page</a>
        </div>
      </div>
    );
  }
  return <main style={{ padding: 24 }}>Redirecting to the store Returns and Exchanges page…</main>;
}
