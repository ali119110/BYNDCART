// prisma/seed.ts
// Run with: npx tsx prisma/seed.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // 1. Create a Merchant
  const merchant = await prisma.merchant.create({
    data: {
      name: "Test Merchant",
      email: "merchant@example.com",
    },
  });
  console.log("Created merchant:", merchant.id);

  // 2. Create a ShopifyStore with a FIXED id matching SKIP_AUTH dev mode
  // (tenant.server.ts returns shopifyStoreId: "mock-store-id" when SKIP_AUTH=true)
  const store = await prisma.shopifyStore.upsert({
    where: { id: "mock-store-id" },
    update: {},
    create: {
      id: "mock-store-id",
      merchantId: merchant.id,
      shop: "mock-store.myshopify.com",
    },
  });
  console.log("Created store:", store.id);

  // 3. Create dummy ReturnRequests
  await prisma.returnRequest.createMany({
    data: [
      {
        shopifyStoreId: store.id,
        shopifyOrderId: "gid://shopify/Order/1001",
        orderNumber: "#1001",
        customerEmail: "alice@example.com",
        customerName: "Alice",
        status: "COMPLETED",
        reason: "DEFECTIVE",
        refundAmount: 49.99,
      },
      {
        shopifyStoreId: store.id,
        shopifyOrderId: "gid://shopify/Order/1002",
        orderNumber: "#1002",
        customerEmail: "bob@example.com",
        customerName: "Bob",
        status: "PENDING",
        reason: "SIZE_TOO_SMALL",
      },
      {
        shopifyStoreId: store.id,
        shopifyOrderId: "gid://shopify/Order/1003",
        orderNumber: "#1003",
        customerEmail: "carol@example.com",
        customerName: "Carol",
        status: "REJECTED",
        reason: "WRONG_ITEM",
      },
      {
        shopifyStoreId: store.id,
        shopifyOrderId: "gid://shopify/Order/1004",
        orderNumber: "#1004",
        customerEmail: "dave@example.com",
        customerName: "Dave",
        status: "COMPLETED",
        reason: "DEFECTIVE",
        refundAmount: 25.5,
      },
    ],
  });
  console.log("Created 4 return requests");

  // 4. Create dummy ExchangeRequests with items
  const exchange1 = await prisma.exchangeRequest.create({
    data: {
      shopifyStoreId: store.id,
      shopifyOrderId: "gid://shopify/Order/2001",
      orderNumber: "#2001",
      customerEmail: "erin@example.com",
      customerName: "Erin",
      status: "COMPLETED",
      items: {
        create: [
          {
            originalLineItemId: "gid://shopify/LineItem/501",
            originalQuantity: 1,
            replacementVariantId: "gid://shopify/ProductVariant/999",
            replacementQuantity: 1,
            replacementTitle: "Blue T-Shirt (L)",
            priceDifference: 5.0,
          },
        ],
      },
    },
  });
  console.log("Created exchange:", exchange1.id);

  const exchange2 = await prisma.exchangeRequest.create({
    data: {
      shopifyStoreId: store.id,
      shopifyOrderId: "gid://shopify/Order/2002",
      orderNumber: "#2002",
      customerEmail: "frank@example.com",
      customerName: "Frank",
      status: "PENDING",
      items: {
        create: [
          {
            originalLineItemId: "gid://shopify/LineItem/502",
            originalQuantity: 1,
            replacementVariantId: "gid://shopify/ProductVariant/1000",
            replacementQuantity: 1,
            replacementTitle: "Red Hoodie (M)",
            priceDifference: -10.0,
          },
        ],
      },
    },
  });
  console.log("Created exchange:", exchange2.id);

  console.log("\nSeed complete. Store ID:", store.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });