-- Order-level phone snapshot used by the customer portal's email-or-phone login.
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "customerPhone" TEXT;

-- Earlier releases stopped order/customer sync at 500 rows. Re-sync affected stores once
-- with the new fully paginated sync so dashboard counts include the full store.
UPDATE "ShopifyStore" AS store
SET "syncStatus" = 'PENDING', "lastSyncError" = NULL
WHERE
  (SELECT COUNT(*) FROM "CustomerCache" customer WHERE customer."shopifyStoreId" = store.id) >= 500
  OR
  (SELECT COUNT(*) FROM "Order" orders WHERE orders."shopifyStoreId" = store.id) >= 500;
