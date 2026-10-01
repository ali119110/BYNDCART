import prisma from "../db.server";
import { enqueueJob } from "./jobs.server";
import {
  upsertOrderFromWebhook,
  cancelOrderFromWebhook,
} from "./orders.server";
import {
  upsertVariantsFromWebhook,
  deleteProductFromWebhook,
} from "./products.server";
import {
  upsertCustomerFromWebhook,
  deleteCustomerFromWebhook,
} from "./customers.server";
import {
  handleCustomerDataRequest,
  handleCustomerRedact,
  handleShopRedact,
} from "./compliance.server";
import { handleSubscriptionWebhook } from "./billing.server";

export async function ingestWebhook(webhookId, shop, topic, payload, admin) {
  try {
    // 1. Uniqueness check for duplicate webhook detection
    const existing = await prisma.webhookEvent.findUnique({
      where: { id: webhookId },
    });

    if (existing) {
      console.log(
        `[Webhook] Duplicate event detected: ${webhookId} (${topic}). Skipping.`,
      );

      return { duplicate: true, success: true, topic };
    }

    // 2. Fetch the store
    const store = await prisma.shopifyStore.findUnique({
      where: { shop },
    });

    if (!store) {
      console.warn(
        `[Webhook] Store not found: ${shop}. Skipping event recording.`,
      );

      return { duplicate: false, success: false, topic };
    }

    const jsonPayload = payload ? JSON.parse(JSON.stringify(payload)) : {};

    // 3. Record the webhook event in the database (unprocessed)
    await prisma.webhookEvent.create({
      data: {
        id: webhookId,
        shopifyStoreId: store.id,
        topic,
        payload: jsonPayload,
        processed: false,
      },
    });
    // 4. Enqueue background job for background worker processing
    const job = await enqueueJob({
      shopifyStoreId: store.id,
      type: "WEBHOOK_PROCESS",
      payload: {
        webhookId,
        topic,
        shop,
        webhookPayload: jsonPayload,
      },
    });
    // 5. In-band processing execution for immediate response
    let processingSuccess = false;

    try {
      processingSuccess = await routeAndProcessWebhook(
        store.id,
        topic,
        jsonPayload,
        admin,
        shop,
      );
    } catch (err) {
      console.error(
        `[Webhook] Error during in-band processing for ${topic}:`,
        err,
      );
    }

    if (processingSuccess) {
      try {
        await prisma.webhookEvent.update({
          where: { id: webhookId },
          data: {
            processed: true,
            processedAt: new Date(),
          },
        });
      } catch (err) {
        console.log(
          `[Webhook] Could not mark ${webhookId} processed (row likely cascaded away): ${err}`,
        );
      }
    }

    return { duplicate: false, success: true, topic, jobId: job.id };
  } catch (error) {
    console.error(
      `[Webhook] Fatal error during webhook ingestion for ${webhookId}:`,
      error,
    );

    return { duplicate: false, success: false, topic };
  }
}

async function routeAndProcessWebhook(
  shopifyStoreId,
  topic,
  payload,
  admin,
  shop,
) {
  console.log(
    `[Webhook] Processing handler for store ${shopifyStoreId}, topic ${topic}`,
  );

  switch (topic) {
    case "app/uninstalled":
      return true;
    case "orders/create":
    case "orders/updated":
      await upsertOrderFromWebhook(shopifyStoreId, payload);

      return true;
    case "orders/cancelled":
      await cancelOrderFromWebhook(shopifyStoreId, payload);

      return true;
    case "products/create":
    case "products/update":
      await upsertVariantsFromWebhook(shopifyStoreId, payload);

      return true;
    case "products/delete":
      await deleteProductFromWebhook(shopifyStoreId, payload);

      return true;
    case "customers/create":
    case "customers/update":
      await upsertCustomerFromWebhook(shopifyStoreId, payload);

      return true;
    case "customers/delete":
      await deleteCustomerFromWebhook(shopifyStoreId, payload);

      return true;
    case "customers/data_request":
      await handleCustomerDataRequest(shopifyStoreId, payload);

      return true;
    case "customers/redact":
      await handleCustomerRedact(shopifyStoreId, payload);

      return true;
    case "shop/redact":
      await handleShopRedact(shop);

      return true;
    case "app_subscriptions/update":
    case "APP_SUBSCRIPTIONS_UPDATE":
      await handleSubscriptionWebhook(shop, payload);

      return true;
    default:
      console.log(`[Webhook] Unhandled topic: ${topic}`);

      return true;
  }
}
