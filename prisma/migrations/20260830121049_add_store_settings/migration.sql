-- CreateTable
CREATE TABLE "StoreSettings" (
    "id" TEXT NOT NULL,
    "shopifyStoreId" TEXT NOT NULL,
    "returnWindowDays" INTEGER NOT NULL DEFAULT 30,
    "restockingFeePercent" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    "exchangeWindowDays" INTEGER NOT NULL DEFAULT 30,
    "exchangeShippingCost" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "notificationEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoreSettings_shopifyStoreId_key" ON "StoreSettings"("shopifyStoreId");

-- AddForeignKey
ALTER TABLE "StoreSettings" ADD CONSTRAINT "StoreSettings_shopifyStoreId_fkey" FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;
