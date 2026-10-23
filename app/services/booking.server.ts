import prisma from "../db.server";
import { CourierRegistry, getDecryptedCourierCredentials, type LabelResult } from "./courier.server";
import { logAction } from "./audit.server";
import { triggerLifecycleNotification } from "./notifications.server";
import {
  matchPakistaniCity,
  normalizePakistaniMobile,
  isValidPakistaniMobile,
  estimatePackageWeight,
} from "./pakistanLogistics.server";

export interface BookingLineItem {
  id: string;
  title: string;
  quantity: number;
  price?: number;
  sku?: string;
  grams?: number;
}

export interface UnfulfilledOrder {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string;
  isCod: boolean;
  totalPrice: number;
  suggestedCod: number;
  suggestedWeight: number;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  address1: string;
  address2: string;
  city: string;
  matchedCity: string;
  province: string;
  zip: string;
  country: string;
  items: BookingLineItem[];
  tags: string[];
  alreadyBooked: boolean;
  existingTracking?: string;
  existingCourier?: string;
}

export interface SingleBookingInput {
  orderId: string;
  orderNumber: string;
  courier: string; // POSTEX, LEOPARDS, TCS, RIDER
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  cityName: string;
  codAmountPKR: number;
  weightKg: number;
  remarks?: string;
  items?: Array<{ title: string; quantity: number; price?: number; sku?: string }>;
}

export interface BookingResult {
  success: boolean;
  orderId: string;
  orderNumber: string;
  courier: string;
  trackingNumber: string;
  labelUrl?: string;
  error?: string;
  fulfillmentId?: string;
}

const UNFULFILLED_ORDERS_QUERY = `#graphql
  query UnfulfilledOrders($first: Int!) {
    orders(first: $first, query: "fulfillment_status:unfulfilled", sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          name
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          tags
          totalPriceSet {
            shopMoney {
              amount
            }
          }
          customer {
            firstName
            lastName
            email
            phone
          }
          shippingAddress {
            name
            phone
            address1
            address2
            city
            province
            zip
            country
          }
          lineItems(first: 20) {
            edges {
              node {
                id
                title
                quantity
                sku
                grams
                originalUnitPriceSet {
                  shopMoney {
                    amount
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const FULFILLMENT_ORDERS_QUERY = `#graphql
  query GetOrderFulfillmentOrders($orderId: ID!) {
    order(id: $orderId) {
      fulfillmentOrders(first: 5) {
        nodes {
          id
          status
          supportedActions {
            action
          }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE_MUTATION = `#graphql
  mutation CreateFulfillment($fulfillment: FulfillmentV2Input!) {
    fulfillmentCreateV2(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
        trackingInfo {
          number
          company
          url
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const TAGS_ADD_MUTATION = `#graphql
  mutation AddOrderTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Returns tracking URL for courier
 */
export function courierTrackingUrl(courier: string, trackingNumber: string): string {
  const norm = courier.toUpperCase();
  if (norm.includes("POSTEX")) return `https://postex.pk/tracking?cn=${encodeURIComponent(trackingNumber)}`;
  if (norm.includes("LEOPARD")) return `https://www.leopardscourier.com/tracking?track_number=${encodeURIComponent(trackingNumber)}`;
  if (norm.includes("TCS")) return `https://www.tcsexpress.com/tracking?consignment=${encodeURIComponent(trackingNumber)}`;
  if (norm.includes("TRAX")) return `https://trax.pk/tracking?cn=${encodeURIComponent(trackingNumber)}`;
  return `/apps/track?tracking=${encodeURIComponent(trackingNumber)}`;
}

/**
 * Normalizes courier name for display and storage
 */
export function normalizeCourierName(courier: string): string {
  const c = courier.trim().toUpperCase();
  if (c.includes("POSTEX")) return "POSTEX";
  if (c.includes("LEOPARD")) return "LEOPARDS";
  if (c.includes("TCS")) return "TCS";
  if (c.includes("RIDER") || c.includes("SELF")) return "RIDER";
  return c;
}

/**
 * Fetches unfulfilled Shopify orders ready for courier booking.
 * Queries live Shopify GraphQL. Only falls back to database if admin client
 * is completely unavailable (offline mode / no session).
 */
export async function fetchUnfulfilledOrders(
  admin: any,
  shopifyStoreId: string,
  limit = 100,
): Promise<UnfulfilledOrder[]> {
  // 1. Always try live Shopify GraphQL first when admin is available
  if (admin) {
    try {
      const response = await admin.graphql(UNFULFILLED_ORDERS_QUERY, { variables: { first: limit } });
      const payload = await response.json();
      const orderNodes = (payload?.data?.orders?.edges || []).map((edge: any) => edge.node);

      // Get all existing active forward shipments for this store to identify already booked orders
      const existingShipments = await prisma.shipmentTrack.findMany({
        where: { shopifyStoreId },
        select: { orderNumber: true, trackingNumber: true, courier: true },
      }).catch(() => []);

      const bookedOrderMap = new Map<string, { trackingNumber: string; courier: string }>();
      for (const ship of existingShipments) {
        bookedOrderMap.set(ship.orderNumber, { trackingNumber: ship.trackingNumber, courier: ship.courier });
      }

      // Map Shopify nodes to UnfulfilledOrder — extracts real customer/address data
      return orderNodes.map((node: any) => {
        const orderNumber = String(node.name || "");
        const totalPrice = Number(node.totalPriceSet?.shopMoney?.amount || 0);
        const finStatus = String(node.displayFinancialStatus || "").toUpperCase();
        const isCod = finStatus === "PENDING";
        const tags = Array.isArray(node.tags) ? node.tags : [];

        // Phone: prefer shipping address phone, fall back to customer phone
        const rawPhone = node.shippingAddress?.phone || node.customer?.phone || "";
        const normalizedPhone = rawPhone ? normalizePakistaniMobile(rawPhone) : "";

        // Address fields from shippingAddress
        const address1 = node.shippingAddress?.address1 || "";
        const address2 = node.shippingAddress?.address2 || "";
        const rawCity = node.shippingAddress?.city || "";
        const fullAddress = [address1, address2].filter(Boolean).join(", ");
        const matchedCity = matchPakistaniCity(rawCity, fullAddress);

        // Customer name: prefer shippingAddress.name, fallback to firstName+lastName
        const customerName =
          node.shippingAddress?.name ||
          [node.customer?.firstName, node.customer?.lastName].filter(Boolean).join(" ") ||
          "Customer";

        const items: BookingLineItem[] = (node.lineItems?.edges || []).map((e: any) => ({
          id: e.node.id,
          title: e.node.title,
          quantity: e.node.quantity,
          sku: e.node.sku || undefined,
          grams: e.node.grams || 250,
          price: Number(e.node.originalUnitPriceSet?.shopMoney?.amount || 0),
        }));

        const alreadyBooked =
          bookedOrderMap.has(orderNumber) ||
          tags.some((t: string) => t.toLowerCase().startsWith("booked-") || t.toLowerCase().startsWith("cn:"));
        const existingInfo = bookedOrderMap.get(orderNumber);

        return {
          id: node.id,
          name: orderNumber,
          createdAt: node.createdAt,
          displayFinancialStatus: node.displayFinancialStatus || "PENDING",
          isCod,
          totalPrice,
          suggestedCod: isCod ? totalPrice : 0,
          suggestedWeight: estimatePackageWeight(items),
          customerName,
          customerPhone: normalizedPhone,
          customerEmail: node.customer?.email || "",
          address1,
          address2,
          city: rawCity,
          matchedCity,
          province: node.shippingAddress?.province || "",
          zip: node.shippingAddress?.zip || "",
          country: node.shippingAddress?.country || "Pakistan",
          items,
          tags,
          alreadyBooked,
          existingTracking: existingInfo?.trackingNumber,
          existingCourier: existingInfo?.courier,
        };
      });
    } catch (error) {
      console.warn("[Booking] Live Shopify GraphQL query failed, falling back to local database:", error);
      // Fall through to DB fallback only on error
    }
  }

  // 2. DB Fallback: ONLY runs when admin is unavailable (null/undefined) or GraphQL errored above.
  // This is for development/offline mode only — never inflates real count when Shopify returns 0.
  try {
    const dbOrders = await prisma.order.findMany({
      where: { shopifyStoreId, fulfillmentStatus: "UNFULFILLED" },
      orderBy: { shopifyCreatedAt: "desc" },
      take: limit,
    }).catch(() => []);

    const existingShipments = await prisma.shipmentTrack.findMany({
      where: { shopifyStoreId },
      select: { orderNumber: true, trackingNumber: true, courier: true },
    }).catch(() => []);

    const bookedOrderMap = new Map<string, { trackingNumber: string; courier: string }>();
    for (const ship of existingShipments) {
      bookedOrderMap.set(ship.orderNumber, { trackingNumber: ship.trackingNumber, courier: ship.courier });
    }

    return dbOrders.map((order) => {
      const orderNumber = order.orderNumber;
      const totalPrice = Number(order.totalPrice || 0);
      const finStatus = (order.financialStatus || "").toUpperCase();
      const isCod = finStatus === "PENDING" || finStatus === "AUTHORIZED" || finStatus === "";

      const rawPhone = order.customerPhone || "";
      const normalizedPhone = rawPhone ? normalizePakistaniMobile(rawPhone) : "";

      const rawItems = Array.isArray(order.lineItems) ? (order.lineItems as any[]) : [];
      const items: BookingLineItem[] = rawItems.map((li, idx) => ({
        id: li.lineItemId || `li-${idx}`,
        title: li.title || "Item",
        quantity: Number(li.quantity || 1),
        sku: li.sku || undefined,
        grams: li.grams || 250,
        price: Number(li.price || 0),
      }));

      const shipping = (order as any).shippingAddress || {};
      const rawCity = shipping.city || "";
      const address1 = shipping.address1 || "";
      const address2 = shipping.address2 || "";
      const fullAddress = [address1, address2].filter(Boolean).join(", ");
      const matchedCity = matchPakistaniCity(rawCity, fullAddress);

      const alreadyBooked = bookedOrderMap.has(orderNumber);
      const existingInfo = bookedOrderMap.get(orderNumber);

      return {
        id: order.shopifyOrderId,
        name: orderNumber,
        createdAt: order.shopifyCreatedAt.toISOString(),
        displayFinancialStatus: order.financialStatus || "PENDING",
        isCod,
        totalPrice,
        suggestedCod: isCod ? totalPrice : 0,
        suggestedWeight: estimatePackageWeight(items),
        customerName: order.customerName || "Customer",
        customerPhone: normalizedPhone,
        customerEmail: order.customerEmail || "",
        address1,
        address2,
        city: rawCity,
        matchedCity,
        province: shipping.province || "",
        zip: shipping.zip || "",
        country: shipping.country || "Pakistan",
        items,
        tags: [],
        alreadyBooked,
        existingTracking: existingInfo?.trackingNumber,
        existingCourier: existingInfo?.courier,
      };
    });
  } catch (error) {
    console.error("[Booking] Database fallback for unfulfilled orders failed:", error);
    return [];
  }
}

/**
 * Creates fulfillment in Shopify with courier tracking info
 */
async function fulfillOrderInShopify(
  admin: any,
  orderId: string,
  courier: string,
  trackingNumber: string,
): Promise<{ success: boolean; fulfillmentId?: string; error?: string }> {
  try {
    const foRes = await admin.graphql(FULFILLMENT_ORDERS_QUERY, { variables: { orderId } });
    const foPayload = await foRes.json();
    const fulfillmentOrders = foPayload?.data?.order?.fulfillmentOrders?.nodes || [];

    const openFo = fulfillmentOrders.find((fo: any) => fo.status === "OPEN" || fo.status === "IN_PROGRESS");
    if (!openFo) {
      return { success: false, error: "No open fulfillment order found in Shopify." };
    }

    const companyName = courier.toUpperCase().includes("POSTEX")
      ? "PostEx"
      : courier.toUpperCase().includes("LEOPARD")
        ? "Leopards Courier"
        : courier.toUpperCase().includes("TCS")
          ? "TCS"
          : "Other";

    const url = courierTrackingUrl(courier, trackingNumber);

    const fCreateRes = await admin.graphql(FULFILLMENT_CREATE_MUTATION, {
      variables: {
        fulfillment: {
          lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: openFo.id }],
          trackingInfo: {
            company: companyName,
            number: trackingNumber,
            url,
          },
          notifyCustomer: true,
        },
      },
    });

    const fPayload = await fCreateRes.json();
    const userErrors = fPayload?.data?.fulfillmentCreateV2?.userErrors || [];
    if (userErrors.length > 0) {
      const msg = userErrors.map((e: any) => e.message).join(", ");
      return { success: false, error: msg };
    }

    return {
      success: true,
      fulfillmentId: fPayload?.data?.fulfillmentCreateV2?.fulfillment?.id,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Shopify fulfillment mutation failed.",
    };
  }
}

/**
 * Adds tracking and booking tags to the Shopify order
 */
async function tagShopifyOrder(admin: any, orderId: string, courier: string, trackingNumber: string): Promise<void> {
  try {
    const tags = [`Booked-${courier}`, `CN:${trackingNumber}`];
    await admin.graphql(TAGS_ADD_MUTATION, {
      variables: {
        id: orderId,
        tags,
      },
    });
  } catch (err) {
    console.warn(`[Booking] Could not tag order ${orderId}:`, err);
  }
}

/**
 * Books a single order with the selected courier and syncs fulfillment into Shopify and database
 */
export async function bookCourierShipment(
  admin: any,
  shopifyStoreId: string,
  session: any,
  input: SingleBookingInput,
): Promise<BookingResult> {
  const normCourier = normalizeCourierName(input.courier);

  // In-House Rider Booking
  if (normCourier === "RIDER") {
    const cleanNum = input.orderNumber.replace(/[^0-9]/g, "") || Date.now().toString().slice(-6);
    const trackingNumber = `RIDER-${cleanNum}-${Date.now().toString().slice(-4)}`;

    try {
      await prisma.shipmentTrack.upsert({
        where: { trackingNumber },
        update: {
          status: "LABEL_CREATED",
          destinationCity: input.cityName,
          codAmount: input.codAmountPKR.toFixed(2),
        },
        create: {
          shopifyStoreId,
          shopifyOrderId: input.orderId,
          orderNumber: input.orderNumber,
          type: "FORWARD",
          courier: "RIDER",
          trackingNumber,
          status: "LABEL_CREATED",
          destinationCity: input.cityName,
          codAmount: input.codAmountPKR.toFixed(2),
        },
      });

      // Fulfill in Shopify
      const fulfillment = await fulfillOrderInShopify(admin, input.orderId, "RIDER", trackingNumber);
      await tagShopifyOrder(admin, input.orderId, "Rider", trackingNumber);

      await logAction({
        shopifyStoreId,
        userId: session?.id,
        action: "COURIER_SHIPMENT_BOOKED",
        entityType: "ShipmentTrack",
        metadata: {
          orderNumber: input.orderNumber,
          courier: "RIDER",
          trackingNumber,
          cityName: input.cityName,
          codAmount: input.codAmountPKR,
        },
      });

      // Trigger optional WhatsApp booking alert
      if (input.customerPhone) {
        triggerLifecycleNotification({
          shopifyStoreId,
          eventType: "COURIER_PICKUP_BOOKED",
          channel: "WHATSAPP",
          entityId: trackingNumber,
          recipientPhone: input.customerPhone,
          recipientEmail: "",
          variables: {
            customer_name: input.customerName || "Customer",
            order_number: input.orderNumber,
            courier_name: "In-House Rider",
            tracking_number: trackingNumber,
            tracking_url: courierTrackingUrl("RIDER", trackingNumber),
            cod_amount: input.codAmountPKR.toFixed(0),
          },
        }).catch((err) => console.warn("[Booking] WhatsApp trigger skipped/error:", err));
      }

      return {
        success: true,
        orderId: input.orderId,
        orderNumber: input.orderNumber,
        courier: "RIDER",
        trackingNumber,
        fulfillmentId: fulfillment.fulfillmentId,
      };
    } catch (err) {
      return {
        success: false,
        orderId: input.orderId,
        orderNumber: input.orderNumber,
        courier: "RIDER",
        trackingNumber: "",
        error: err instanceof Error ? err.message : "Failed to record rider delivery.",
      };
    }
  }

  // Carrier API Booking (PostEx, Leopards, TCS)
  try {
    const credentials = await getDecryptedCourierCredentials(shopifyStoreId, normCourier);
    if (!credentials) {
      return {
        success: false,
        orderId: input.orderId,
        orderNumber: input.orderNumber,
        courier: normCourier,
        trackingNumber: "",
        error: `${normCourier} is not configured or disabled. Connect API credentials in Settings > Couriers.`,
      };
    }

    const adapter = CourierRegistry.get(normCourier);

    const bookingPayload = {
      shopifyStoreId,
      orderId: input.orderId,
      orderNumber: input.orderNumber,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      cityName: input.cityName,
      shipmentType: "FORWARD" as const,
      destinationAddress: {
        address1: input.customerAddress,
        city: input.cityName,
      },
      originAddress: {
        city: (credentials as any).warehouseCity || credentials.credentials?.warehouseCity || "Karachi",
      },
      weightKg: Number(input.weightKg) || 0.5,
      codAmountPKR: Number(input.codAmountPKR) || 0,
      remarks: input.remarks,
      items: input.items || [{ title: input.orderNumber, quantity: 1, price: input.codAmountPKR }],
    };

    const labelResult: LabelResult = await adapter.createForwardShipment(bookingPayload, credentials);

    if (!labelResult.success || !labelResult.trackingNumber) {
      return {
        success: false,
        orderId: input.orderId,
        orderNumber: input.orderNumber,
        courier: normCourier,
        trackingNumber: "",
        error: labelResult.error || `${normCourier} API booking was not confirmed.`,
      };
    }

    const trackingNumber = labelResult.trackingNumber;

    // Persist to ShipmentTrack
    await prisma.shipmentTrack.upsert({
      where: { trackingNumber },
      update: {
        status: "LABEL_CREATED",
        labelUrl: labelResult.labelUrl,
        destinationCity: input.cityName,
        codAmount: input.codAmountPKR.toFixed(2),
      },
      create: {
        shopifyStoreId,
        shopifyOrderId: input.orderId,
        orderNumber: input.orderNumber,
        type: "FORWARD",
        courier: normCourier,
        trackingNumber,
        labelUrl: labelResult.labelUrl,
        status: "LABEL_CREATED",
        destinationCity: input.cityName,
        codAmount: input.codAmountPKR.toFixed(2),
      },
    });

    // Fulfill in Shopify
    const fulfillment = await fulfillOrderInShopify(admin, input.orderId, normCourier, trackingNumber);

    // Tag in Shopify
    await tagShopifyOrder(admin, input.orderId, normCourier, trackingNumber);

    // Audit log
    await logAction({
      shopifyStoreId,
      userId: session?.id,
      action: "COURIER_SHIPMENT_BOOKED",
      entityType: "ShipmentTrack",
      metadata: {
        orderNumber: input.orderNumber,
        courier: normCourier,
        trackingNumber,
        cityName: input.cityName,
        codAmount: input.codAmountPKR,
        fulfillmentSuccess: fulfillment.success,
      },
    });

    // Trigger optional WhatsApp booking alert
    if (input.customerPhone) {
      triggerLifecycleNotification({
        shopifyStoreId,
        eventType: "COURIER_PICKUP_BOOKED",
        channel: "WHATSAPP",
        entityId: trackingNumber,
        recipientPhone: input.customerPhone,
        recipientEmail: "",
        variables: {
          customer_name: input.customerName || "Customer",
          order_number: input.orderNumber,
          courier_name: normCourier,
          tracking_number: trackingNumber,
          tracking_url: courierTrackingUrl(normCourier, trackingNumber),
          cod_amount: input.codAmountPKR.toFixed(0),
        },
      }).catch((err) => console.warn("[Booking] WhatsApp trigger skipped/error:", err));
    }

    return {
      success: true,
      orderId: input.orderId,
      orderNumber: input.orderNumber,
      courier: normCourier,
      trackingNumber,
      labelUrl: labelResult.labelUrl,
      fulfillmentId: fulfillment.fulfillmentId,
    };
  } catch (err) {
    return {
      success: false,
      orderId: input.orderId,
      orderNumber: input.orderNumber,
      courier: normCourier,
      trackingNumber: "",
      error: err instanceof Error ? err.message : `${normCourier} API booking encountered an error.`,
    };
  }
}

/**
 * Bulk books multiple unfulfilled orders in sequence
 */
export async function bulkBookCourierShipments(
  admin: any,
  shopifyStoreId: string,
  session: any,
  bookings: SingleBookingInput[],
): Promise<{ booked: BookingResult[]; failed: BookingResult[] }> {
  const booked: BookingResult[] = [];
  const failed: BookingResult[] = [];

  for (const booking of bookings) {
    const res = await bookCourierShipment(admin, shopifyStoreId, session, booking);
    if (res.success) {
      booked.push(res);
    } else {
      failed.push(res);
    }
    // Small delay to prevent carrier API rate limits
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  return { booked, failed };
}
