import prisma from "../db.server";
import { notifyStatusChange } from "./notifications.server";
import { checkReturnEligibility } from "./policyEngine.server";
import { assertCanCreateReturn } from "./planGate.server";

export interface CreateExchangeRequestInput {
  shopifyStoreId: string;
  shopifyOrderId: string;
  orderNumber: string;
  customerEmail: string;
  customerName?: string;
  items: Array<{
    originalLineItemId: string;
    originalQuantity: number;
    originalPrice?: number;
    replacementVariantId: string;
    replacementQuantity: number;
    replacementPrice?: number;
    replacementTitle?: string;
    priceDifference?: number;
    sku?: string;
    category?: string;
  }>;
}

export async function createExchangeRequest(input: CreateExchangeRequestInput) {
  // Authoritative Server-Side PlanGate Usage Limit Check
  await assertCanCreateReturn(input.shopifyStoreId);

  // Authoritative Server-Side Return & Exchange Policy Check
  const eligibility = await checkReturnEligibility({
    shopifyStoreId: input.shopifyStoreId,
    orderId: input.shopifyOrderId,
    orderNumber: input.orderNumber,
    customerEmail: input.customerEmail,
    requestedItems: input.items.map((i) => ({
      shopifyLineItemId: i.originalLineItemId,
      quantity: i.originalQuantity,
      reason: "EXCHANGE",
      price: i.originalPrice || 0,
      sku: i.sku,
      category: i.category,
    })),
    requestType: "EXCHANGE",
  });

  if (!eligibility.eligible) {
    throw new Error(`Exchange Policy Rejection (${eligibility.reasonCode}): ${eligibility.message}`);
  }

  return await prisma.$transaction(async (tx) => {
    // 1. Create exchange request parent
    const exchangeRequest = await tx.exchangeRequest.create({
      data: {
        shopifyStoreId: input.shopifyStoreId,
        shopifyOrderId: input.shopifyOrderId,
        orderNumber: input.orderNumber,
        customerEmail: input.customerEmail,
        customerName: input.customerName,
        status: "PENDING",
      },
    });

    // 2. Create exchange items
    if (input.items && input.items.length > 0) {
      await tx.exchangeItem.createMany({
        data: input.items.map((item) => {
          const diff = item.priceDifference !== undefined
            ? item.priceDifference
            : ((item.replacementPrice || 0) * item.replacementQuantity) - ((item.originalPrice || 0) * item.originalQuantity);
          return {
            exchangeRequestId: exchangeRequest.id,
            originalLineItemId: item.originalLineItemId,
            originalQuantity: item.originalQuantity,
            replacementVariantId: item.replacementVariantId,
            replacementQuantity: item.replacementQuantity,
            replacementTitle: item.replacementTitle || "",
            priceDifference: diff,
          };
        }),
      });
    }

    // 3. Write audit log
    await tx.auditLog.create({
      data: {
        shopifyStoreId: input.shopifyStoreId,
        action: "EXCHANGE_CREATED",
        entityType: "ExchangeRequest",
        entityId: exchangeRequest.id,
        metadata: { orderNumber: input.orderNumber, itemCount: input.items.length },
      },
    });

    const createdExchange = await tx.exchangeRequest.findUnique({
      where: { id: exchangeRequest.id },
      include: { items: true },
    });

    if (!createdExchange) {
      throw new Error(`Exchange request ${exchangeRequest.id} could not be reloaded after creation`);
    }

    return createdExchange;
  });
}

export async function getExchangeRequests(shopifyStoreId: string) {
  return await prisma.exchangeRequest.findMany({
    where: { shopifyStoreId },
    include: { items: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function getExchangeRequestById(id: string, shopifyStoreId: string) {
  return await prisma.exchangeRequest.findFirst({
    where: { id, shopifyStoreId },
    include: { items: true },
  });
}

import { transitionExchangeStatus, ExchangeStatus } from "./stateMachine.server";

export async function updateExchangeStatus(
  id: string,
  shopifyStoreId: string,
  status: "PENDING" | "APPROVED" | "REJECTED" | "FULFILLED" | "COMPLETED" | "CANCELLED",
  newOrderId?: string,
  newOrderNumber?: string,
  userId?: string
) {
  return await transitionExchangeStatus({
    id,
    shopifyStoreId,
    targetStatus: status as ExchangeStatus,
    newOrderId,
    newOrderNumber,
    userId,
  });
}


/**
 * Approves an exchange and creates a real Shopify draft order for the
 * replacement item(s), so the merchant can send an invoice / collect any
 * balance owed and track fulfillment through Shopify.
 *
 * Falls back to a plain status update (no Shopify call) if admin is
 * unavailable — e.g. local SKIP_AUTH dev mode.
 */
export async function approveExchangeWithDraftOrder(
  admin: any,
  id: string,
  shopifyStoreId: string,
  userId?: string
) {
  return await transitionExchangeStatus({
    id,
    shopifyStoreId,
    targetStatus: "APPROVED",
    userId,
    admin,
  });
}
