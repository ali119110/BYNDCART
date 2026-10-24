import db from "../db.server";

type ShopMetadata = { email: string | null; name: string | null };

export type ShipperProfile = {
  name: string;
  phone: string;
  city: string;
  address: string;
};

export type CourierOperationsSettings = {
  autoCourierTracking: boolean;
  sendDeliveryUpdates: boolean;
  deliveryUpdatePage: string;
  deliveryUpdateTemplate: string;
  fraudCheckEnabled: boolean;
  fraudTagDefinition: string;
  duplicateCheckEnabled: boolean;
  duplicateCheckDurationMinutes: number;
  labelWebsite: string;
  labelLogoUrl: string;
  labelSize: "A4_3" | "A4_4" | "THERMAL_4X6";
  defaultShipperProfileIndex: number;
  shipperProfiles: ShipperProfile[];
};

export const DEFAULT_COURIER_OPERATIONS_SETTINGS: CourierOperationsSettings = {
  // Preserve BYNDCART's existing on-demand live tracking behavior for stores not yet configured.
  autoCourierTracking: true,
  // Keep outbound customer messaging enabled by default to preserve existing notification behavior.
  sendDeliveryUpdates: true,
  deliveryUpdatePage: "COURIER_LOGS",
  deliveryUpdateTemplate:
    "Dear {{customer_name}}, your order #{{order_number}} of amount Rs {{order_amount}} has been shipped.\n\nCourier: {{courier_name}}\nTracking: {{tracking_number}}\nTrack your parcel: {{tracking_url}}",
  fraudCheckEnabled: false,
  fraudTagDefinition: "courier: Trusted - if customer delivery ratio > 85%",
  duplicateCheckEnabled: false,
  duplicateCheckDurationMinutes: 30,
  labelWebsite: "",
  labelLogoUrl: "",
  labelSize: "A4_3",
  defaultShipperProfileIndex: 0,
  shipperProfiles: [
    { name: "", phone: "", city: "", address: "" },
    { name: "", phone: "", city: "", address: "" },
    { name: "", phone: "", city: "", address: "" },
  ],
};

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function boundedSettingText(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

/** Normalize the JSON settings so older stores always receive a complete, safe shape. */
export function normalizeCourierOperationsSettings(value: unknown): CourierOperationsSettings {
  const raw = asRecord(value);
  const profilesValue = Array.isArray(raw.shipperProfiles) ? raw.shipperProfiles : [];
  const shipperProfiles = Array.from({ length: 3 }, (_, index) => {
    const profile = asRecord(profilesValue[index]);
    return {
      name: boundedSettingText(profile.name, 100),
      phone: boundedSettingText(profile.phone, 40),
      city: boundedSettingText(profile.city, 100),
      address: boundedSettingText(profile.address, 500),
    };
  });
  const duration = Number(raw.duplicateCheckDurationMinutes);
  const labelSize = ["A4_3", "A4_4", "THERMAL_4X6"].includes(String(raw.labelSize))
    ? String(raw.labelSize) as CourierOperationsSettings["labelSize"]
    : DEFAULT_COURIER_OPERATIONS_SETTINGS.labelSize;
  const defaultIndex = Number(raw.defaultShipperProfileIndex);

  return {
    autoCourierTracking: typeof raw.autoCourierTracking === "boolean"
      ? raw.autoCourierTracking
      : DEFAULT_COURIER_OPERATIONS_SETTINGS.autoCourierTracking,
    sendDeliveryUpdates: typeof raw.sendDeliveryUpdates === "boolean"
      ? raw.sendDeliveryUpdates
      : DEFAULT_COURIER_OPERATIONS_SETTINGS.sendDeliveryUpdates,
    deliveryUpdatePage: raw.deliveryUpdatePage === "SHIPMENTS" ? "SHIPMENTS" : "COURIER_LOGS",
    deliveryUpdateTemplate: boundedSettingText(
      raw.deliveryUpdateTemplate ?? DEFAULT_COURIER_OPERATIONS_SETTINGS.deliveryUpdateTemplate,
      4000,
    ),
    fraudCheckEnabled: raw.fraudCheckEnabled === true,
    fraudTagDefinition: boundedSettingText(
      raw.fraudTagDefinition ?? DEFAULT_COURIER_OPERATIONS_SETTINGS.fraudTagDefinition,
      160,
    ),
    duplicateCheckEnabled: raw.duplicateCheckEnabled === true,
    duplicateCheckDurationMinutes: [15, 30, 60, 120, 240].includes(duration)
      ? duration
      : DEFAULT_COURIER_OPERATIONS_SETTINGS.duplicateCheckDurationMinutes,
    labelWebsite: boundedSettingText(raw.labelWebsite, 200),
    labelLogoUrl: boundedSettingText(raw.labelLogoUrl, 1000),
    labelSize,
    defaultShipperProfileIndex: Number.isInteger(defaultIndex) && defaultIndex >= 0 && defaultIndex < 3 ? defaultIndex : 0,
    shipperProfiles,
  };
}

/** Shared merchant-level preferences used by booking, labels and all configured couriers. */
export async function getCourierOperationsSettings(shopifyStoreId: string): Promise<CourierOperationsSettings> {
  const row = await db.storeSettings.findUnique({
    where: { shopifyStoreId },
    select: { courierOperationsSettings: true },
  });
  return normalizeCourierOperationsSettings(row?.courierOperationsSettings);
}

export async function getSettings(shopifyStoreId: string, admin?: any) {
  const store = process.env.NODE_ENV === "test"
    ? null
    : await db.shopifyStore.findUnique({
      where: { id: shopifyStoreId },
      select: { shop: true, merchant: { select: { name: true } } },
    }).catch(() => null);

  let settings = await db.storeSettings.findUnique({ where: { shopifyStoreId } });
  let shopMetadata: ShopMetadata | null = null;
  if ((!settings || !settings.portalSlug) && process.env.NODE_ENV !== "test") {
    shopMetadata = await fetchShopMetadata(admin);
  }

  if (!settings) {
    try {
      settings = await db.storeSettings.create({
        data: { shopifyStoreId, notificationEmail: shopMetadata?.email ?? null },
      });
    } catch (error: any) {
      if (error?.code !== "P2002") throw error;
      settings = await db.storeSettings.findUnique({ where: { shopifyStoreId } });
      if (!settings) throw error;
    }
  }

  if (!settings.portalSlug && store && process.env.NODE_ENV !== "test") {
    const preferredName = shopMetadata?.name || store.shop.replace(/\.myshopify\.com$/i, "") || store.merchant?.name || "store";
    const portalSlug = await assignUniquePortalSlug(shopifyStoreId, preferredName);
    const refreshed = await db.storeSettings.findUnique({ where: { shopifyStoreId } });
    if (refreshed?.portalSlug === portalSlug) settings = refreshed;
  }

  if (admin && process.env.NODE_ENV !== "test" && (!settings.policies || Object.keys(settings.policies as object || {}).length === 0)) {
    const policies = await fetchShopPolicies(admin);
    if (policies) {
      await db.storeSettings.update({
        where: { shopifyStoreId },
        data: { policies: policies as any },
      }).catch(() => null);
      settings.policies = policies;
    }
  }

  return serializeSettings(settings);
}

export type ShopPolicyItem = {
  title: string;
  url: string;
};

export type StorePolicies = {
  privacyPolicy?: ShopPolicyItem | null;
  refundPolicy?: ShopPolicyItem | null;
  termsOfService?: ShopPolicyItem | null;
  shippingPolicy?: ShopPolicyItem | null;
  legalNotice?: ShopPolicyItem | null;
  subscriptionPolicy?: ShopPolicyItem | null;
};

export async function fetchShopPolicies(admin?: any): Promise<StorePolicies | null> {
  if (!admin) return null;
  try {
    const response = await admin.graphql(
      `#graphql
      query getShopPolicies {
        shop {
          privacyPolicy { title url }
          refundPolicy { title url }
          termsOfService { title url }
          shippingPolicy { title url }
          legalNotice { title url }
          subscriptionPolicy { title url }
        }
      }`
    );
    const { data } = await response.json();
    if (!data?.shop) return null;
    const policies: StorePolicies = {};
    if (data.shop.privacyPolicy?.url) {
      policies.privacyPolicy = {
        title: data.shop.privacyPolicy.title || "Privacy Policy",
        url: data.shop.privacyPolicy.url,
      };
    }
    if (data.shop.refundPolicy?.url) {
      policies.refundPolicy = {
        title: data.shop.refundPolicy.title || "Refund Policy",
        url: data.shop.refundPolicy.url,
      };
    }
    if (data.shop.termsOfService?.url) {
      policies.termsOfService = {
        title: data.shop.termsOfService.title || "Terms of Service",
        url: data.shop.termsOfService.url,
      };
    }
    if (data.shop.shippingPolicy?.url) {
      policies.shippingPolicy = {
        title: data.shop.shippingPolicy.title || "Shipping Policy",
        url: data.shop.shippingPolicy.url,
      };
    }
    if (data.shop.legalNotice?.url) {
      policies.legalNotice = {
        title: data.shop.legalNotice.title || "Legal Notice",
        url: data.shop.legalNotice.url,
      };
    }
    if (data.shop.subscriptionPolicy?.url) {
      policies.subscriptionPolicy = {
        title: data.shop.subscriptionPolicy.title || "Subscription Policy",
        url: data.shop.subscriptionPolicy.url,
      };
    }
    return Object.keys(policies).length > 0 ? policies : null;
  } catch (error) {
    console.error("[Settings] Failed to fetch Shopify shop policies:", error);
    return null;
  }
}

async function fetchShopMetadata(admin?: any): Promise<ShopMetadata | null> {
  if (!admin) return null;
  try {
    const response = await admin.graphql(
      `#graphql
      query getShopPortalMetadata {
        shop { email name }
      }`
    );
    const { data } = await response.json();
    return {
      email: data?.shop?.email ?? null,
      name: data?.shop?.name ?? null,
    };
  } catch (error) {
    console.error("[Settings] Failed to fetch Shopify shop metadata:", error);
    return null;
  }
}

function slugifyPortalName(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "store";
}

async function assignUniquePortalSlug(shopifyStoreId: string, preferredName: string): Promise<string> {
  const base = slugifyPortalName(preferredName);
  for (let suffix = 0; suffix < 1000; suffix++) {
    const tail = suffix === 0 ? "" : `-${suffix + 1}`;
    const candidate = `${base.slice(0, Math.max(1, 48 - tail.length))}${tail}`;
    const owner = await db.storeSettings.findUnique({
      where: { portalSlug: candidate },
      select: { shopifyStoreId: true },
    });
    if (owner && owner.shopifyStoreId !== shopifyStoreId) continue;

    try {
      await db.storeSettings.update({ where: { shopifyStoreId }, data: { portalSlug: candidate } });
      return candidate;
    } catch (error: any) {
      if (error?.code === "P2002") continue;
      throw error;
    }
  }
  throw new Error("Could not allocate a unique customer portal slug for this store.");
}

export function getCustomerPortalBaseUrl(): string | null {
  const configured = process.env.CUSTOMER_PORTAL_BASE_URL
    || process.env.RAILWAY_PUBLIC_DOMAIN
    || process.env.SHOPIFY_APP_URL
    || process.env.APP_URL;
  if (!configured) return null;

  const candidate = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && process.env.NODE_ENV === "production") return null;
    return parsed.origin.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function buildCustomerPortalUrl(portalSlug: string | null | undefined): string | null {
  const slug = String(portalSlug || "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(slug)) return null;
  const baseUrl = getCustomerPortalBaseUrl();
  return baseUrl ? `${baseUrl}/returns/${encodeURIComponent(slug)}` : null;
}

export async function updateSettings(
  shopifyStoreId: string,
  data: {
    returnWindowDays?: number;
    restockingFeePercent?: number;
    exchangeWindowDays?: number;
    exchangeShippingCost?: number;
    notificationEmail?: string | null;
    emailNotificationsEnabled?: boolean;
    refundExecutionMode?: "SHOPIFY_API" | "MANUAL";
    exchangeReplacementTiming?: "AFTER_APPROVAL" | "AFTER_INSPECTION";
    fraudFlagReturnCount?: number;
    fraudFlagWindowDays?: number;
    fraudFlagWindowCount?: number;
    codTaxPercent?: number;
    codDeliveryCharge?: number;
    storeLogoUrl?: string | null;
    supportEmail?: string | null;
    whatsappNumber?: string | null;
    returnAddress?: string | null;
    courierOperationsSettings?: CourierOperationsSettings | any;
    policies?: any;
  }
) {
  const updated = await db.storeSettings.upsert({
    where: { shopifyStoreId },
    update: data,
    create: { shopifyStoreId, ...data },
  });

  return serializeSettings(updated);
}

// Prisma Decimal fields don't serialize cleanly over the loader/action
// boundary (React Router's turbo-stream doesn't know how to handle them),
// so convert them to plain numbers before returning to the client.
function serializeSettings(settings: any) {
  return {
    ...settings,
    restockingFeePercent: Number(settings.restockingFeePercent),
    exchangeShippingCost: Number(settings.exchangeShippingCost),
    codTaxPercent: Number(settings.codTaxPercent ?? 4),
    codDeliveryCharge: Number(settings.codDeliveryCharge ?? 280),
    courierOperationsSettings: normalizeCourierOperationsSettings(settings.courierOperationsSettings),
  };
}
