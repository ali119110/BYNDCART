import prisma from "../db.server";

export interface ShopifySyncInput {
  shopifyStoreId: string;
  entityId: string; // returnRequestId or exchangeRequestId
  admin?: any; // optional provided admin client
}

/**
 * Resolves active authenticated Shopify Admin GraphQL client for a tenant store.
 */
export async function getShopifyAdminClient(shopifyStoreId: string, providedAdmin?: any) {
  if (providedAdmin) return providedAdmin;

  try {
    const store = await prisma.shopifyStore.findUnique({
      where: { id: shopifyStoreId },
    });

    if (!store?.shop) {
      console.log(`[ShopifySync] No shop found for store ID ${shopifyStoreId}`);
      return null;
    }

    const { unauthenticated } = await import("../shopify.server");
    const { admin } = await unauthenticated.admin(store.shop);
    return admin;
  } catch (error) {
    console.warn(`[ShopifySync] Could not resolve offline admin client for store ${shopifyStoreId}:`, error);
    return null;
  }
}

/**
 * 1. Executes Shopify Admin GraphQL `returnCreate` mutation.
 * Idempotent: Skips if shopifyReturnId is already set on ReturnRequest.
 */
export async function executeShopifyReturnCreate({ shopifyStoreId, entityId, admin }: ShopifySyncInput) {
  const returnRequest = await prisma.returnRequest.findFirst({
    where: { id: entityId, shopifyStoreId },
    include: { items: true },
  });

  if (!returnRequest) {
    throw new Error(`Return request ${entityId} not found for store ${shopifyStoreId}`);
  }

  // Idempotency check: if return is already registered in Shopify, return existing ID
  if (returnRequest.shopifyReturnId) {
    console.log(`[ShopifySync] Idempotent skip: returnCreate already executed for Return ${entityId} (${returnRequest.shopifyReturnId})`);
    return { success: true, shopifyReturnId: returnRequest.shopifyReturnId, idempotent: true };
  }

  const client = await getShopifyAdminClient(shopifyStoreId, admin);
  if (!client) {
    console.log(`[ShopifySync] No admin client available — skipping live returnCreate for Return ${entityId}`);
    return { success: false, skipped: true, reason: "No admin client available" };
  }

  const returnLineItems = returnRequest.items.map((item) => ({
    lineItemId: item.shopifyLineItemId,
    quantity: item.quantity,
    returnReason: "SIZE_TOO_SMALL",
    returnReasonNote: item.reasonNote || item.reason || "Customer return",
  }));

  const response = await client.graphql(
    `#graphql
    mutation returnCreate($returnInput: ReturnInput!) {
      returnCreate(returnInput: $returnInput) {
        return {
          id
          name
          status
        }
        userErrors {
          field
          message
          code
        }
      }
    }`,
    {
      variables: {
        returnInput: {
          orderId: returnRequest.shopifyOrderId,
          returnLineItems,
        },
      },
    }
  );

  const { data } = await response.json();
  const userErrors = data?.returnCreate?.userErrors ?? [];

  if (userErrors.length > 0) {
    const errorMsg = `Shopify returnCreate userErrors: ${userErrors.map((e: any) => `${e.field ? e.field.join('.') + ': ' : ''}${e.message}`).join("; ")}`;
    await prisma.auditLog.create({
      data: {
        shopifyStoreId,
        action: "SHOPIFY_RETURN_CREATE_FAILED",
        entityType: "ReturnRequest",
        entityId,
        metadata: { userErrors },
      },
    });
    throw new Error(errorMsg);
  }

  const shopifyReturn = data?.returnCreate?.return;
  if (!shopifyReturn?.id) {
    throw new Error("Shopify returnCreate returned no return object and no userErrors.");
  }

  // Persist Shopify Return ID into PostgreSQL
  await prisma.returnRequest.update({
    where: { id: entityId },
    data: { shopifyReturnId: shopifyReturn.id },
  });

  await prisma.auditLog.create({
    data: {
      shopifyStoreId,
      action: "SHOPIFY_RETURN_CREATED",
      entityType: "ReturnRequest",
      entityId,
      metadata: { shopifyReturnId: shopifyReturn.id, name: shopifyReturn.name },
    },
  });

  return { success: true, shopifyReturnId: shopifyReturn.id, idempotent: false };
}

/**
 * 2. Executes Shopify Admin GraphQL `refundCreate` mutation.
 * Idempotent: Skips if shopifyRefundId is already set on ReturnRequest.
 */
export async function executeShopifyRefundCreate({ shopifyStoreId, entityId, admin }: ShopifySyncInput) {
  const returnRequest = await prisma.returnRequest.findFirst({
    where: { id: entityId, shopifyStoreId },
    include: { items: true },
  });

  if (!returnRequest) {
    throw new Error(`Return request ${entityId} not found for store ${shopifyStoreId}`);
  }

  if (returnRequest.shopifyRefundId) {
    console.log(`[ShopifySync] Idempotent skip: refundCreate already executed for Return ${entityId} (${returnRequest.shopifyRefundId})`);
    return { success: true, shopifyRefundId: returnRequest.shopifyRefundId, idempotent: true };
  }

  const client = await getShopifyAdminClient(shopifyStoreId, admin);
  if (!client) {
    console.log(`[ShopifySync] No admin client available — skipping live refundCreate for Return ${entityId}`);
    return { success: false, skipped: true, reason: "No admin client available" };
  }

  const refundAmountVal = returnRequest.refundAmount ? Number(returnRequest.refundAmount) : 0;

  const response = await client.graphql(
    `#graphql
    mutation refundCreate($input: RefundInput!) {
      refundCreate(input: $input) {
        refund {
          id
          totalRefundedSet {
            shopMoney {
              amount
              currencyCode
            }
          }
        }
        userErrors {
          field
          message
          code
        }
      }
    }`,
    {
      variables: {
        input: {
          orderId: returnRequest.shopifyOrderId,
          note: `BYNDCART Refund for Return #${returnRequest.orderNumber} (Request ${returnRequest.id})`,
          currency: "PKR",
          notify: true,
          transactions: [
            {
              orderId: returnRequest.shopifyOrderId,
              amount: refundAmountVal.toFixed(2),
              currency: "PKR",
              gateway: "manual",
            },
          ],
        },
      },
    }
  );

  const { data } = await response.json();
  const userErrors = data?.refundCreate?.userErrors ?? [];

  if (userErrors.length > 0) {
    const errorMsg = `Shopify refundCreate userErrors: ${userErrors.map((e: any) => `${e.field ? e.field.join('.') + ': ' : ''}${e.message}`).join("; ")}`;
    await prisma.auditLog.create({
      data: {
        shopifyStoreId,
        action: "SHOPIFY_REFUND_CREATE_FAILED",
        entityType: "ReturnRequest",
        entityId,
        metadata: { userErrors },
      },
    });
    throw new Error(errorMsg);
  }

  const refund = data?.refundCreate?.refund;
  if (!refund?.id) {
    throw new Error("Shopify refundCreate returned no refund object and no userErrors.");
  }

  await prisma.returnRequest.update({
    where: { id: entityId },
    data: { shopifyRefundId: refund.id },
  });

  await prisma.auditLog.create({
    data: {
      shopifyStoreId,
      action: "SHOPIFY_REFUND_CREATED",
      entityType: "ReturnRequest",
      entityId,
      metadata: { shopifyRefundId: refund.id, amount: refundAmountVal },
    },
  });

  return { success: true, shopifyRefundId: refund.id, idempotent: false };
}

/**
 * 3. Executes Shopify Admin GraphQL `inventoryAdjustQuantities` mutation.
 * Idempotent: Checks AuditLog for prior SHOPIFY_INVENTORY_ADJUSTED entry.
 */
export async function executeShopifyInventoryAdjust({ shopifyStoreId, entityId, admin }: ShopifySyncInput) {
  const returnRequest = await prisma.returnRequest.findFirst({
    where: { id: entityId, shopifyStoreId },
    include: { items: true },
  });

  if (!returnRequest) {
    throw new Error(`Return request ${entityId} not found for store ${shopifyStoreId}`);
  }

  const priorLog = await prisma.auditLog.findFirst({
    where: {
      shopifyStoreId,
      entityType: "ReturnRequest",
      entityId,
      action: "SHOPIFY_INVENTORY_ADJUSTED",
    },
  });

  if (priorLog) {
    console.log(`[ShopifySync] Idempotent skip: inventoryAdjustQuantities already executed for Return ${entityId}`);
    return { success: true, idempotent: true };
  }

  const client = await getShopifyAdminClient(shopifyStoreId, admin);
  if (!client) {
    console.log(`[ShopifySync] No admin client available — skipping live inventoryAdjustQuantities for Return ${entityId}`);
    return { success: false, skipped: true, reason: "No admin client available" };
  }

  // Get first available location ID from Shopify store
  const locationRes = await client.graphql(
    `#graphql
    query getLocations {
      locations(first: 1) {
        edges {
          node {
            id
          }
        }
      }
    }`
  );
  const locationData = await locationRes.json();
  const locationId = locationData?.data?.locations?.edges?.[0]?.node?.id;

  if (!locationId) {
    throw new Error("Could not resolve Shopify store primary location ID for inventory adjustment.");
  }

  const changes = returnRequest.items.map((item) => ({
    inventoryItemId: item.shopifyLineItemId, // mapped line item / inventory item ID
    locationId,
    delta: item.quantity,
  }));

  const response = await client.graphql(
    `#graphql
    mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        inventoryAdjustmentGroup {
          id
          reason
          changes {
            name
            delta
          }
        }
        userErrors {
          field
          message
          code
        }
      }
    }`,
    {
      variables: {
        input: {
          reason: "return_restock",
          name: "available",
          changes,
        },
      },
    }
  );

  const { data } = await response.json();
  const userErrors = data?.inventoryAdjustQuantities?.userErrors ?? [];

  if (userErrors.length > 0) {
    const errorMsg = `Shopify inventoryAdjustQuantities userErrors: ${userErrors.map((e: any) => `${e.field ? e.field.join('.') + ': ' : ''}${e.message}`).join("; ")}`;
    await prisma.auditLog.create({
      data: {
        shopifyStoreId,
        action: "SHOPIFY_INVENTORY_ADJUST_FAILED",
        entityType: "ReturnRequest",
        entityId,
        metadata: { userErrors },
      },
    });
    throw new Error(errorMsg);
  }

  await prisma.auditLog.create({
    data: {
      shopifyStoreId,
      action: "SHOPIFY_INVENTORY_ADJUSTED",
      entityType: "ReturnRequest",
      entityId,
      metadata: { itemsRestocked: returnRequest.items.length },
    },
  });

  return { success: true, idempotent: false };
}

/**
 * 4. Executes Shopify Admin GraphQL `draftOrderCreate` mutation for exchanges.
 * Idempotent: Skips if ExchangeRequest.newOrderId is already set.
 * Preserves originalOrderId and links replacement draft order.
 */
export async function executeShopifyDraftOrderCreate({ shopifyStoreId, entityId, admin }: ShopifySyncInput) {
  const exchangeRequest = await prisma.exchangeRequest.findFirst({
    where: { id: entityId, shopifyStoreId },
    include: { items: true },
  });

  if (!exchangeRequest) {
    throw new Error(`Exchange request ${entityId} not found for store ${shopifyStoreId}`);
  }

  // Idempotency check: if draft order ID already created, return existing details
  if (exchangeRequest.newOrderId) {
    console.log(`[ShopifySync] Idempotent skip: draftOrderCreate already executed for Exchange ${entityId} (${exchangeRequest.newOrderId})`);
    return {
      success: true,
      draftOrderId: exchangeRequest.newOrderId,
      draftOrderName: exchangeRequest.newOrderNumber,
      idempotent: true,
    };
  }

  const client = await getShopifyAdminClient(shopifyStoreId, admin);
  if (!client) {
    console.log(`[ShopifySync] No admin client available — skipping live draftOrderCreate for Exchange ${entityId}`);
    return { success: false, skipped: true, reason: "No admin client available" };
  }

  const lineItems = exchangeRequest.items.map((item) => ({
    variantId: item.replacementVariantId,
    quantity: item.replacementQuantity,
  }));

  const netPriceDiff = exchangeRequest.items.reduce((acc, item) => acc + Number(item.priceDifference || 0), 0);
  const diffLabel = netPriceDiff > 0 ? `+PKR ${netPriceDiff} (Customer Balance Owed)` : netPriceDiff < 0 ? `-PKR ${Math.abs(netPriceDiff)} (Store Credit / Partial Refund Owed)` : "Even Exchange (0 Balance)";

  const response = await client.graphql(
    `#graphql
    mutation draftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          name
          totalPrice
        }
        userErrors {
          field
          message
          code
        }
      }
    }`,
    {
      variables: {
        input: {
          email: exchangeRequest.customerEmail || undefined,
          note: `Exchange replacement for original order ${exchangeRequest.orderNumber} (Exchange Request ${exchangeRequest.id}) — ${diffLabel}`,
          tags: ["exchange-replacement", `original-order-${exchangeRequest.orderNumber}`, `price-diff-${netPriceDiff}`],
          lineItems,
        },
      },
    }
  );

  const { data } = await response.json();
  const userErrors = data?.draftOrderCreate?.userErrors ?? [];

  if (userErrors.length > 0) {
    const errorMsg = `Shopify draftOrderCreate userErrors: ${userErrors.map((e: any) => `${e.field ? e.field.join('.') + ': ' : ''}${e.message}`).join("; ")}`;
    await prisma.auditLog.create({
      data: {
        shopifyStoreId,
        action: "SHOPIFY_DRAFT_ORDER_CREATE_FAILED",
        entityType: "ExchangeRequest",
        entityId,
        metadata: { userErrors },
      },
    });
    throw new Error(errorMsg);
  }

  const draftOrder = data?.draftOrderCreate?.draftOrder;
  if (!draftOrder?.id) {
    throw new Error("Shopify draftOrderCreate returned no draftOrder object and no userErrors.");
  }

  // Update ExchangeRequest with replacement draft order ID and name while preserving originalOrderId
  await prisma.exchangeRequest.update({
    where: { id: entityId },
    data: {
      newOrderId: draftOrder.id,
      newOrderNumber: draftOrder.name,
    },
  });

  await prisma.auditLog.create({
    data: {
      shopifyStoreId,
      action: "SHOPIFY_DRAFT_ORDER_CREATED",
      entityType: "ExchangeRequest",
      entityId,
      metadata: {
        originalOrderId: exchangeRequest.shopifyOrderId,
        replacementOrderId: draftOrder.id,
        draftOrderName: draftOrder.name,
      },
    },
  });

  return {
    success: true,
    draftOrderId: draftOrder.id,
    draftOrderName: draftOrder.name,
    idempotent: false,
  };
}

/**
 * 5. Executes initial full synchronization for a shop (Orders, Products, Customers).
 */
export async function executeInitialShopifySync({ shopifyStoreId, admin: providedAdmin }: { shopifyStoreId: string; admin?: any }) {
  await prisma.shopifyStore.update({
    where: { id: shopifyStoreId },
    data: { syncStatus: "SYNCING", lastSyncError: null },
  });

  try {
    const admin = await getShopifyAdminClient(shopifyStoreId, providedAdmin);

    const { syncShopifyOrders } = await import("./orders.server");
    const { syncShopifyProducts } = await import("./products.server");
    const { syncShopifyCustomers } = await import("./customers.server");

    const ordersResult = await syncShopifyOrders({ shopifyStoreId, admin });
    const productsResult = await syncShopifyProducts(shopifyStoreId, admin);
    const customersResult = await syncShopifyCustomers(shopifyStoreId, admin);

    const totalSynced = (ordersResult.synchronizedCount || 0) + (productsResult.synchronizedCount || 0) + (customersResult.count || 0);

    const now = new Date();
    await prisma.shopifyStore.update({
      where: { id: shopifyStoreId },
      data: {
        syncStatus: "COMPLETED",
        lastSyncAt: now,
        lastSyncError: null,
      },
    });

    await prisma.auditLog.create({
      data: {
        shopifyStoreId,
        action: "SHOPIFY_INITIAL_SYNC_COMPLETED",
        entityType: "ShopifyStore",
        entityId: shopifyStoreId,
        metadata: { totalSynced, orders: ordersResult.synchronizedCount, products: productsResult.synchronizedCount, customers: customersResult.count },
      },
    });

    return { success: true, totalSynced };
  } catch (error: any) {
    const errorMsg = error?.message || String(error);
    console.error(`[ShopifySync] Initial sync failed for store ${shopifyStoreId}:`, error);

    await prisma.shopifyStore.update({
      where: { id: shopifyStoreId },
      data: {
        syncStatus: "FAILED",
        lastSyncError: errorMsg,
      },
    });

    await prisma.auditLog.create({
      data: {
        shopifyStoreId,
        action: "SHOPIFY_INITIAL_SYNC_FAILED",
        entityType: "ShopifyStore",
        entityId: shopifyStoreId,
        metadata: { error: errorMsg },
      },
    });

    throw error;
  }
}

/**
 * 6. Automatically registers shop-specific webhooks.
 */
export async function executeWebhookRegistration({ shopifyStoreId, admin: providedAdmin }: { shopifyStoreId: string; admin?: any }) {
  try {
    const store = await prisma.shopifyStore.findUnique({ where: { id: shopifyStoreId } });
    if (!store) throw new Error(`Store ${shopifyStoreId} not found`);

    const admin = await getShopifyAdminClient(shopifyStoreId, providedAdmin);

    if (admin) {
      const webhookTopics = [
        "ORDERS_CREATE",
        "ORDERS_UPDATED",
        "ORDERS_CANCELLED",
        "PRODUCTS_CREATE",
        "PRODUCTS_UPDATE",
        "PRODUCTS_DELETE",
        "CUSTOMERS_CREATE",
        "CUSTOMERS_UPDATE",
        "CUSTOMERS_DELETE",
        "INVENTORY_LEVELS_UPDATE",
        "REFUNDS_CREATE",
      ];

      const callbackUrl = `${process.env.SHOPIFY_APP_URL || "https://byndcart-mock.app"}/webhooks`;

      for (const topic of webhookTopics) {
        try {
          await admin.graphql(
            `#graphql
            mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
              webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
                userErrors { field message }
                webhookSubscription { id }
              }
            }`,
            {
              variables: {
                topic,
                webhookSubscription: {
                  callbackUrl,
                  format: "JSON",
                },
              },
            }
          );
        } catch (e) {
          // Ignore individual topic registration warnings
        }
      }
    }

    await prisma.shopifyStore.update({
      where: { id: shopifyStoreId },
      data: { webhookStatus: "REGISTERED" },
    });

    return { success: true };
  } catch (error: any) {
    const errorMsg = error?.message || String(error);
    console.error(`[WebhookRegistration] Webhook registration failed for store ${shopifyStoreId}:`, error);

    await prisma.shopifyStore.update({
      where: { id: shopifyStoreId },
      data: { webhookStatus: "FAILED", lastSyncError: `Webhook reg failed: ${errorMsg}` },
    });

    throw error;
  }
}

/**
 * 7. Executes periodic reconciliation pass.
 */
export async function executeShopifyReconciliation({ shopifyStoreId, admin: providedAdmin }: { shopifyStoreId: string; admin?: any }) {
  try {
    const admin = await getShopifyAdminClient(shopifyStoreId, providedAdmin);

    const { syncShopifyOrders } = await import("./orders.server");
    const { syncShopifyProducts } = await import("./products.server");
    const { syncShopifyCustomers } = await import("./customers.server");

    await syncShopifyOrders({ shopifyStoreId, admin });
    await syncShopifyProducts(shopifyStoreId, admin);
    await syncShopifyCustomers(shopifyStoreId, admin);

    const now = new Date();
    await prisma.shopifyStore.update({
      where: { id: shopifyStoreId },
      data: {
        lastReconciledAt: now,
      },
    });

    return { success: true, reconciledAt: now };
  } catch (error: any) {
    console.error(`[Reconciliation] Failed for store ${shopifyStoreId}:`, error);
    throw error;
  }
}
