-- AlterTable
ALTER TABLE "StoreSettings" ADD COLUMN     "fraudFlagReturnCount" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "fraudFlagWindowCount" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "fraudFlagWindowDays" INTEGER NOT NULL DEFAULT 30;
