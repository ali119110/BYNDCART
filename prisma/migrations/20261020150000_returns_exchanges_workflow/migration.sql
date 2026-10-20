-- BYNDCART returns/exchanges lifecycle: item-level inspection, policy audit,
-- refund execution preference, and replacement-order timing.
ALTER TABLE "StoreSettings"
  ADD COLUMN IF NOT EXISTS "refundExecutionMode" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS "exchangeReplacementTiming" TEXT NOT NULL DEFAULT 'AFTER_INSPECTION';

ALTER TABLE "ReturnRequest"
  ADD COLUMN IF NOT EXISTS "requestSource" TEXT NOT NULL DEFAULT 'CUSTOMER',
  ADD COLUMN IF NOT EXISTS "policyOverrideReason" TEXT,
  ADD COLUMN IF NOT EXISTS "inspectionCompletedAt" TIMESTAMP(3);

ALTER TABLE "ExchangeRequest"
  ADD COLUMN IF NOT EXISTS "requestSource" TEXT NOT NULL DEFAULT 'CUSTOMER',
  ADD COLUMN IF NOT EXISTS "policyOverrideReason" TEXT,
  ADD COLUMN IF NOT EXISTS "inspectionCompletedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reason" TEXT,
  ADD COLUMN IF NOT EXISTS "customerNote" TEXT,
  ADD COLUMN IF NOT EXISTS "adminNote" TEXT;

ALTER TABLE "ExchangeItem"
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'PENDING';

-- A warehouse intake can now belong to a return OR an exchange. Existing
-- return intake rows remain associated through ReturnRequest as before.
ALTER TABLE "WarehouseIntake"
  ALTER COLUMN "returnRequestId" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "exchangeRequestId" TEXT;

ALTER TABLE "ItemInspection"
  ADD COLUMN IF NOT EXISTS "exchangeItemId" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WarehouseIntake_exchangeRequestId_fkey'
  ) THEN
    ALTER TABLE "WarehouseIntake"
      ADD CONSTRAINT "WarehouseIntake_exchangeRequestId_fkey"
      FOREIGN KEY ("exchangeRequestId") REFERENCES "ExchangeRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ItemInspection_exchangeItemId_fkey'
  ) THEN
    ALTER TABLE "ItemInspection"
      ADD CONSTRAINT "ItemInspection_exchangeItemId_fkey"
      FOREIGN KEY ("exchangeItemId") REFERENCES "ExchangeItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "WarehouseIntake_exchangeRequestId_idx" ON "WarehouseIntake"("exchangeRequestId");
CREATE INDEX IF NOT EXISTS "ItemInspection_exchangeItemId_idx" ON "ItemInspection"("exchangeItemId");
