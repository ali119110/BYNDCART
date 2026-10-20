import prisma from "../db.server";
import { notifyStatusChange, triggerLifecycleNotification } from "./notifications.server";
import { checkReturnEligibility } from "./policyEngine.server";
import { getSettings } from "./settings.server";
import { transitionReturnStatus, type ReturnStatus } from "./stateMachine.server";

export interface CreateReturnRequestInput {
  shopifyStoreId: string;
  shopifyOrderId: string;
  orderNumber: string;
  customerEmail: string;
  customerName?: string;
  reason?: string;
  customerNote?: string;
  adminNote?: string;
  refundAmount?: number;
  requestSource?: "CUSTOMER" | "MERCHANT";
  policyOverrideReason?: string;
  items: Array<{
    shopifyLineItemId: string;
    quantity: number;
    reason: string;
    reasonNote?: string;
  }>;
}

/** Creates a tenant-scoped, item-validated request and records every override. */
export async function createReturnRequest(input: CreateReturnRequestInput) {
  const source = input.requestSource || "CUSTOMER";
  const overrideReason = String(input.policyOverrideReason || "").trim();
  if (!Array.isArray(input.items) || !input.items.length) throw new Error("Select at least one item.");

  const order = await prisma.order.findFirst({
    where: { shopifyStoreId: input.shopifyStoreId, shopifyOrderId: input.shopifyOrderId },
  });
  if (!order) throw new Error("The selected Shopify order could not be found for this store. Sync the order and try again.");

  const snapshotLines = Array.isArray(order.lineItems) ? order.lineItems as any[] : [];
  const seen = new Set<string>();
  const normalizedItems = input.items.map((item) => {
    const lineId = String(item.shopifyLineItemId || "").trim();
    const line = snapshotLines.find((candidate: any) => String(candidate.lineItemId) === lineId);
    const quantity = Number(item.quantity);
    if (!lineId || !line) throw new Error("A selected item does not belong to this Shopify order.");
    if (seen.has(lineId)) throw new Error("Each Shopify line item may only appear once in a request. Combine duplicate quantities.");
    seen.add(lineId);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > Number(line.quantity || 0)) {
      throw new Error(`Invalid quantity for ${line.title || "selected item"}. Quantity must be between 1 and the original order quantity.`);
    }
    return {
      shopifyLineItemId: lineId,
      quantity,
      reason: String(item.reason || input.reason || "CUSTOMER_REQUEST").slice(0, 120),
      reasonNote: item.reasonNote ? String(item.reasonNote).slice(0, 1000) : undefined,
      unitPrice: Number(line.price || 0),
    };
  });

  const eligibility = await checkReturnEligibility({
    shopifyStoreId: input.shopifyStoreId,
    orderId: order.shopifyOrderId,
    orderNumber: order.orderNumber,
    customerEmail: String(order.customerEmail || input.customerEmail).trim().toLowerCase(),
    requestedItems: normalizedItems.map((item) => ({ shopifyLineItemId: item.shopifyLineItemId, quantity: item.quantity, reason: item.reason, price: item.unitPrice })),
    requestType: "RETURN",
  });
  if (!eligibility.eligible && source !== "MERCHANT") {
    throw new Error(`Policy Rejection (${eligibility.reasonCode}): ${eligibility.message}`);
  }
  if (!eligibility.eligible && overrideReason.length < 5) {
    throw new Error(`Policy Rejection (${eligibility.reasonCode}): ${eligibility.message} A merchant policy-override reason is required to proceed.`);
  }

  const settings = await getSettings(input.shopifyStoreId);
  const grossItemValue = normalizedItems.reduce((total, item) => total + item.unitPrice * item.quantity, 0);
  const fee = grossItemValue * Number(settings.restockingFeePercent || 0) / 100;
  const calculatedRefund = Math.max(0, Number((grossItemValue - fee).toFixed(2)));
  let refundAmount = calculatedRefund;
  if (input.refundAmount !== undefined && source === "MERCHANT") {
    const requestedRefund = Number(input.refundAmount);
    if (!Number.isFinite(requestedRefund) || requestedRefund < 0 || requestedRefund > grossItemValue) {
      throw new Error(`Refund amount must be between 0 and the selected items' value (${grossItemValue.toFixed(2)}).`);
    }
    refundAmount = Number(requestedRefund.toFixed(2));
  }

  const created = await prisma.$transaction(async (tx) => {
    // Lock this tenant-scoped original order so two simultaneous submissions
    // cannot both pass the same remaining-quantity check under READ COMMITTED.
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "shopifyStoreId" = ${input.shopifyStoreId} AND "shopifyOrderId" = ${order.shopifyOrderId} FOR UPDATE`;
    // A merchant policy override never permits requesting an already-requested
    // quantity of the same original line item.
    for (const selected of normalizedItems) {
      const sourceLine = snapshotLines.find((line: any) => String(line.lineItemId) === selected.shopifyLineItemId);
      const [priorReturns, priorExchanges] = await Promise.all([
        tx.returnRequest.findMany({
          where: { shopifyStoreId: input.shopifyStoreId, shopifyOrderId: order.shopifyOrderId, status: { notIn: ["CANCELLED", "REJECTED"] } },
          include: { items: { where: { shopifyLineItemId: selected.shopifyLineItemId } } },
        }),
        tx.exchangeRequest.findMany({
          where: { shopifyStoreId: input.shopifyStoreId, shopifyOrderId: order.shopifyOrderId, status: { notIn: ["CANCELLED", "REJECTED"] } },
          include: { items: { where: { originalLineItemId: selected.shopifyLineItemId } } },
        }),
      ]);
      const alreadyUsed = priorReturns.reduce((total: number, row: any) => total + row.items.reduce((sum: number, item: any) => sum + Number(item.quantity || 0), 0), 0)
        + priorExchanges.reduce((total: number, row: any) => total + row.items.reduce((sum: number, item: any) => sum + Number(item.originalQuantity || 0), 0), 0);
      const remaining = Math.max(0, Number(sourceLine?.quantity || 0) - alreadyUsed);
      if (selected.quantity > remaining) {
        throw new Error(`This item already has a return/exchange request. Only ${remaining} unit(s) remain available; duplicate quantities cannot be overridden.`);
      }
    }

    const request = await tx.returnRequest.create({
      data: {
        shopifyStoreId: input.shopifyStoreId,
        shopifyOrderId: order.shopifyOrderId,
        orderNumber: order.orderNumber,
        customerEmail: order.customerEmail || input.customerEmail,
        customerName: order.customerName || input.customerName,
        reason: input.reason || normalizedItems[0]?.reason || "Customer request",
        customerNote: input.customerNote,
        adminNote: input.adminNote,
        requestSource: source,
        policyOverrideReason: !eligibility.eligible ? overrideReason : null,
        refundAmount,
        status: "PENDING",
        items: {
          create: normalizedItems.map((item) => ({
            shopifyLineItemId: item.shopifyLineItemId,
            quantity: item.quantity,
            reason: item.reason,
            reasonNote: item.reasonNote,
            status: "PENDING",
          })),
        },
      },
      include: { items: true },
    });
    await tx.auditLog.create({
      data: {
        shopifyStoreId: input.shopifyStoreId,
        action: "RETURN_CREATED",
        entityType: "ReturnRequest",
        entityId: request.id,
        metadata: {
          orderNumber: order.orderNumber,
          itemCount: normalizedItems.length,
          requestSource: source,
          requestedItemQuantities: normalizedItems.map(({ shopifyLineItemId, quantity }) => ({ shopifyLineItemId, quantity })),
          policyEligible: eligibility.eligible,
        },
      },
    });
    if (!eligibility.eligible) {
      await tx.auditLog.create({
        data: {
          shopifyStoreId: input.shopifyStoreId,
          action: "RETURN_POLICY_OVERRIDE",
          entityType: "ReturnRequest",
          entityId: request.id,
          metadata: { reason: overrideReason, policyReasonCode: eligibility.reasonCode, policyMessage: eligibility.message, userSource: source },
        },
      });
    }
    return request;
  });

  await Promise.all([
    triggerLifecycleNotification({
      shopifyStoreId: input.shopifyStoreId,
      eventType: "RETURN_SUBMITTED",
      entityId: created.id,
      recipientEmail: created.customerEmail,
      variables: { customer_name: created.customerName || "Customer", order_number: created.orderNumber, status: "PENDING" },
    }),
    notifyStatusChange({ shopifyStoreId: input.shopifyStoreId, entity: "RETURN REQUEST", orderNumber: created.orderNumber, previousStatus: "NEW", newStatus: "PENDING", adminNote: "New return request submitted" }),
  ]);
  return created;
}

export async function getReturnRequests(shopifyStoreId: string) {
  const requests = await prisma.returnRequest.findMany({
    where: { shopifyStoreId },
    include: { items: true },
    orderBy: { createdAt: "desc" },
  });
  const ids = requests.map((request) => request.id);
  const audit = ids.length ? await prisma.auditLog.findMany({
    where: { shopifyStoreId, entityType: "ReturnRequest", entityId: { in: ids } },
    orderBy: { createdAt: "asc" },
  }) : [];
  const auditById = new Map<string, any[]>();
  for (const entry of audit) {
    if (!entry.entityId) continue;
    if (!auditById.has(entry.entityId)) auditById.set(entry.entityId, []);
    auditById.get(entry.entityId)!.push(entry);
  }
  return requests.map((request) => ({ ...request, auditHistory: auditById.get(request.id) || [] }));
}

export async function getReturnRequestById(id: string, shopifyStoreId: string) {
  return await prisma.returnRequest.findFirst({ where: { id, shopifyStoreId }, include: { items: true } });
}

export async function updateReturnRequestStatus(
  id: string,
  shopifyStoreId: string,
  status: ReturnStatus,
  adminNote?: string,
  userId?: string,
  admin?: any,
) {
  return await transitionReturnStatus({ id, shopifyStoreId, targetStatus: status, adminNote, userId, admin });
}
