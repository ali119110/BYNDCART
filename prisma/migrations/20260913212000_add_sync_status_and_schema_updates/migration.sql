-- AlterTable
ALTER TABLE "ShopifyStore" ADD COLUMN     "lastReconciledAt" TIMESTAMP(3),
ADD COLUMN     "lastSyncAt" TIMESTAMP(3),
ADD COLUMN     "lastSyncError" TEXT,
ADD COLUMN     "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "webhookStatus" TEXT NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "CustomerCache" (
    "id" TEXT NOT NULL,
    "shopifyStoreId" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "ordersCount" INTEGER NOT NULL DEFAULT 0,
    "totalSpent" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundJob" (
    "id" TEXT NOT NULL,
    "shopifyStoreId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lastError" TEXT,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentTrack" (
    "id" TEXT NOT NULL,
    "shopifyStoreId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'RETURN',
    "courier" TEXT NOT NULL DEFAULT 'STANDARD',
    "trackingNumber" TEXT NOT NULL,
    "labelUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'LABEL_CREATED',
    "location" TEXT,
    "estimatedDelivery" TIMESTAMP(3),
    "returnRequestId" TEXT,
    "exchangeRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShipmentTrack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarehouseIntake" (
    "id" TEXT NOT NULL,
    "shopifyStoreId" TEXT NOT NULL,
    "shipmentTrackId" TEXT,
    "returnRequestId" TEXT NOT NULL,
    "scannedAwb" TEXT NOT NULL,
    "receivedByUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "notes" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WarehouseIntake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemInspection" (
    "id" TEXT NOT NULL,
    "warehouseIntakeId" TEXT NOT NULL,
    "returnItemId" TEXT,
    "shopifyLineItemId" TEXT NOT NULL,
    "title" TEXT,
    "sku" TEXT,
    "expectedQuantity" INTEGER NOT NULL,
    "receivedQuantity" INTEGER NOT NULL,
    "condition" TEXT NOT NULL DEFAULT 'RESTOCKABLE',
    "inspectionNotes" TEXT,
    "restockedInShopify" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemInspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerOTP" (
    "id" TEXT NOT NULL,
    "shopifyStoreId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "otpHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerOTP_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantCourierConfig" (
    "id" TEXT NOT NULL,
    "shopifyStoreId" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "encryptedApiToken" TEXT NOT NULL,
    "accountNumber" TEXT,
    "additionalConfig" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isDefaultReverse" BOOLEAN NOT NULL DEFAULT false,
    "isDefaultForward" BOOLEAN NOT NULL DEFAULT false,
    "isLive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantCourierConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentEvent" (
    "id" TEXT NOT NULL,
    "shipmentTrackId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawPayload" JSONB,

    CONSTRAINT "ShipmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnPolicyRule" (
    "id" TEXT NOT NULL,
    "shopifyStoreId" TEXT NOT NULL,
    "returnWindowDays" INTEGER NOT NULL DEFAULT 30,
    "exchangeWindowDays" INTEGER NOT NULL DEFAULT 30,
    "returnsAllowed" BOOLEAN NOT NULL DEFAULT true,
    "exchangesAllowed" BOOLEAN NOT NULL DEFAULT true,
    "allowSaleItems" BOOLEAN NOT NULL DEFAULT true,
    "maxReturnQuantity" INTEGER NOT NULL DEFAULT 5,
    "preventPreviousReturns" BOOLEAN NOT NULL DEFAULT true,
    "excludedSkus" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludedProductIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludedCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "eligibleCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnPolicyRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingSubscription" (
    "id" TEXT NOT NULL,
    "shopifyStoreId" TEXT NOT NULL,
    "shopifySubscriptionId" TEXT,
    "name" TEXT NOT NULL DEFAULT 'Free',
    "planCode" TEXT NOT NULL DEFAULT 'FREE',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "price" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "interval" TEXT NOT NULL DEFAULT 'EVERY_30_DAYS',
    "monthlyReturnLimit" INTEGER NOT NULL DEFAULT 15,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "cappedAmount" DECIMAL(10,2),
    "trialDays" INTEGER NOT NULL DEFAULT 0,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationTemplate" (
    "id" TEXT NOT NULL,
    "shopifyStoreId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "shopifyStoreId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCache_shopifyCustomerId_key" ON "CustomerCache"("shopifyCustomerId");

-- CreateIndex
CREATE INDEX "CustomerCache_shopifyStoreId_idx" ON "CustomerCache"("shopifyStoreId");

-- CreateIndex
CREATE INDEX "CustomerCache_shopifyCustomerId_idx" ON "CustomerCache"("shopifyCustomerId");

-- CreateIndex
CREATE INDEX "BackgroundJob_shopifyStoreId_idx" ON "BackgroundJob"("shopifyStoreId");

-- CreateIndex
CREATE INDEX "BackgroundJob_status_runAt_idx" ON "BackgroundJob"("status", "runAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentTrack_trackingNumber_key" ON "ShipmentTrack"("trackingNumber");

-- CreateIndex
CREATE INDEX "ShipmentTrack_shopifyStoreId_idx" ON "ShipmentTrack"("shopifyStoreId");

-- CreateIndex
CREATE INDEX "ShipmentTrack_shopifyStoreId_type_idx" ON "ShipmentTrack"("shopifyStoreId", "type");

-- CreateIndex
CREATE INDEX "ShipmentTrack_shopifyStoreId_status_idx" ON "ShipmentTrack"("shopifyStoreId", "status");

-- CreateIndex
CREATE INDEX "WarehouseIntake_shopifyStoreId_idx" ON "WarehouseIntake"("shopifyStoreId");

-- CreateIndex
CREATE INDEX "WarehouseIntake_shopifyStoreId_scannedAwb_idx" ON "WarehouseIntake"("shopifyStoreId", "scannedAwb");

-- CreateIndex
CREATE INDEX "WarehouseIntake_returnRequestId_idx" ON "WarehouseIntake"("returnRequestId");

-- CreateIndex
CREATE INDEX "ItemInspection_warehouseIntakeId_idx" ON "ItemInspection"("warehouseIntakeId");

-- CreateIndex
CREATE INDEX "CustomerOTP_shopifyStoreId_idx" ON "CustomerOTP"("shopifyStoreId");

-- CreateIndex
CREATE INDEX "CustomerOTP_shopifyStoreId_orderNumber_destination_idx" ON "CustomerOTP"("shopifyStoreId", "orderNumber", "destination");

-- CreateIndex
CREATE INDEX "MerchantCourierConfig_shopifyStoreId_idx" ON "MerchantCourierConfig"("shopifyStoreId");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantCourierConfig_shopifyStoreId_providerName_key" ON "MerchantCourierConfig"("shopifyStoreId", "providerName");

-- CreateIndex
CREATE INDEX "ShipmentEvent_shipmentTrackId_idx" ON "ShipmentEvent"("shipmentTrackId");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnPolicyRule_shopifyStoreId_key" ON "ReturnPolicyRule"("shopifyStoreId");

-- CreateIndex
CREATE INDEX "ReturnPolicyRule_shopifyStoreId_idx" ON "ReturnPolicyRule"("shopifyStoreId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingSubscription_shopifyStoreId_key" ON "BillingSubscription"("shopifyStoreId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingSubscription_shopifySubscriptionId_key" ON "BillingSubscription"("shopifySubscriptionId");

-- CreateIndex
CREATE INDEX "BillingSubscription_shopifyStoreId_idx" ON "BillingSubscription"("shopifyStoreId");

-- CreateIndex
CREATE INDEX "BillingSubscription_shopifySubscriptionId_idx" ON "BillingSubscription"("shopifySubscriptionId");

-- CreateIndex
CREATE INDEX "BillingSubscription_status_idx" ON "BillingSubscription"("status");

-- CreateIndex
CREATE INDEX "NotificationTemplate_shopifyStoreId_idx" ON "NotificationTemplate"("shopifyStoreId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationTemplate_shopifyStoreId_eventType_channel_key" ON "NotificationTemplate"("shopifyStoreId", "eventType", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationLog_idempotencyKey_key" ON "NotificationLog"("idempotencyKey");

-- CreateIndex
CREATE INDEX "NotificationLog_shopifyStoreId_idx" ON "NotificationLog"("shopifyStoreId");

-- CreateIndex
CREATE INDEX "NotificationLog_idempotencyKey_idx" ON "NotificationLog"("idempotencyKey");

-- CreateIndex
CREATE INDEX "NotificationLog_status_idx" ON "NotificationLog"("status");

-- AddForeignKey
ALTER TABLE "CustomerCache" ADD CONSTRAINT "CustomerCache_shopifyStoreId_fkey" FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundJob" ADD CONSTRAINT "BackgroundJob_shopifyStoreId_fkey" FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentTrack" ADD CONSTRAINT "ShipmentTrack_shopifyStoreId_fkey" FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseIntake" ADD CONSTRAINT "WarehouseIntake_shopifyStoreId_fkey" FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseIntake" ADD CONSTRAINT "WarehouseIntake_returnRequestId_fkey" FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseIntake" ADD CONSTRAINT "WarehouseIntake_shipmentTrackId_fkey" FOREIGN KEY ("shipmentTrackId") REFERENCES "ShipmentTrack"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemInspection" ADD CONSTRAINT "ItemInspection_warehouseIntakeId_fkey" FOREIGN KEY ("warehouseIntakeId") REFERENCES "WarehouseIntake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemInspection" ADD CONSTRAINT "ItemInspection_returnItemId_fkey" FOREIGN KEY ("returnItemId") REFERENCES "ReturnItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerOTP" ADD CONSTRAINT "CustomerOTP_shopifyStoreId_fkey" FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantCourierConfig" ADD CONSTRAINT "MerchantCourierConfig_shopifyStoreId_fkey" FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentEvent" ADD CONSTRAINT "ShipmentEvent_shipmentTrackId_fkey" FOREIGN KEY ("shipmentTrackId") REFERENCES "ShipmentTrack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnPolicyRule" ADD CONSTRAINT "ReturnPolicyRule_shopifyStoreId_fkey" FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSubscription" ADD CONSTRAINT "BillingSubscription_shopifyStoreId_fkey" FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationTemplate" ADD CONSTRAINT "NotificationTemplate_shopifyStoreId_fkey" FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_shopifyStoreId_fkey" FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

