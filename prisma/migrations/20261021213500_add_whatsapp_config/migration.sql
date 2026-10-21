-- CreateTable
CREATE TABLE "WhatsAppConfig" (
    "id" TEXT NOT NULL,
    "shopifyStoreId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "phoneNumberId" TEXT,
    "wabaId" TEXT,
    "accessToken" TEXT,
    "displayPhoneNumber" TEXT,
    "verifiedName" TEXT,
    "qualityRating" TEXT DEFAULT 'UNKNOWN',
    "connectionType" TEXT NOT NULL DEFAULT 'EMBEDDED_SIGNUP',
    "connectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppConfig_shopifyStoreId_key" ON "WhatsAppConfig"("shopifyStoreId");

-- CreateIndex
CREATE INDEX "WhatsAppConfig_shopifyStoreId_idx" ON "WhatsAppConfig"("shopifyStoreId");

-- AddForeignKey
ALTER TABLE "WhatsAppConfig" ADD CONSTRAINT "WhatsAppConfig_shopifyStoreId_fkey" FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;
