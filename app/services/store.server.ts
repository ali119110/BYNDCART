import prisma from "../db.server";
import { apiVersion } from "../shopify.server";

export interface RegisterStoreInput {
  shop: string;
  accessToken: string;
}

export async function registerStore({ shop, accessToken }: RegisterStoreInput) {
  try {
    // 1. Fetch store info from Shopify GraphQL Admin API
    const response = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: `
          query {
            shop {
              name
              email
              contactEmail
            }
          }
        `,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch shop details: ${response.statusText}`);
    }

    const { data } = await response.json();
    const shopData = data?.shop;
    const name = shopData?.name || shop.split(".")[0];
    const email = shopData?.contactEmail || shopData?.email || "";

    // 2. Perform logical multi-tenant database registration
    return await prisma.$transaction(async (tx) => {
      // Find if we already have a store registered
      let store = await tx.shopifyStore.findUnique({
        where: { shop },
        include: { merchant: true },
      });

      if (store) {
        // Update access token or other details if needed
        store = await tx.shopifyStore.update({
          where: { id: store.id },
          data: { updatedAt: new Date() },
          include: { merchant: true },
        });
      } else {
        // Find or create merchant by email
        let merchant = await tx.merchant.findFirst({
          where: { email },
        });

        if (!merchant) {
          merchant = await tx.merchant.create({
            data: {
              name: `${name} Group`,
              email,
            },
          });
        }

        // Create ShopifyStore linked to the merchant
        store = await tx.shopifyStore.create({
          data: {
            merchantId: merchant.id,
            shop,
          },
          include: { merchant: true },
        });

        // Create a default Admin user under the merchant
        if (email) {
          const userExists = await tx.user.findUnique({
            where: { email },
          });

          if (!userExists) {
            await tx.user.create({
              data: {
                merchantId: merchant.id,
                email,
                name: name,
                role: "ADMIN",
              },
            });
          }
        }
      }

      // Log audit trail
      await tx.auditLog.create({
        data: {
          shopifyStoreId: store.id,
          action: "STORE_REGISTERED",
          entityType: "ShopifyStore",
          entityId: store.id,
          metadata: { shop, email },
        },
      });

      return store;
    });
  } catch (error) {
    console.error(`[registerStore] Error registering shop ${shop}:`, error);
    throw error;
  }
}

export async function getStoreByShop(shop: string) {
  return await prisma.shopifyStore.findUnique({
    where: { shop },
    include: { merchant: true },
  });
}
