-- Merchant branding, support, return address, and shop policies for customer portal
ALTER TABLE "StoreSettings"
  ADD COLUMN IF NOT EXISTS "storeLogoUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "supportEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "whatsappNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "returnAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "policies" JSONB;
