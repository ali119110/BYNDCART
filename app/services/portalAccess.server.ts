import { getStoreByShop } from "./store.server";
import { configuredShopDomain } from "./shopifyAdmin.server";
import { normalizeShopDomain } from "../utils/shopDomain";

export { normalizeShopDomain };

export async function resolvePortalStore(shopValue: string | null | undefined) {
  const explicitShop = normalizeShopDomain(shopValue);
  const shop = explicitShop || configuredShopDomain();
  if (!shop) {
    throw new Response("Open returns from your store's Returns and exchanges link.", { status: 400 });
  }

  const store = await getStoreByShop(shop);
  if (!store) {
    throw new Response("This store has not installed BYNDCART.", { status: 404 });
  }

  return { shop, shopifyStoreId: store.id };
}
