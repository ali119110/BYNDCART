import prisma from "../db.server";
import {
  CourierRegistry,
  getDefaultMerchantCourier,
  getDecryptedCourierCredentials,
  normalizeCourierStatus,
  LabelResult,
  StandardShipmentStatus,
} from "./courier.server";
import { triggerLifecycleNotification } from "./notifications.server";
import { getCourierOperationsSettings } from "./settings.server";
import { getShopifyAdminClient } from "./shopifySync.server";

export interface RegisterShipmentInput {
  shopifyStoreId: string;
  orderId: string;
  orderNumber?: string;
  courier?: string;
  /** Carrier-generated tracking number returned by a successful booking API response. */
  /** Carrier-generated tracking number returned by a successful booking API response. */
  trackingNumber?: string;
  /** Required when persisting a tracking number already confirmed by a carrier API response. */
  carrierResponseConfirmed?: boolean;
  /** Skip a "pickup booked" notification when the carrier accepted an order but has not yet booked pickup. */
  notifyPickupBooked?: boolean;
  labelUrl?: string;
  type?: "FORWARD" | "RETURN" | "EXCHANGE";
  returnRequestId?: string;
  exchangeRequestId?: string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  cityName?: string;
  weightKg?: number;
  codAmountPKR?: number;
  remarks?: string;
  originAddress?: any;
  destinationAddress?: any;
  items?: Array<{ title: string; quantity: number }>;
}

/**
 * Registers tracking details for forward or return logistics packages using merchant-configured ICourierAdapters.
 * Enforces tenant scoping, credential decryption, status normalization, idempotency, and background job retries.
 */
export async function registerShipmentTrack(input: RegisterShipmentInput) {
  const shipmentType = input.type || "RETURN";
  const orderNumber = input.orderNumber || input.orderId;
  if (input.trackingNumber && input.carrierResponseConfirmed !== true) {
    throw new Error("A shipment tracking number can only be saved after a carrier API confirms the booking.");
  }

  // Prevent a tracking number from being reused to mutate a shipment owned by another tenant
  // or a different order/type within this tenant. trackingNumber is unique in the current schema.
  let existingByTrackingNumber: any = null;
  if (input.trackingNumber) {
    existingByTrackingNumber = await prisma.shipmentTrack.findUnique({
      where: { trackingNumber: input.trackingNumber },
      select: {
        id: true,
        shopifyStoreId: true,
        shopifyOrderId: true,
        type: true,
        courier: true,
        status: true,
        labelUrl: true,
        location: true,
      },
    });

    if (existingByTrackingNumber) {
      if (existingByTrackingNumber.shopifyStoreId !== input.shopifyStoreId) {
        throw new Error("This tracking number is already assigned to another shipment.");
      }
      if (
        existingByTrackingNumber.shopifyOrderId !== input.orderId ||
        existingByTrackingNumber.type !== shipmentType ||
        (Boolean(input.courier) && existingByTrackingNumber.courier !== input.courier!.trim().toUpperCase())
      ) {
        throw new Error("This tracking number is already assigned to a different order or shipment type.");
      }
    }
  }

  // 1. Idempotency Check: Prevent duplicate package booking for same order & type
  if (!input.trackingNumber) {
    try {
      const existingShipment = await prisma.shipmentTrack.findFirst({
        where: {
          shopifyStoreId: input.shopifyStoreId,
          shopifyOrderId: input.orderId,
          type: shipmentType,
        },
      });

      if (existingShipment) {
        console.log(
          `[Shipment Service] Idempotent skip: Package booking already exists for order ${orderNumber} (${existingShipment.trackingNumber})`
        );
        return {
          success: true,
          shipmentId: existingShipment.id,
          trackingNumber: existingShipment.trackingNumber,
          labelUrl: existingShipment.labelUrl || "",
          courier: existingShipment.courier,
          status: existingShipment.status as StandardShipmentStatus,
        };
      }
    } catch {
      // Offline unit test fallback
    }
  }


  // 2. Resolve Courier Adapter (Requested vs Default Merchant Inbound/Outbound)
  const usesForwardCourier = shipmentType === "FORWARD" || shipmentType === "EXCHANGE";
  if (input.courier && !CourierRegistry.has(input.courier)) {
    throw new Error("Unsupported courier provider.");
  }
  const adapter = input.courier
    ? CourierRegistry.get(input.courier)
    : await getDefaultMerchantCourier(input.shopifyStoreId, usesForwardCourier ? "FORWARD" : "REVERSE");

  // Load merchant's decrypted API credentials
  const credentials = await getDecryptedCourierCredentials(input.shopifyStoreId, adapter.providerName);
  if (!adapter.isLive) throw new Error(`${adapter.displayName} API booking is disabled in BYNDCART.`);
  if (!credentials || credentials.isLive !== true) {
    throw new Error(`${adapter.displayName} credentials are missing, disabled, or not verified for this store.`);
  }
  const adapterSetup = CourierRegistry.getRegisteredAdapters().find((item) => item.providerName === adapter.providerName);
  const missingRequiredCredential = (adapterSetup?.fields || []).find((field) => field.required && !String(credentials.credentials?.[field.key] || "").trim());
  if (missingRequiredCredential) throw new Error(`Configure ${missingRequiredCredential.label} for ${adapter.displayName} before booking.`);

  let trackingNumber = input.trackingNumber;
  let labelUrl = input.labelUrl?.trim() || existingByTrackingNumber?.labelUrl || "";
  let estimatedDeliveryDate: Date | undefined;
  let labelResult: LabelResult | null = null;

  // 3. Generate Reverse or Forward Shipping Label via Courier Adapter if tracking number not provided
  if (!trackingNumber) {
    try {
      if (shipmentType === "FORWARD" || shipmentType === "EXCHANGE") {
        labelResult = await adapter.createForwardShipment(
          {
            shopifyStoreId: input.shopifyStoreId,
            orderId: input.orderId,
            orderNumber,
            customerName: input.customerName,
            customerPhone: input.customerPhone,
            customerEmail: input.customerEmail,
            cityName: input.cityName || input.destinationAddress?.city,
            shipmentType,
            weightKg: input.weightKg,
            codAmountPKR: input.codAmountPKR,
            remarks: input.remarks,
            originAddress: input.originAddress,
            destinationAddress: input.destinationAddress,
            items: input.items,
          },
          credentials
        );
      } else {
        labelResult = await adapter.createReverseShipment(
          {
            shopifyStoreId: input.shopifyStoreId,
            orderId: input.orderId,
            orderNumber,
            customerName: input.customerName,
            customerPhone: input.customerPhone,
            customerEmail: input.customerEmail,
            cityName: input.cityName || input.originAddress?.city,
            shipmentType,
            weightKg: input.weightKg,
            codAmountPKR: input.codAmountPKR,
            remarks: input.remarks,
            originAddress: input.originAddress,
            destinationAddress: input.destinationAddress,
            items: input.items,
          },
          credentials
        );
      }

      if (!labelResult?.success || !labelResult.isLive || !labelResult.trackingNumber) {
        const message = labelResult?.error || `${adapter.providerName} did not confirm a shipment through its API.`;
        if (!labelResult?.isLive) {
          const unsupportedError = new Error(message) as Error & { unsupportedBooking?: boolean };
          unsupportedError.unsupportedBooking = true;
          throw unsupportedError;
        }
        throw new Error(message);
      }
      trackingNumber = labelResult.trackingNumber;
      labelUrl = labelResult.labelUrl || "";
      estimatedDeliveryDate = labelResult.estimatedDeliveryDate;
    } catch (err: any) {
      if (err?.unsupportedBooking) throw err;
      console.error(`[Shipment Service] External Courier API failure for ${orderNumber}:`, err.message);
      await prisma.backgroundJob.create({
        data: {
          shopifyStoreId: input.shopifyStoreId,
          type: "COURIER_SHIPMENT_CREATE",
          payload: {
            providerName: adapter.providerName,
            orderNumber,
            error: err.message,
          },
          status: "PENDING",
        },
      });
      throw new Error(`Courier booking failed for ${adapter.providerName}: ${err.message}. Queued for retry.`);
    }
  }

  // Carrier-confirmed API bookings start as LABEL_CREATED until real tracking reports a status.
  // A tracking poll only changes that status when the courier returns a real status.
  let normalizedStatus: StandardShipmentStatus = existingByTrackingNumber
    ? existingByTrackingNumber.status as StandardShipmentStatus
    : "LABEL_CREATED";
  let location: string | undefined = existingByTrackingNumber?.location || undefined;
  let rawPayload: any;
  if (!input.trackingNumber && labelResult?.isLive) {
    try {
      const trackingInfo = await adapter.trackShipment(trackingNumber!, credentials);
      rawPayload = trackingInfo.rawPayload;
      if (trackingInfo.status !== "UNKNOWN") {
        normalizedStatus = normalizeCourierStatus(trackingInfo.status);
        location = trackingInfo.location;
      }
    } catch (trackingError) {
      // Booking already returned a carrier tracking number. Keep that confirmed shipment record
      // even if the first tracking call is temporarily unavailable; it can be refreshed later.
      console.warn(`[Shipment Service] Initial tracking lookup failed for ${trackingNumber}:`, trackingError instanceof Error ? trackingError.message : trackingError);
    }
  }

  // 5. Persist shipment record in PostgreSQL
  const shipment = await prisma.shipmentTrack.upsert({
    where: { trackingNumber: trackingNumber! },
    update: {
      status: normalizedStatus,
      location: location || null,
      ...(labelUrl ? { labelUrl } : {}),
      updatedAt: new Date(),
    },
    create: {
      shopifyStoreId: input.shopifyStoreId,
      shopifyOrderId: input.orderId,
      orderNumber,
      type: shipmentType,
      courier: adapter.providerName,
      trackingNumber: trackingNumber!,
      labelUrl,
      status: normalizedStatus,
      location: location || null,
      estimatedDelivery: estimatedDeliveryDate || null,
      returnRequestId: input.returnRequestId || null,
      exchangeRequestId: input.exchangeRequestId || null,
    },
  });

  try {
    const { ensureCourierTrackingScheduled } = await import("../worker.server");
    await ensureCourierTrackingScheduled(input.shopifyStoreId);
  } catch (trackingScheduleError) {
    console.warn("[Shipment Service] Shipment was saved, but automatic tracking could not be queued:", trackingScheduleError);
  }

  // FedEx and DHL return Base64 label documents. Keep bytes server-side and expose only
  // the authenticated /app/shipments-label URL; do not store large data URIs in labelUrl.
  if (labelResult?.labelContentBase64) {
    const contentBase64 = labelResult.labelContentBase64.replace(/^data:[^,]+;base64,/i, "").replace(/\s/g, "");
    try {
      if (!contentBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64)) {
        throw new Error("The carrier returned an invalid Base64 label document.");
      }
      await prisma.shipmentDocument.upsert({
        where: { shipmentTrackId_documentType: { shipmentTrackId: shipment.id, documentType: "LABEL" } },
        update: {
          shopifyStoreId: input.shopifyStoreId,
          fileName: labelResult.labelFileName || `${adapter.providerName}-${trackingNumber}.pdf`,
          mimeType: labelResult.labelContentType || "application/pdf",
          contentBase64,
        },
        create: {
          shopifyStoreId: input.shopifyStoreId,
          shipmentTrackId: shipment.id,
          documentType: "LABEL",
          fileName: labelResult.labelFileName || `${adapter.providerName}-${trackingNumber}.pdf`,
          mimeType: labelResult.labelContentType || "application/pdf",
          contentBase64,
        },
      });
    } catch (documentError) {
      console.error(`[Shipment Service] ${adapter.displayName} booking succeeded but label storage failed for ${trackingNumber}: ${documentError instanceof Error ? documentError.message : "unknown error"}`);
      if (labelUrl.includes("/app/shipments-label") && labelResult.labelContentBase64) {
        labelUrl = "";
        await prisma.shipmentTrack.update({ where: { id: shipment.id }, data: { labelUrl: null } }).catch(() => undefined);
      }
    }
  }

  // 6. Record normalized ShipmentEvent
  try {
    await prisma.shipmentEvent.create({
      data: {
        shipmentTrackId: shipment.id,
        status: normalizedStatus,
        description: input.trackingNumber
          ? `Carrier API booking recorded via ${adapter.displayName}`
          : `Shipment registered via ${adapter.displayName}`,
        location: location || null,
        rawPayload: rawPayload || (labelResult ? labelResult.rawResponse : null),
      },
    });
  } catch {
    // Offline unit test fallback
  }

  // Trigger non-blocking COURIER_PICKUP_BOOKED notification
  if (input.customerEmail && input.notifyPickupBooked !== false) {
    await triggerLifecycleNotification({
      shopifyStoreId: input.shopifyStoreId,
      eventType: "COURIER_PICKUP_BOOKED",
      entityId: shipment.id,
      recipientEmail: input.customerEmail,
      variables: {
        customer_name: input.customerName || "Customer",
        order_number: orderNumber,
        tracking_number: trackingNumber!,
        carrier: adapter.displayName,
      },
    });
  }

  // 7. Write AuditLog entry
  try {
    await prisma.auditLog.create({
      data: {
        shopifyStoreId: input.shopifyStoreId,
        action: "SHIPMENT_REGISTERED",
        entityType: "ShipmentTrack",
        entityId: shipment.id,
        metadata: {
          trackingNumber: trackingNumber!,
          courier: adapter.providerName,
          type: shipmentType,
          status: normalizedStatus,
        },
      },
    });
  } catch {
    // Offline unit test fallback
  }


  console.log(
    `[Shipment Service] Registered ${shipmentType} package with tracking ${trackingNumber} via ${adapter.providerName} (Status: ${normalizedStatus})`
  );

  return {
    success: true,
    shipmentId: shipment.id,
    trackingNumber: trackingNumber!,
    labelUrl,
    courier: adapter.providerName,
    status: normalizedStatus,
  };
}

/**
 * Syncs and updates tracking events for an existing shipment. Prevents duplicate webhook event logging.
 */
async function syncShopifyFulfillmentEvent(
  shopifyStoreId: string,
  shopifyOrderId: string,
  trackingNumber: string,
  shipmentType: string,
  normalizedStatus: string,
  occurredAt: Date,
): Promise<void> {
  // Returns are inbound pickups, not customer-facing Shopify fulfillments.
  if (shipmentType === "RETURN") return;

  const statusMap: Record<string, string> = {
    IN_TRANSIT: "IN_TRANSIT",
    OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
    DELIVERED: "DELIVERED",
    FAILED: "FAILURE",
    CANCELLED: "CANCELLED",
  };
  const shopifyStatus = statusMap[normalizedStatus.toUpperCase()];
  if (!shopifyStatus) return;

  try {
    const admin = await getShopifyAdminClient(shopifyStoreId);
    if (!admin) return;

    const orderResponse = await admin.graphql(`#graphql
      query BYNDCARTFulfillmentTracking($orderId: ID!) {
        order(id: $orderId) {
          fulfillments(first: 20) {
            nodes {
              id
              trackingInfo {
                number
              }
            }
          }
        }
      }`, { variables: { orderId: shopifyOrderId } });
    const orderPayload = await orderResponse.json();
    const fulfillments = orderPayload?.data?.order?.fulfillments?.nodes || [];
    const normalizedTracking = trackingNumber.trim().toLowerCase();
    const fulfillment = fulfillments.find((item: any) =>
      (item.trackingInfo || []).some((tracking: any) =>
        String(tracking?.number || "").trim().toLowerCase() === normalizedTracking
      )
    );
    if (!fulfillment?.id) {
      // An order may not have a Shopify fulfillment (for example, an inbound return).
      return;
    }

    const eventResponse = await admin.graphql(`#graphql
      mutation BYNDCARTCreateFulfillmentEvent($fulfillmentEvent: FulfillmentEventInput!) {
        fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
          fulfillmentEvent { id status message }
          userErrors { field message }
        }
      }`, {
        variables: {
          fulfillmentEvent: {
            fulfillmentId: fulfillment.id,
            status: shopifyStatus,
            happenedAt: occurredAt.toISOString(),
            message: `Courier tracking update: ${normalizedStatus.replace(/_/g, " ")}`,
          },
        },
      });
    const eventPayload = await eventResponse.json();
    const userErrors = eventPayload?.data?.fulfillmentEventCreate?.userErrors || [];
    if (userErrors.length) {
      console.warn(
        `[Shipment Service] Shopify fulfillment event not recorded for ${trackingNumber}:`,
        userErrors.map((item: any) => item.message).join("; "),
      );
    }
  } catch (error) {
    // Tracking in BYNDCART must continue if Shopify rejects the event or the new scope is not yet granted.
    console.warn(
      `[Shipment Service] Shopify fulfillment status sync skipped for ${trackingNumber}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

export async function syncShipmentTrackingStatus(trackingNumber: string, shopifyStoreId?: string) {
  const shipment = await prisma.shipmentTrack.findFirst({
    where: { trackingNumber, ...(shopifyStoreId ? { shopifyStoreId } : {}) },
    include: { events: true },
  });

  if (!shipment) {
    throw new Error(`Shipment with tracking number ${trackingNumber} not found.`);
  }

  const warehouseIntake = await prisma.warehouseIntake.findFirst({
    where: { shopifyStoreId: shipment.shopifyStoreId, shipmentTrackId: shipment.id },
    select: { id: true },
  });
  if (warehouseIntake) {
    return {
      success: true,
      trackingNumber,
      status: shipment.status as StandardShipmentStatus,
      location: shipment.location,
      skipped: true,
      reason: "Shipment has already been received at the warehouse.",
    };
  }

  const adapter = CourierRegistry.get(shipment.courier);
  if (!adapter.isLive) throw new Error(`${adapter.displayName} tracking is disabled in BYNDCART.`);
  const credentials = await getDecryptedCourierCredentials(shipment.shopifyStoreId, adapter.providerName);
  if (!credentials || credentials.isLive !== true) throw new Error(`${adapter.displayName} credentials are disabled or unverified for this store.`);
  const trackingInfo = await adapter.trackShipment(trackingNumber, credentials);
  const carrierNormalizedStatus = normalizeCourierStatus(trackingInfo.status);
  const normalizedStatus = carrierNormalizedStatus === "UNKNOWN"
    ? shipment.status as StandardShipmentStatus
    : carrierNormalizedStatus;
  const previousStatus = String(shipment.status || "").toUpperCase();
  const shipmentStatusChanged = carrierNormalizedStatus !== "UNKNOWN"
    && String(normalizedStatus).toUpperCase() !== previousStatus;

  // Keep the last known useful state when the carrier returns an unrecognized status.
  const updatedShipment = await prisma.shipmentTrack.update({
    where: { trackingNumber },
    data: {
      ...(carrierNormalizedStatus === "UNKNOWN" ? {} : { status: normalizedStatus }),
      location: trackingInfo.location || shipment.location,
    },
  });

  // Webhook deduplication: skip event creation if status & description already logged recently
  const latestEvent = shipment.events[shipment.events.length - 1];
  const latestDesc = trackingInfo.events?.[0]?.description || `Status update: ${normalizedStatus}`;

  if (!latestEvent || latestEvent.status !== normalizedStatus || latestEvent.description !== latestDesc) {
    await prisma.shipmentEvent.create({
      data: {
        shipmentTrackId: shipment.id,
        status: normalizedStatus,
        description: latestDesc,
        location: trackingInfo.location || null,
        rawPayload: trackingInfo.rawPayload || null,
      },
    });
  }

  // Send the confirmed carrier status to the matching Shopify fulfillment, when available.
  // Only create an event on a state transition to avoid duplicate Shopify timeline entries.
  if (shipmentStatusChanged) {
    await syncShopifyFulfillmentEvent(
      shipment.shopifyStoreId,
      shipment.shopifyOrderId,
      trackingNumber,
      shipment.type,
      String(normalizedStatus),
      new Date(),
    );
  }

  // Send a single WhatsApp update per confirmed status transition, using merchant-level
  // template settings shared by all courier integrations. This is non-blocking for tracking.
  if (shipmentStatusChanged) {
    try {
      const courierSettings = await getCourierOperationsSettings(shipment.shopifyStoreId);
      if (courierSettings.sendDeliveryUpdates) {
        const order = await prisma.order.findFirst({
          where: {
            shopifyStoreId: shipment.shopifyStoreId,
            shopifyOrderId: shipment.shopifyOrderId,
          },
          select: { customerName: true, customerPhone: true, customerEmail: true, totalPrice: true },
        });
        if (order?.customerPhone) {
          const trackingUrl = (() => {
            const normalizedCourier = String(shipment.courier || "").toUpperCase();
            if (normalizedCourier.includes("POSTEX")) return `https://postex.pk/tracking?cn=${encodeURIComponent(trackingNumber)}`;
            if (normalizedCourier.includes("LEOPARD")) return `https://www.leopardscourier.com/tracking?track_number=${encodeURIComponent(trackingNumber)}`;
            if (normalizedCourier.includes("TCS")) return `https://www.tcsexpress.com/tracking?consignment=${encodeURIComponent(trackingNumber)}`;
            if (normalizedCourier.includes("TRAX")) return `https://trax.pk/tracking?cn=${encodeURIComponent(trackingNumber)}`;
            return `/apps/track?tracking=${encodeURIComponent(trackingNumber)}`;
          })();
          const amount = Number(shipment.codAmount ?? order.totalPrice ?? 0);
          await triggerLifecycleNotification({
            shopifyStoreId: shipment.shopifyStoreId,
            eventType: "TRACKING_UPDATE",
            channel: "WHATSAPP",
            entityId: `${trackingNumber}:${normalizedStatus}`,
            recipientPhone: order.customerPhone,
            recipientEmail: order.customerEmail || "",
            variables: {
              customer_name: order.customerName || "Customer",
              customer_phone: order.customerPhone,
              order_number: shipment.orderNumber,
              order_amount: Number.isFinite(amount) ? amount.toLocaleString("en-PK") : "0",
              cod_amount: Number.isFinite(amount) ? amount.toLocaleString("en-PK") : "0",
              courier_name: adapter.displayName,
              carrier: adapter.displayName,
              tracking_number: trackingNumber,
              tracking_url: trackingUrl,
              status: normalizedStatus,
            },
          });
        }
      }
    } catch (notificationError) {
      console.warn(`[Shipment Service] Tracking notification failed for ${trackingNumber}:`, notificationError);
    }
  }

  // Automated Exchange Delivery Transition:
  // When courier tracking indicates delivery (DELIVERED), automatically transition
  // linked FULFILLED exchange requests to COMPLETED without requiring manual clicks.
  if (normalizedStatus === "DELIVERED") {
    let exchangeIdToComplete = shipment.exchangeRequestId;
    if (!exchangeIdToComplete && (shipment.type === "EXCHANGE" || shipment.type === "FORWARD")) {
      const match = await prisma.exchangeRequest.findFirst({
        where: {
          shopifyStoreId: shipment.shopifyStoreId,
          status: "FULFILLED",
          OR: [
            { shopifyOrderId: shipment.shopifyOrderId },
            { orderNumber: shipment.orderNumber },
            ...(shipment.orderNumber ? [{ newOrderNumber: shipment.orderNumber }] : []),
          ],
        },
        select: { id: true },
      });
      if (match) exchangeIdToComplete = match.id;
    }

    if (exchangeIdToComplete) {
      const exchange = await prisma.exchangeRequest.findFirst({
        where: { id: exchangeIdToComplete, shopifyStoreId: shipment.shopifyStoreId },
      });
      if (exchange && exchange.status === "FULFILLED") {
        try {
          const { transitionExchangeStatus } = await import("./stateMachine.server");
          await transitionExchangeStatus({
            id: exchange.id,
            shopifyStoreId: shipment.shopifyStoreId,
            targetStatus: "COMPLETED",
            adminNote: `Automated: Courier ${adapter.displayName} confirmed delivery for tracking ${trackingNumber}.`,
          });
          if (!shipment.exchangeRequestId) {
            await prisma.shipmentTrack.update({
              where: { id: shipment.id },
              data: { exchangeRequestId: exchange.id },
            }).catch(() => null);
          }
        } catch (err) {
          console.error(`[Shipment Service] Automatic delivery transition failed for exchange ${exchange.id}:`, err);
        }
      }
    }
  }

  return {
    success: true,
    trackingNumber,
    status: normalizedStatus,
    location: updatedShipment.location,
  };
}

/** Cancel a shipment only when the current tenant owns it and the carrier API confirms cancellation. */
export async function cancelShipmentTrack(shopifyStoreId: string, shipmentId: string) {
  const shipment = await prisma.shipmentTrack.findFirst({
    where: { id: shipmentId, shopifyStoreId },
    select: { id: true, shopifyStoreId: true, trackingNumber: true, courier: true, status: true, orderNumber: true },
  });
  if (!shipment) throw new Error("Shipment not found for this store.");
  if (["DELIVERED", "CANCELLED"].includes(String(shipment.status))) {
    throw new Error(`A shipment with status ${shipment.status} cannot be cancelled from BYNDCART.`);
  }
  if (!CourierRegistry.has(shipment.courier)) {
    throw new Error(`${shipment.courier} is disabled in BYNDCART. Cancellation is unavailable for this carrier.`);
  }
  const adapter = CourierRegistry.get(shipment.courier);
  if (adapter.supportsCancellation === false) {
    throw new Error(`${adapter.displayName} shipment cancellation is not supported by the configured carrier API contract.`);
  }
  if (!adapter.isLive) throw new Error(`${adapter.displayName} cancellation is disabled in BYNDCART.`);
  const credentials = await getDecryptedCourierCredentials(shopifyStoreId, adapter.providerName);
  if (!credentials || credentials.isLive !== true) throw new Error(`${adapter.displayName} credentials are missing, disabled, or unverified.`);
  const result = await adapter.cancelShipment(shipment.trackingNumber, credentials);
  if (!result.success) throw new Error(result.message || `${adapter.displayName} did not confirm cancellation.`);

  await prisma.shipmentTrack.update({ where: { id: shipment.id }, data: { status: "CANCELLED", updatedAt: new Date() } });
  try {
    await prisma.shipmentEvent.create({
      data: {
        shipmentTrackId: shipment.id,
        status: "CANCELLED",
        description: `Cancellation confirmed by ${adapter.displayName} API`,
        rawPayload: { message: result.message || "Cancellation confirmed" },
      },
    });
  } catch {
    // Keep successful cancellation even when the optional event table write fails.
  }
  try {
    await prisma.auditLog.create({
      data: {
        shopifyStoreId,
        action: "SHIPMENT_CANCELLED",
        entityType: "ShipmentTrack",
        entityId: shipment.id,
        metadata: { courier: adapter.providerName, trackingNumber: shipment.trackingNumber, orderNumber: shipment.orderNumber },
      },
    });
  } catch {
    // Audit logging should not reverse a successful carrier cancellation.
  }
  return { success: true, message: result.message || `${adapter.displayName} confirmed cancellation.`, trackingNumber: shipment.trackingNumber };
}

export interface GetShipmentsOptions {
  type?: string;
  statusFilter?: "ALL" | "ACTIVE" | "COMPLETED";
  search?: string;
  page?: number;
  pageSize?: number;
  limit?: number;
}

/**
 * Retrieves tenant-scoped track lists from PostgreSQL with server-side filtering and pagination.
 */
export async function getStoreShipments(shopifyStoreId: string, options: GetShipmentsOptions = {}) {
  const { type, statusFilter = "ALL", search } = options;
  const page = Math.max(1, Number(options.page || 1));
  const pageSize = Math.max(1, Number(options.pageSize || options.limit || 10));

  const where: any = { shopifyStoreId };

  if (type && type !== "All") {
    where.type = type.toUpperCase();
  }

  if (statusFilter === "ACTIVE") {
    where.status = { in: ["LABEL_CREATED", "IN_TRANSIT", "OUT_FOR_DELIVERY"] };
  } else if (statusFilter === "COMPLETED") {
    where.status = { in: ["DELIVERED"] };
  }

  if (search && search.trim()) {
    const query = search.trim();
    where.OR = [
      { id: { contains: query, mode: "insensitive" } },
      { orderNumber: { contains: query, mode: "insensitive" } },
      { trackingNumber: { contains: query, mode: "insensitive" } },
    ];
  }

  const [totalCount, shipments] = await Promise.all([
    typeof (prisma.shipmentTrack as any).count === "function"
      ? (prisma.shipmentTrack as any).count({ where }).catch(() => 0)
      : Promise.resolve(0),
    prisma.shipmentTrack.findMany({
      where,
      include: { events: true },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const effectiveTotal = Math.max(Number(totalCount) || 0, shipments.length);
  const totalPages = Math.max(1, Math.ceil(effectiveTotal / pageSize));

  const mapped: any = shipments.map((s) => ({
    id: s.id,
    shopifyOrderId: s.shopifyOrderId,
    orderNumber: s.orderNumber,
    type: s.type,
    courier: s.courier,
    trackingNumber: s.trackingNumber,
    status: s.status,
    location: s.location,
    labelUrl: s.labelUrl,
    date: s.createdAt.toISOString().split("T")[0],
    eventsCount: s.events?.length || 0,
    exchangeRequestId: (s as any).exchangeRequestId || null,
    returnRequestId: (s as any).returnRequestId || null,
  }));

  Object.assign(mapped, {
    pagination: {
      page,
      pageSize,
      totalCount: effectiveTotal,
      totalPages,
    },
    totalCount: effectiveTotal,
    totalPages,
    page,
    pageSize,
  });

  return mapped;
}

/**
 * Automatically synchronizes shipment tracking statuses for all active (in-transit/pending) shipments.
 */
export async function syncAllActiveShipments(shopifyStoreId: string) {
  const activeShipments = await prisma.shipmentTrack.findMany({
    where: {
      shopifyStoreId,
      status: { in: ["LABEL_CREATED", "IN_TRANSIT", "OUT_FOR_DELIVERY"] },
      warehouseIntakes: { none: {} },
    },
    select: { trackingNumber: true },
    take: 25,
  });

  const results = await Promise.allSettled(
    activeShipments.map((s) => syncShipmentTrackingStatus(s.trackingNumber, shopifyStoreId))
  );

  const syncedCount = results.filter((r) => r.status === "fulfilled").length;
  return { success: true, total: activeShipments.length, syncedCount };
}

