import prisma from "../db.server";
import { logAction } from "./audit.server";

export interface CreateLoadsheetInput {
  courier: string;
  shipmentIds: string[];
  riderName?: string;
  riderPhone?: string;
  notes?: string;
}

/**
 * Generates an official courier loadsheet manifest for rider pickup handover
 */
export async function createLoadsheet(
  shopifyStoreId: string,
  userId: string | undefined,
  input: CreateLoadsheetInput,
) {
  if (!input.shipmentIds.length) {
    throw new Error("Select at least one booked shipment to generate a loadsheet.");
  }

  const courierUpper = input.courier.trim().toUpperCase();

  // Load selected shipments
  const shipments = await prisma.shipmentTrack.findMany({
    where: {
      shopifyStoreId,
      id: { in: input.shipmentIds },
    },
  });

  if (!shipments.length) {
    throw new Error("No matching shipments found.");
  }

  const totalCod = shipments.reduce((sum, s) => sum + Number(s.codAmount || 0), 0);
  const parcelCount = shipments.length;

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const randomSuffix = Math.floor(100 + Math.random() * 900);
  const loadsheetNumber = `LS-${courierUpper}-${dateStr}-${randomSuffix}`;

  return await prisma.$transaction(async (tx) => {
    const loadsheet = await tx.loadsheet.create({
      data: {
        shopifyStoreId,
        loadsheetNumber,
        courier: courierUpper,
        parcelCount,
        totalCodAmount: totalCod.toFixed(2),
        status: "GENERATED",
        riderName: input.riderName?.trim() || undefined,
        riderPhone: input.riderPhone?.trim() || undefined,
        notes: input.notes?.trim() || undefined,
      },
    });

    await tx.shipmentTrack.updateMany({
      where: {
        id: { in: shipments.map((s) => s.id) },
        shopifyStoreId,
      },
      data: {
        loadsheetId: loadsheet.id,
      },
    });

    await logAction({
      shopifyStoreId,
      userId,
      action: "LOADSHEET_CREATED",
      entityType: "Loadsheet",
      entityId: loadsheet.id,
      metadata: {
        loadsheetNumber,
        courier: courierUpper,
        parcelCount,
        totalCod,
      },
    });

    return loadsheet;
  });
}

/**
 * Fetches booked shipments that haven't been attached to a loadsheet yet
 */
export async function getUnassignedBookedShipments(shopifyStoreId: string, courier?: string) {
  const where: any = {
    shopifyStoreId,
    loadsheetId: null,
    status: { notIn: ["CANCELLED"] },
  };

  if (courier && courier !== "ALL") {
    where.courier = courier.toUpperCase();
  }

  return prisma.shipmentTrack.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

/**
 * Lists past loadsheets
 */
export async function listLoadsheets(shopifyStoreId: string, courier?: string) {
  const where: any = { shopifyStoreId };
  if (courier && courier !== "ALL") {
    where.courier = courier.toUpperCase();
  }

  return prisma.loadsheet.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      _count: {
        select: { shipments: true },
      },
    },
    take: 50,
  });
}

/**
 * Fetches full loadsheet details with all attached shipments for printing
 */
export async function getLoadsheetDetails(shopifyStoreId: string, loadsheetId: string) {
  return prisma.loadsheet.findFirst({
    where: { id: loadsheetId, shopifyStoreId },
    include: {
      shipments: {
        orderBy: { createdAt: "asc" },
      },
      shopifyStore: {
        select: {
          shop: true,
          storeSettings: true,
        },
      },
    },
  });
}
