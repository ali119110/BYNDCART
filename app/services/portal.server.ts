import prisma from "../db.server";
import { getSettings } from "./settings.server";
import { createReturnRequest } from "./returns.server";
import { registerShipmentTrack } from "./shipments.server";
import { CourierRegistry, getDecryptedCourierCredentials } from "./courier.server";
import { verifyCustomerSessionToken } from "./otp.server";
import { checkReturnEligibility, EligibilityResult } from "./policyEngine.server";
import { assertCanCreateReturn } from "./planGate.server";
import { triggerLifecycleNotification } from "./notifications.server";

export interface ShopperOrderLookupResult {
  eligible: boolean;
  ineligibilityReason?: string;
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
      variantId: string;
      title: string;
      quantity: number;
      price: number;
    }>;
  };
  settings: {
    returnWindowDays: number;
    restockingFeePercent: number;
    exchangeWindowDays: number;
    exchangeShippingCost: number;
  };
  eligibilityResult?: EligibilityResult;
}

/**
 * Validates shopper order lookup and return window eligibility via authoritative Policy Engine.
 * REQUIRES a verified, non-expired Customer Session token.
 */
export async function lookupShopperOrder(
  shopifyStoreId: string,
  sessionToken: string
): Promise<ShopperOrderLookupResult> {
  const session = verifyCustomerSessionToken(sessionToken, shopifyStoreId);

  if (!session) {
    throw new Error("Unauthorized access. Please authenticate with a valid OTP code.");
  }

  const normalizedEmail = session.customerEmail.trim().toLowerCase();
  const normalizedOrderNumber = session.orderNumber.trim().startsWith("#")
    ? session.orderNumber.trim()
    : `#${session.orderNumber.trim()}`;

  const order = await prisma.order.findFirst({
    where: {
      shopifyStoreId,
      orderNumber: { equals: normalizedOrderNumber, mode: "insensitive" },
      customerEmail: { equals: normalizedEmail, mode: "insensitive" },
    },
  });

  if (!order) {
    throw new Error(
      `Order ${normalizedOrderNumber} with email '${normalizedEmail}' was not found.`
    );
  }

  const settings = await getSettings(shopifyStoreId);

  // Authoritative Policy Engine Evaluation
  const eligibility = await checkReturnEligibility({
    shopifyStoreId,
    orderId: order.shopifyOrderId,
    orderNumber: order.orderNumber,
    customerEmail: order.customerEmail || session.customerEmail,
    requestType: "RETURN",
  });

  return {
    eligible: eligibility.eligible,
    ineligibilityReason: eligibility.eligible ? undefined : eligibility.message,
    eligibilityResult: eligibility,
    order: {
      id: order.id,
      shopifyOrderId: order.shopifyOrderId,
      orderNumber: order.orderNumber,
      customerEmail: order.customerEmail || session.customerEmail,
      customerName: order.customerName || "Customer",
      totalPrice: Number(order.totalPrice),
      currency: order.currency || "PKR",
      createdAt: order.shopifyCreatedAt,
      lineItems: (order.lineItems as any) || [],
    },
    settings: {
      returnWindowDays: eligibility.policy.returnWindowDays || settings.returnWindowDays,
      restockingFeePercent: Number(settings.restockingFeePercent),
      exchangeWindowDays: eligibility.policy.exchangeWindowDays || settings.exchangeWindowDays,
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
  courier?: string;
  customerPhone?: string;
  pickupAddress?: string;
  customerCity?: string;
  reason: string;
  customerNote?: string;
  sessionToken: string;
  items: Array<{
    shopifyLineItemId: string;
    quantity: number;
    reason: string;
    price: number;
    title?: string;
    sku?: string;
    category?: string;
  }>;
}

/**
 * Submits a shopper return request with PKR restocking fee deduction and Pakistani courier booking.
 * ENFORCES server-side checkReturnEligibility() — prevents frontend bypass attempts.
 */
export async function submitShopperReturn(input: SubmitShopperReturnInput) {
  const session = verifyCustomerSessionToken(
    input.sessionToken,
    input.shopifyStoreId,
    input.orderNumber
  );

  if (!session) {
    throw new Error("Unauthorized return submission. Your session has expired or is invalid.");
  }

  // Authoritative Server-Side PlanGate Usage Check
  await assertCanCreateReturn(input.shopifyStoreId);

  // Authoritative Server-Side Policy Engine Check (Never trust frontend!)
  const eligibility = await checkReturnEligibility({
    shopifyStoreId: input.shopifyStoreId,
    orderId: input.shopifyOrderId,
    orderNumber: input.orderNumber,
    customerEmail: input.customerEmail,
    requestedItems: input.items,
    requestType: "RETURN",
  });

  if (!eligibility.eligible) {
    throw new Error(`Policy Rejection (${eligibility.reasonCode}): ${eligibility.message}`);
  }

  const settings = await getSettings(input.shopifyStoreId);

  let totalItemValuePKR = 0;
  for (const item of input.items) {
    totalItemValuePKR += item.price * item.quantity;
  }

  const restockingFeePercent = Number(settings.restockingFeePercent) || 0;
  const restockingFeePKR = Math.round((totalItemValuePKR * restockingFeePercent) / 100);

  const selectedCourier = String(input.courier || "").trim().toUpperCase();
  if (!selectedCourier || !CourierRegistry.has(selectedCourier)) {
    throw new Error("Please select a supported courier.");
  }
  const adapter = CourierRegistry.get(selectedCourier);

  // Fetch credentials for this merchant only. Never use another store's/global app credential.
  const credentials = await getDecryptedCourierCredentials(input.shopifyStoreId, adapter.providerName);

  // API-only rule: do not create a return request unless the selected provider has a
  // live adapter and the carrier confirms booking with a tracking/consignment number.
  if (!adapter.isLive) {
    throw new Error(`${adapter.displayName} API booking is not enabled in BYNDCART yet. No return request was created.`);
  }
  if (!credentials || credentials.isLive !== true) {
    throw new Error(`${adapter.displayName} credentials are missing, disabled, or not verified for this store. No return request was created.`);
  }
  const adapterSetup = CourierRegistry.getRegisteredAdapters().find((item) => item.providerName === adapter.providerName);
  const missingRequiredCredential = (adapterSetup?.fields || []).find((field) => field.required && !String(credentials.credentials?.[field.key] || "").trim());
  if (missingRequiredCredential) {
    throw new Error(`The store has not configured ${missingRequiredCredential.label} for ${adapter.displayName}. No return request was created.`);
  }
  const labelResult = await adapter.generateReturnLabel({
    shopifyStoreId: input.shopifyStoreId,
    orderId: input.shopifyOrderId,
    orderNumber: input.orderNumber,
    customerName: input.customerName,
    customerPhone: input.customerPhone?.trim(),
    customerEmail: input.customerEmail,
    cityName: input.customerCity?.trim(),
    shipmentType: "RETURN",
    items: input.items.map((item) => ({ title: item.title || item.shopifyLineItemId, quantity: item.quantity, price: item.price })),
    originAddress: input.pickupAddress?.trim() ? { address1: input.pickupAddress.trim(), city: input.customerCity?.trim() } : undefined,
  }, credentials);

  const apiOrderAccepted = Boolean(labelResult.success && labelResult.isLive && labelResult.trackingNumber?.trim());
  if (!apiOrderAccepted) {
    throw new Error(labelResult.error || `${adapter.displayName} did not confirm the booking. No return request was created. Please check the carrier setup and try again.`);
  }
  const pickupFeePKR = Number(labelResult.costPKR || 0);
  const netRefundAmountPKR = Math.max(0, totalItemValuePKR - restockingFeePKR - pickupFeePKR);

  // Create ReturnRequest in database
  const returnRequest = await createReturnRequest({
    shopifyStoreId: input.shopifyStoreId,
    shopifyOrderId: input.shopifyOrderId,
    orderNumber: input.orderNumber,
    customerEmail: input.customerEmail,
    customerName: input.customerName,
    reason: input.reason,
    customerNote: input.customerNote,
    items: input.items.map((i) => ({
      shopifyLineItemId: i.shopifyLineItemId,
      quantity: i.quantity,
      reason: i.reason,
    })),
  });

  if (!returnRequest) {
    throw new Error("Failed to create return request in database.");
  }

  // Update refund amount in DB
  await prisma.returnRequest.update({
    where: { id: returnRequest.id },
    data: { refundAmount: netRefundAmountPKR },
  });

  if (apiOrderAccepted) {
    await registerShipmentTrack({
      shopifyStoreId: input.shopifyStoreId,
      orderId: input.shopifyOrderId,
      orderNumber: input.orderNumber,
      courier: selectedCourier,
      trackingNumber: labelResult.trackingNumber,
      carrierResponseConfirmed: true,
      notifyPickupBooked: !(selectedCourier === "POSTEX" && String(labelResult.carrierStatus || "").toUpperCase().includes("UNBOOKED")),
      labelUrl: labelResult.labelUrl,
      type: "RETURN",
      returnRequestId: returnRequest.id,
    });
  }

  // Trigger non-blocking RETURN_SUBMITTED notification
  await triggerLifecycleNotification({
    shopifyStoreId: input.shopifyStoreId,
    eventType: "RETURN_SUBMITTED",
    entityId: returnRequest.id,
    recipientEmail: input.customerEmail,
    variables: {
      customer_name: input.customerName || "Customer",
      order_number: input.orderNumber,
      tracking_number: labelResult.trackingNumber,
      carrier: adapter.displayName,
    },
  });

  return {
    success: true,
    returnRequestId: returnRequest.id,
    orderNumber: input.orderNumber,
    trackingNumber: apiOrderAccepted ? labelResult.trackingNumber : "",
    apiOrderAccepted,
    carrierStatus: labelResult.carrierStatus || (selectedCourier === "LEOPARDS" ? "BOOKED" : ""),
    bookingMessage: selectedCourier === "POSTEX"
      ? `PostEx accepted the return order and assigned a tracking number${labelResult.carrierStatus ? ` (initial status: ${labelResult.carrierStatus})` : ""}. The carrier may need to process the order before pickup.`
      : "Leopards accepted the packet booking and returned a consignment number.",
    courier: adapter.displayName,
    labelUrl: apiOrderAccepted ? labelResult.labelUrl : undefined,
    summaryPKR: {
      totalItemValue: totalItemValuePKR,
      restockingFeeDeduction: restockingFeePKR,
      pickupFeeDeduction: pickupFeePKR,
      netRefundAmount: netRefundAmountPKR,
    },
  };
}
