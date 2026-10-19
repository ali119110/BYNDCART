export function normalizeShopDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  const shop = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) return null;
  return shop;
}
