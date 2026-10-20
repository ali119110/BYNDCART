import prisma from "../db.server";
import { getSettings } from "./settings.server";
import { createReturnRequest } from "./returns.server";
import { createExchangeRequest } from "./exchanges.server";
import { verifyCustomerSessionToken } from "./otp.server";
import { checkReturnEligibility, EligibilityResult } from "./policyEngine.server";
import { assertCanCreateReturn } from "./planGate.server";
import { notifyStatusChange, triggerLifecycleNotification } from "./notifications.server";

export interface ShopperOrderLookupResult {
  eligible: boolean;
  ineligibilityReason?: string;
  eligibilityByType: { RETURN: EligibilityResult; EXCHANGE: EligibilityResult };
  order: {
    id: string;
    shopifyOrderId: string;
    orderNumber: string;
    customerEmail: string;
    customerName: string;
    totalPrice: number;
    currency: string;
    createdAt: Date;
    lineItems: Array<{
      lineItemId: string;
      variantId: string | null;
      productId?: string | null;
      title: string;
      quantity: number;
      price: number;
      sku?: string | null;
    }>;
  };
  replacementVariants: Array<{ variantId: string; title: string; price: number; sku: string | null }>;
  requestHistory: Array<{
    id: string;
    type: "RETURN" | "EXCHANGE";
    orderNumber: string;
    status: string;
    createdAt: Date;
    trackingNumber?: string;
    courier?: string;
  }>;
  settings: {
    returnWindowDays: number;
    restockingFeePercent: number;
    exchangeWindowDays: number;
    exchangeShippingCost: number;
  };
}

export async function lookupShopperOrder(shopifyStoreId: string, sessionToken: string): Promise<ShopperOrderLookupResult> {
  const session = verifyCustomerSessionToken(sessionToken, shopifyStoreId);
  if (!session) throw new Error("Unauthorized access. Please authenticate with a valid OTP code.");
  const normalizedEmail = session.customerEmail.trim().toLowerCase();
  const rawOrderNumber = session.orderNumber.trim();
  const normalizedOrderNumber = rawOrderNumber.startsWith("#") ? rawOrderNumber : `#${rawOrderNumber}`;
  const order = await prisma.order.findFirst({
    where: { shopifyStoreId, orderNumber: { equals: normalizedOrderNumber, mode: "insensitive" }, customerEmail: { equals: normalizedEmail, mode: "insensitive" } },
  });
  if (!order) throw new Error(`Order ${normalizedOrderNumber} with email '${normalizedEmail}' was not found.`);

  const [settings, returnEligibility, exchangeEligibility, productRows, returns, exchanges] = await Promise.all([
    getSettings(shopifyStoreId),
    checkReturnEligibility({ shopifyStoreId, orderId: order.shopifyOrderId, orderNumber: order.orderNumber, customerEmail: order.customerEmail || normalizedEmail, requestType: "RETURN" }),
    checkReturnEligibility({ shopifyStoreId, orderId: order.shopifyOrderId, orderNumber: order.orderNumber, customerEmail: order.customerEmail || normalizedEmail, requestType: "EXCHANGE" }),
    prisma.productCache.findMany({ where: { shopifyStoreId }, orderBy: [{ title: "asc" }, { variantTitle: "asc" }], take: 1000 }),
    prisma.returnRequest.findMany({ where: { shopifyStoreId, shopifyOrderId: order.shopifyOrderId, customerEmail: { equals: normalizedEmail, mode: "insensitive" } }, orderBy: { createdAt: "desc" } }),
    prisma.exchangeRequest.findMany({ where: { shopifyStoreId, shopifyOrderId: order.shopifyOrderId, customerEmail: { equals: normalizedEmail, mode: "insensitive" } }, orderBy: { createdAt: "desc" } }),
  ]);

  const requests = [
    ...returns.map((row: any) => ({ id: row.id, type: "RETURN" as const, orderNumber: row.orderNumber, status: row.status, createdAt: row.createdAt })),
    ...exchanges.map((row: any) => ({ id: row.id, type: "EXCHANGE" as const, orderNumber: row.orderNumber, status: row.status, createdAt: row.createdAt })),
  ];
  const trackConditions: Array<{ returnRequestId: string } | { exchangeRequestId: string }> = [];
  for (const request of requests) {
    trackConditions.push(request.type === "RETURN"
      ? { returnRequestId: request.id }
      : { exchangeRequestId: request.id });
  }
  const shipments = trackConditions.length ? await prisma.shipmentTrack.findMany({
    where: { shopifyStoreId, OR: trackConditions }, orderBy: { createdAt: "desc" },
  }) : [];
  const requestHistory = requests.map((request) => {
    const shipment = shipments.find((row: any) => request.type === "RETURN" ? row.returnRequestId === request.id : row.exchangeRequestId === request.id);
    return { ...request, trackingNumber: shipment?.trackingNumber || undefined, courier: shipment?.courier || undefined };
  }).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const rawLines = Array.isArray(order.lineItems) ? order.lineItems as any[] : [];
  const skuByVariant = new Map(productRows.map((product: any) => [product.shopifyVariantId, product.sku]));
  const lineItems = rawLines.map((line: any) => ({
    lineItemId: String(line.lineItemId), variantId: line.variantId || null, productId: line.productId || null,
    title: String(line.title || "Product"), quantity: Number(line.quantity || 0), price: Number(line.price || 0),
    sku: line.sku || skuByVariant.get(String(line.variantId || "")) || null,
  }));
  const eligible = returnEligibility.eligible || exchangeEligibility.eligible;
  return {
    eligible,
    ineligibilityReason: eligible ? undefined : `Returns: ${returnEligibility.message} Exchanges: ${exchangeEligibility.message}`,
    eligibilityByType: { RETURN: returnEligibility, EXCHANGE: exchangeEligibility },
    order: {
      id: order.id, shopifyOrderId: order.shopifyOrderId, orderNumber: order.orderNumber,
      customerEmail: order.customerEmail || normalizedEmail, customerName: order.customerName || "Customer",
      totalPrice: Number(order.totalPrice), currency: order.currency || "USD", createdAt: order.shopifyCreatedAt, lineItems,
    },
    replacementVariants: productRows.map((product: any) => ({
      variantId: product.shopifyVariantId,
      title: [product.title, product.variantTitle].filter(Boolean).join(" - "),
      price: Number(product.price), sku: product.sku,
    })),
    requestHistory,
    settings: {
      returnWindowDays: returnEligibility.policy.returnWindowDays || settings.returnWindowDays,
      restockingFeePercent: Number(settings.restockingFeePercent),
      exchangeWindowDays: exchangeEligibility.policy.exchangeWindowDays || settings.exchangeWindowDays,
      exchangeShippingCost: Number(settings.exchangeShippingCost),
    },
  };
}

export interface SubmitShopperReturnInput {
  shopifyStoreId: string;
  shopifyOrderId: string;
  orderNumber: string;
  customerEmail: string;
  customerName?: string;
  requestType?: "RETURN" | "EXCHANGE";
  reason: string;
  customerNote?: string;
  sessionToken: string;
  items: Array<{
    shopifyLineItemId: string;
    quantity: number;
    reason: string;
    replacementVariantId?: string;
    replacementQuantity?: number;
    // Ignored for financial calculation; retained for old portal payload compatibility.
    price?: number;
    title?: string;
    sku?: string;
    category?: string;
  }>;
}

/** Submits a pending request without ever calling a courier adapter or booking shipment. */
export async function submitShopperReturn(input: SubmitShopperReturnInput) {
  const session = verifyCustomerSessionToken(input.sessionToken, input.shopifyStoreId, input.orderNumber);
  if (!session) throw new Error("Unauthorized request submission. Your session has expired or is invalid.");
  await assertCanCreateReturn(input.shopifyStoreId);
  const sessionEmail = session.customerEmail.trim().toLowerCase();
  const sessionOrderNumber = session.orderNumber.trim().replace(/^#/, "");
  const order = await prisma.order.findFirst({ where: {
    shopifyStoreId: input.shopifyStoreId,
    orderNumber: { equals: `#${sessionOrderNumber}`, mode: "insensitive" },
    customerEmail: { equals: sessionEmail, mode: "insensitive" },
  } });
  if (!order || order.shopifyOrderId !== input.shopifyOrderId) throw new Error("The verified order could not be matched to this request. Verify the order again.");
  if (!Array.isArray(input.items) || !input.items.length) throw new Error("Choose at least one item.");
  const orderLines = Array.isArray(order.lineItems) ? order.lineItems as any[] : [];
  const selected = new Set<string>();
  const safeItems = input.items.map((item) => {
    const lineId = String(item.shopifyLineItemId || "").trim();
    const line = orderLines.find((candidate: any) => String(candidate.lineItemId) === lineId);
    const quantity = Number(item.quantity);
    if (!line) throw new Error("A selected item does not belong to the verified order.");
    if (selected.has(lineId)) throw new Error("Each order line item can only be selected once.");
    selected.add(lineId);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > Number(line.quantity || 0)) throw new Error(`Invalid quantity for ${line.title || "selected item"}.`);
    return {
      shopifyLineItemId: lineId, quantity, reason: String(item.reason || input.reason || "Customer request").slice(0, 120),
      replacementVariantId: item.replacementVariantId ? String(item.replacementVariantId) : undefined,
      replacementQuantity: item.replacementQuantity === undefined ? quantity : Number(item.replacementQuantity),
    };
  });

  const type = input.requestType === "EXCHANGE" ? "EXCHANGE" : "RETURN";
  if (type === "RETURN") {
    const request = await createReturnRequest({
      shopifyStoreId: input.shopifyStoreId, shopifyOrderId: order.shopifyOrderId, orderNumber: order.orderNumber,
      customerEmail: order.customerEmail || sessionEmail, customerName: order.customerName || input.customerName,
      reason: input.reason || safeItems[0].reason, customerNote: input.customerNote, requestSource: "CUSTOMER",
      items: safeItems.map((item) => ({ shopifyLineItemId: item.shopifyLineItemId, quantity: item.quantity, reason: item.reason })),
    });
    return { success: true, requestType: type, returnRequestId: request.id, orderNumber: order.orderNumber, status: request.status, request };
  }

  const exchangeItems = safeItems.map((item) => {
    if (!item.replacementVariantId) throw new Error(`Select a replacement product for ${orderLines.find((line: any) => line.lineItemId === item.shopifyLineItemId)?.title || "each selected item"}.`);
    return {
      originalLineItemId: item.shopifyLineItemId,
      originalQuantity: item.quantity,
      replacementVariantId: item.replacementVariantId,
      replacementQuantity: item.replacementQuantity || item.quantity,
    };
  });
  const exchange = await createExchangeRequest({
    shopifyStoreId: input.shopifyStoreId, shopifyOrderId: order.shopifyOrderId, orderNumber: order.orderNumber,
    customerEmail: order.customerEmail || sessionEmail, customerName: order.customerName || input.customerName,
    reason: input.reason || safeItems[0].reason, customerNote: input.customerNote, requestSource: "CUSTOMER", items: exchangeItems,
  });
  return { success: true, requestType: type, returnRequestId: exchange.id, orderNumber: order.orderNumber, status: exchange.status, request: exchange };
}

/** Store a customer-provided carrier and AWB without calling any courier API. */
export async function submitCustomerTracking(input: {
  shopifyStoreId: string;
  sessionToken: string;
  requestId: string;
  requestType: "RETURN" | "EXCHANGE";
  carrier: string;
  trackingNumber: string;
}) {
  const session = verifyCustomerSessionToken(input.sessionToken, input.shopifyStoreId);
  if (!session) throw new Error("Your verification session expired. Verify the order again to submit tracking.");
  const carrier = String(input.carrier || "").trim().slice(0, 80);
  const trackingNumber = String(input.trackingNumber || "").trim().slice(0, 120);
  if (carrier.length < 2) throw new Error("Enter the carrier or courier name.");
  if (!/^[A-Za-z0-9][A-Za-z0-9 ./_-]{2,119}$/.test(trackingNumber)) throw new Error("Enter a valid carrier tracking number or airway bill.");

  const normalizedOrder = session.orderNumber.trim().replace(/^#/, "");
  const order = await prisma.order.findFirst({ where: {
    shopifyStoreId: input.shopifyStoreId,
    orderNumber: { equals: `#${normalizedOrder}`, mode: "insensitive" },
    customerEmail: { equals: session.customerEmail.trim().toLowerCase(), mode: "insensitive" },
  } });
  if (!order) throw new Error("Verified order was not found.");

  const request = input.requestType === "RETURN"
    ? await prisma.returnRequest.findFirst({ where: { id: input.requestId, shopifyStoreId: input.shopifyStoreId, shopifyOrderId: order.shopifyOrderId, status: "APPROVED", customerEmail: { equals: session.customerEmail.trim().toLowerCase(), mode: "insensitive" } } })
    : await prisma.exchangeRequest.findFirst({ where: { id: input.requestId, shopifyStoreId: input.shopifyStoreId, shopifyOrderId: order.shopifyOrderId, status: "APPROVED", customerEmail: { equals: session.customerEmail.trim().toLowerCase(), mode: "insensitive" } } });
  if (!request) throw new Error("Tracking can only be submitted for an approved request belonging to this verified order.");

  const priorShipment = await prisma.shipmentTrack.findFirst({ where: input.requestType === "RETURN"
    ? { shopifyStoreId: input.shopifyStoreId, returnRequestId: input.requestId }
    : { shopifyStoreId: input.shopifyStoreId, exchangeRequestId: input.requestId } });
  if (priorShipment) {
    if (priorShipment.trackingNumber === trackingNumber && priorShipment.courier.toLowerCase() === carrier.toLowerCase()) {
      return { success: true, idempotent: true, shipmentId: priorShipment.id, trackingNumber, carrier, requestId: input.requestId };
    }
    throw new Error("Tracking details have already been submitted for this request. Contact the store if they need correction.");
  }

  const shipment = await prisma.$transaction(async (tx) => {
    const created = await tx.shipmentTrack.create({
      data: {
        shopifyStoreId: input.shopifyStoreId,
        shopifyOrderId: order.shopifyOrderId,
        orderNumber: order.orderNumber,
        type: input.requestType,
        courier: carrier,
        trackingNumber,
        status: "TRACKING_PROVIDED",
        returnRequestId: input.requestType === "RETURN" ? input.requestId : null,
        exchangeRequestId: input.requestType === "EXCHANGE" ? input.requestId : null,
      },
    });
    await tx.shipmentEvent.create({ data: { shipmentTrackId: created.id, status: "TRACKING_PROVIDED", description: "Customer provided carrier and tracking details; BYNDCART did not book or verify the shipment." } });
    await tx.auditLog.create({
      data: { shopifyStoreId: input.shopifyStoreId, action: "CUSTOMER_TRACKING_SUBMITTED", entityType: input.requestType === "RETURN" ? "ReturnRequest" : "ExchangeRequest", entityId: input.requestId, metadata: { shipmentId: created.id, carrier, trackingNumber } },
    });
    return created;
  });

  await Promise.all([
    triggerLifecycleNotification({ shopifyStoreId: input.shopifyStoreId, eventType: "TRACKING_UPDATE", entityId: shipment.id, recipientEmail: session.customerEmail, variables: { customer_name: order.customerName || "Customer", order_number: order.orderNumber, tracking_number: trackingNumber, status: "Tracking details received by the store" } }),
    notifyStatusChange({ shopifyStoreId: input.shopifyStoreId, entity: `${input.requestType} TRACKING`, orderNumber: order.orderNumber, previousStatus: "APPROVED", newStatus: "TRACKING_PROVIDED", adminNote: `${carrier}: ${trackingNumber}` }),
  ]);
  return { success: true, idempotent: false, shipmentId: shipment.id, trackingNumber, carrier, requestId: input.requestId };
}
