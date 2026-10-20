import prisma from "../db.server";
import { getSettings } from "./settings.server";
import { createReturnRequest } from "./returns.server";
import { createExchangeRequest } from "./exchanges.server";
import { createCustomerSessionToken, normalizeCustomerOrderNumber, verifyCustomerSessionToken } from "./otp.server";
import type { CustomerSessionPayload } from "./otp.server";
import { syncCustomerOrder } from "./orders.server";
import { rateLimit } from "../utils/rateLimit.server";
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

function normalizePortalPhone(value: unknown): string {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("0092")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = "92" + digits.slice(1);
  return digits;
}

async function findOrderForCustomerSession(shopifyStoreId: string, session: CustomerSessionPayload, orderNumber = session.orderNumber) {
  const normalizedOrderNumber = normalizeCustomerOrderNumber(orderNumber);
  const filters: any[] = [];
  const email = String(session.customerEmail || "").trim().toLowerCase();
  const phone = normalizePortalPhone(session.customerPhone);
  if (email) filters.push({ customerEmail: { equals: email, mode: "insensitive" } });
  if (phone) filters.push({ customerPhone: phone });
  if (!filters.length || !normalizedOrderNumber) return null;

  const baseWhere: any = {
    shopifyStoreId,
    orderNumber: { equals: normalizedOrderNumber, mode: "insensitive" },
    OR: filters,
  };
  let order = await prisma.order.findFirst({ where: baseWhere });
  if (!order && normalizedOrderNumber.startsWith("#")) {
    order = await prisma.order.findFirst({
      where: { ...baseWhere, orderNumber: { equals: normalizedOrderNumber.slice(1), mode: "insensitive" } },
    });
  }
  return order;
}

export async function authenticateShopperOrder(
  shopifyStoreId: string,
  input: { orderNumber: string; identifierType: "EMAIL" | "PHONE"; identifier: string }
) {
  const rawOrderNumber = String(input.orderNumber || "").trim();
  const orderNumber = normalizeCustomerOrderNumber(rawOrderNumber);
  const identifierType = input.identifierType === "PHONE" ? "PHONE" : "EMAIL";
  const rawIdentifier = String(input.identifier || "").trim();
  const identifier = identifierType === "EMAIL" ? rawIdentifier.toLowerCase() : normalizePortalPhone(rawIdentifier);

  if (!orderNumber) throw new Error("Enter your order number.");
  if (identifierType === "EMAIL" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)) {
    throw new Error("Enter a valid email address used at checkout.");
  }
  if (identifierType === "PHONE" && (identifier.length < 7 || identifier.length > 15)) {
    throw new Error("Enter the phone number used at checkout, including the country code if needed.");
  }

  const attempts = rateLimit("customer-portal-login:" + shopifyStoreId + ":" + identifierType + ":" + identifier, {
    limit: 10,
    windowMs: 15 * 60 * 1000,
  });
  if (!attempts.allowed) throw new Error("Too many attempts. Please wait a few minutes before trying again.");

  const findOrder = async () => {
    let result = await prisma.order.findFirst({
      where: { shopifyStoreId, orderNumber: { equals: orderNumber, mode: "insensitive" } },
    });
    if (!result && orderNumber.startsWith("#")) {
      result = await prisma.order.findFirst({
        where: { shopifyStoreId, orderNumber: { equals: orderNumber.slice(1), mode: "insensitive" } },
      });
    }
    return result;
  };

  const matchesIdentifier = async (candidate: any): Promise<boolean> => {
    if (!candidate) return false;
    if (identifierType === "EMAIL") {
      return String(candidate.customerEmail || "").trim().toLowerCase() === identifier;
    }

    const savedPhone = normalizePortalPhone(candidate.customerPhone);
    if (savedPhone) return savedPhone === identifier;

    if (candidate.customerEmail) {
      const cachedCustomer = await prisma.customerCache.findFirst({
        where: { shopifyStoreId, email: { equals: String(candidate.customerEmail).trim(), mode: "insensitive" } },
      });
      if (normalizePortalPhone(cachedCustomer?.phone) === identifier) {
        await prisma.order.update({
          where: { shopifyOrderId: candidate.shopifyOrderId },
          data: { customerPhone: identifier },
        });
        candidate.customerPhone = identifier;
        return true;
      }
    }
    return false;
  };

  let order = await findOrder();
  let matched = await matchesIdentifier(order);
  if (!matched) {
    try {
      await syncCustomerOrder(shopifyStoreId, rawOrderNumber);
    } catch (error) {
      console.warn("[CustomerPortal] Could not refresh order details before login:", error);
    }
    order = await findOrder();
    matched = await matchesIdentifier(order);
  }

  if (!order || !matched) {
    throw new Error("We could not find an order matching those details. Check the order number and the email or phone used at checkout.");
  }

  const sessionEmail = String(order.customerEmail || (identifierType === "EMAIL" ? identifier : "")).trim().toLowerCase();
  const sessionPhone = normalizePortalPhone(order.customerPhone) || (identifierType === "PHONE" ? identifier : "");
  const sessionToken = createCustomerSessionToken({
    shopifyStoreId,
    orderNumber: order.orderNumber,
    customerEmail: sessionEmail,
    customerPhone: sessionPhone,
    durationMinutes: 30,
  });

  const maskedIdentifier = identifierType === "EMAIL"
    ? identifier.replace(/^(.).+(@.*)$/, "$1***$2")
    : "***" + identifier.slice(-4);
  await prisma.auditLog.create({
    data: {
      shopifyStoreId,
      action: "CUSTOMER_PORTAL_LOGIN",
      entityType: "Order",
      entityId: order.shopifyOrderId,
      metadata: { orderNumber: order.orderNumber, identifierType, maskedIdentifier },
    },
  }).catch((error) => console.warn("[CustomerPortal] Login audit could not be saved:", error));

  return { success: true as const, sessionToken, orderNumber: order.orderNumber };
}

export async function lookupShopperOrder(shopifyStoreId: string, sessionToken: string): Promise<ShopperOrderLookupResult> {
  const session = verifyCustomerSessionToken(sessionToken, shopifyStoreId);
  if (!session) throw new Error("Your customer portal session is invalid or has expired. Find your order again to continue.");
  const normalizedOrderNumber = normalizeCustomerOrderNumber(session.orderNumber);
  const order = await findOrderForCustomerSession(shopifyStoreId, session, normalizedOrderNumber);
  if (!order) throw new Error("We could not reload this order. Return to the portal and try again.");
  const normalizedEmail = String(order.customerEmail || session.customerEmail || "").trim().toLowerCase();

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
  const sessionEmail = String(session.customerEmail || "").trim().toLowerCase();
  const order = await findOrderForCustomerSession(input.shopifyStoreId, session, input.orderNumber);
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

  const order = await findOrderForCustomerSession(input.shopifyStoreId, session);
  if (!order) throw new Error("Verified order was not found.");
  const sessionEmail = String(order.customerEmail || session.customerEmail || "").trim().toLowerCase();

  const request = input.requestType === "RETURN"
    ? await prisma.returnRequest.findFirst({ where: { id: input.requestId, shopifyStoreId: input.shopifyStoreId, shopifyOrderId: order.shopifyOrderId, status: "APPROVED", customerEmail: { equals: sessionEmail, mode: "insensitive" } } })
    : await prisma.exchangeRequest.findFirst({ where: { id: input.requestId, shopifyStoreId: input.shopifyStoreId, shopifyOrderId: order.shopifyOrderId, status: "APPROVED", customerEmail: { equals: sessionEmail, mode: "insensitive" } } });
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
    triggerLifecycleNotification({ shopifyStoreId: input.shopifyStoreId, eventType: "TRACKING_UPDATE", entityId: shipment.id, recipientEmail: order.customerEmail || session.customerEmail, variables: { customer_name: order.customerName || "Customer", order_number: order.orderNumber, tracking_number: trackingNumber, status: "Tracking details received by the store" } }),
    notifyStatusChange({ shopifyStoreId: input.shopifyStoreId, entity: `${input.requestType} TRACKING`, orderNumber: order.orderNumber, previousStatus: "APPROVED", newStatus: "TRACKING_PROVIDED", adminNote: `${carrier}: ${trackingNumber}` }),
  ]);
  return { success: true, idempotent: false, shipmentId: shipment.id, trackingNumber, carrier, requestId: input.requestId };
}
