import prisma from "../db.server";
import { CourierRegistry, getDecryptedCourierCredentials, type LabelResult } from "./courier.server";
import { logAction } from "./audit.server";
import { triggerLifecycleNotification } from "./notifications.server";
import { getCourierOperationsSettings } from "./settings.server";
import { checkFeatureAccess } from "./planGate.server";
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
  displayFulfillmentStatus: string;
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
  serviceType?: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  customerAddress: string;
  cityName: string;
  codAmountPKR: number;
  weightKg: number;
  shipperProfileIndex?: number;
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
  /** Carrier booking succeeded but Shopify rejected or could not confirm fulfillment. */
  fulfillmentSyncError?: string;
}

const UNFULFILLED_ORDERS_QUERY = `#graphql
  query UnfulfilledOrders($first: Int!) {
    orders(first: $first, query: "status:open AND fulfillment_status:unfulfilled", sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          name
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          paymentGatewayNames
          tags
          currentTotalPriceSet {
            shopMoney {
              amount
            }
          }
          totalPriceSet {
            shopMoney {
              amount
            }
          }
          totalOutstandingSet {
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
                weight {
                  value
                  unit
                }
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

const BOOKING_ORDER_STATUS_QUERY = `#graphql
  query VerifyBookingOrder($orderId: ID!) {
    order(id: $orderId) {
      id
      name
      displayFulfillmentStatus
      closedAt
      cancelledAt
    }
  }
`;

const FULFILLMENT_ORDERS_QUERY = `#graphql
  query GetOrderFulfillmentOrders($orderId: ID!) {
    order(id: $orderId) {
      id
      displayFulfillmentStatus
      fulfillments(first: 30) {
        nodes {
          id
          trackingInfo {
            number
          }
        }
      }
      fulfillmentOrders(first: 20, includeClosed: true) {
        nodes {
          id
          status
          supportedActions {
            action
          }
          assignedLocation {
            location {
              id
            }
          }
          fulfillments(first: 10) {
            nodes {
              id
              trackingInfo {
                number
              }
            }
          }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE_MUTATION = `#graphql
  mutation CreateFulfillment($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
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
function lineItemWeightInGrams(weight: any): number {
  const value = Number(weight?.value);
  if (!Number.isFinite(value) || value <= 0) return 250;

  switch (String(weight?.unit || "").toUpperCase()) {
    case "GRAMS":
      return value;
    case "KILOGRAMS":
      return value * 1000;
    case "OUNCES":
      return value * 28.349523125;
    case "POUNDS":
      return value * 453.59237;
    default:
      return 250;
  }
}

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
      if (payload?.errors?.length) {
        throw new Error(payload.errors.map((entry: any) => entry.message).filter(Boolean).join("; "));
      }
      if (!payload?.data?.orders || !Array.isArray(payload.data.orders.edges)) {
        throw new Error("Shopify returned an unexpected orders response.");
      }

      // Do not trust the search query alone: only show genuinely unfulfilled orders.
      const orderNodes = payload.data.orders.edges
        .map((edge: any) => edge.node)
        .filter((node: any) => String(node?.displayFulfillmentStatus || "").toUpperCase() === "UNFULFILLED");

      // Get all existing active forward shipments for this store to identify already booked orders
      const existingShipments = await prisma.shipmentTrack.findMany({
        where: { shopifyStoreId, type: "FORWARD", status: { not: "FAILED" } },
        select: { orderNumber: true, trackingNumber: true, courier: true },
      }).catch(() => []);

      const bookedOrderMap = new Map<string, { trackingNumber: string; courier: string }>();
      for (const ship of existingShipments) {
        bookedOrderMap.set(ship.orderNumber, { trackingNumber: ship.trackingNumber, courier: ship.courier });
      }

      // Map Shopify nodes to UnfulfilledOrder — extracts real customer/address data
      const mappedOrders: UnfulfilledOrder[] = orderNodes.map((node: any) => {
        const orderNumber = String(node.name || "");
        const totalPrice = Number(
          node.currentTotalPriceSet?.shopMoney?.amount
          ?? node.totalPriceSet?.shopMoney?.amount
          ?? 0
        );
        const finStatus = String(node.displayFinancialStatus || "").toUpperCase();
        const paymentGateways: string[] = Array.isArray(node.paymentGatewayNames)
          ? node.paymentGatewayNames.map((name: unknown) => String(name || "").trim()).filter(Boolean)
          : [];
        const hasCodGateway = paymentGateways.some((gateway) =>
          /cash\s*on\s*delivery|\bcod\b|\bcash\b|\bmanual\b/i.test(gateway)
        );
        const isCod = hasCodGateway
          || (paymentGateways.length === 0 && (finStatus === "PENDING" || finStatus === "AUTHORIZED"));
        const rawOutstanding = node.totalOutstandingSet?.shopMoney?.amount;
        const outstandingAmount = rawOutstanding === undefined || rawOutstanding === null
          ? totalPrice
          : Number(rawOutstanding);
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
          grams: lineItemWeightInGrams(e.node.weight),
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
          displayFulfillmentStatus: String(node.displayFulfillmentStatus || "UNFULFILLED").toUpperCase(),
          isCod,
          totalPrice,
          // On COD/manual-gateway orders, collect the outstanding balance. Some COD apps
          // mark the Shopify order paid prematurely; if that leaves zero outstanding, use the
          // current order total because the carrier still needs the COD amount.
          suggestedCod: isCod
            ? (Number.isFinite(outstandingAmount) && outstandingAmount > 0 ? outstandingAmount : totalPrice)
            : 0,
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

      // Do not offer an order again if a forward label already exists, or Shopify has its booking tag.
      return mappedOrders.filter((order) => !order.alreadyBooked);
    } catch (error) {
      console.error("[Booking] Live Shopify GraphQL query failed; refusing stale database orders:", error);
      const details = error instanceof Error ? error.message : "Unknown Shopify GraphQL error.";
      throw new Error(`Unable to load current unfulfilled orders from Shopify: ${details}`);
    }
  }

  // 2. Database fallback is only for local/offline development when no Shopify admin client exists.
  try {
    const dbOrders = await prisma.order.findMany({
      where: { shopifyStoreId, fulfillmentStatus: "UNFULFILLED" },
      orderBy: { shopifyCreatedAt: "desc" },
      take: limit,
    }).catch(() => []);

    const existingShipments = await prisma.shipmentTrack.findMany({
      where: { shopifyStoreId, type: "FORWARD", status: { not: "FAILED" } },
      select: { orderNumber: true, trackingNumber: true, courier: true },
    }).catch(() => []);

    const bookedOrderMap = new Map<string, { trackingNumber: string; courier: string }>();
    for (const ship of existingShipments) {
      bookedOrderMap.set(ship.orderNumber, { trackingNumber: ship.trackingNumber, courier: ship.courier });
    }

    const mappedOrders: UnfulfilledOrder[] = dbOrders.map((order) => {
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
        displayFulfillmentStatus: String(order.fulfillmentStatus || "UNFULFILLED").toUpperCase(),
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
    return mappedOrders.filter((order) => !order.alreadyBooked);
  } catch (error) {
    console.error("[Booking] Database fallback for unfulfilled orders failed:", error);
    return [];
  }
}

/**
 * Creates fulfillment in Shopify with courier tracking info
 */
export async function fulfillOrderInShopify(
  admin: any,
  orderId: string,
  courier: string,
  trackingNumber: string,
): Promise<{ success: boolean; fulfillmentId?: string; error?: string }> {
  if (!admin) {
    return { success: false, error: "Shopify admin client is unavailable. Reopen the app and retry Shopify fulfillment sync." };
  }
  if (!orderId || !trackingNumber) {
    return { success: false, error: "A Shopify order ID and confirmed courier tracking number are required." };
  }

  try {
    const foRes = await admin.graphql(FULFILLMENT_ORDERS_QUERY, { variables: { orderId } });
    const foPayload = await foRes.json();
    const queryErrors = Array.isArray(foPayload?.errors) ? foPayload.errors : [];
    if (queryErrors.length) {
      return {
        success: false,
        error: queryErrors.map((entry: any) => String(entry?.message || "Shopify GraphQL query failed.")).join("; "),
      };
    }

    const order = foPayload?.data?.order;
    if (!order || order.id !== orderId) {
      return { success: false, error: "Shopify order was not found or is not accessible to this app." };
    }

    const fulfillments = Array.isArray(order.fulfillments?.nodes) ? order.fulfillments.nodes : [];
    const matchingFulfillments = fulfillments.filter((fulfillment: any) =>
      Array.isArray(fulfillment.trackingInfo)
      && fulfillment.trackingInfo.some((tracking: any) =>
        String(tracking?.number || "").trim() === String(trackingNumber).trim()
      )
    );

    const allFulfillmentOrders = Array.isArray(order.fulfillmentOrders?.nodes) ? order.fulfillmentOrders.nodes : [];
    const targetTracking = String(trackingNumber).trim();
    const alreadySyncedFulfillmentOrderIds = new Set<string>();
    for (const fulfillmentOrder of allFulfillmentOrders) {
      const existingFulfillmentForTracking = (fulfillmentOrder.fulfillments?.nodes || []).some((fulfillment: any) =>
        Array.isArray(fulfillment.trackingInfo)
        && fulfillment.trackingInfo.some((tracking: any) =>
          String(tracking?.number || "").trim() === targetTracking
        )
      );
      if (existingFulfillmentForTracking && fulfillmentOrder?.id) {
        alreadySyncedFulfillmentOrderIds.add(String(fulfillmentOrder.id));
      }
    }

    if (String(order.displayFulfillmentStatus || "").toUpperCase() === "FULFILLED") {
      if (matchingFulfillments.length) {
        return { success: true, fulfillmentId: matchingFulfillments[0]?.id };
      }
      return {
        success: false,
        error: "Shopify already marks this order fulfilled with different or missing tracking information. No duplicate fulfillment was created; verify the order in Shopify before retrying.",
      };
    }

    const eligibleFulfillmentOrders = allFulfillmentOrders.filter((fulfillmentOrder: any) => {
      const status = String(fulfillmentOrder?.status || "").toUpperCase();
      const supportedActions = Array.isArray(fulfillmentOrder?.supportedActions)
        ? fulfillmentOrder.supportedActions.map((action: any) => String(action?.action || "").toUpperCase())
        : [];
      return ["OPEN", "IN_PROGRESS"].includes(status)
        && supportedActions.includes("CREATE_FULFILLMENT")
        && !alreadySyncedFulfillmentOrderIds.has(String(fulfillmentOrder.id));
    });

    // One Shopify fulfillment can include multiple fulfillment orders only when they
    // belong to the same order and the same location. Preserve that rule for multi-location orders.
    const groups = new Map<string, any[]>();
    for (const fulfillmentOrder of eligibleFulfillmentOrders) {
      const locationId = fulfillmentOrder.assignedLocation?.location?.id;
      const groupKey = locationId ? String(locationId) : `fulfillment-order:${fulfillmentOrder.id}`;
      groups.set(groupKey, [...(groups.get(groupKey) || []), fulfillmentOrder]);
    }

    if (!groups.size) {
      if (matchingFulfillments.length) {
        return { success: true, fulfillmentId: matchingFulfillments[0]?.id };
      }
      const statusSummary = allFulfillmentOrders
        .map((fulfillmentOrder: any) => `${fulfillmentOrder.status || "UNKNOWN"} (${(fulfillmentOrder.supportedActions || []).map((action: any) => action.action).join(", ") || "no supported actions"})`)
        .join("; ");
      return {
        success: false,
        error: statusSummary
          ? `Shopify has no fulfillment order available for this app to fulfill. Current fulfillment orders: ${statusSummary}. Check the fulfillment location and app permissions.`
          : "No open fulfillment order found in Shopify. The order may be assigned to a fulfillment service or already fulfilled.",
      };
    }

    const normalizedCourier = courier.toUpperCase();
    const companyName = normalizedCourier.includes("POSTEX")
      ? "PostEx"
      : normalizedCourier.includes("LEOPARD")
        ? "Leopards Courier"
        : normalizedCourier.includes("TCS")
          ? "TCS"
          : "Other";
    const url = courierTrackingUrl(courier, trackingNumber);
    const createdFulfillmentIds: string[] = matchingFulfillments
      .map((fulfillment: any) => String(fulfillment?.id || ""))
      .filter(Boolean);

    for (const fulfillmentOrders of groups.values()) {
      const fCreateRes = await admin.graphql(FULFILLMENT_CREATE_MUTATION, {
        variables: {
          fulfillment: {
            lineItemsByFulfillmentOrder: fulfillmentOrders.map((fulfillmentOrder: any) => ({
              fulfillmentOrderId: fulfillmentOrder.id,
            })),
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
      const mutationErrors = Array.isArray(fPayload?.errors) ? fPayload.errors : [];
      if (mutationErrors.length) {
        return {
          success: false,
          fulfillmentId: createdFulfillmentIds[0],
          error: mutationErrors.map((entry: any) => String(entry?.message || "Shopify fulfillment mutation failed.")).join("; "),
        };
      }

      const result = fPayload?.data?.fulfillmentCreate;
      const userErrors = Array.isArray(result?.userErrors) ? result.userErrors : [];
      if (userErrors.length) {
        return {
          success: false,
          fulfillmentId: createdFulfillmentIds[0],
          error: userErrors.map((entry: any) => String(entry?.message || "Shopify rejected the fulfillment.")).join("; "),
        };
      }
      if (!result?.fulfillment?.id) {
        return {
          success: false,
          fulfillmentId: createdFulfillmentIds[0],
          error: "Shopify returned no fulfillment ID. The courier booking may exist, but Shopify fulfillment was not confirmed.",
        };
      }
      const fulfillmentStatus = String(result.fulfillment.status || "").toUpperCase();
      if (["ERROR", "FAILURE", "CANCELLED"].includes(fulfillmentStatus)) {
        return {
          success: false,
          fulfillmentId: createdFulfillmentIds[0],
          error: `Shopify returned fulfillment status ${fulfillmentStatus} instead of confirming success.`,
        };
      }
      createdFulfillmentIds.push(String(result.fulfillment.id));
    }

    return {
      success: true,
      fulfillmentId: createdFulfillmentIds[0],
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Shopify fulfillment mutation failed.",
    };
  }
}

function canonicalCustomerPhone(value: unknown): string {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("0092")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return `92${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith("3")) return `92${digits}`;
  return digits;
}

function customerPhoneVariants(value: unknown): string[] {
  const raw = String(value || "").replace(/\D/g, "");
  const canonical = canonicalCustomerPhone(raw);
  const variants = new Set([raw, canonical]);
  if (canonical.startsWith("92") && canonical.length === 12) variants.add(`0${canonical.slice(2)}`);
  if (raw.startsWith("0") && raw.length === 11) variants.add(`92${raw.slice(1)}`);
  return Array.from(variants).filter((v) => v.length >= 10);
}

/**
 * Evaluate shared, merchant-level duplicate/trust rules from the combined BYNDCART
 * order and shipment history. These checks are best-effort and never block a carrier booking.
 */
async function sharedCourierRuleTags(
  shopifyStoreId: string,
  orderId: string,
  customerPhone: string,
): Promise<string[]> {
  const rules = await getCourierOperationsSettings(shopifyStoreId);
  const variants = customerPhoneVariants(customerPhone);
  if (!variants.length || (!rules.fraudCheckEnabled && !rules.duplicateCheckEnabled)) return [];

  // Enforce the paid-plan gate at runtime too, so saved settings cannot keep running after downgrade.
  const aiChecksAllowed = await checkFeatureAccess(shopifyStoreId, "COURIER_AI_CHECKS").catch(() => false);
  if (!aiChecksAllowed) return [];

  const tags = new Set<string>();

  if (rules.duplicateCheckEnabled) {
    try {
      const cutoff = new Date(Date.now() - rules.duplicateCheckDurationMinutes * 60 * 1000);
      const recentOrders = await prisma.order.findMany({
        where: {
          shopifyStoreId,
          shopifyOrderId: { not: orderId },
          shopifyCreatedAt: { gte: cutoff },
          customerPhone: { in: variants },
        },
        select: { shopifyOrderId: true },
        take: 100,
        orderBy: { shopifyCreatedAt: "desc" },
      });
      if (recentOrders.length > 0) tags.add("courier: Duplicate Order");
    } catch (error) {
      console.warn("[Booking] Duplicate check could not read recent order history:", error);
    }
  }

  if (rules.fraudCheckEnabled) {
    try {
      const historyOrders = await prisma.order.findMany({
        where: { shopifyStoreId, customerPhone: { in: variants } },
        select: { shopifyOrderId: true },
        take: 1000,
        orderBy: { shopifyCreatedAt: "desc" },
      });
      const orderIds = Array.from(new Set(historyOrders.map((row) => row.shopifyOrderId).filter(Boolean)));
      const shipments = orderIds.length
        ? await prisma.shipmentTrack.findMany({
            where: {
              shopifyStoreId,
              shopifyOrderId: { in: orderIds },
              type: "FORWARD",
              status: { notIn: ["FAILED", "CANCELLED"] },
            },
            select: { status: true },
            take: 2000,
          })
        : [];
      const ratio = shipments.length
        ? shipments.filter((shipment) => String(shipment.status).toUpperCase() === "DELIVERED").length / shipments.length
        : null;
      const rule = rules.fraudTagDefinition;
      const thresholdMatch = rule.match(/>\s*(\d+(?:\.\d+)?)\s*%/);
      const threshold = thresholdMatch ? Number(thresholdMatch[1]) / 100 : 0.85;
      const tagName = rule.split(/\s+-\s+if\s+|\s+—\s+/i)[0].trim();
      const isReviewRule = /review|risk|fraud/i.test(tagName);
      if (ratio !== null && tagName && (
        (isReviewRule && ratio <= threshold)
        || (!isReviewRule && ratio > threshold)
      )) {
        tags.add(tagName);
      }
    } catch (error) {
      console.warn("[Booking] Customer trust check could not read cross-courier shipment history:", error);
    }
  }

  return Array.from(tags);
}

async function scheduleCourierTrackingRefresh(shopifyStoreId: string): Promise<void> {
  try {
    const { ensureCourierTrackingScheduled } = await import("../worker.server");
    await ensureCourierTrackingScheduled(shopifyStoreId);
  } catch (error) {
    console.warn("[Booking] Shipment was saved, but automatic tracking could not be queued:", error);
  }
}

/**
 * Adds tracking tags plus the shared trust/duplicate tags to a Shopify order.
 */
async function tagShopifyOrder(
  admin: any,
  shopifyStoreId: string,
  orderId: string,
  courier: string,
  trackingNumber: string,
  customerPhone: string,
): Promise<void> {
  try {
    const tags = [`Booked-${courier}`, `CN:${trackingNumber}`];
    for (const tag of await sharedCourierRuleTags(shopifyStoreId, orderId, customerPhone)) {
      if (!tags.includes(tag)) tags.push(tag);
    }
    const response = await admin.graphql(TAGS_ADD_MUTATION, { variables: { id: orderId, tags } });
    const payload = await response.json().catch(() => ({}));
    const errors = payload?.data?.tagsAdd?.userErrors || [];
    if (errors.length) console.warn(`[Booking] Shopify rejected order tags for ${orderId}:`, errors);
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
  const serviceType = input.serviceType || "Normal";
  const shipmentType = serviceType === "Reverse" || serviceType === "Reversed"
    ? "RETURN"
    : serviceType === "Replacement" ? "EXCHANGE" : "FORWARD";
  const shipperProfileIndex = Number.isInteger(input.shipperProfileIndex)
    && Number(input.shipperProfileIndex) >= 0
    && Number(input.shipperProfileIndex) < 3
    ? Number(input.shipperProfileIndex)
    : undefined;

  const normalizedPhone = normalizePakistaniMobile(String(input.customerPhone || ""));
  let validationError: string | null = null;
  if (!input.orderId || !String(input.orderNumber || "").trim()) validationError = "Select a valid Shopify order before booking.";
  else if (!String(input.customerName || "").trim()) validationError = "Customer name is required.";
  else if (!isValidPakistaniMobile(normalizedPhone)) validationError = "Enter a valid Pakistani mobile number (e.g. 03001234567).";
  else if (!String(input.customerAddress || "").trim() || String(input.customerAddress || "").trim().length < 8) validationError = "Enter a complete delivery address (at least 8 characters).";
  else if (!String(input.cityName || "").trim()) validationError = "Select the customer's city before booking.";
  else if (!Number.isFinite(Number(input.weightKg)) || Number(input.weightKg) <= 0 || Number(input.weightKg) > 50) validationError = "Weight must be between 0.1 and 50 kg.";
  else if (!Number.isFinite(Number(input.codAmountPKR)) || Number(input.codAmountPKR) < 0) validationError = "COD amount must be zero or greater.";
  if (validationError) {
    return {
      success: false,
      orderId: input.orderId,
      orderNumber: input.orderNumber,
      courier: normCourier,
      trackingNumber: "",
      error: validationError,
    };
  }
  if (normCourier === "RIDER" && serviceType !== "Normal") {
    return {
      success: false,
      orderId: input.orderId,
      orderNumber: input.orderNumber,
      courier: normCourier,
      trackingNumber: "",
      error: "In-House Rider currently supports Normal bookings only.",
    };
  }

  // Revalidate the selected order against Shopify immediately before booking. The page may
  // be stale, or a crafted request could otherwise book a fulfilled/cancelled order.
  if (admin) {
    try {
      const verifyResponse = await admin.graphql(BOOKING_ORDER_STATUS_QUERY, {
        variables: { orderId: input.orderId },
      });
      const verifyPayload = await verifyResponse.json();
      if (verifyPayload?.errors?.length) {
        throw new Error(verifyPayload.errors.map((item: any) => item.message).filter(Boolean).join("; "));
      }
      const liveOrder = verifyPayload?.data?.order;
      if (!liveOrder || liveOrder.id !== input.orderId || liveOrder.name !== input.orderNumber) {
        return {
          success: false,
          orderId: input.orderId,
          orderNumber: input.orderNumber,
          courier: normCourier,
          trackingNumber: "",
          error: "This order could not be confirmed in Shopify. Refresh the booking page and try again.",
        };
      }
      if (
        String(liveOrder.displayFulfillmentStatus || "").toUpperCase() !== "UNFULFILLED"
        || liveOrder.closedAt
        || liveOrder.cancelledAt
      ) {
        return {
          success: false,
          orderId: input.orderId,
          orderNumber: input.orderNumber,
          courier: normCourier,
          trackingNumber: "",
          error: "This order is no longer open and unfulfilled in Shopify. Refresh the booking page before booking.",
        };
      }
    } catch (error) {
      return {
        success: false,
        orderId: input.orderId,
        orderNumber: input.orderNumber,
        courier: normCourier,
        trackingNumber: "",
        error: error instanceof Error
          ? `Shopify order verification failed: ${error.message}`
          : "Could not verify this order with Shopify. No courier booking was submitted.",
      };
    }
  }

  // Prevent repeat normal bookings even if the UI is stale or the request is submitted twice.
  if (shipmentType === "FORWARD") {
    try {
      const existingBooking = await prisma.shipmentTrack.findFirst({
        where: {
          shopifyStoreId,
          shopifyOrderId: input.orderId,
          type: "FORWARD",
          status: { notIn: ["FAILED", "CANCELLED"] },
        },
        select: { trackingNumber: true, courier: true },
      });
      if (existingBooking) {
        return {
          success: false,
          orderId: input.orderId,
          orderNumber: input.orderNumber,
          courier: normCourier,
          trackingNumber: "",
          error: `This order already has an active ${existingBooking.courier} booking (CN: ${existingBooking.trackingNumber}). Cancel it before creating another normal booking.`,
        };
      }
    } catch (error) {
      return {
        success: false,
        orderId: input.orderId,
        orderNumber: input.orderNumber,
        courier: normCourier,
        trackingNumber: "",
        error: "Could not check for an existing booking. No new courier booking was submitted; retry after checking the shipment history.",
      };
    }
  }

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
          shipperProfileIndex,
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
          shipperProfileIndex,
        },
      });
      await scheduleCourierTrackingRefresh(shopifyStoreId);

      // Fulfill in Shopify
      const fulfillment = await fulfillOrderInShopify(admin, input.orderId, "RIDER", trackingNumber);
      await tagShopifyOrder(admin, shopifyStoreId, input.orderId, "Rider", trackingNumber, input.customerPhone);

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
        fulfillmentSyncError: fulfillment.success ? undefined : fulfillment.error || "Shopify fulfillment could not be confirmed.",
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
    const sharedCourierSettings = await getCourierOperationsSettings(shopifyStoreId).catch((settingsError) => {
      console.warn("[Booking] Could not read shared shipper profile; using empty profile defaults.", settingsError);
      return null;
    });
    const effectiveShipperProfileIndex = shipperProfileIndex ?? sharedCourierSettings?.defaultShipperProfileIndex ?? 0;
    const selectedShipperProfile = sharedCourierSettings?.shipperProfiles[effectiveShipperProfileIndex]
      || sharedCourierSettings?.shipperProfiles[0]
      || { name: "", phone: "", email: "", city: "", state: "", postalCode: "", countryCode: "PK", address: "" };
    const shipperAddress = {
      address1: selectedShipperProfile.address || "",
      city: selectedShipperProfile.city || "",
      name: selectedShipperProfile.name || "",
      phone: selectedShipperProfile.phone || "",
      email: selectedShipperProfile.email || "",
      state: selectedShipperProfile.state || "",
      postalCode: selectedShipperProfile.postalCode || "",
      countryCode: selectedShipperProfile.countryCode || "PK",
    };
    const customerAddress = {
      address1: input.customerAddress,
      city: input.cityName,
      name: input.customerName,
      phone: input.customerPhone,
      email: input.customerEmail || "",
      countryCode: "PK",
    };

    const bookingPayload = {
      shopifyStoreId,
      orderId: input.orderId,
      orderNumber: input.orderNumber,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      customerEmail: input.customerEmail || "",
      cityName: input.cityName,
      shipmentType: shipmentType as "RETURN" | "FORWARD" | "EXCHANGE",
      courierServiceType: serviceType,
      destinationAddress: shipmentType === "RETURN" ? shipperAddress : customerAddress,
      originAddress: shipmentType === "RETURN" ? customerAddress : shipperAddress,
      weightKg: Number(input.weightKg) || 0.5,
      codAmountPKR: shipmentType === "RETURN" ? 0 : Number(input.codAmountPKR) || 0,
      remarks: input.remarks,
      items: input.items || [{ title: input.orderNumber, quantity: 1, price: input.codAmountPKR }],
    };

    const labelResult: LabelResult = shipmentType === "RETURN"
      ? await adapter.createReverseShipment(bookingPayload, credentials)
      : await adapter.createForwardShipment(bookingPayload, credentials);

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
        type: shipmentType,
        labelUrl: labelResult.labelUrl,
        destinationCity: input.cityName,
        codAmount: (shipmentType === "RETURN" ? 0 : input.codAmountPKR).toFixed(2),
        shipperProfileIndex,
      },
      create: {
        shopifyStoreId,
        shopifyOrderId: input.orderId,
        orderNumber: input.orderNumber,
        type: shipmentType,
        courier: normCourier,
        trackingNumber,
        labelUrl: labelResult.labelUrl,
        status: "LABEL_CREATED",
        destinationCity: input.cityName,
        codAmount: (shipmentType === "RETURN" ? 0 : input.codAmountPKR).toFixed(2),
        shipperProfileIndex,
      },
    });
    await scheduleCourierTrackingRefresh(shopifyStoreId);

    // A reverse pickup must not fulfill the original Shopify order.
    const fulfillment = shipmentType === "RETURN"
      ? { success: true as const, fulfillmentId: undefined }
      : await fulfillOrderInShopify(admin, input.orderId, normCourier, trackingNumber);

    // Tag in Shopify
    await tagShopifyOrder(admin, shopifyStoreId, input.orderId, normCourier, trackingNumber, input.customerPhone);

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
        fulfillmentSyncError: fulfillment.success ? undefined : fulfillment.error,
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
      fulfillmentSyncError: fulfillment.success ? undefined : fulfillment.error || "Shopify fulfillment could not be confirmed.",
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
