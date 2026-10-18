ALTER TABLE "ReturnRequest" ADD COLUMN IF NOT EXISTS "shopifyReturnId" TEXT;
ALTER TABLE "ReturnRequest" ADD COLUMN IF NOT EXISTS "shopifyRefundId" TEXT;
