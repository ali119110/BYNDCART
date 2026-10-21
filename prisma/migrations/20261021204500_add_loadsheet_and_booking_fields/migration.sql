-- AlterTable
ALTER TABLE "ShipmentTrack" ADD COLUMN IF NOT EXISTS "destinationCity" TEXT;
ALTER TABLE "ShipmentTrack" ADD COLUMN IF NOT EXISTS "codAmount" DECIMAL(12,2);
ALTER TABLE "ShipmentTrack" ADD COLUMN IF NOT EXISTS "loadsheetId" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Loadsheet" (
    "id" TEXT NOT NULL,
    "shopifyStoreId" TEXT NOT NULL,
    "loadsheetNumber" TEXT NOT NULL,
    "courier" TEXT NOT NULL,
    "parcelCount" INTEGER NOT NULL DEFAULT 0,
    "totalCodAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'GENERATED',
    "riderName" TEXT,
    "riderPhone" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Loadsheet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Loadsheet_loadsheetNumber_key" ON "Loadsheet"("loadsheetNumber");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Loadsheet_shopifyStoreId_idx" ON "Loadsheet"("shopifyStoreId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Loadsheet_shopifyStoreId_courier_idx" ON "Loadsheet"("shopifyStoreId", "courier");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ShipmentTrack_shopifyStoreId_loadsheetId_idx" ON "ShipmentTrack"("shopifyStoreId", "loadsheetId");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ShipmentTrack_loadsheetId_fkey'
    ) THEN
        ALTER TABLE "ShipmentTrack" ADD CONSTRAINT "ShipmentTrack_loadsheetId_fkey" FOREIGN KEY ("loadsheetId") REFERENCES "Loadsheet"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Loadsheet_shopifyStoreId_fkey'
    ) THEN
        ALTER TABLE "Loadsheet" ADD CONSTRAINT "Loadsheet_shopifyStoreId_fkey" FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
