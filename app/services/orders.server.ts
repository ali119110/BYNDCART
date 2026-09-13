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
  customerName: string | null;
  totalPrice: number;
  currency: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  lineItems: MappedLineItem[];
  shopifyCreatedAt: Date;
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
              createdAt
              displayFinancialStatus
              displayFulfillmentStatus
              totalPriceSet { shopMoney { amount currencyCode } }
              customer { firstName lastName email }
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

    const { data }: any = await response.json();
    const edges = data?.orders?.edges ?? [];

    for (const edge of edges) {
      await upsertOrder(shopifyStoreId, mapGraphqlOrder(edge.node));
      synchronizedCount++;
    }

    hasNextPage = data?.orders?.pageInfo?.hasNextPage ?? false;
    cursor = data?.orders?.pageInfo?.endCursor ?? null;

    // Safety cap so a bad loop can't run away in local testing.
    if (synchronizedCount >= 500) break;
  }

  return { success: true, synchronizedCount };
}

/**
 * Retrieves orders for a store, annotated with return/exchange status
 * pulled from ReturnRequest / ExchangeRequest (matched by shopifyOrderId).
 */
export async function getStoreOrders(shopifyStoreId: string, limit = 50) {
  const orders = await prisma.order.findMany({
    where: { shopifyStoreId },
    orderBy: { shopifyCreatedAt: "desc" },
    take: limit,
  });

  if (orders.length === 0) return [];

  const orderIds = orders.map((o) => o.shopifyOrderId);

  const [returns, exchanges] = await Promise.all([
    prisma.returnRequest.findMany({
      where: { shopifyStoreId, shopifyOrderId: { in: orderIds } },
      select: { shopifyOrderId: true, status: true },
    }),
    prisma.exchangeRequest.findMany({
      where: { shopifyStoreId, shopifyOrderId: { in: orderIds } },
      select: { shopifyOrderId: true, status: true },
    }),
  ]);

  const returnStatusByOrder = new Map(returns.map((r) => [r.shopifyOrderId, r.status]));
  const exchangeStatusByOrder = new Map(exchanges.map((e) => [e.shopifyOrderId, e.status]));

  return orders.map((order) => ({
    ...order,
    totalPrice: Number(order.totalPrice), // Decimal doesn't serialize across loader boundary
    returnStatus: returnStatusByOrder.get(order.shopifyOrderId) ?? "None",
    exchangeStatus: exchangeStatusByOrder.get(order.shopifyOrderId) ?? "None",
  }));
}
