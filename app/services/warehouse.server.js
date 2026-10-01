import prisma from "../db.server";
import { executeShopifyInventoryAdjust } from "./shopifySync.server";
import { transitionReturnStatus } from "./stateMachine.server";
import { enqueueJob } from "./jobs.server";
import { triggerLifecycleNotification } from "./notifications.server";

/**
 * Searches and validates inbound return shipments by scanned AWB tracking number.
 * Enforces strict tenant isolation and prevents cross-merchant scans or duplicate intake.
 */
export async function lookupInboundShipmentByAwb(shopifyStoreId, scannedAwb) {
  const normalizedAwb = scannedAwb.trim();

  if (!normalizedAwb) {
    throw new Error("Scanned AWB tracking number cannot be empty.");
  }

  // Cross-tenant check: verify tracking number does not belong to a different store
  const globalShipment = await prisma.shipmentTrack.findUnique({
    where: { trackingNumber: normalizedAwb },
  });

  if (globalShipment && globalShipment.shopifyStoreId !== shopifyStoreId) {
    throw new Error(
      `Cross-merchant shipment scan rejected: tracking number '${normalizedAwb}' belongs to a different merchant store.`,
    );
  }

  // Find shipment for current tenant
  let shipment = globalShipment;

  if (!shipment) {
    shipment = await prisma.shipmentTrack.findFirst({
      where: {
        shopifyStoreId,
        trackingNumber: { equals: normalizedAwb, mode: "insensitive" },
      },
    });
  }

  let returnRequest = null;

  if (shipment?.returnRequestId) {
    returnRequest = await prisma.returnRequest.findFirst({
      where: { id: shipment.returnRequestId, shopifyStoreId },
      include: { items: true },
    });
  }

  // Fallback lookup: if shipment tracking record not found directly, search ReturnRequest by orderNumber or ID
  if (!returnRequest) {
    const formattedOrderNumber = normalizedAwb.startsWith("#")
      ? normalizedAwb
      : `#${normalizedAwb}`;

    returnRequest = await prisma.returnRequest.findFirst({
      where: {
        shopifyStoreId,
        OR: [
          {
            orderNumber: { equals: formattedOrderNumber, mode: "insensitive" },
          },
          { id: normalizedAwb },
        ],
      },
      include: { items: true },
    });
  }

  if (!returnRequest) {
    return {
      found: false,
      alreadyReceived: false,
    };
  }

  // Check if warehouse intake was already completed for this return request / AWB
  const existingIntake = await prisma.warehouseIntake.findFirst({
    where: {
      shopifyStoreId,
      returnRequestId: returnRequest.id,
    },
  });
  // Query synced order line items to get item title & SKU details
  const syncedOrder = await prisma.order.findFirst({
    where: { shopifyStoreId, shopifyOrderId: returnRequest.shopifyOrderId },
  });
  const orderLineItemsMap = new Map();

  if (syncedOrder && Array.isArray(syncedOrder.lineItems)) {
    for (const li of syncedOrder.lineItems) {
      orderLineItemsMap.set(li.lineItemId, {
        title: li.title || "Returned Product",
        sku: li.sku || li.variantId || "N/A",
      });
    }
  }

  const items = returnRequest.items.map((item) => {
    const details = orderLineItemsMap.get(item.shopifyLineItemId) || {
      title: "Returned Product",
      sku: "N/A",
    };

    return {
      id: item.id,
      shopifyLineItemId: item.shopifyLineItemId,
      title: details.title,
      sku: details.sku,
      expectedQuantity: item.quantity,
      reason: item.reason,
    };
  });

  return {
    found: true,
    alreadyReceived: !!existingIntake,
    existingIntakeId: existingIntake?.id,
    shipment: shipment
      ? {
          id: shipment.id,
          courier: shipment.courier,
          trackingNumber: shipment.trackingNumber,
          status: shipment.status,
        }
      : {
          id: "virtual-shipment",
          courier: "STANDARD",
          trackingNumber: normalizedAwb,
          status: "LABEL_CREATED",
        },
    returnRequest: {
      id: returnRequest.id,
      orderNumber: returnRequest.orderNumber,
      customerName: returnRequest.customerName || "Customer",
      customerEmail: returnRequest.customerEmail,
      status: returnRequest.status,
      reason: returnRequest.reason || "Return Request",
      items,
    },
  };
}

/**
 * Processes warehouse intake & item condition inspection.
 * Idempotent, tenant-scoped, triggers inventory restocks for RESTOCKABLE items,
 * enqueues BackgroundJobs on inventory failure, and updates Return lifecycle.
 */
export async function processWarehouseIntake(input) {
  const {
    shopifyStoreId,
    returnRequestId,
    shipmentTrackId,
    scannedAwb,
    receivedByUserId,
    notes,
    admin,
    inspections,
  } = input;
  const returnRequest = await prisma.returnRequest.findFirst({
    where: { id: returnRequestId, shopifyStoreId },
    include: { items: true },
  });

  if (!returnRequest) {
    throw new Error(
      `Return request ${returnRequestId} not found for store ${shopifyStoreId}`,
    );
  }

  // Idempotency check: prevent duplicate receiving of the same package
  const existingIntake = await prisma.warehouseIntake.findFirst({
    where: {
      shopifyStoreId,
      returnRequestId,
    },
  });

  if (existingIntake) {
    console.log(
      `[Warehouse] Idempotent skip: Package intake already processed for Return ${returnRequestId} (Intake ID: ${existingIntake.id})`,
    );

    return {
      success: true,
      intakeId: existingIntake.id,
      returnStatus: returnRequest.status,
      idempotent: true,
    };
  }

  if (!inspections || inspections.length === 0) {
    throw new Error(
      "Cannot process warehouse intake without item inspection records.",
    );
  }

  // Execute database transaction to create WarehouseIntake & ItemInspection records
  const intakeResult = await prisma.$transaction(async (tx) => {
    const intake = await tx.warehouseIntake.create({
      data: {
        shopifyStoreId,
        returnRequestId,
        shipmentTrackId: shipmentTrackId || null,
        scannedAwb,
        receivedByUserId,
        status: "INSPECTED",
        notes,
      },
    });
    const createdInspections = [];

    for (const item of inspections) {
      const insp = await tx.itemInspection.create({
        data: {
          warehouseIntakeId: intake.id,
          returnItemId: item.returnItemId || null,
          shopifyLineItemId: item.shopifyLineItemId,
          title: item.title || "Returned Item",
          sku: item.sku || "N/A",
          expectedQuantity: item.expectedQuantity,
          receivedQuantity: item.receivedQuantity,
          condition: item.condition,
          inspectionNotes: item.inspectionNotes,
          restockedInShopify: false,
        },
      });

      createdInspections.push(insp);
    }

    if (shipmentTrackId && shipmentTrackId !== "virtual-shipment") {
      await tx.shipmentTrack.updateMany({
        where: { id: shipmentTrackId, shopifyStoreId },
        data: { status: "DELIVERED" },
      });
    }

    await tx.auditLog.create({
      data: {
        shopifyStoreId,
        userId: receivedByUserId,
        action: "WAREHOUSE_PACKAGE_RECEIVED",
        entityType: "WarehouseIntake",
        entityId: intake.id,
        metadata: {
          scannedAwb,
          returnRequestId,
          inspectedItemCount: inspections.length,
        },
      },
    });

    return { intake, inspections: createdInspections };
  });
  // Handle inventory restocks for items marked RESTOCKABLE
  const restockableItems = inspections.filter(
    (i) => i.condition === "RESTOCKABLE" && i.receivedQuantity > 0,
  );
  let inventoryRestocked = false;

  if (restockableItems.length > 0) {
    try {
      await executeShopifyInventoryAdjust({
        shopifyStoreId,
        entityId: returnRequestId,
        admin,
      });
      inventoryRestocked = true;
      await prisma.itemInspection.updateMany({
        where: {
          warehouseIntakeId: intakeResult.intake.id,
          condition: "RESTOCKABLE",
        },
        data: { restockedInShopify: true },
      });
    } catch (err) {
      console.error(
        `[Warehouse] Live inventory restock failed for Return ${returnRequestId}:`,
        err?.message || err,
      );
      // Enqueue retryable background job for inventory adjustment failure
      await enqueueJob({
        shopifyStoreId,
        type: "SHOPIFY_INVENTORY_ADJUST",
        payload: { returnRequestId },
      });
    }
  }

  // Update Return Request lifecycle to COMPLETED via central state machine
  const updatedReturn = await transitionReturnStatus({
    id: returnRequestId,
    shopifyStoreId,
    targetStatus: "COMPLETED",
    userId: receivedByUserId,
    admin,
  });

  await prisma.auditLog.create({
    data: {
      shopifyStoreId,
      userId: receivedByUserId,
      action: "WAREHOUSE_INSPECTION_COMPLETED",
      entityType: "ReturnRequest",
      entityId: returnRequestId,
      metadata: {
        intakeId: intakeResult.intake.id,
        inventoryRestocked,
        finalStatus: updatedReturn.status,
      },
    },
  });
  // Trigger non-blocking RETURN_RECEIVED & INSPECTION_COMPLETED notifications
  await triggerLifecycleNotification({
    shopifyStoreId,
    eventType: "RETURN_RECEIVED",
    entityId: intakeResult.intake.id,
    recipientEmail: updatedReturn.customerEmail,
    variables: {
      customer_name: updatedReturn.customerName || "Customer",
      order_number: updatedReturn.orderNumber,
    },
  });
  await triggerLifecycleNotification({
    shopifyStoreId,
    eventType: "INSPECTION_COMPLETED",
    entityId: `${intakeResult.intake.id}_inspected`,
    recipientEmail: updatedReturn.customerEmail,
    variables: {
      customer_name: updatedReturn.customerName || "Customer",
      order_number: updatedReturn.orderNumber,
      condition: inspections[0]?.condition || "RESTOCKABLE",
    },
  });

  return {
    success: true,
    intakeId: intakeResult.intake.id,
    returnStatus: updatedReturn.status,
    inventoryRestocked,
    idempotent: false,
  };
}

/**
 * Fetches historical warehouse intake records for a tenant.
 */
export async function getWarehouseIntakes(shopifyStoreId, limit = 50) {
  return await prisma.warehouseIntake.findMany({
    where: { shopifyStoreId },
    include: {
      inspections: true,
      returnRequest: true,
      shipmentTrack: true,
    },
    orderBy: { receivedAt: "desc" },
    take: limit,
  });
}
