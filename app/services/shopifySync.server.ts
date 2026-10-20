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

  let storeShop: string | null = null;
  try {
    const store = await prisma.shopifyStore.findUnique({
      where: { id: shopifyStoreId },
    });
    storeShop = store?.shop ?? null;

    if (!storeShop) {
      console.log(`[ShopifySync] No shop found for store ID ${shopifyStoreId}`);
      return null;
    }

    const { unauthenticated } = await import("../shopify.server");
    const { admin } = await unauthenticated.admin(storeShop);
    return admin;
  } catch (error) {
    try {
      const { configuredShopDomain, createClientCredentialsAdmin } = await import("./shopifyAdmin.server");
      const configured = configuredShopDomain();
      if (storeShop && configured && storeShop === configured) {
        return await createClientCredentialsAdmin(storeShop);
      }
    } catch (tokenError) {
      console.warn(`[ShopifySync] Client credentials fallback failed for store ${shopifyStoreId}:`, tokenError);
    }
    console.warn(`[ShopifySync] Could not resolve offline admin client for store ${shopifyStoreId}:`, error);
    return null;
  }
}

/** Adds order tags in Shopify. This is deliberately separate from returnCreate. */
export async function executeShopifyOrderTagAdd(input: { shopifyStoreId: string; orderId: string; tags: string[]; entityId?: string; admin?: any }) {
  const client = await getShopifyAdminClient(input.shopifyStoreId, input.admin);
  if (!client) return { success: false, skipped: true, reason: "No admin client available" };
  const tags = [...new Set(input.tags.map((tag) => String(tag).trim()).filter(Boolean))];
  if (!tags.length) return { success: true, skipped: true, reason: "No tags provided" };
  const response = await client.graphql(
    `#graphql
    mutation addOrderTags($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        node { id }
        userErrors { field message }
      }
    }`,
    { variables: { id: input.orderId, tags } }
  );
  const payload = await response.json();
  const topLevelErrors = payload?.errors ?? [];
  if (topLevelErrors.length) throw new Error(`Shopify tagsAdd GraphQL errors: ${topLevelErrors.map((error: any) => error.message).join("; ")}`);
  const errors = payload?.data?.tagsAdd?.userErrors ?? [];
  if (errors.length) throw new Error(`Shopify tagsAdd userErrors: ${errors.map((error: any) => error.message).join("; ")}`);
  if (!payload?.data?.tagsAdd?.node?.id) throw new Error("Shopify tagsAdd did not return the order node.");
  await prisma.auditLog.create({
    data: { shopifyStoreId: input.shopifyStoreId, action: "SHOPIFY_ORDER_TAGS_ADDED", entityType: "Order", entityId: input.orderId, metadata: { tags, requestId: input.entityId || null } },
  });
  return { success: true, orderId: input.orderId, tags };
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
  if (!returnRequest) throw new Error(`Return request ${entityId} not found for store ${shopifyStoreId}`);
  if (returnRequest.shopifyRefundId) {
    return { success: true, shopifyRefundId: returnRequest.shopifyRefundId, idempotent: true };
  }

  const client = await getShopifyAdminClient(shopifyStoreId, admin);
  if (!client) return { success: false, skipped: true, reason: "No admin client available" };
  const refundAmount = Number(returnRequest.refundAmount || 0);
  if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
    throw new Error("A positive, server-calculated refund amount is required before processing the refund.");
  }

  // Shopify needs a real, successful payment transaction parent to create a
  // payment refund. A manual/COD payment not represented in Shopify must use
  // the app's manual refund workflow instead of fabricating a gateway refund.
  const orderResponse = await client.graphql(
    `#graphql
    query getRefundableOrder($id: ID!) {
      order(id: $id) {
        id name currencyCode totalPriceSet { shopMoney { currencyCode } }
        transactions(first: 20) {
          edges { node { id kind gateway status amountSet { shopMoney { amount currencyCode } } } }
        }
      }
    }`,
    { variables: { id: returnRequest.shopifyOrderId } }
  );
  const orderPayload = await orderResponse.json();
  const order = orderPayload?.data?.order;
  if (!order?.id) throw new Error("Shopify order could not be loaded for refund processing.");
  const shopCurrency = order.totalPriceSet?.shopMoney?.currencyCode || order.currencyCode || "USD";
  const successfulTransactions = (order.transactions?.edges || []).map((edge: any) => edge.node).filter((txn: any) =>
    txn.status === "SUCCESS" && ["SALE", "CAPTURE"].includes(String(txn.kind).toUpperCase()) && txn.id && txn.gateway
  );
  const payment = successfulTransactions.find((txn: any) =>
    String(txn.amountSet?.shopMoney?.currencyCode || shopCurrency) === String(shopCurrency)
    && Number(txn.amountSet?.shopMoney?.amount || 0) >= refundAmount
  );
  if (!payment) {
    throw new Error("No successful Shopify payment transaction can cover this refund. Confirm the refund manually instead (common for COD or externally collected payments).");
  }
  const currency = payment.amountSet?.shopMoney?.currencyCode || shopCurrency;
  const idempotencyKey = `byndcart-return-refund-${entityId}`.replace(/[^a-zA-Z0-9_-]/g, "-");

  const response = await client.graphql(
    `#graphql
    mutation refundCreate($input: RefundInput!) {
      refundCreate(input: $input) @idempotent(key: "${idempotencyKey}") {
        refund { id totalRefundedSet { shopMoney { amount currencyCode } } }
        userErrors { field message code }
      }
    }`,
    {
      variables: {
        input: {
          orderId: returnRequest.shopifyOrderId,
          note: `BYNDCART refund for return ${returnRequest.orderNumber} (request ${returnRequest.id})`,
          transactions: [{
            orderId: returnRequest.shopifyOrderId,
            gateway: payment.gateway,
            kind: "REFUND",
            amount: refundAmount.toFixed(2),
            currency,
            parentId: payment.id,
          }],
        },
      },
    }
  );
  const payload = await response.json();
  const errors = payload?.data?.refundCreate?.userErrors ?? [];
  if (errors.length) {
    const errorMsg = `Shopify refundCreate userErrors: ${errors.map((e: any) => `${e.field ? e.field.join(".") + ": " : ""}${e.message}`).join("; ")}`;
    await prisma.auditLog.create({ data: { shopifyStoreId, action: "SHOPIFY_REFUND_CREATE_FAILED", entityType: "ReturnRequest", entityId, metadata: { userErrors: errors, refundAmount, currency } } });
    throw new Error(errorMsg);
  }

  const refund = payload?.data?.refundCreate?.refund;
  if (!refund?.id) throw new Error("Shopify refundCreate returned no refund object and no userErrors.");
  await prisma.returnRequest.update({ where: { id: entityId }, data: { shopifyRefundId: refund.id } });
  await prisma.auditLog.create({ data: { shopifyStoreId, action: "SHOPIFY_REFUND_CREATED", entityType: "ReturnRequest", entityId, metadata: { shopifyRefundId: refund.id, amount: refundAmount, currency, paymentGateway: payment.gateway, parentTransactionId: payment.id } } });
  return { success: true, shopifyRefundId: refund.id, idempotent: false };
}

/**
 * 3. Executes Shopify Admin GraphQL `inventoryAdjustQuantities` mutation.
 * Idempotent: Checks AuditLog for prior SHOPIFY_INVENTORY_ADJUSTED entry.
 */
export async function executeShopifyInventoryAdjust({ shopifyStoreId, entityId, admin }: ShopifySyncInput) {
  const returnRequest = await prisma.returnRequest.findFirst({ where: { id: entityId, shopifyStoreId }, include: { items: true } });
  if (!returnRequest) throw new Error(`Return request ${entityId} not found for store ${shopifyStoreId}`);
  const priorLog = await prisma.auditLog.findFirst({ where: { shopifyStoreId, entityType: "ReturnRequest", entityId, action: "SHOPIFY_INVENTORY_ADJUSTED" } });
  if (priorLog) return { success: true, idempotent: true };

  const itemIds = returnRequest.items.map((item) => item.id);
  if (!itemIds.length) return { success: true, skipped: true, reason: "No return items" };
  const inspections = await prisma.itemInspection.findMany({
    where: { returnItemId: { in: itemIds }, condition: "RESTOCKABLE", receivedQuantity: { gt: 0 } },
  });
  if (!inspections.length) return { success: true, skipped: true, reason: "No inspected restockable quantities" };

  const client = await getShopifyAdminClient(shopifyStoreId, admin);
  if (!client) return { success: false, skipped: true, reason: "No admin client available" };
  const orderResponse = await client.graphql(
    `#graphql
    query getReturnInventoryItems($id: ID!) {
      order(id: $id) {
        lineItems(first: 100) {
          edges { node { id variant { inventoryItem { id } } } }
        }
      }
    }`,
    { variables: { id: returnRequest.shopifyOrderId } }
  );
  const orderPayload = await orderResponse.json();
  const edges = orderPayload?.data?.order?.lineItems?.edges ?? [];
  const inventoryIdByLineItem = new Map<string, string>();
  for (const edge of edges) {
    const line = edge.node;
    const inventoryId = line?.variant?.inventoryItem?.id;
    if (line?.id && inventoryId) inventoryIdByLineItem.set(line.id, inventoryId);
  }

  const locationResponse = await client.graphql(`#graphql
query getRestockLocation { locations(first: 1) { edges { node { id } } } }`);
  const locationPayload = await locationResponse.json();
  const locationId = locationPayload?.data?.locations?.edges?.[0]?.node?.id;
  if (!locationId) throw new Error("Could not resolve Shopify store location ID for inventory adjustment.");

  const quantitiesByLineItem = new Map<string, number>();
  for (const inspection of inspections as any[]) {
    quantitiesByLineItem.set(inspection.shopifyLineItemId, (quantitiesByLineItem.get(inspection.shopifyLineItemId) || 0) + Number(inspection.receivedQuantity || 0));
  }
  const changes = [...quantitiesByLineItem.entries()].map(([lineItemId, quantity]) => {
    const inventoryItemId = inventoryIdByLineItem.get(lineItemId);
    if (!inventoryItemId) throw new Error(`Shopify inventory item could not be resolved for line item ${lineItemId}.`);
    return { inventoryItemId, locationId, delta: quantity };
  });

  const response = await client.graphql(
    `#graphql
    mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        inventoryAdjustmentGroup { id reason changes { name delta } }
        userErrors { field message code }
      }
    }`,
    { variables: { input: { reason: "return_restock", name: "available", changes } } }
  );
  const payload = await response.json();
  const errors = payload?.data?.inventoryAdjustQuantities?.userErrors ?? [];
  if (errors.length) {
    const errorMsg = `Shopify inventoryAdjustQuantities userErrors: ${errors.map((e: any) => `${e.field ? e.field.join(".") + ": " : ""}${e.message}`).join("; ")}`;
    await prisma.auditLog.create({ data: { shopifyStoreId, action: "SHOPIFY_INVENTORY_ADJUST_FAILED", entityType: "ReturnRequest", entityId, metadata: { userErrors: errors } } });
    throw new Error(errorMsg);
  }
  await prisma.auditLog.create({ data: { shopifyStoreId, action: "SHOPIFY_INVENTORY_ADJUSTED", entityType: "ReturnRequest", entityId, metadata: { restockedItems: changes } } });
  await prisma.itemInspection.updateMany({ where: { id: { in: inspections.map((item: any) => item.id) } }, data: { restockedInShopify: true } });
  return { success: true, idempotent: false };
}

/**
 * 4. Executes Shopify Admin GraphQL `draftOrderCreate` mutation for exchanges.
 * Idempotent: Skips if ExchangeRequest.newOrderId is already set.
 * Preserves originalOrderId and links replacement draft order.
 */
export async function executeShopifyDraftOrderCreate({ shopifyStoreId, entityId, admin }: ShopifySyncInput) {
  const exchangeRequest = await prisma.exchangeRequest.findFirst({ where: { id: entityId, shopifyStoreId }, include: { items: true } });
  if (!exchangeRequest) throw new Error(`Exchange request ${entityId} not found for store ${shopifyStoreId}`);

  // Keep the existing-order path available for settlement retries. Credit/invoice
  // status fields below make those retries safe and prevent repeated credits.
  const alreadyCreatedOrderId = exchangeRequest.newOrderId && exchangeRequest.newOrderId.startsWith("gid://shopify/Order/")
    ? exchangeRequest.newOrderId : null;
  const alreadyCreatedOrderNumber = alreadyCreatedOrderId ? exchangeRequest.newOrderNumber : null;
  const client = await getShopifyAdminClient(shopifyStoreId, admin);
  if (!client && alreadyCreatedOrderId) {
    return { success: true, replacementOrderId: alreadyCreatedOrderId, replacementOrderNumber: alreadyCreatedOrderNumber, idempotent: true };
  }
  if (!client) return { success: false, skipped: true, reason: "No admin client available" };

  const orderSnapshot = await prisma.order.findFirst({ where: { shopifyStoreId, shopifyOrderId: exchangeRequest.shopifyOrderId } });
  if (!orderSnapshot) throw new Error("Original Shopify order snapshot is missing; refresh/sync the order before creating a replacement.");
  const originalLines = Array.isArray(orderSnapshot.lineItems) ? orderSnapshot.lineItems as any[] : [];
  const replacementVariantIds = [...new Set(exchangeRequest.items.map((item: any) => item.replacementVariantId))];
  const variants = await prisma.productCache.findMany({ where: { shopifyStoreId, shopifyVariantId: { in: replacementVariantIds } } });
  const variantById = new Map(variants.map((variant: any) => [variant.shopifyVariantId, variant]));

  let replacementTotal = 0;
  let returnedGoodsValue = 0;
  const recalculatedItems: Array<{ id: string; priceDifference: number; replacementTitle: string }> = [];
  const lineItems = exchangeRequest.items.map((item: any) => {
    const original = originalLines.find((line: any) => line.lineItemId === item.originalLineItemId);
    const replacement = variantById.get(item.replacementVariantId);
    if (!original) throw new Error(`Original line item ${item.originalLineItemId} does not belong to order ${exchangeRequest.orderNumber}.`);
    if (!replacement) throw new Error(`Replacement variant ${item.replacementVariantId} is not in this store's synced product catalogue. Sync products and try again.`);
    const originalQuantity = Number(item.originalQuantity);
    const replacementQuantity = Number(item.replacementQuantity);
    if (!Number.isInteger(originalQuantity) || originalQuantity < 1 || originalQuantity > Number(original.quantity || 0)) throw new Error("Invalid original item quantity in exchange request.");
    if (!Number.isInteger(replacementQuantity) || replacementQuantity < 1) throw new Error("Invalid replacement quantity in exchange request.");
    const originalPrice = Number(original.price || 0);
    const replacementPrice = Number(replacement.price || 0);
    const itemDifference = replacementPrice * replacementQuantity - originalPrice * originalQuantity;
    replacementTotal += replacementPrice * replacementQuantity;
    returnedGoodsValue += originalPrice * originalQuantity;
    // Persist server-calculated values; do not trust browser-supplied priceDifference/title.
    recalculatedItems.push({ id: item.id, priceDifference: itemDifference, replacementTitle: [replacement.title, replacement.variantTitle].filter(Boolean).join(" - ") });
    return { variantId: item.replacementVariantId, quantity: replacementQuantity };
  });
  await Promise.all(recalculatedItems.map((item) => prisma.exchangeItem.update({ where: { id: item.id }, data: { priceDifference: item.priceDifference, replacementTitle: item.replacementTitle } })));

  const netDifference = Number((replacementTotal - returnedGoodsValue).toFixed(2));
  const credit = Math.min(replacementTotal, returnedGoodsValue);

  if (alreadyCreatedOrderId) {
    const settlement = await settleExchangeFinancialBalance({
      client, shopifyStoreId, exchangeRequest, originalOrderId: exchangeRequest.shopifyOrderId,
      replacementOrderId: alreadyCreatedOrderId, netDifference, currency: orderSnapshot.currency || "USD",
    });
    return { success: true, replacementOrderId: alreadyCreatedOrderId, replacementOrderNumber: alreadyCreatedOrderNumber, idempotent: true, netDifference, settlement };
  }
  const input: any = {
    email: exchangeRequest.customerEmail || undefined,
    note: `BYNDCART exchange replacement for original order ${exchangeRequest.orderNumber} (request ${exchangeRequest.id}). Net difference: ${netDifference.toFixed(2)} ${orderSnapshot.currency}. A positive balance remains unpaid until collected by the merchant.`,
    tags: ["exchange-replacement", `original-order-${exchangeRequest.orderNumber}`, `byndcart-exchange-${exchangeRequest.id}`],
    lineItems,
  };
  if (credit > 0) input.appliedDiscount = { value: Number(credit.toFixed(2)), valueType: "FIXED_AMOUNT", title: "Exchange credit for returned items" };

  let draftOrderId = exchangeRequest.newOrderId && exchangeRequest.newOrderId.startsWith("gid://shopify/DraftOrder/")
    ? exchangeRequest.newOrderId : null;
  let draftOrderName: string | null = null;
  if (!draftOrderId) {
    const createResponse = await client.graphql(
      `#graphql
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id name }
          userErrors { field message }
        }
      }`,
      { variables: { input } }
    );
    const createPayload = await createResponse.json();
    const graphqlErrors = Array.isArray(createPayload?.errors) ? createPayload.errors.map((error: any) => error?.message).filter(Boolean) : [];
    if (graphqlErrors.length) {
      throw new Error(`Shopify draftOrderCreate failed: ${graphqlErrors.join("; ")}`);
    }
    const createErrors = createPayload?.data?.draftOrderCreate?.userErrors ?? [];
    if (createErrors.length) {
      const message = `Shopify draftOrderCreate userErrors: ${createErrors.map((e: any) => `${e.field ? e.field.join(".") + ": " : ""}${e.message}`).join("; ")}`;
      await prisma.auditLog.create({ data: { shopifyStoreId, action: "SHOPIFY_DRAFT_ORDER_CREATE_FAILED", entityType: "ExchangeRequest", entityId, metadata: { userErrors: createErrors } } });
      throw new Error(message);
    }
    const draft = createPayload?.data?.draftOrderCreate?.draftOrder;
    if (!draft?.id) throw new Error("Shopify draftOrderCreate returned no draft order and no userErrors.");
    draftOrderId = draft.id;
    draftOrderName = draft.name;
    await prisma.exchangeRequest.update({ where: { id: entityId }, data: { newOrderId: draftOrderId, newOrderNumber: draftOrderName } });
    await prisma.auditLog.create({ data: { shopifyStoreId, action: "SHOPIFY_REPLACEMENT_DRAFT_CREATED", entityType: "ExchangeRequest", entityId, metadata: { originalOrderId: exchangeRequest.shopifyOrderId, draftOrderId, draftOrderName } } });
  }

  const completeResponse = await client.graphql(
    `#graphql
    mutation completeReplacementDraft($id: ID!, $paymentPending: Boolean) {
      draftOrderComplete(id: $id, paymentPending: $paymentPending) {
        draftOrder { id name order { id name displayFinancialStatus } }
        userErrors { field message }
      }
    }`,
    { variables: { id: draftOrderId, paymentPending: netDifference > 0 } }
  );
    const completePayload = await completeResponse.json();
    const completeGraphqlErrors = Array.isArray(completePayload?.errors) ? completePayload.errors.map((error: any) => error?.message).filter(Boolean) : [];
    if (completeGraphqlErrors.length) throw new Error(`Shopify draftOrderComplete failed: ${completeGraphqlErrors.join("; ")}`);
    const completeErrors = completePayload?.data?.draftOrderComplete?.userErrors ?? [];
  if (completeErrors.length) throw new Error(`Shopify draftOrderComplete userErrors: ${completeErrors.map((e: any) => e.message).join("; ")}`);
  const completedDraft = completePayload?.data?.draftOrderComplete?.draftOrder;
  const replacementOrder = completedDraft?.order;
  if (!replacementOrder?.id) throw new Error("Shopify completed the draft mutation without returning the replacement order. Check Shopify scopes and app API version.");

  await prisma.exchangeRequest.update({ where: { id: entityId }, data: { newOrderId: replacementOrder.id, newOrderNumber: replacementOrder.name || completedDraft.name || draftOrderName } });
  await prisma.auditLog.create({ data: { shopifyStoreId, action: "SHOPIFY_REPLACEMENT_ORDER_CREATED", entityType: "ExchangeRequest", entityId, metadata: { originalOrderId: exchangeRequest.shopifyOrderId, draftOrderId, replacementOrderId: replacementOrder.id, replacementOrderNumber: replacementOrder.name, netDifference, currency: orderSnapshot.currency, financialStatus: replacementOrder.displayFinancialStatus } } });

  const settlement = await settleExchangeFinancialBalance({
    client, shopifyStoreId, exchangeRequest, originalOrderId: exchangeRequest.shopifyOrderId,
    replacementOrderId: replacementOrder.id, netDifference, currency: orderSnapshot.currency || "USD",
  });

  return { success: true, draftOrderId, draftOrderName: completedDraft.name || draftOrderName, replacementOrderId: replacementOrder.id, replacementOrderNumber: replacementOrder.name || completedDraft.name || draftOrderName, idempotent: false, netDifference, settlement };
}



/**
 * Settle the exchange price difference only after Shopify has created the replacement
 * order. A PENDING status is a durable claim: if the process crashes after Shopify
 * accepts a mutation but before persistence, automatic retries must not double-credit.
 */
async function settleExchangeFinancialBalance(input: {
  client: any;
  shopifyStoreId: string;
  exchangeRequest: any;
  originalOrderId: string;
  replacementOrderId: string;
  netDifference: number;
  currency: string;
}) {
  const { client, shopifyStoreId, exchangeRequest, originalOrderId, replacementOrderId } = input;
  const netDifference = Number(input.netDifference.toFixed(2));
  const currency = input.currency || "USD";
  const result: any = { difference: netDifference, currency };

  if (netDifference < 0) {
    const amount = Number(Math.abs(netDifference).toFixed(2));
    const exchangeId = exchangeRequest.id;
    const existing = await prisma.exchangeRequest.findFirst({ where: { id: exchangeId, shopifyStoreId }, select: { storeCreditStatus: true, storeCreditTransactionId: true } });
    if (existing?.storeCreditStatus === "ISSUED") {
      result.storeCredit = { status: "ISSUED", transactionId: existing.storeCreditTransactionId };
    } else if (existing?.storeCreditStatus === "PENDING") {
      result.storeCredit = { status: "PENDING_RECONCILIATION", message: "A previous credit attempt is still marked pending; it was not repeated to avoid double-crediting." };
    } else {
      const claim = await prisma.exchangeRequest.updateMany({
        where: { id: exchangeId, shopifyStoreId, OR: [{ storeCreditStatus: null }, { storeCreditStatus: "FAILED" }] },
        data: { storeCreditStatus: "PENDING", storeCreditAmount: amount, storeCreditCurrency: currency },
      });
      if (!claim.count) {
        const latest = await prisma.exchangeRequest.findFirst({ where: { id: exchangeId, shopifyStoreId }, select: { storeCreditStatus: true, storeCreditTransactionId: true } });
        result.storeCredit = { status: latest?.storeCreditStatus || "PENDING", transactionId: latest?.storeCreditTransactionId || null };
      } else {
        let transactionCreated = false;
        let creditMutationStarted = false;
        let creditMutationResponseReceived = false;
        let creditMutationOutcomeUnknown = false;
        let transactionId: string | null = null;
        try {
          const orderResponse = await client.graphql(
            `#graphql
            query exchangeCreditCustomer($id: ID!) { order(id: $id) { id customer { id email } } }`,
            { variables: { id: originalOrderId } },
          );
          const orderPayload = await orderResponse.json();
          const customer = orderPayload?.data?.order?.customer;
          if (orderPayload?.errors?.length) throw new Error(orderPayload.errors.map((error: any) => error.message).join("; "));
          if (!customer?.id) throw new Error("Shopify did not return a customer for the original order; store credit was not issued.");

          creditMutationStarted = true;
          const creditResponse = await client.graphql(
            `#graphql
            mutation exchangeStoreCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
              storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
                storeCreditAccountTransaction { id amount { amount currencyCode } account { id balance { amount currencyCode } } }
                userErrors { field message }
              }
            }`,
            { variables: { id: customer.id, creditInput: { creditAmount: { amount: amount.toFixed(2), currencyCode: currency }, notify: true } } },
          );
          const creditPayload = await creditResponse.json();
          creditMutationResponseReceived = true;
          if (creditPayload?.errors?.length) {
            creditMutationOutcomeUnknown = true;
            throw new Error(creditPayload.errors.map((error: any) => error.message).join("; "));
          }
          const payload = creditPayload?.data?.storeCreditAccountCredit;
          const userErrors = payload?.userErrors || [];
          if (userErrors.length || !payload?.storeCreditAccountTransaction?.id) {
            throw new Error(userErrors.map((error: any) => error.message).join("; ") || "Shopify did not confirm a store-credit transaction.");
          }
          const transaction = payload.storeCreditAccountTransaction;
          transactionCreated = true;
          transactionId = transaction.id;
          await prisma.exchangeRequest.update({ where: { id: exchangeId }, data: {
            storeCreditStatus: "ISSUED", storeCreditTransactionId: transaction.id,
            storeCreditAmount: amount, storeCreditCurrency: currency, storeCreditIssuedAt: new Date(),
          } });
          await prisma.refundRecord.create({ data: {
            shopifyStoreId, exchangeRequestId: exchangeId, method: "STORE_CREDIT", amount, currency,
            status: "CONFIRMED", reference: transaction.id, reason: `Shopify store credit issued for cheaper exchange ${exchangeRequest.orderNumber}`, confirmedAt: new Date(),
          } });
          await prisma.auditLog.create({ data: {
            shopifyStoreId, action: "EXCHANGE_STORE_CREDIT_ISSUED", entityType: "ExchangeRequest", entityId: exchangeId,
            metadata: { originalOrderId, replacementOrderId, amount, currency, transactionId: transaction.id, accountId: transaction.account?.id || null },
          } });
          result.storeCredit = { status: "ISSUED", amount, currency, transactionId: transaction.id };
        } catch (error: any) {
          const reason = String(error?.message || error).slice(0, 1000);
          if (transactionCreated || (creditMutationStarted && (!creditMutationResponseReceived || creditMutationOutcomeUnknown))) {
            // The mutation is confirmed, or its network outcome is unknown. Never
            // downgrade it to retryable FAILED: that could create duplicate credit.
            const latest = await prisma.exchangeRequest.findFirst({ where: { id: exchangeId, shopifyStoreId }, select: { storeCreditStatus: true, storeCreditTransactionId: true } }).catch(() => null);
            const status = latest?.storeCreditStatus === "ISSUED" ? "ISSUED" : "PENDING_RECONCILIATION";
            await prisma.auditLog.create({ data: {
              shopifyStoreId, action: "EXCHANGE_STORE_CREDIT_RECONCILIATION_REQUIRED", entityType: "ExchangeRequest", entityId: exchangeId,
              metadata: { originalOrderId, replacementOrderId, amount, currency, transactionId, error: reason, mutationOutcomeUnknown: creditMutationStarted && !creditMutationResponseReceived },
            } }).catch(() => undefined);
            result.storeCredit = { status, amount, currency, transactionId, message: reason };
          } else {
            await prisma.exchangeRequest.update({ where: { id: exchangeId }, data: { storeCreditStatus: "FAILED" } });
            const existingPending = await prisma.refundRecord.findFirst({ where: { shopifyStoreId, exchangeRequestId: exchangeId, status: "PENDING" } });
            if (!existingPending) await prisma.refundRecord.create({ data: {
              shopifyStoreId, exchangeRequestId: exchangeId, method: "MANUAL", amount, currency, status: "PENDING",
              reason: "Shopify store credit failed; merchant action is required: " + reason,
            } });
            await prisma.auditLog.create({ data: {
              shopifyStoreId, action: "EXCHANGE_STORE_CREDIT_FAILED", entityType: "ExchangeRequest", entityId: exchangeId,
              metadata: { originalOrderId, replacementOrderId, amount, currency, error: reason },
            } });
            result.storeCredit = { status: "FAILED", amount, currency, message: reason };
          }
        }
      }
    }
  } else if (netDifference > 0) {
    const exchangeId = exchangeRequest.id;
    const existing = await prisma.exchangeRequest.findFirst({ where: { id: exchangeId, shopifyStoreId }, select: { paymentInvoiceStatus: true } });
    if (existing?.paymentInvoiceStatus === "SENT") {
      result.paymentInvoice = { status: "SENT" };
    } else if (existing?.paymentInvoiceStatus === "PENDING") {
      result.paymentInvoice = { status: "PENDING_RECONCILIATION", message: "A previous invoice attempt is still marked pending; it was not sent again automatically." };
    } else {
      const claim = await prisma.exchangeRequest.updateMany({
        where: { id: exchangeId, shopifyStoreId, OR: [{ paymentInvoiceStatus: null }, { paymentInvoiceStatus: "FAILED" }] },
        data: { paymentInvoiceStatus: "PENDING", paymentInvoiceError: null },
      });
      if (!claim.count) {
        result.paymentInvoice = { status: "PENDING" };
      } else {
        let invoiceSent = false;
        let invoiceMutationStarted = false;
        let invoiceResponseReceived = false;
        try {
          if (!String(exchangeRequest.customerEmail || "").includes("@")) throw new Error("The customer email on the exchange is missing or invalid; payment invoice was not sent.");
          invoiceMutationStarted = true;
          const invoiceResponse = await client.graphql(
            `#graphql
            mutation exchangePaymentInvoice($id: ID!, $email: EmailInput) {
              orderInvoiceSend(id: $id, email: $email) { order { id } userErrors { field message } }
            }`,
            { variables: { id: replacementOrderId, email: {
              to: exchangeRequest.customerEmail,
              subject: `Payment required for exchange replacement ${exchangeRequest.orderNumber}`,
              customMessage: `Your replacement order requires an additional payment of ${netDifference.toFixed(2)} ${currency}. Use the secure checkout link in this email to complete payment.`,
            } } },
          );
          const invoicePayload = await invoiceResponse.json();
          invoiceResponseReceived = true;
          if (invoicePayload?.errors?.length) throw new Error(invoicePayload.errors.map((error: any) => error.message).join("; "));
          const payload = invoicePayload?.data?.orderInvoiceSend;
          const userErrors = payload?.userErrors || [];
          if (userErrors.length || !payload?.order?.id) throw new Error(userErrors.map((error: any) => error.message).join("; ") || "Shopify did not confirm invoice delivery.");
          invoiceSent = true;
          await prisma.exchangeRequest.update({ where: { id: exchangeId }, data: { paymentInvoiceStatus: "SENT", paymentInvoiceSentAt: new Date(), paymentInvoiceError: null } });
          await prisma.auditLog.create({ data: {
            shopifyStoreId, action: "EXCHANGE_PAYMENT_INVOICE_SENT", entityType: "ExchangeRequest", entityId: exchangeId,
            metadata: { originalOrderId, replacementOrderId, amount: netDifference, currency, recipient: exchangeRequest.customerEmail },
          } });
          result.paymentInvoice = { status: "SENT", amount: netDifference, currency };
        } catch (error: any) {
          const reason = String(error?.message || error).slice(0, 1000);
          if (invoiceSent || (invoiceMutationStarted && !invoiceResponseReceived)) {
            const latest = await prisma.exchangeRequest.findFirst({ where: { id: exchangeId, shopifyStoreId }, select: { paymentInvoiceStatus: true } }).catch(() => null);
            await prisma.auditLog.create({ data: {
              shopifyStoreId, action: "EXCHANGE_PAYMENT_INVOICE_PERSISTENCE_WARNING", entityType: "ExchangeRequest", entityId: exchangeId,
              metadata: { originalOrderId, replacementOrderId, amount: netDifference, currency, error: reason, mutationOutcomeUnknown: invoiceMutationStarted && !invoiceResponseReceived },
            } }).catch(() => undefined);
            result.paymentInvoice = { status: latest?.paymentInvoiceStatus === "SENT" ? "SENT" : "PENDING_RECONCILIATION", amount: netDifference, currency, message: reason };
          } else {
            await prisma.exchangeRequest.update({ where: { id: exchangeId }, data: { paymentInvoiceStatus: "FAILED", paymentInvoiceError: reason } });
            await prisma.auditLog.create({ data: {
              shopifyStoreId, action: "EXCHANGE_PAYMENT_INVOICE_FAILED", entityType: "ExchangeRequest", entityId: exchangeId,
              metadata: { originalOrderId, replacementOrderId, amount: netDifference, currency, error: reason },
            } });
            result.paymentInvoice = { status: "FAILED", amount: netDifference, currency, message: reason };
          }
        }
      }
    }
  }

  return result;
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
