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

  // A loadsheet is a courier handover manifest: only open forward parcels can be included.
  const requestedIds = Array.from(new Set(input.shipmentIds));
  const shipments = await prisma.shipmentTrack.findMany({
    where: {
      shopifyStoreId,
      id: { in: requestedIds },
      type: "FORWARD",
      loadsheetId: null,
      status: { notIn: ["CANCELLED", "FAILED", "DELIVERED"] },
    },
  });

  if (!shipments.length) {
    throw new Error("No eligible forward shipments found. Returns, exchanges, delivered parcels, and shipments already assigned to a loadsheet cannot be included.");
  }
  if (shipments.length !== requestedIds.length) {
    throw new Error("One or more selected shipments are no longer eligible for handover. Refresh the list and select only open forward parcels.");
  }
  const courierNames = Array.from(new Set(shipments.map((shipment) => shipment.courier.toUpperCase())));
  if (courierNames.length !== 1) {
    throw new Error("Create a separate loadsheet for each courier. The selected parcels contain more than one courier.");
  }

  // Use the courier stored on the shipments, never a stale booking dropdown value.
  const courierUpper = courierNames[0];
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
    type: "FORWARD",
    loadsheetId: null,
    status: { notIn: ["CANCELLED", "FAILED", "DELIVERED"] },
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
