CREATE TABLE "ShipmentDocument" (
  "id" TEXT NOT NULL,
  "shopifyStoreId" TEXT NOT NULL,
  "shipmentTrackId" TEXT NOT NULL,
  "documentType" TEXT NOT NULL DEFAULT 'LABEL',
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL DEFAULT 'application/pdf',
  "contentBase64" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShipmentDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShipmentDocument_shipmentTrackId_documentType_key"
  ON "ShipmentDocument"("shipmentTrackId", "documentType");
CREATE INDEX "ShipmentDocument_shopifyStoreId_idx"
  ON "ShipmentDocument"("shopifyStoreId");
CREATE INDEX "ShipmentDocument_shopifyStoreId_documentType_idx"
  ON "ShipmentDocument"("shopifyStoreId", "documentType");

ALTER TABLE "ShipmentDocument"
  ADD CONSTRAINT "ShipmentDocument_shopifyStoreId_fkey"
  FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShipmentDocument"
  ADD CONSTRAINT "ShipmentDocument_shipmentTrackId_fkey"
  FOREIGN KEY ("shipmentTrackId") REFERENCES "ShipmentTrack"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
