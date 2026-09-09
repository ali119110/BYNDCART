import db from "../db.server";

export async function getSettings(shopifyStoreId: string, admin?: any) {
  let settings = await db.storeSettings.findUnique({
    where: { shopifyStoreId },
  });

  // Auto-create defaults on first visit if none exist yet.
  // Pre-fill notificationEmail with the Shopify shop owner's email when we
  // have a live admin client — merchants shouldn't have to type their own
  // email in on day one. emailNotificationsEnabled stays OFF by default
  // regardless (schema default), merchant has to opt in.
  if (!settings) {
    const shopEmail = await fetchShopOwnerEmail(admin);
    settings = await db.storeSettings.create({
      data: { shopifyStoreId, notificationEmail: shopEmail },
    });
  }

  return serializeSettings(settings);
}

async function fetchShopOwnerEmail(admin?: any): Promise<string | null> {
  if (!admin) return null;

  try {
    const response = await admin.graphql(
      `#graphql
      query getShopEmail {
        shop { email }
      }`
    );
    const { data } = await response.json();
    return data?.shop?.email ?? null;
  } catch (error) {
    console.error("[Settings] Failed to fetch shop owner email:", error);
    return null;
  }
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
    fraudFlagReturnCount?: number;
    fraudFlagWindowDays?: number;
    fraudFlagWindowCount?: number;
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
  };
}
