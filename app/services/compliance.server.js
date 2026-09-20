import prisma from "../db.server";

/**
 * customers/data_request — Shopify requires the app to be able to produce all
 * data held on the requesting customer within 30 days. We don't have a
 * customer-facing delivery channel, so this compiles what we hold into an
 * AuditLog entry the merchant can pull and act on manually.
 */
export async function handleCustomerDataRequest(shopifyStoreId, payload) {
  const email = payload?.customer?.email;

  if (!email) {
    console.warn(
      `[Compliance] customers/data_request missing customer email for store ${shopifyStoreId}`,
    );

    return;
  }

  const [returns, exchanges] = await Promise.all([
    prisma.returnRequest.findMany({
      where: { shopifyStoreId, customerEmail: email },
      include: { items: true },
    }),
    prisma.exchangeRequest.findMany({
      where: { shopifyStoreId, customerEmail: email },
      include: { items: true },
    }),
  ]);

  await prisma.auditLog.create({
    data: {
      shopifyStoreId,
      action: "GDPR_DATA_REQUEST",
      entityType: "Customer",
      entityId: email,
      metadata: {
        customerEmail: email,
        dataRequestId: payload?.data_request?.id ?? null,
        returnRequestCount: returns.length,
        exchangeRequestCount: exchanges.length,
        returns: returns.map((r) => ({
          id: r.id,
          orderNumber: r.orderNumber,
          status: r.status,
          createdAt: r.createdAt,
        })),
        exchanges: exchanges.map((e) => ({
          id: e.id,
          orderNumber: e.orderNumber,
          status: e.status,
          createdAt: e.createdAt,
        })),
      },
    },
  });
  console.log(
    `[Compliance] Logged data request for ${email} on store ${shopifyStoreId}`,
  );
}

/**
 * customers/redact — Shopify requires erasure of customer PII once the
 * retention period has passed. We anonymize the identifying fields rather
 * than hard-deleting the rows, so aggregate/audit history (used by
 * Analytics) survives without exposing PII.
 */
export async function handleCustomerRedact(shopifyStoreId, payload) {
  const email = payload?.customer?.email;

  if (!email) {
    console.warn(
      `[Compliance] customers/redact missing customer email for store ${shopifyStoreId}`,
    );

    return;
  }

  const redactedEmail = `redacted-${payload?.customer?.id ?? Date.now()}@deleted.customer`;
  const [returnsResult, exchangesResult] = await Promise.all([
    prisma.returnRequest.updateMany({
      where: { shopifyStoreId, customerEmail: email },
      data: {
        customerEmail: redactedEmail,
        customerName: null,
        customerNote: null,
        adminNote: null,
      },
    }),
    prisma.exchangeRequest.updateMany({
      where: { shopifyStoreId, customerEmail: email },
      data: { customerEmail: redactedEmail, customerName: null },
    }),
  ]);

  await prisma.auditLog.create({
    data: {
      shopifyStoreId,
      action: "GDPR_CUSTOMER_REDACTED",
      entityType: "Customer",
      entityId: redactedEmail,
      metadata: {
        returnsAffected: returnsResult.count,
        exchangesAffected: exchangesResult.count,
      },
    },
  });
  console.log(
    `[Compliance] Redacted customer on store ${shopifyStoreId} (${returnsResult.count} returns, ${exchangesResult.count} exchanges)`,
  );
}

/**
 * shop/redact — sent ~48h after uninstall. Requires deleting all shop data.
 * ShopifyStore cascades onto ReturnRequest, ExchangeRequest, WebhookEvent,
 * AuditLog, StoreSettings, Order, and ProductCache, so deleting the store row
 * removes everything in one step.
 */
export async function handleShopRedact(shop) {
  const store = await prisma.shopifyStore.findUnique({ where: { shop } });

  if (!store) {
    console.warn(
      `[Compliance] shop/redact: store ${shop} not found (already deleted?)`,
    );

    return;
  }

  await prisma.shopifyStore.delete({ where: { id: store.id } });
  console.log(`[Compliance] Deleted all data for shop ${shop} (shop/redact)`);
}
