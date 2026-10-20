import prisma from "../db.server";
import { notifyStatusChange, triggerLifecycleNotification } from "./notifications.server";
import {
  executeShopifyOrderTagAdd,
  executeShopifyRefundCreate,
  executeShopifyDraftOrderCreate,
} from "./shopifySync.server";
import { enqueueJob } from "./jobs.server";
import { getSettings } from "./settings.server";

export type ReturnStatus = "PENDING" | "APPROVED" | "REJECTED" | "RECEIVED" | "INSPECTED" | "REFUND_PENDING" | "COMPLETED" | "CANCELLED";
export type ExchangeStatus = "PENDING" | "APPROVED" | "REJECTED" | "RECEIVED" | "INSPECTED" | "FULFILLED" | "COMPLETED" | "CANCELLED";

const ALLOWED_RETURN_TRANSITIONS: Record<ReturnStatus, ReturnStatus[]> = {
  PENDING: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["RECEIVED", "CANCELLED"],
  RECEIVED: ["INSPECTED", "CANCELLED"],
  INSPECTED: ["REFUND_PENDING", "CANCELLED"],
  REFUND_PENDING: ["COMPLETED", "CANCELLED"],
  REJECTED: [],
  COMPLETED: [],
  CANCELLED: [],
};

const ALLOWED_EXCHANGE_TRANSITIONS: Record<ExchangeStatus, ExchangeStatus[]> = {
  PENDING: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["RECEIVED", "CANCELLED"],
  RECEIVED: ["INSPECTED", "CANCELLED"],
  INSPECTED: ["FULFILLED", "COMPLETED", "CANCELLED"],
  FULFILLED: ["COMPLETED", "CANCELLED"],
  REJECTED: [],
  COMPLETED: [],
  CANCELLED: [],
};

export interface TransitionReturnInput {
  id: string;
  shopifyStoreId: string;
  targetStatus: ReturnStatus;
  adminNote?: string;
  userId?: string;
  admin?: any;
}

export interface TransitionExchangeInput {
  id: string;
  shopifyStoreId: string;
  targetStatus: ExchangeStatus;
  newOrderId?: string;
  newOrderNumber?: string;
  userId?: string;
  admin?: any;
  adminNote?: string;
}

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
}: TransitionReturnInput) {
  const result = await prisma.$transaction(async (tx) => {
    const returnRequest = await tx.returnRequest.findFirst({
      where: { id, shopifyStoreId },
    });

    if (!returnRequest) {
      throw new Error(`Return request ${id} not found for store ${shopifyStoreId}`);
    }

    const currentStatus = returnRequest.status as ReturnStatus;

    // Idempotency check: if already at target status, return existing record
    if (currentStatus === targetStatus) {
      return { updated: returnRequest, previousStatus: currentStatus, idempotent: true };
    }

    // Validate state machine graph transition
    const allowed = ALLOWED_RETURN_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(targetStatus)) {
      throw new Error(
        `Invalid return status transition: cannot move from '${currentStatus}' to '${targetStatus}'. Allowed transitions: [${allowed.join(", ")}]`
      );
    }

    if (targetStatus === "RECEIVED" || targetStatus === "INSPECTED") {
      const intake = await tx.warehouseIntake.findFirst({
        where: { shopifyStoreId, returnRequestId: id, status: targetStatus === "RECEIVED" ? { in: ["RECEIVED", "INSPECTED"] } : "INSPECTED" },
        include: { inspections: true },
        orderBy: { receivedAt: "desc" },
      });
      if (!intake) throw new Error(targetStatus === "RECEIVED"
        ? "Record warehouse receipt before advancing this return."
        : "Complete the warehouse inspection before advancing this return.");
      if (targetStatus === "INSPECTED") {
        const inspectedLineIds = new Set(intake.inspections.map((inspection: any) => inspection.shopifyLineItemId));
        const missing = await tx.returnItem.findMany({ where: { returnRequestId: id } });
        if (missing.some((item: any) => !inspectedLineIds.has(item.shopifyLineItemId))) {
          throw new Error("Every requested return item must be inspected before refund processing.");
        }
      }
    }

    if (targetStatus === "COMPLETED" && !returnRequest.shopifyRefundId && currentStatus === "REFUND_PENDING" && !String(adminNote || "").trim()) {
      throw new Error("Add the manual refund reference or a short confirmation note before marking this return completed.");
    }

    const updated = await tx.returnRequest.update({
      where: { id },
      data: {
        status: targetStatus,
        adminNote: adminNote !== undefined ? adminNote : returnRequest.adminNote,
        inspectionCompletedAt: targetStatus === "INSPECTED" ? new Date() : returnRequest.inspectionCompletedAt,
      },
      include: { items: true },
    });

    // Synchronize return item statuses based on parent status
    if (targetStatus === "APPROVED") {
      await tx.returnItem.updateMany({ where: { returnRequestId: id }, data: { status: "PENDING" } });
    } else if (targetStatus === "RECEIVED") {
      await tx.returnItem.updateMany({ where: { returnRequestId: id }, data: { status: "RECEIVED" } });
    } else if (targetStatus === "INSPECTED") {
      await tx.returnItem.updateMany({ where: { returnRequestId: id }, data: { status: "INSPECTED" } });
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
    let finalStatus = targetStatus;

    // Approval only tags the order. It intentionally does NOT create a Shopify
    // Return object: tags and Shopify Return objects are different resources.
    if (targetStatus === "APPROVED") {
      try {
        const tagResult = await executeShopifyOrderTagAdd({
          shopifyStoreId,
          orderId: result.updated.shopifyOrderId,
          tags: ["return-in-progress", `byndcart-return-${id}`],
          entityId: id,
          admin,
        });
        if (!tagResult?.success) {
          await prisma.auditLog.create({ data: { shopifyStoreId, action: "SHOPIFY_ORDER_TAG_ADD_SKIPPED", entityType: "ReturnRequest", entityId: id, metadata: { orderId: result.updated.shopifyOrderId, reason: tagResult?.reason || "Shopify Admin client unavailable" } } });
        }
      } catch (err: any) {
        console.error(`[StateMachine] Failed to tag order for Return ${id}:`, err?.message || err);
        await prisma.auditLog.create({ data: { shopifyStoreId, action: "SHOPIFY_ORDER_TAG_ADD_FAILED", entityType: "ReturnRequest", entityId: id, metadata: { orderId: result.updated.shopifyOrderId, tags: ["return-in-progress", `byndcart-return-${id}`], error: String(err?.message || err) } } });
      }
    }

    // Inspection is the gate for any refund. In Shopify API mode BYNDCART
    // attempts refundCreate; otherwise it creates a pending manual RefundRecord.
    if (targetStatus === "INSPECTED") {
      const settings = await getSettings(shopifyStoreId, admin);
      const linkedOrder = await prisma.order.findFirst({
        where: { shopifyStoreId, shopifyOrderId: result.updated.shopifyOrderId },
        select: { currency: true },
      });
      const refundCurrency = linkedOrder?.currency || "USD";
      const amount = Math.max(0, Number(result.updated.refundAmount || 0));
      if (settings.refundExecutionMode === "SHOPIFY_API") {
        try {
          const refundResult = await executeShopifyRefundCreate({ shopifyStoreId, entityId: id, admin });
          if (refundResult?.success && !refundResult?.skipped) {
            await prisma.refundRecord.create({
              data: { shopifyStoreId, returnRequestId: id, method: "SHOPIFY", amount, currency: refundCurrency, status: "CONFIRMED", reference: refundResult.shopifyRefundId || undefined, reason: "Warehouse inspection completed; Shopify refund created", confirmedAt: new Date() },
            });
            await prisma.returnRequest.update({ where: { id }, data: { status: "COMPLETED" } });
            await prisma.auditLog.create({ data: { shopifyStoreId, action: "RETURN_SHOPIFY_REFUND_COMPLETED", entityType: "ReturnRequest", entityId: id, metadata: { refundAmount: amount, shopifyRefundId: refundResult.shopifyRefundId } } });
            finalStatus = "COMPLETED";
          } else {
            throw new Error(refundResult?.reason || "Shopify Admin client was unavailable; refund was not executed.");
          }
        } catch (err: any) {
          console.error(`[StateMachine] Shopify refund failed for Return ${id}:`, err?.message || err);
          await prisma.refundRecord.create({
            data: { shopifyStoreId, returnRequestId: id, method: "SHOPIFY", amount, currency: refundCurrency, status: "FAILED", reason: "Shopify API refund failed", notes: String(err?.message || err) },
          });
          await prisma.returnRequest.update({ where: { id }, data: { status: "REFUND_PENDING", adminNote: [result.updated.adminNote, `Shopify refund failed: ${String(err?.message || err)}`].filter(Boolean).join("\n") } });
          await prisma.auditLog.create({ data: { shopifyStoreId, action: "RETURN_REFUND_FALLBACK_TO_MANUAL", entityType: "ReturnRequest", entityId: id, metadata: { error: String(err?.message || err), refundAmount: amount } } });
          finalStatus = "REFUND_PENDING";
        }
      } else {
        const existingPending = await prisma.refundRecord.findFirst({ where: { shopifyStoreId, returnRequestId: id, status: "PENDING" } });
        if (!existingPending) {
          await prisma.refundRecord.create({ data: { shopifyStoreId, returnRequestId: id, method: "MANUAL", amount, currency: refundCurrency, status: "PENDING", reason: "Warehouse inspection completed; awaiting merchant refund confirmation" } });
        }
        await prisma.returnRequest.update({ where: { id }, data: { status: "REFUND_PENDING" } });
        await prisma.auditLog.create({ data: { shopifyStoreId, action: "RETURN_MANUAL_REFUND_PENDING", entityType: "ReturnRequest", entityId: id, metadata: { refundAmount: amount } } });
        finalStatus = "REFUND_PENDING";
      }
    }

    // Mark a manual refund as confirmed only after an explicit merchant status action.
    if (targetStatus === "COMPLETED" && !result.updated.shopifyRefundId) {
      const pendingRefund = await prisma.refundRecord.findFirst({ where: { shopifyStoreId, returnRequestId: id, status: "PENDING" }, orderBy: { createdAt: "desc" } });
      if (pendingRefund) {
        await prisma.refundRecord.update({ where: { id: pendingRefund.id }, data: { status: "CONFIRMED", method: "MANUAL", reference: String(adminNote || "").trim().slice(0, 200) || null, notes: "Merchant confirmed a manual refund", confirmedAt: new Date() } });
      } else {
        const orderCurrency = await prisma.order.findFirst({ where: { shopifyStoreId, shopifyOrderId: result.updated.shopifyOrderId }, select: { currency: true } });
        await prisma.refundRecord.create({ data: { shopifyStoreId, returnRequestId: id, method: "MANUAL", amount: Math.max(0, Number(result.updated.refundAmount || 0)), currency: orderCurrency?.currency || "USD", status: "CONFIRMED", reason: "Merchant confirmed manual refund", notes: String(adminNote || "").trim(), reference: String(adminNote || "").trim().slice(0, 200) || null, confirmedAt: new Date() } });
      }
    }

    await notifyStatusChange({
      shopifyStoreId,
      entity: "RETURN",
      entityId: id,
      orderNumber: result.updated.orderNumber,
      customerEmail: result.updated.customerEmail,
      previousStatus: result.previousStatus,
      newStatus: finalStatus,
    });

    if (targetStatus === "APPROVED") {
      await triggerLifecycleNotification({ shopifyStoreId, eventType: "RETURN_APPROVED", entityId: id, recipientEmail: result.updated.customerEmail, variables: { customer_name: result.updated.customerName || "Customer", order_number: result.updated.orderNumber, status: "APPROVED" } });
    } else if (targetStatus === "REJECTED") {
      await triggerLifecycleNotification({ shopifyStoreId, eventType: "RETURN_REJECTED", entityId: id, recipientEmail: result.updated.customerEmail, variables: { customer_name: result.updated.customerName || "Customer", order_number: result.updated.orderNumber, reason: adminNote || result.updated.reason || "Policy non-compliance" } });
    } else if (targetStatus === "RECEIVED") {
      await triggerLifecycleNotification({ shopifyStoreId, eventType: "RETURN_RECEIVED", entityId: id, recipientEmail: result.updated.customerEmail, variables: { customer_name: result.updated.customerName || "Customer", order_number: result.updated.orderNumber } });
    } else if (targetStatus === "INSPECTED") {
      await triggerLifecycleNotification({ shopifyStoreId, eventType: "INSPECTION_COMPLETED", entityId: id, recipientEmail: result.updated.customerEmail, variables: { customer_name: result.updated.customerName || "Customer", order_number: result.updated.orderNumber, condition: "Inspection completed" } });
      if (finalStatus === "COMPLETED") {
        await triggerLifecycleNotification({ shopifyStoreId, eventType: "REFUND_INITIATED", entityId: id, recipientEmail: result.updated.customerEmail, variables: { customer_name: result.updated.customerName || "Customer", order_number: result.updated.orderNumber, refund_amount: amountForNotification(result.updated.refundAmount), refund_currency: (await prisma.order.findFirst({ where: { shopifyStoreId, shopifyOrderId: result.updated.shopifyOrderId }, select: { currency: true } }))?.currency || "USD" } });
      }
    } else if (targetStatus === "COMPLETED") {
      await triggerLifecycleNotification({ shopifyStoreId, eventType: "REFUND_INITIATED", entityId: id, recipientEmail: result.updated.customerEmail, variables: { customer_name: result.updated.customerName || "Customer", order_number: result.updated.orderNumber, refund_amount: amountForNotification(result.updated.refundAmount), refund_currency: (await prisma.order.findFirst({ where: { shopifyStoreId, shopifyOrderId: result.updated.shopifyOrderId }, select: { currency: true } }))?.currency || "USD" } });
      await triggerLifecycleNotification({ shopifyStoreId, eventType: "LIFECYCLE_COMPLETED", entityId: `${id}_completed`, recipientEmail: result.updated.customerEmail, variables: { customer_name: result.updated.customerName || "Customer", order_number: result.updated.orderNumber } });
    }

    if (finalStatus !== result.updated.status) {
      result.updated = await prisma.returnRequest.findFirst({ where: { id, shopifyStoreId }, include: { items: true } }) as any;
    }
  }

  return result.updated;
}


function amountForNotification(amount: any) {
  return amount === null || amount === undefined ? "0.00" : Number(amount).toFixed(2);
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
  adminNote,
}: TransitionExchangeInput) {
  const result = await prisma.$transaction(async (tx) => {
    const exchangeRequest = await tx.exchangeRequest.findFirst({
      where: { id, shopifyStoreId },
    });

    if (!exchangeRequest) {
      throw new Error(`Exchange request ${id} not found for store ${shopifyStoreId}`);
    }

    const currentStatus = exchangeRequest.status as ExchangeStatus;

    // Idempotency check: if already at target status, return existing record
    if (currentStatus === targetStatus) {
      return { updated: exchangeRequest, previousStatus: currentStatus, idempotent: true };
    }

    // Validate state machine graph transition
    const allowed = ALLOWED_EXCHANGE_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(targetStatus)) {
      throw new Error(
        `Invalid exchange status transition: cannot move from '${currentStatus}' to '${targetStatus}'. Allowed transitions: [${allowed.join(", ")}]`
      );
    }
    if (targetStatus === "COMPLETED" && !String(adminNote || "").trim()) {
      throw new Error("Add a delivery confirmation note before marking the replacement as delivered.");
    }

    if (targetStatus === "RECEIVED" || targetStatus === "INSPECTED") {
      const intake = await tx.warehouseIntake.findFirst({
        where: { shopifyStoreId, exchangeRequestId: id, status: targetStatus === "RECEIVED" ? { in: ["RECEIVED", "INSPECTED"] } : "INSPECTED" },
        include: { inspections: true },
        orderBy: { receivedAt: "desc" },
      });
      if (!intake) throw new Error(targetStatus === "RECEIVED"
        ? "Record warehouse receipt before advancing this exchange."
        : "Complete the warehouse inspection before advancing this exchange.");
      if (targetStatus === "INSPECTED") {
        const inspectedItemIds = new Set(intake.inspections.map((inspection: any) => inspection.exchangeItemId).filter(Boolean));
        const exchangeItems = await tx.exchangeItem.findMany({ where: { exchangeRequestId: id } });
        if (exchangeItems.some((item: any) => !inspectedItemIds.has(item.id))) throw new Error("Every original exchange item must be inspected before creating the replacement order.");
      }
    }

    const updated = await tx.exchangeRequest.update({
      where: { id },
      data: {
        status: targetStatus,
        newOrderId: newOrderId || exchangeRequest.newOrderId,
        newOrderNumber: newOrderNumber || exchangeRequest.newOrderNumber,
        adminNote: adminNote !== undefined ? adminNote : exchangeRequest.adminNote,
        inspectionCompletedAt: targetStatus === "INSPECTED" ? new Date() : exchangeRequest.inspectionCompletedAt,
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
          adminNote,
        },
      },
    });

    return { updated, previousStatus: currentStatus, idempotent: false };
  });

  if (!result.idempotent) {
    const settings = (targetStatus === "APPROVED" || targetStatus === "INSPECTED")
      ? await getSettings(shopifyStoreId, admin)
      : null;
    const linkedOrderId = String(result.updated.newOrderId || "");
    const hasActualReplacementOrder = linkedOrderId.startsWith("gid://shopify/Order/");
    const hasIncompleteReplacementDraft = linkedOrderId.startsWith("gid://shopify/DraftOrder/");
    const shouldCreateReplacement = targetStatus === "APPROVED"
      ? settings?.exchangeReplacementTiming === "AFTER_APPROVAL"
      : targetStatus === "INSPECTED" && (settings?.exchangeReplacementTiming === "AFTER_INSPECTION" || hasIncompleteReplacementDraft);

    if (shouldCreateReplacement && !hasActualReplacementOrder) {
      try {
        const replacement = await executeShopifyDraftOrderCreate({ shopifyStoreId, entityId: id, admin });
        if (replacement?.success && !replacement?.skipped) {
          result.updated.newOrderId = replacement.replacementOrderId || replacement.draftOrderId || null;
          result.updated.newOrderNumber = replacement.replacementOrderNumber || replacement.draftOrderName || null;
        }
      } catch (err: any) {
        console.error(`[StateMachine] Exchange ${id} replacement order creation failed:`, err?.message || err);
        if (err?.message?.includes("userErrors")) throw err;
        await enqueueJob({ shopifyStoreId, type: "SHOPIFY_DRAFT_ORDER_CREATE", payload: { exchangeRequestId: id } });
      }
    }

    // Once inspection is complete, an already-created (AFTER_APPROVAL) or new
    // (AFTER_INSPECTION) replacement enters FULFILLED processing.
    if (targetStatus === "INSPECTED" && String(result.updated.newOrderId || "").startsWith("gid://shopify/Order/")) {
      await prisma.exchangeRequest.update({ where: { id, shopifyStoreId }, data: { status: "FULFILLED" } });
      await prisma.auditLog.create({ data: {
        shopifyStoreId,
        action: "EXCHANGE_STATUS_TRANSITION_FULFILLED",
        entityType: "ExchangeRequest",
        entityId: id,
        userId,
        metadata: { previousStatus: "INSPECTED", newStatus: "FULFILLED", newOrderId: result.updated.newOrderId, newOrderNumber: result.updated.newOrderNumber },
      } });
      result.updated.status = "FULFILLED";
    }

    await notifyStatusChange({
      shopifyStoreId,
      entity: "EXCHANGE",
      entityId: id,
      orderNumber: result.updated.orderNumber,
      customerEmail: result.updated.customerEmail,
      previousStatus: result.previousStatus,
      newStatus: result.updated.status,
      extra: result.updated.newOrderNumber
        ? { draftOrderNumber: result.updated.newOrderNumber }
        : undefined,
    });

    if (targetStatus === "RECEIVED") {
      await triggerLifecycleNotification({ shopifyStoreId, eventType: "EXCHANGE_RECEIVED", entityId: id, recipientEmail: result.updated.customerEmail, variables: { customer_name: result.updated.customerName || "Customer", order_number: result.updated.orderNumber } });
    } else if (targetStatus === "INSPECTED") {
      await triggerLifecycleNotification({ shopifyStoreId, eventType: "EXCHANGE_INSPECTION_COMPLETED", entityId: id, recipientEmail: result.updated.customerEmail, variables: { customer_name: result.updated.customerName || "Customer", order_number: result.updated.orderNumber, condition: "Inspection completed" } });
    }

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
    } else if (targetStatus === "FULFILLED" || (targetStatus === "INSPECTED" && result.updated.status === "FULFILLED")) {
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
