import prisma from "../db.server";
import { getSettings } from "./settings.server";
import { createReturnRequest } from "./returns.server";
import { registerShipmentTrack } from "./shipments.server";
import { CourierRegistry } from "./courier.server";
import { verifyCustomerSessionToken } from "./otp.server";
import { checkReturnEligibility } from "./policyEngine.server";
import { assertCanCreateReturn } from "./planGate.server";
import { triggerLifecycleNotification } from "./notifications.server";

/**
 * Validates shopper order lookup and return window eligibility via authoritative Policy Engine.
 * REQUIRES a verified, non-expired Customer Session token.
 */
export async function lookupShopperOrder(shopifyStoreId, sessionToken) {
  const session = verifyCustomerSessionToken(sessionToken, shopifyStoreId);

  if (!session) {
    throw new Error(
      "Unauthorized access. Please authenticate with a valid OTP code.",
    );
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
      `Order ${normalizedOrderNumber} with email '${normalizedEmail}' was not found.`,
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
      lineItems: order.lineItems || [],
    },
    settings: {
      returnWindowDays:
        eligibility.policy.returnWindowDays || settings.returnWindowDays,
      restockingFeePercent: Number(settings.restockingFeePercent),
      exchangeWindowDays:
        eligibility.policy.exchangeWindowDays || settings.exchangeWindowDays,
      exchangeShippingCost: Number(settings.exchangeShippingCost),
    },
  };
}

/**
 * Submits a shopper return request with PKR restocking fee deduction and Pakistani courier booking.
 * ENFORCES server-side checkReturnEligibility() — prevents frontend bypass attempts.
 */
export async function submitShopperReturn(input) {
  const session = verifyCustomerSessionToken(
    input.sessionToken,
    input.shopifyStoreId,
    input.orderNumber,
  );

  if (!session) {
    throw new Error(
      "Unauthorized return submission. Your session has expired or is invalid.",
    );
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
    throw new Error(
      `Policy Rejection (${eligibility.reasonCode}): ${eligibility.message}`,
    );
  }

  const settings = await getSettings(input.shopifyStoreId);
  let totalItemValuePKR = 0;

  for (const item of input.items) {
    totalItemValuePKR += item.price * item.quantity;
  }

  const restockingFeePercent = Number(settings.restockingFeePercent) || 0;
  const restockingFeePKR = Math.round(
    (totalItemValuePKR * restockingFeePercent) / 100,
  );
  const selectedCourier = input.courier || "TCS";
  const adapter = CourierRegistry.get(selectedCourier);
  // Generate return shipping label via selected Pakistani courier
  const labelResult = await adapter.generateReturnLabel({
    shopifyStoreId: input.shopifyStoreId,
    orderId: input.shopifyOrderId,
    orderNumber: input.orderNumber,
    customerName: input.customerName,
  });
  const pickupFeePKR = labelResult.costPKR || labelResult.cost || 200;
  const netRefundAmountPKR = Math.max(
    0,
    totalItemValuePKR - restockingFeePKR - pickupFeePKR,
  );
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
  // Register reverse shipment in PostgreSQL
  await registerShipmentTrack({
    shopifyStoreId: input.shopifyStoreId,
    orderId: input.shopifyOrderId,
    orderNumber: input.orderNumber,
    courier: selectedCourier,
    trackingNumber: labelResult.trackingNumber,
    type: "RETURN",
    returnRequestId: returnRequest.id,
  });
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
    trackingNumber: labelResult.trackingNumber,
    courier: adapter.displayName,
    labelUrl: labelResult.labelUrl,
    summaryPKR: {
      totalItemValue: totalItemValuePKR,
      restockingFeeDeduction: restockingFeePKR,
      pickupFeeDeduction: pickupFeePKR,
      netRefundAmount: netRefundAmountPKR,
    },
  };
}
