-- Additive production migration. Existing rows are preserved.
ALTER TABLE "ReturnPolicyRule" ADD COLUMN IF NOT EXISTS "evidenceRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ReturnPolicyRule" ADD COLUMN IF NOT EXISTS "reserveInventoryOnReceipt" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS "RefundRecord" (
    "id" TEXT NOT NULL,
    "shopifyStoreId" TEXT NOT NULL,
    "returnRequestId" TEXT,
    "exchangeRequestId" TEXT,
    "method" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reference" TEXT,
    "reason" TEXT,
    "notes" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RefundRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EvidenceAttachment" (
    "id" TEXT NOT NULL,
    "shopifyStoreId" TEXT NOT NULL,
    "returnRequestId" TEXT,
    "exchangeRequestId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'PHOTO',
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sourceUrl" TEXT,
    "contentBase64" TEXT,
    "uploadedBy" TEXT NOT NULL DEFAULT 'MERCHANT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvidenceAttachment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CodImportBatch" (
    "id" TEXT NOT NULL,
    "shopifyStoreId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CodImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CodSettlement" (
    "id" TEXT NOT NULL,
    "shopifyStoreId" TEXT NOT NULL,
    "courier" TEXT NOT NULL,
    "trackingNumber" TEXT,
    "orderNumber" TEXT,
    "expectedAmount" DECIMAL(12,2) NOT NULL,
    "collectedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "shippingCharge" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reverseCharge" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "fees" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "adjustments" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(12,2) NOT NULL,
    "settlementDate" TIMESTAMP(3),
    "batchReference" TEXT,
    "courierReference" TEXT,
    "bankReference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'EXPECTED',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "importBatchId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CodSettlement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RefundRecord_shopifyStoreId_idx" ON "RefundRecord"("shopifyStoreId");
CREATE INDEX IF NOT EXISTS "RefundRecord_shopifyStoreId_status_idx" ON "RefundRecord"("shopifyStoreId", "status");
CREATE INDEX IF NOT EXISTS "RefundRecord_returnRequestId_idx" ON "RefundRecord"("returnRequestId");
CREATE INDEX IF NOT EXISTS "RefundRecord_exchangeRequestId_idx" ON "RefundRecord"("exchangeRequestId");
CREATE INDEX IF NOT EXISTS "EvidenceAttachment_shopifyStoreId_idx" ON "EvidenceAttachment"("shopifyStoreId");
CREATE INDEX IF NOT EXISTS "EvidenceAttachment_returnRequestId_idx" ON "EvidenceAttachment"("returnRequestId");
CREATE INDEX IF NOT EXISTS "EvidenceAttachment_exchangeRequestId_idx" ON "EvidenceAttachment"("exchangeRequestId");
CREATE UNIQUE INDEX IF NOT EXISTS "CodImportBatch_shopifyStoreId_fileHash_key" ON "CodImportBatch"("shopifyStoreId", "fileHash");
CREATE INDEX IF NOT EXISTS "CodImportBatch_shopifyStoreId_idx" ON "CodImportBatch"("shopifyStoreId");
CREATE INDEX IF NOT EXISTS "CodSettlement_shopifyStoreId_idx" ON "CodSettlement"("shopifyStoreId");
CREATE INDEX IF NOT EXISTS "CodSettlement_shopifyStoreId_status_idx" ON "CodSettlement"("shopifyStoreId", "status");
CREATE INDEX IF NOT EXISTS "CodSettlement_shopifyStoreId_courierReference_idx" ON "CodSettlement"("shopifyStoreId", "courierReference");

DO $$ BEGIN
  ALTER TABLE "RefundRecord" ADD CONSTRAINT "RefundRecord_shopifyStoreId_fkey" FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EvidenceAttachment" ADD CONSTRAINT "EvidenceAttachment_shopifyStoreId_fkey" FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CodImportBatch" ADD CONSTRAINT "CodImportBatch_shopifyStoreId_fkey" FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CodSettlement" ADD CONSTRAINT "CodSettlement_shopifyStoreId_fkey" FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CodSettlement" ADD CONSTRAINT "CodSettlement_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "CodImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
