import prisma from "../db.server";
import {
  transitionReturnStatus,
  transitionExchangeStatus,
} from "./stateMachine.server";
import { getSettings } from "./settings.server";
import { executeShopifyInventoryAdjust } from "./shopifySync.server";

/**
 * Records physical warehouse receipt. The warehouse scan is database-only:
 * this function never calls a courier API or creates a courier booking.
 */
export async function receiveInboundRequest(input) {
  const scannedAwb = String(input.scannedAwb || "")
    .trim()
    .slice(0, 120);

  if (scannedAwb.length < 3)
    throw new Error("Scan or enter the carrier tracking number / airway bill.");
  const request =
    input.requestType === "RETURN"
      ? await prisma.returnRequest.findFirst({
          where: { id: input.requestId, shopifyStoreId: input.shopifyStoreId },
          include: { items: true },
        })
      : await prisma.exchangeRequest.findFirst({
          where: { id: input.requestId, shopifyStoreId: input.shopifyStoreId },
          include: { items: true },
        });

  if (!request)
    throw new Error(
      `${input.requestType.toLowerCase()} request was not found for this store.`,
    );
  const duplicateAwb = await prisma.warehouseIntake.findFirst({
    where: { shopifyStoreId: input.shopifyStoreId, scannedAwb },
  });

  if (duplicateAwb) {
    const sameRequest =
      input.requestType === "RETURN"
        ? duplicateAwb.returnRequestId === input.requestId
        : duplicateAwb.exchangeRequestId === input.requestId;

    if (sameRequest)
      return { success: true, idempotent: true, intake: duplicateAwb };
    throw new Error(
      "This airway bill has already been scanned for another request in this store.",
    );
  }

  if (request.status !== "APPROVED")
    throw new Error(
      `Only an approved ${input.requestType.toLowerCase()} can be received. Current status: ${request.status}.`,
    );
  let shipment = await prisma.shipmentTrack.findFirst({
    where:
      input.requestType === "RETURN"
        ? {
            shopifyStoreId: input.shopifyStoreId,
            returnRequestId: input.requestId,
            trackingNumber: scannedAwb,
          }
        : {
            shopifyStoreId: input.shopifyStoreId,
            exchangeRequestId: input.requestId,
            trackingNumber: scannedAwb,
          },
  });

  // Warehouse may receive a parcel even if the customer did not submit tracking.
  // Keep the scanned airway bill without contacting any carrier.
  if (!shipment) {
    shipment = await prisma.shipmentTrack.create({
      data: {
        shopifyStoreId: input.shopifyStoreId,
        shopifyOrderId: request.shopifyOrderId,
        orderNumber: request.orderNumber,
        type: input.requestType,
        courier: "MANUAL",
        trackingNumber: scannedAwb,
        status: "DELIVERED",
        returnRequestId:
          input.requestType === "RETURN" ? input.requestId : null,
        exchangeRequestId:
          input.requestType === "EXCHANGE" ? input.requestId : null,
      },
    });
  } else if (shipment.status !== "DELIVERED") {
    shipment = await prisma.shipmentTrack.update({
      where: { id: shipment.id },
      data: { status: "DELIVERED", location: "Warehouse received" },
    });
  }

  // Record the physical arrival regardless of whether tracking was entered by
  // the customer earlier or scanned for the first time at the warehouse.
  const arrivalEvent = await prisma.shipmentEvent.findFirst({
    where: { shipmentTrackId: shipment.id, status: "DELIVERED" },
  });

  if (!arrivalEvent) {
    await prisma.shipmentEvent.create({
      data: {
        shipmentTrackId: shipment.id,
        status: "DELIVERED",
        description:
          "Warehouse received parcel by physical scan; no carrier API was used.",
      },
    });
  }

  const intake = await prisma.warehouseIntake.create({
    data: {
      shopifyStoreId: input.shopifyStoreId,
      shipmentTrackId: shipment.id,
      returnRequestId: input.requestType === "RETURN" ? input.requestId : null,
      exchangeRequestId:
        input.requestType === "EXCHANGE" ? input.requestId : null,
      scannedAwb,
      receivedByUserId: input.receivedByUserId || null,
      status: "RECEIVED",
      notes: input.notes || null,
    },
    include: { inspections: true },
  });

  await prisma.auditLog.create({
    data: {
      shopifyStoreId: input.shopifyStoreId,
      action: `${input.requestType}_WAREHOUSE_RECEIVED`,
      entityType:
        input.requestType === "RETURN" ? "ReturnRequest" : "ExchangeRequest",
      entityId: input.requestId,
      userId: input.receivedByUserId || undefined,
      metadata: {
        intakeId: intake.id,
        scannedAwb,
        shipmentTrackId: shipment.id,
      },
    },
  });
  const updated =
    input.requestType === "RETURN"
      ? await transitionReturnStatus({
          id: input.requestId,
          shopifyStoreId: input.shopifyStoreId,
          targetStatus: "RECEIVED",
          userId: input.receivedByUserId,
        })
      : await transitionExchangeStatus({
          id: input.requestId,
          shopifyStoreId: input.shopifyStoreId,
          targetStatus: "RECEIVED",
          userId: input.receivedByUserId,
        });

  return { success: true, idempotent: false, intake, request: updated };
}

/**
 * Saves a complete, item-by-item inspection. Every requested original line item
 * must appear once; requested quantities and line item IDs are server-validated.
 */
export async function completeWarehouseInspection(input) {
  const intake = await prisma.warehouseIntake.findFirst({
    where: { id: input.intakeId, shopifyStoreId: input.shopifyStoreId },
    include: { inspections: true },
  });

  if (!intake) throw new Error("Warehouse intake not found for this store.");
  if (intake.status === "INSPECTED")
    return { success: true, idempotent: true, intake };
  if (intake.status !== "RECEIVED")
    throw new Error(
      `Only a received package can be inspected (current status: ${intake.status}).`,
    );
  const requestType = intake.returnRequestId ? "RETURN" : "EXCHANGE";
  const requestId = intake.returnRequestId || intake.exchangeRequestId;

  if (!requestId)
    throw new Error(
      "Warehouse intake is not linked to a return or exchange request.",
    );
  const request =
    requestType === "RETURN"
      ? await prisma.returnRequest.findFirst({
          where: { id: requestId, shopifyStoreId: input.shopifyStoreId },
          include: { items: true },
        })
      : await prisma.exchangeRequest.findFirst({
          where: { id: requestId, shopifyStoreId: input.shopifyStoreId },
          include: { items: true },
        });

  if (!request)
    throw new Error("Linked return/exchange request was not found.");
  if (request.status !== "RECEIVED")
    throw new Error(
      `The request must be at warehouse-received status before inspection (current status: ${request.status}).`,
    );
  const settings =
    requestType === "RETURN" ? await getSettings(input.shopifyStoreId) : null;
  const requestItems = request.items;
  const itemByLineId = new Map(
    requestItems.map((item) => [
      requestType === "RETURN"
        ? item.shopifyLineItemId
        : item.originalLineItemId,
      item,
    ]),
  );
  const suppliedIds = new Set();
  const inspections = input.items.map((item) => {
    const lineId = String(item.shopifyLineItemId || "").trim();
    const requestItem = itemByLineId.get(lineId);

    if (!requestItem)
      throw new Error(
        `Line item ${lineId || "(empty)"} is not part of this request.`,
      );
    if (suppliedIds.has(lineId))
      throw new Error(`Line item ${lineId} was inspected more than once.`);
    suppliedIds.add(lineId);
    const expectedQuantity =
      requestType === "RETURN"
        ? Number(requestItem.quantity)
        : Number(requestItem.originalQuantity);
    const receivedQuantity = Number(item.receivedQuantity);

    if (
      !Number.isInteger(receivedQuantity) ||
      receivedQuantity < 0 ||
      receivedQuantity > expectedQuantity
    )
      throw new Error(
        `Received quantity for ${lineId} must be between 0 and ${expectedQuantity}.`,
      );
    const allowed = [
      "RESTOCKABLE",
      "DAMAGED",
      "DEFECTIVE",
      "WRONG_ITEM",
      "MISSING_ITEM",
      "DISCARD",
    ];

    if (!allowed.includes(item.condition))
      throw new Error(`Invalid inspection condition for ${lineId}.`);

    return {
      requestItem,
      lineId,
      expectedQuantity,
      receivedQuantity,
      condition: item.condition,
      notes: String(item.inspectionNotes || "").slice(0, 2000),
      sku: item.sku ? String(item.sku).slice(0, 120) : null,
      title: item.title ? String(item.title).slice(0, 250) : null,
    };
  });

  if (
    suppliedIds.size !== requestItems.length ||
    requestItems.some(
      (item) =>
        !suppliedIds.has(
          requestType === "RETURN"
            ? item.shopifyLineItemId
            : item.originalLineItemId,
        ),
    )
  ) {
    throw new Error(
      "Submit an inspection result for every item in this request before completing inspection.",
    );
  }

  await prisma.$transaction(async (tx) => {
    for (const inspection of inspections) {
      await tx.itemInspection.create({
        data: {
          warehouseIntakeId: intake.id,
          returnItemId:
            requestType === "RETURN" ? inspection.requestItem.id : null,
          exchangeItemId:
            requestType === "EXCHANGE" ? inspection.requestItem.id : null,
          shopifyLineItemId: inspection.lineId,
          title:
            inspection.title || inspection.requestItem.replacementTitle || null,
          sku: inspection.sku,
          expectedQuantity: inspection.expectedQuantity,
          receivedQuantity: inspection.receivedQuantity,
          condition: inspection.condition,
          inspectionNotes: inspection.notes || null,
        },
      });

      if (requestType === "RETURN") {
        await tx.returnItem.update({
          where: { id: inspection.requestItem.id },
          data: { status: "INSPECTED" },
        });
      } else {
        await tx.exchangeItem.update({
          where: { id: inspection.requestItem.id },
          data: { status: "INSPECTED" },
        });
      }
    }

    await tx.warehouseIntake.update({
      where: { id: intake.id },
      data: {
        status: "INSPECTED",
        notes: [intake.notes, input.notes].filter(Boolean).join("\n") || null,
      },
    });
    await tx.auditLog.create({
      data: {
        shopifyStoreId: input.shopifyStoreId,
        action: `${requestType}_WAREHOUSE_INSPECTION_COMPLETED`,
        entityType:
          requestType === "RETURN" ? "ReturnRequest" : "ExchangeRequest",
        entityId: requestId,
        userId: input.inspectedByUserId || undefined,
        metadata: {
          intakeId: intake.id,
          items: inspections.map((row) => ({
            lineItemId: row.lineId,
            expectedQuantity: row.expectedQuantity,
            receivedQuantity: row.receivedQuantity,
            condition: row.condition,
            notes: row.notes,
          })),
        },
      },
    });

    if (requestType === "RETURN") {
      const order = await tx.order.findFirst({
        where: {
          shopifyStoreId: input.shopifyStoreId,
          shopifyOrderId: request.shopifyOrderId,
        },
      });
      const orderLines = Array.isArray(order?.lineItems) ? order.lineItems : [];
      const valueForReceivedItems = inspections.reduce((sum, row) => {
        const orderLine = orderLines.find(
          (line) => String(line.lineItemId) === row.lineId,
        );

        return (
          sum +
          Math.max(0, Number(orderLine?.price || 0)) * row.receivedQuantity
        );
      }, 0);
      const fee =
        (valueForReceivedItems * Number(settings?.restockingFeePercent || 0)) /
        100;
      const calculatedRefund = Math.max(
        0,
        Number((valueForReceivedItems - fee).toFixed(2)),
      );

      await tx.returnRequest.update({
        where: { id: requestId },
        data: {
          refundAmount: calculatedRefund,
          inspectionCompletedAt: new Date(),
        },
      });
    } else {
      await tx.exchangeRequest.update({
        where: { id: requestId },
        data: { inspectionCompletedAt: new Date() },
      });
    }
  });
  const updatedRequest =
    requestType === "RETURN"
      ? await transitionReturnStatus({
          id: requestId,
          shopifyStoreId: input.shopifyStoreId,
          targetStatus: "INSPECTED",
          userId: input.inspectedByUserId,
        })
      : await transitionExchangeStatus({
          id: requestId,
          shopifyStoreId: input.shopifyStoreId,
          targetStatus: "INSPECTED",
          userId: input.inspectedByUserId,
        });

  // Only RESTOCKABLE quantities are eligible for stock adjustment. The sync
  // helper resolves Shopify InventoryItem IDs; it must never use LineItem IDs.
  if (
    requestType === "RETURN" &&
    inspections.some(
      (row) => row.condition === "RESTOCKABLE" && row.receivedQuantity > 0,
    )
  ) {
    try {
      const restock = await executeShopifyInventoryAdjust({
        shopifyStoreId: input.shopifyStoreId,
        entityId: requestId,
      });

      if (!restock?.success) {
        await prisma.auditLog.create({
          data: {
            shopifyStoreId: input.shopifyStoreId,
            action: "SHOPIFY_INVENTORY_RESTOCK_FAILED",
            entityType: "ReturnRequest",
            entityId: requestId,
            metadata: {
              reason: restock?.reason || "Shopify restock was not confirmed",
            },
          },
        });
      }
    } catch (error) {
      await prisma.auditLog.create({
        data: {
          shopifyStoreId: input.shopifyStoreId,
          action: "SHOPIFY_INVENTORY_RESTOCK_FAILED",
          entityType: "ReturnRequest",
          entityId: requestId,
          metadata: { error: String(error?.message || error) },
        },
      });
      console.error(
        "[Warehouse] Inspection is complete, but Shopify restock failed:",
        error,
      );
    }
  }

  const refreshedIntake = await prisma.warehouseIntake.findFirst({
    where: { id: intake.id, shopifyStoreId: input.shopifyStoreId },
    include: { inspections: true },
  });

  return {
    success: true,
    idempotent: false,
    intake: refreshedIntake,
    request: updatedRequest,
  };
}
