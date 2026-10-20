-- Persist financial settlement state so exchange retries cannot silently issue duplicate credit/invoices.
ALTER TABLE "ExchangeRequest" ADD COLUMN "storeCreditStatus" TEXT;
ALTER TABLE "ExchangeRequest" ADD COLUMN "storeCreditTransactionId" TEXT;
ALTER TABLE "ExchangeRequest" ADD COLUMN "storeCreditAmount" DECIMAL(10,2);
ALTER TABLE "ExchangeRequest" ADD COLUMN "storeCreditCurrency" TEXT;
ALTER TABLE "ExchangeRequest" ADD COLUMN "storeCreditIssuedAt" TIMESTAMP(3);
ALTER TABLE "ExchangeRequest" ADD COLUMN "paymentInvoiceStatus" TEXT;
ALTER TABLE "ExchangeRequest" ADD COLUMN "paymentInvoiceSentAt" TIMESTAMP(3);
ALTER TABLE "ExchangeRequest" ADD COLUMN "paymentInvoiceError" TEXT;
