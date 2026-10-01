import prisma from "../db.server";
import {
  notifyStatusChange,
  triggerLifecycleNotification,
} from "./notifications.server";

const ALLOWED_RETURN_TRANSITIONS = {
  PENDING: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["COMPLETED", "CANCELLED"],
  REJECTED: [],
  COMPLETED: [],
  CANCELLED: [],
};
const ALLOWED_EXCHANGE_TRANSITIONS = {
  PENDING: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["FULFILLED", "COMPLETED", "CANCELLED"],
  FULFILLED: ["COMPLETED", "CANCELLED"],
  REJECTED: [],
  COMPLETED: [],
  CANCELLED: [],
};

import {
  executeShopifyReturnCreate,
  executeShopifyRefundCreate,
  executeShopifyInventoryAdjust,
  executeShopifyDraftOrderCreate,
} from "./shopifySync.server";
import { enqueueJob } from "./jobs.server";
import { registerShipmentTrack } from "./shipments.server";

/**
 * Authoritative state machine transition service for Return Requests.
 */
export async function transitionReturnStatus({
  id,
  shopifyStoreId,
  targetStatus,
  adminNote,
  userId,
  admin,
}) {
  const result = await prisma.$transaction(async (tx) => {
    const returnRequest = await tx.returnRequest.findFirst({
      where: { id, shopifyStoreId },
    });

    if (!returnRequest) {
      throw new Error(
        `Return request ${id} not found for store ${shopifyStoreId}`,
      );
    }

    const currentStatus = returnRequest.status;

    // Idempotency check: if already at target status, return existing record
    if (currentStatus === targetStatus) {
      return {
        updated: returnRequest,
        previousStatus: currentStatus,
        idempotent: true,
      };
    }

    // Validate state machine graph transition
    const allowed = ALLOWED_RETURN_TRANSITIONS[currentStatus] || [];

    if (!allowed.includes(targetStatus)) {
      throw new Error(
        `Invalid return status transition: cannot move from '${currentStatus}' to '${targetStatus}'. Allowed transitions: [${allowed.join(", ")}]`,
      );
    }

    const updated = await tx.returnRequest.update({
      where: { id },
      data: {
        status: targetStatus,
        adminNote:
          adminNote !== undefined ? adminNote : returnRequest.adminNote,
      },
      include: { items: true },
    });

    // Synchronize return item statuses based on parent status
    if (targetStatus === "APPROVED") {
      await tx.returnItem.updateMany({
        where: { returnRequestId: id },
        data: { status: "PENDING" },
      });
    } else if (targetStatus === "COMPLETED") {
      await tx.returnItem.updateMany({
        where: { returnRequestId: id },
        data: { status: "RECEIVED" },
      });
    } else if (targetStatus === "REJECTED") {
      await tx.returnItem.updateMany({
        where: { returnRequestId: id },
        data: { status: "REJECTED" },
      });
    }

    // Record authoritative audit log entry
    await tx.auditLog.create({
      data: {
        shopifyStoreId,
        userId,
        action: `RETURN_STATUS_TRANSITION_${targetStatus}`,
        entityType: "ReturnRequest",
        entityId: id,
        metadata: {
          previousStatus: currentStatus,
          newStatus: targetStatus,
          adminNote,
        },
      },
    });

    return { updated, previousStatus: currentStatus, idempotent: false };
  });

  if (!result.idempotent) {
    // Synchronize live Shopify operations asynchronously or enqueuing background job on failure
    if (targetStatus === "APPROVED") {
      try {
        await executeShopifyReturnCreate({
          shopifyStoreId,
          entityId: id,
          admin,
        });
      } catch (err) {
        console.error(
          `[StateMachine] Return ${id} returnCreate error:`,
          err?.message || err,
        );

        // If Shopify userErrors error, rethrow so merchant caller sees exact error; otherwise enqueue background retry job
        if (err?.message?.includes("userErrors")) {
          throw err;
        }

        await enqueueJob({
          shopifyStoreId,
          type: "SHOPIFY_RETURN_CREATE",
          payload: { returnRequestId: id },
        });
      }
    } else if (targetStatus === "COMPLETED") {
      try {
        await executeShopifyRefundCreate({
          shopifyStoreId,
          entityId: id,
          admin,
        });
      } catch (err) {
        console.error(
          `[StateMachine] Return ${id} refundCreate error:`,
          err?.message || err,
        );

        if (err?.message?.includes("userErrors")) {
          throw err;
        }

        await enqueueJob({
          shopifyStoreId,
          type: "SHOPIFY_REFUND_CREATE",
          payload: { returnRequestId: id },
        });
      }

      try {
        await executeShopifyInventoryAdjust({
          shopifyStoreId,
          entityId: id,
          admin,
        });
      } catch (err) {
        console.error(
          `[StateMachine] Return ${id} inventoryAdjust error:`,
          err?.message || err,
        );

        if (err?.message?.includes("userErrors")) {
          throw err;
        }

        await enqueueJob({
          shopifyStoreId,
          type: "SHOPIFY_INVENTORY_ADJUST",
          payload: { returnRequestId: id },
        });
      }
    }

    await notifyStatusChange({
      shopifyStoreId,
      entity: "RETURN",
      entityId: id,
      orderNumber: result.updated.orderNumber,
      customerEmail: result.updated.customerEmail,
      previousStatus: result.previousStatus,
      newStatus: targetStatus,
    });

    // Lifecycle Notifications dispatch
    if (targetStatus === "APPROVED") {
      await triggerLifecycleNotification({
        shopifyStoreId,
        eventType: "RETURN_APPROVED",
        entityId: id,
        recipientEmail: result.updated.customerEmail,
        variables: {
          customer_name: result.updated.customerName || "Customer",
          order_number: result.updated.orderNumber,
          status: targetStatus,
        },
      });
    } else if (targetStatus === "REJECTED") {
      await triggerLifecycleNotification({
        shopifyStoreId,
        eventType: "RETURN_REJECTED",
        entityId: id,
        recipientEmail: result.updated.customerEmail,
        variables: {
          customer_name: result.updated.customerName || "Customer",
          order_number: result.updated.orderNumber,
          reason: adminNote || result.updated.reason || "Policy non-compliance",
        },
      });
    } else if (targetStatus === "COMPLETED") {
      await triggerLifecycleNotification({
        shopifyStoreId,
        eventType: "REFUND_INITIATED",
        entityId: id,
        recipientEmail: result.updated.customerEmail,
        variables: {
          customer_name: result.updated.customerName || "Customer",
          order_number: result.updated.orderNumber,
          refund_amount: result.updated.refundAmount
            ? Number(result.updated.refundAmount)
            : 0,
        },
      });
      await triggerLifecycleNotification({
        shopifyStoreId,
        eventType: "LIFECYCLE_COMPLETED",
        entityId: `${id}_completed`,
        recipientEmail: result.updated.customerEmail,
        variables: {
          customer_name: result.updated.customerName || "Customer",
          order_number: result.updated.orderNumber,
        },
      });
    }
  }

  return result.updated;
}

/**
 * Authoritative state machine transition service for Exchange Requests.
 */
export async function transitionExchangeStatus({
  id,
  shopifyStoreId,
  targetStatus,
  newOrderId,
  newOrderNumber,
  userId,
  admin,
}) {
  const result = await prisma.$transaction(async (tx) => {
    const exchangeRequest = await tx.exchangeRequest.findFirst({
      where: { id, shopifyStoreId },
    });

    if (!exchangeRequest) {
      throw new Error(
        `Exchange request ${id} not found for store ${shopifyStoreId}`,
      );
    }

    const currentStatus = exchangeRequest.status;

    // Idempotency check: if already at target status, return existing record
    if (currentStatus === targetStatus) {
      return {
        updated: exchangeRequest,
        previousStatus: currentStatus,
        idempotent: true,
      };
    }

    // Validate state machine graph transition
    const allowed = ALLOWED_EXCHANGE_TRANSITIONS[currentStatus] || [];

    if (!allowed.includes(targetStatus)) {
      throw new Error(
        `Invalid exchange status transition: cannot move from '${currentStatus}' to '${targetStatus}'. Allowed transitions: [${allowed.join(", ")}]`,
      );
    }

    const updated = await tx.exchangeRequest.update({
      where: { id },
      data: {
        status: targetStatus,
        newOrderId: newOrderId || exchangeRequest.newOrderId,
        newOrderNumber: newOrderNumber || exchangeRequest.newOrderNumber,
      },
      include: { items: true },
    });

    // Record authoritative audit log entry
    await tx.auditLog.create({
      data: {
        shopifyStoreId,
        userId,
        action: `EXCHANGE_STATUS_TRANSITION_${targetStatus}`,
        entityType: "ExchangeRequest",
        entityId: id,
        metadata: {
          previousStatus: currentStatus,
          newStatus: targetStatus,
          newOrderId,
          newOrderNumber,
        },
      },
    });

    return { updated, previousStatus: currentStatus, idempotent: false };
  });

  if (!result.idempotent) {
    if (targetStatus === "APPROVED") {
      try {
        await executeShopifyDraftOrderCreate({
          shopifyStoreId,
          entityId: id,
          admin,
        });
      } catch (err) {
        console.error(
          `[StateMachine] Exchange ${id} draftOrderCreate error:`,
          err?.message || err,
        );

        if (err?.message?.includes("userErrors")) {
          throw err;
        }

        await enqueueJob({
          shopifyStoreId,
          type: "SHOPIFY_DRAFT_ORDER_CREATE",
          payload: { exchangeRequestId: id },
        });
      }

      // Register outbound forward replacement shipment
      try {
        await registerShipmentTrack({
          shopifyStoreId,
          orderId: result.updated.shopifyOrderId,
          orderNumber: result.updated.orderNumber,
          customerName: result.updated.customerName || undefined,
          customerEmail: result.updated.customerEmail,
          type: "FORWARD",
          exchangeRequestId: id,
        });
      } catch (err) {
        console.error(
          `[StateMachine] Forward shipment registration error for Exchange ${id}:`,
          err?.message || err,
        );
      }
    }

    await notifyStatusChange({
      shopifyStoreId,
      entity: "EXCHANGE",
      entityId: id,
      orderNumber: result.updated.orderNumber,
      customerEmail: result.updated.customerEmail,
      previousStatus: result.previousStatus,
      newStatus: targetStatus,
      extra: result.updated.newOrderNumber
        ? { draftOrderNumber: result.updated.newOrderNumber }
        : undefined,
    });

    if (targetStatus === "APPROVED") {
      await triggerLifecycleNotification({
        shopifyStoreId,
        eventType: "EXCHANGE_APPROVED",
        entityId: id,
        recipientEmail: result.updated.customerEmail,
        variables: {
          customer_name: result.updated.customerName || "Customer",
          order_number: result.updated.orderNumber,
          replacement_order: result.updated.newOrderNumber || "Pending",
        },
      });
    } else if (targetStatus === "FULFILLED") {
      await triggerLifecycleNotification({
        shopifyStoreId,
        eventType: "REPLACEMENT_CREATED",
        entityId: `${id}_fulfilled`,
        recipientEmail: result.updated.customerEmail,
        variables: {
          customer_name: result.updated.customerName || "Customer",
          order_number: result.updated.orderNumber,
          replacement_order: result.updated.newOrderNumber || "Fulfilled",
        },
      });
    } else if (targetStatus === "COMPLETED") {
      await triggerLifecycleNotification({
        shopifyStoreId,
        eventType: "REPLACEMENT_DELIVERED",
        entityId: `${id}_delivered`,
        recipientEmail: result.updated.customerEmail,
        variables: {
          customer_name: result.updated.customerName || "Customer",
          order_number: result.updated.orderNumber,
          replacement_order: result.updated.newOrderNumber || "Delivered",
        },
      });
      await triggerLifecycleNotification({
        shopifyStoreId,
        eventType: "LIFECYCLE_COMPLETED",
        entityId: `${id}_completed`,
        recipientEmail: result.updated.customerEmail,
        variables: {
          customer_name: result.updated.customerName || "Customer",
          order_number: result.updated.orderNumber,
        },
      });
    }
  }

  return result.updated;
}
