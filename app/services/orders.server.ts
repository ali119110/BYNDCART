import prisma from "../db.server";

export interface SyncOrdersInput {
  shopifyStoreId: string;
  admin: any; // authenticated GraphQL client, null in local SKIP_AUTH dev mode
}

interface MappedLineItem {
  lineItemId: string;
  variantId: string | null;
  productId: string | null;
  title: string;
  quantity: number;
  price: number;
}

interface MappedOrder {
  shopifyOrderId: string;
  orderNumber: string;
  customerEmail: string | null;
  customerPhone: string | null;
  customerName: string | null;
  totalPrice: number;
  currency: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  lineItems: MappedLineItem[];
  shopifyCreatedAt: Date;
}

function normalizePhoneDigits(value: unknown): string | null {
  let digits = String(value ?? "").replace(/\\D/g, "");
  if (digits.startsWith("0092")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = "92" + digits.slice(1);
  return digits || null;
}

/**
 * Maps a Shopify REST-shaped webhook order payload (orders/create, orders/updated)
 * into our normalized Order shape.
 */
function mapWebhookOrder(payload: any): MappedOrder {
  return {
    shopifyOrderId: `gid://shopify/Order/${payload.id}`,
    orderNumber: payload.name ?? `#${payload.order_number}`,
    customerEmail: payload.email ?? payload.customer?.email ?? null,
    customerPhone: normalizePhoneDigits(payload.phone ?? payload.customer?.phone),
    customerName: payload.customer
      ? `${payload.customer.first_name ?? ""} ${payload.customer.last_name ?? ""}`.trim() || null
      : null,
    totalPrice: parseFloat(payload.total_price ?? "0"),
    currency: payload.currency ?? "USD",
    financialStatus: payload.financial_status ?? null,
    fulfillmentStatus: payload.fulfillment_status ?? null,
    lineItems: (payload.line_items ?? []).map((li: any) => ({
      lineItemId: `gid://shopify/LineItem/${li.id}`,
      variantId: li.variant_id ? `gid://shopify/ProductVariant/${li.variant_id}` : null,
      productId: li.product_id ? `gid://shopify/Product/${li.product_id}` : null,
      title: li.title ?? li.name ?? "Unknown Item",
      quantity: li.quantity ?? 1,
      price: parseFloat(li.price ?? "0"),
    })),
    shopifyCreatedAt: new Date(payload.created_at ?? Date.now()),
  };
}

/**
 * Maps a Shopify GraphQL order node into our normalized Order shape.
 */
function mapGraphqlOrder(node: any): MappedOrder {
  return {
    shopifyOrderId: node.id,
    orderNumber: node.name,
    customerEmail: node.customer?.email ?? node.email ?? null,
    customerPhone: normalizePhoneDigits(node.phone ?? node.customer?.phone),
    customerName: node.customer
      ? `${node.customer.firstName ?? ""} ${node.customer.lastName ?? ""}`.trim() || null
      : null,
    totalPrice: parseFloat(node.totalPriceSet?.shopMoney?.amount ?? "0"),
    currency: node.totalPriceSet?.shopMoney?.currencyCode ?? "USD",
    financialStatus: node.displayFinancialStatus ?? null,
    fulfillmentStatus: node.displayFulfillmentStatus ?? null,
    lineItems: (node.lineItems?.edges ?? []).map((edge: any) => ({
      lineItemId: edge.node.id,
      variantId: edge.node.variant?.id ?? null,
      productId: edge.node.variant?.product?.id ?? null,
      title: edge.node.title,
      quantity: edge.node.quantity,
      price: parseFloat(edge.node.originalUnitPriceSet?.shopMoney?.amount ?? "0"),
    })),
    shopifyCreatedAt: new Date(node.createdAt),
  };
}

async function upsertOrder(shopifyStoreId: string, mapped: MappedOrder, payloadUpdatedAt?: Date) {
  const existing = await prisma.order.findUnique({
    where: { shopifyOrderId: mapped.shopifyOrderId },
  });

  if (existing && payloadUpdatedAt && existing.updatedAt > payloadUpdatedAt) {
    console.log(`[Orders Service] Out-of-order webhook detected for ${mapped.shopifyOrderId}. Skipping stale update.`);
    return existing;
  }

  return await prisma.order.upsert({
    where: { shopifyOrderId: mapped.shopifyOrderId },
    update: {
      orderNumber: mapped.orderNumber,
      customerEmail: mapped.customerEmail,
      customerPhone: mapped.customerPhone,
      customerName: mapped.customerName,
      totalPrice: mapped.totalPrice,
      currency: mapped.currency,
      financialStatus: mapped.financialStatus,
      fulfillmentStatus: mapped.fulfillmentStatus,
      lineItems: mapped.lineItems as any,
      syncedAt: new Date(),
    },
    create: {
      shopifyStoreId,
      shopifyOrderId: mapped.shopifyOrderId,
      orderNumber: mapped.orderNumber,
      customerEmail: mapped.customerEmail,
      customerPhone: mapped.customerPhone,
      customerName: mapped.customerName,
      totalPrice: mapped.totalPrice,
      currency: mapped.currency,
      financialStatus: mapped.financialStatus,
      fulfillmentStatus: mapped.fulfillmentStatus,
      lineItems: mapped.lineItems as any,
      shopifyCreatedAt: mapped.shopifyCreatedAt,
    },
  });
}

/**
 * Called from webhooks.server.ts on orders/create and orders/updated.
 */
export async function upsertOrderFromWebhook(shopifyStoreId: string, payload: any) {
  const mapped = mapWebhookOrder(payload);
  const updatedAt = payload.updated_at ? new Date(payload.updated_at) : undefined;
  return await upsertOrder(shopifyStoreId, mapped, updatedAt);
}

export async function cancelOrderFromWebhook(shopifyStoreId: string, payload: any) {
  const mapped = mapWebhookOrder(payload);
  mapped.fulfillmentStatus = "CANCELLED";
  mapped.financialStatus = payload.financial_status ?? "voided";
  const updatedAt = payload.updated_at ? new Date(payload.updated_at) : undefined;
  return await upsertOrder(shopifyStoreId, mapped, updatedAt);
}

/**
 * Pulls recent orders from Shopify via GraphQL and upserts them.
 * No-ops gracefully if admin is unavailable (local SKIP_AUTH dev mode).
 */
export async function syncShopifyOrders({ shopifyStoreId, admin }: SyncOrdersInput) {
  if (!admin) {
    console.log(`[Orders Service] Skipping sync for ${shopifyStoreId}: no admin client (local dev)`);
    return { success: true, synchronizedCount: 0 };
  }

  let synchronizedCount = 0;
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response: any = await admin.graphql(
      `#graphql
      query getOrders($cursor: String) {
        orders(first: 50, after: $cursor, sortKey: CREATED_AT, reverse: true) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              name
              email
              phone
              createdAt
              displayFinancialStatus
              displayFulfillmentStatus
              totalPriceSet { shopMoney { amount currencyCode } }
              customer { firstName lastName email phone }
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    title
                    quantity
                    originalUnitPriceSet { shopMoney { amount } }
                    variant { id product { id } }
                  }
                }
              }
            }
          }
        }
      }`,
      { variables: { cursor } }
    );

    const payload: any = await response.json();
    if (payload?.errors?.length) {
      throw new Error("Shopify order sync failed: " + payload.errors.map((e: any) => e.message).join("; "));
    }
    const data = payload?.data;
    const edges = data?.orders?.edges ?? [];

    for (const edge of edges) {
      await upsertOrder(shopifyStoreId, mapGraphqlOrder(edge.node));
      synchronizedCount++;
    }

    hasNextPage = data?.orders?.pageInfo?.hasNextPage ?? false;
    cursor = data?.orders?.pageInfo?.endCursor ?? null;
    if (!edges.length || !cursor) break;
  }

  return { success: true, synchronizedCount };
}

/** Loads one order from Shopify so a customer can request a verification code before the webhook arrives. */
export async function syncCustomerOrder(shopifyStoreId: string, orderNumber: string) {
  const { getShopifyAdminClient } = await import("./shopifySync.server");
  const admin = await getShopifyAdminClient(shopifyStoreId);
  if (!admin) return null;

  const stripped = orderNumber.trim().replace(/^#/, "");
  if (!stripped) return null;
  return searchOrSyncOrders({ shopifyStoreId, admin, query: `name:${stripped}` });
}

/**
 * Searches Shopify for the requested query and returns those matching orders.
 * The old implementation synced matching orders, then returned the newest 100
 * cached orders, which meant the visible results did not correspond to the query.
 */
export async function searchOrSyncOrders({ shopifyStoreId, admin, query }: SyncOrdersInput & { query: string }) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];

  if (!admin) {
    // Local/dev fallback: filter a larger tenant-scoped snapshot in memory.
    const cached = await prisma.order.findMany({
      where: { shopifyStoreId },
      orderBy: { shopifyCreatedAt: "desc" },
      take: 1000,
    });
    const q = normalizedQuery.toLowerCase().replace(/^#/, "");
    const matches = cached.filter((order: any) => {
      const lines = Array.isArray(order.lineItems) ? order.lineItems : [];
      return String(order.orderNumber || "").toLowerCase().replace(/^#/, "").includes(q)
        || String(order.customerName || "").toLowerCase().includes(q)
        || String(order.customerEmail || "").toLowerCase().includes(q)
        || lines.some((line: any) => String(line.title || "").toLowerCase().includes(q));
    });
    return annotateOrders(shopifyStoreId, matches);
  }

  const mappedOrders: MappedOrder[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const response: any = await admin.graphql(
      `#graphql
      query searchOrders($query: String!, $cursor: String) {
        orders(first: 100, after: $cursor, query: $query, sortKey: CREATED_AT, reverse: true) {
          pageInfo { hasNextPage endCursor }
          edges { node {
            id name email phone createdAt displayFinancialStatus displayFulfillmentStatus
            totalPriceSet { shopMoney { amount currencyCode } }
            customer { firstName lastName email phone }
            lineItems(first: 50) { edges { node {
              id title quantity originalUnitPriceSet { shopMoney { amount } }
              variant { id product { id } }
            } } }
          } }
        }
      }`,
      { variables: { query: normalizedQuery, cursor } }
    );
    const payload = await response.json();
    const errors = payload?.errors || [];
    if (errors.length) throw new Error(`Shopify order search failed: ${errors.map((e: any) => e.message).join("; ")}`);
    const orderConnection = payload?.data?.orders;
    const edges = orderConnection?.edges ?? [];
    for (const edge of edges) mappedOrders.push(mapGraphqlOrder(edge.node));
    hasNextPage = Boolean(orderConnection?.pageInfo?.hasNextPage);
    cursor = orderConnection?.pageInfo?.endCursor ?? null;
    if (!edges.length || !cursor) break;
  }

  // Upsert the exact search results, then return those IDs—not the newest cached
  // orders. Pagination supports broad customer/product searches beyond page one.
  for (const mapped of mappedOrders) await upsertOrder(shopifyStoreId, mapped);
  if (!mappedOrders.length) return [];
  const matchingIds = mappedOrders.map((order) => order.shopifyOrderId);
  const matchedOrders = await prisma.order.findMany({
    where: { shopifyStoreId, shopifyOrderId: { in: matchingIds } },
    orderBy: { shopifyCreatedAt: "desc" },
  });
  return annotateOrders(shopifyStoreId, matchedOrders);
}

/**
 * Retrieves orders for a store, annotated with return/exchange status.
 */
export async function getStoreOrders(shopifyStoreId: string, limit = 50, admin?: any) {
  const orders = await prisma.order.findMany({
    where: { shopifyStoreId },
    orderBy: { shopifyCreatedAt: "desc" },
    take: limit,
  });

  if (orders.length === 0 && admin) {
    await syncShopifyOrders({ shopifyStoreId, admin });
    return getStoreOrders(shopifyStoreId, limit);
  }
  if (orders.length === 0) return [];
  return annotateOrders(shopifyStoreId, orders);
}

async function annotateOrders(shopifyStoreId: string, orders: any[]) {
  if (!orders.length) return [];
  const orderIds = orders.map((order) => order.shopifyOrderId);
  const [returns, exchanges] = await Promise.all([
    prisma.returnRequest.findMany({
      where: { shopifyStoreId, shopifyOrderId: { in: orderIds } },
      select: { shopifyOrderId: true, status: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.exchangeRequest.findMany({
      where: { shopifyStoreId, shopifyOrderId: { in: orderIds } },
      select: { shopifyOrderId: true, status: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
    }),
  ]);

  const returnStatusByOrder = new Map<string, string>();
  const exchangeStatusByOrder = new Map<string, string>();
  for (const record of returns) if (!returnStatusByOrder.has(record.shopifyOrderId)) returnStatusByOrder.set(record.shopifyOrderId, record.status);
  for (const record of exchanges) if (!exchangeStatusByOrder.has(record.shopifyOrderId)) exchangeStatusByOrder.set(record.shopifyOrderId, record.status);

  return orders.map((order) => ({
    ...order,
    totalPrice: Number(order.totalPrice),
    returnStatus: returnStatusByOrder.get(order.shopifyOrderId) ?? "None",
    exchangeStatus: exchangeStatusByOrder.get(order.shopifyOrderId) ?? "None",
  }));
}
