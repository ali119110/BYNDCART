-- Each installed Shopify store receives a stable, unique customer-portal slug.
-- Nullable keeps existing StoreSettings rows valid until settings are visited.
ALTER TABLE "StoreSettings"
  ADD COLUMN IF NOT EXISTS "portalSlug" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "StoreSettings_portalSlug_key"
  ON "StoreSettings"("portalSlug");
