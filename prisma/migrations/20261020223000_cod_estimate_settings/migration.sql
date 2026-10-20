-- Merchant-selected COD estimate inputs. Existing stores keep the previous 4% and PKR 280 defaults.
ALTER TABLE "StoreSettings"
  ADD COLUMN IF NOT EXISTS "codTaxPercent" DECIMAL(5,2) NOT NULL DEFAULT 4.00;

ALTER TABLE "StoreSettings"
  ADD COLUMN IF NOT EXISTS "codDeliveryCharge" DECIMAL(10,2) NOT NULL DEFAULT 280.00;
