-- CreateIndex
CREATE INDEX "AuditLog_shopifyStoreId_idx" ON "AuditLog"("shopifyStoreId");

-- CreateIndex
CREATE INDEX "AuditLog_shopifyStoreId_createdAt_idx" ON "AuditLog"("shopifyStoreId", "createdAt");

-- CreateIndex
CREATE INDEX "ExchangeItem_exchangeRequestId_idx" ON "ExchangeItem"("exchangeRequestId");

-- CreateIndex
CREATE INDEX "ExchangeRequest_shopifyStoreId_idx" ON "ExchangeRequest"("shopifyStoreId");

-- CreateIndex
CREATE INDEX "ExchangeRequest_shopifyStoreId_status_idx" ON "ExchangeRequest"("shopifyStoreId", "status");

-- CreateIndex
CREATE INDEX "ExchangeRequest_shopifyStoreId_createdAt_idx" ON "ExchangeRequest"("shopifyStoreId", "createdAt");

-- CreateIndex
CREATE INDEX "ReturnItem_returnRequestId_idx" ON "ReturnItem"("returnRequestId");

-- CreateIndex
CREATE INDEX "ReturnRequest_shopifyStoreId_idx" ON "ReturnRequest"("shopifyStoreId");

-- CreateIndex
CREATE INDEX "ReturnRequest_shopifyStoreId_status_idx" ON "ReturnRequest"("shopifyStoreId", "status");

-- CreateIndex
CREATE INDEX "ReturnRequest_shopifyStoreId_createdAt_idx" ON "ReturnRequest"("shopifyStoreId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_shopifyStoreId_idx" ON "WebhookEvent"("shopifyStoreId");

-- CreateIndex
CREATE INDEX "WebhookEvent_processed_idx" ON "WebhookEvent"("processed");
