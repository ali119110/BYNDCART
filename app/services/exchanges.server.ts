import prisma from "../db.server";
import { notifyStatusChange, triggerLifecycleNotification } from "./notifications.server";
import { checkReturnEligibility } from "./policyEngine.server";
import { assertCanCreateReturn } from "./planGate.server";
import { transitionExchangeStatus, type ExchangeStatus } from "./stateMachine.server";

export interface CreateExchangeRequestInput {
  shopifyStoreId: string;
  shopifyOrderId: string;
  orderNumber: string;
  customerEmail: string;
  customerName?: string;
  reason?: string;
  customerNote?: string;
  adminNote?: string;
  requestSource?: "CUSTOMER" | "MERCHANT";
  policyOverrideReason?: string;
  items: Array<{
    originalLineItemId: string;
    originalQuantity: number;
    replacementVariantId: string;
    replacementQuantity: number;
    // Accepted for backwards compatibility but never trusted for calculation.
    originalPrice?: number;
    replacementPrice?: number;
    replacementTitle?: string;
    priceDifference?: number;
    sku?: string;
    category?: string;
  }>;
}

/** Creates a pending exchange request; approval and replacement order creation are separate lifecycle steps. */
export async function createExchangeRequest(input: CreateExchangeRequestInput) {
  await assertCanCreateReturn(input.shopifyStoreId);
  const source = input.requestSource || "CUSTOMER";
  const overrideReason = String(input.policyOverrideReason || "").trim();
  if (!Array.isArray(input.items) || input.items.length === 0) throw new Error("At least one exchange item must be selected.");

  const order = await prisma.order.findFirst({ where: { shopifyStoreId: input.shopifyStoreId, shopifyOrderId: input.shopifyOrderId } });
  if (!order) throw new Error("Original Shopify order was not found for this store. Sync the order and try again.");
  const orderLines = Array.isArray(order.lineItems) ? order.lineItems as any[] : [];
  const seen = new Set<string>();
  const variantIds = [...new Set(input.items.map((item) => String(item.replacementVariantId || "")))];
  if (variantIds.some((id) => !id.startsWith("gid://shopify/ProductVariant/"))) throw new Error("Each replacement item must use a valid Shopify product variant.");
  const variants = await prisma.productCache.findMany({ where: { shopifyStoreId: input.shopifyStoreId, shopifyVariantId: { in: variantIds } } });
  const variantsById = new Map(variants.map((variant: any) => [variant.shopifyVariantId, variant]));

  const normalizedItems = input.items.map((item) => {
    const originalLineItemId = String(item.originalLineItemId || "").trim();
    const original = orderLines.find((line: any) => String(line.lineItemId) === originalLineItemId);
    const replacement = variantsById.get(String(item.replacementVariantId));
    const originalQuantity = Number(item.originalQuantity);
    const replacementQuantity = Number(item.replacementQuantity);
    if (!original || !originalLineItemId) throw new Error("An original exchange item does not belong to the selected order.");
    if (seen.has(originalLineItemId)) throw new Error("Each original line item can appear only once in an exchange request.");
    seen.add(originalLineItemId);
    if (!Number.isInteger(originalQuantity) || originalQuantity < 1 || originalQuantity > Number(original.quantity || 0)) throw new Error(`Invalid exchange quantity for ${original.title || "item"}.`);
    if (!Number.isInteger(replacementQuantity) || replacementQuantity < 1) throw new Error("Replacement quantity must be a positive whole number.");
    if (!replacement) throw new Error(`Replacement variant ${item.replacementVariantId} is missing from this store's product cache. Sync products and try again.`);
    const originalUnitPrice = Number(original.price || 0);
    const replacementUnitPrice = Number(replacement.price || 0);
    return {
      originalLineItemId,
      originalQuantity,
      replacementVariantId: replacement.shopifyVariantId,
      replacementQuantity,
      replacementTitle: [replacement.title, replacement.variantTitle].filter(Boolean).join(" - "),
      priceDifference: Number((replacementUnitPrice * replacementQuantity - originalUnitPrice * originalQuantity).toFixed(2)),
      originalUnitPrice,
      productId: original.productId,
      variantId: original.variantId,
      sku: replacement.sku,
    };
  });

  const eligibility = await checkReturnEligibility({
    shopifyStoreId: input.shopifyStoreId,
    orderId: order.shopifyOrderId,
    orderNumber: order.orderNumber,
    customerEmail: String(order.customerEmail || input.customerEmail).trim().toLowerCase(),
    requestedItems: normalizedItems.map((item) => ({ shopifyLineItemId: item.originalLineItemId, quantity: item.originalQuantity, reason: "EXCHANGE", price: item.originalUnitPrice, productId: item.productId, variantId: item.variantId })),
    requestType: "EXCHANGE",
  });
  if (!eligibility.eligible && source !== "MERCHANT") throw new Error(`Exchange policy rejection (${eligibility.reasonCode}): ${eligibility.message}`);
  if (!eligibility.eligible && overrideReason.length < 5) throw new Error(`Exchange policy rejection (${eligibility.reasonCode}): ${eligibility.message} Provide a policy override reason of at least five characters.`);

  const created = await prisma.$transaction(async (tx) => {
    // Lock this tenant-scoped original order so two simultaneous submissions
    // cannot both pass the same remaining-quantity check under READ COMMITTED.
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "shopifyStoreId" = ${input.shopifyStoreId} AND "shopifyOrderId" = ${order.shopifyOrderId} FOR UPDATE`;
    // Hard duplicate guard: unlike normal eligibility policy, same line-item
    // quantities cannot be overridden by a merchant policy exception.
    for (const selected of normalizedItems) {
      const sourceLine = orderLines.find((line: any) => String(line.lineItemId) === selected.originalLineItemId);
      const [priorReturns, priorExchanges] = await Promise.all([
        tx.returnRequest.findMany({
          where: { shopifyStoreId: input.shopifyStoreId, shopifyOrderId: order.shopifyOrderId, status: { notIn: ["CANCELLED", "REJECTED"] } },
          include: { items: { where: { shopifyLineItemId: selected.originalLineItemId } } },
        }),
        tx.exchangeRequest.findMany({
          where: { shopifyStoreId: input.shopifyStoreId, shopifyOrderId: order.shopifyOrderId, status: { notIn: ["CANCELLED", "REJECTED"] } },
          include: { items: { where: { originalLineItemId: selected.originalLineItemId } } },
        }),
      ]);
      const alreadyUsed = priorReturns.reduce((total: number, row: any) => total + row.items.reduce((sum: number, item: any) => sum + Number(item.quantity || 0), 0), 0)
        + priorExchanges.reduce((total: number, row: any) => total + row.items.reduce((sum: number, item: any) => sum + Number(item.originalQuantity || 0), 0), 0);
      const remaining = Math.max(0, Number(sourceLine?.quantity || 0) - alreadyUsed);
      if (selected.originalQuantity > remaining) {
        throw new Error(`This item already has a return/exchange request. Only ${remaining} unit(s) remain available; duplicate quantities cannot be overridden.`);
      }
    }

    const request = await tx.exchangeRequest.create({
      data: {
        shopifyStoreId: input.shopifyStoreId,
        shopifyOrderId: order.shopifyOrderId,
        orderNumber: order.orderNumber,
        customerEmail: order.customerEmail || input.customerEmail,
        customerName: order.customerName || input.customerName,
        status: "PENDING",
        reason: input.reason || null,
        customerNote: input.customerNote || null,
        adminNote: input.adminNote || null,
        requestSource: source,
        policyOverrideReason: !eligibility.eligible ? overrideReason : null,
        items: {
          create: normalizedItems.map((item) => ({
            originalLineItemId: item.originalLineItemId,
            originalQuantity: item.originalQuantity,
            replacementVariantId: item.replacementVariantId,
            replacementQuantity: item.replacementQuantity,
            replacementTitle: item.replacementTitle,
            priceDifference: item.priceDifference,
            status: "PENDING",
          })),
        },
      },
      include: { items: true },
    });
    await tx.auditLog.create({
      data: { shopifyStoreId: input.shopifyStoreId, action: "EXCHANGE_CREATED", entityType: "ExchangeRequest", entityId: request.id, metadata: { orderNumber: order.orderNumber, itemCount: normalizedItems.length, requestSource: source, policyEligible: eligibility.eligible } },
    });
    if (!eligibility.eligible) {
      await tx.auditLog.create({ data: { shopifyStoreId: input.shopifyStoreId, action: "EXCHANGE_POLICY_OVERRIDE", entityType: "ExchangeRequest", entityId: request.id, metadata: { reason: overrideReason, policyReasonCode: eligibility.reasonCode, policyMessage: eligibility.message, userSource: source } } });
    }
    return request;
  });

  await Promise.all([
    triggerLifecycleNotification({ shopifyStoreId: input.shopifyStoreId, eventType: "EXCHANGE_SUBMITTED", entityId: created.id, recipientEmail: created.customerEmail, variables: { customer_name: created.customerName || "Customer", order_number: created.orderNumber, status: "PENDING" } }),
    notifyStatusChange({ shopifyStoreId: input.shopifyStoreId, entity: "EXCHANGE REQUEST", orderNumber: created.orderNumber, previousStatus: "NEW", newStatus: "PENDING", adminNote: "New exchange request submitted" }),
  ]);
  return created;
}

export async function getExchangeRequests(shopifyStoreId: string) {
  const requests = await prisma.exchangeRequest.findMany({ where: { shopifyStoreId }, include: { items: true }, orderBy: { createdAt: "desc" } });
  const ids = requests.map((request) => request.id);
  const originalOrderIds = [...new Set(requests.map((request) => request.shopifyOrderId))];
  const linkedOrders = originalOrderIds.length ? await prisma.order.findMany({ where: { shopifyStoreId, shopifyOrderId: { in: originalOrderIds } }, select: { shopifyOrderId: true, currency: true } }) : [];
  const currencyByOrderId = new Map(linkedOrders.map((order) => [order.shopifyOrderId, order.currency]));
  const audit = ids.length ? await prisma.auditLog.findMany({ where: { shopifyStoreId, entityType: "ExchangeRequest", entityId: { in: ids } }, orderBy: { createdAt: "asc" } }) : [];
  const auditById = new Map<string, any[]>();
  for (const entry of audit) {
    if (!entry.entityId) continue;
    if (!auditById.has(entry.entityId)) auditById.set(entry.entityId, []);
    auditById.get(entry.entityId)!.push(entry);
  }
  return requests.map((request) => ({ ...request, currency: currencyByOrderId.get(request.shopifyOrderId) || "USD", auditHistory: auditById.get(request.id) || [] }));
}

export async function getExchangeRequestById(id: string, shopifyStoreId: string) {
  return await prisma.exchangeRequest.findFirst({ where: { id, shopifyStoreId }, include: { items: true } });
}

export async function updateExchangeStatus(
  id: string,
  shopifyStoreId: string,
  status: ExchangeStatus,
  newOrderId?: string,
  newOrderNumber?: string,
  userId?: string,
  admin?: any,
  adminNote?: string,
) {
  return await transitionExchangeStatus({ id, shopifyStoreId, targetStatus: status, newOrderId, newOrderNumber, userId, admin, adminNote });
}

/** Approves an exchange. Replacement order creation is governed by StoreSettings. */
export async function approveExchangeWithDraftOrder(admin: any, id: string, shopifyStoreId: string, userId?: string) {
  return await transitionExchangeStatus({ id, shopifyStoreId, targetStatus: "APPROVED", userId, admin });
}
