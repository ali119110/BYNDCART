-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "shopifyStoreId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "customerEmail" TEXT,
    "customerName" TEXT,
    "totalPrice" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "financialStatus" TEXT,
    "fulfillmentStatus" TEXT,
    "lineItems" JSONB NOT NULL,
    "shopifyCreatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCache" (
    "id" TEXT NOT NULL,
    "shopifyStoreId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT,
    "sku" TEXT,
    "imageUrl" TEXT,
    "price" DECIMAL(10,2) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Order_shopifyOrderId_key" ON "Order"("shopifyOrderId");

-- CreateIndex
CREATE INDEX "Order_shopifyStoreId_idx" ON "Order"("shopifyStoreId");

-- CreateIndex
CREATE INDEX "Order_shopifyStoreId_shopifyCreatedAt_idx" ON "Order"("shopifyStoreId", "shopifyCreatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCache_shopifyVariantId_key" ON "ProductCache"("shopifyVariantId");

-- CreateIndex
CREATE INDEX "ProductCache_shopifyStoreId_idx" ON "ProductCache"("shopifyStoreId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_shopifyStoreId_fkey" FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCache" ADD CONSTRAINT "ProductCache_shopifyStoreId_fkey" FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;
