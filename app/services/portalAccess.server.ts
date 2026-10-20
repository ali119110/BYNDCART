import prisma from "../db.server";
import { configuredShopDomain } from "./shopifyAdmin.server";
import { normalizeShopDomain } from "../utils/shopDomain";

export { normalizeShopDomain };

const PORTAL_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

export function normalizePortalSlug(value: unknown): string | null {
  const slug = String(value ?? "").trim().toLowerCase();
  return PORTAL_SLUG_PATTERN.test(slug) ? slug : null;
}

function brandFromSlug(portalSlug: string | null | undefined, shop: string) {
  if (portalSlug) return portalSlug.replace(/-/g, " ").toUpperCase();
  return shop.replace(/\.myshopify\.com$/i, "").toUpperCase();
}

/** Resolve a storefront App Proxy request to an installed BYNDCART store. */
export async function resolvePortalStore(shopValue: string | null | undefined) {
  const explicitShop = normalizeShopDomain(shopValue);
  const shop = explicitShop || configuredShopDomain();
  if (!shop) {
    throw new Response("Open returns from your store's Returns and exchanges link.", { status: 400 });
  }

  const store = await prisma.shopifyStore.findUnique({
    where: { shop },
    select: {
      id: true,
      shop: true,
      storeSettings: { select: { portalSlug: true } },
    },
  });
  if (!store) {
    throw new Response("This store has not installed BYNDCART.", { status: 404 });
  }

  return {
    shop: store.shop,
    shopifyStoreId: store.id,
    portalSlug: store.storeSettings?.portalSlug ?? null,
    brandName: brandFromSlug(store.storeSettings?.portalSlug, store.shop),
  };
}

/** Resolve the hosted /returns/:merchantSlug portal route to exactly one tenant. */
export async function resolvePortalStoreBySlug(slugValue: unknown) {
  const portalSlug = normalizePortalSlug(slugValue);
  if (!portalSlug) throw new Error("Invalid customer portal URL.");

  const settings = await prisma.storeSettings.findUnique({
    where: { portalSlug },
    select: {
      shopifyStoreId: true,
      portalSlug: true,
      shopifyStore: { select: { shop: true } },
    },
  });
  if (!settings?.portalSlug || !settings.shopifyStore) {
    throw new Error("This customer portal could not be found.");
  }

  return {
    shopifyStoreId: settings.shopifyStoreId,
    shop: settings.shopifyStore.shop,
    portalSlug: settings.portalSlug,
    brandName: brandFromSlug(settings.portalSlug, settings.shopifyStore.shop),
  };
}
