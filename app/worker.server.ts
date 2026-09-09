import { claimNextJob, completeJob, failJob } from "./services/jobs.server";
import { upsertOrderFromWebhook } from "./services/orders.server";
import { upsertVariantsFromWebhook } from "./services/products.server";
import { handleCustomerDataRequest, handleCustomerRedact, handleShopRedact } from "./services/compliance.server";

type JobHandler = (payload: any, shopifyStoreId?: string) => Promise<void>;

const jobHandlers = new Map<string, JobHandler>();

export function registerJobHandler(type: string, handler: JobHandler) {
  jobHandlers.set(type, handler);
}

import {
  executeShopifyReturnCreate,
  executeShopifyRefundCreate,
  executeShopifyInventoryAdjust,
  executeShopifyDraftOrderCreate,
} from "./services/shopifySync.server";
import { processNotificationJob } from "./services/notifications.server";

// Register built-in background job handlers
registerJobHandler("WEBHOOK_PROCESS", async (payload: any, shopifyStoreId?: string) => {
  const { topic, shop, webhookPayload } = payload;
  console.log(`[Worker] Executing WEBHOOK_PROCESS for topic: ${topic}, store: ${shopifyStoreId || shop}`);

  switch (topic) {
    case "orders/create":
    case "orders/updated":
      if (shopifyStoreId) {
        await upsertOrderFromWebhook(shopifyStoreId, webhookPayload);
      }
      break;

    case "products/create":
    case "products/update":
      if (shopifyStoreId) {
        await upsertVariantsFromWebhook(shopifyStoreId, webhookPayload);
      }
      break;

    case "customers/data_request":
      if (shopifyStoreId) {
        await handleCustomerDataRequest(shopifyStoreId, webhookPayload);
      }
      break;

    case "customers/redact":
      if (shopifyStoreId) {
        await handleCustomerRedact(shopifyStoreId, webhookPayload);
      }
      break;

    case "shop/redact":
      if (shop) {
        await handleShopRedact(shop);
      }
      break;

    default:
      console.log(`[Worker] Unhandled job topic: ${topic}`);
      break;
  }
});

registerJobHandler("SHOPIFY_RETURN_CREATE", async (payload: any, shopifyStoreId?: string) => {
  if (!shopifyStoreId || !payload.returnRequestId) {
    throw new Error("Invalid payload for SHOPIFY_RETURN_CREATE background job");
  }
  await executeShopifyReturnCreate({ shopifyStoreId, entityId: payload.returnRequestId });
});

registerJobHandler("SHOPIFY_REFUND_CREATE", async (payload: any, shopifyStoreId?: string) => {
  if (!shopifyStoreId || !payload.returnRequestId) {
    throw new Error("Invalid payload for SHOPIFY_REFUND_CREATE background job");
  }
  await executeShopifyRefundCreate({ shopifyStoreId, entityId: payload.returnRequestId });
});

registerJobHandler("SHOPIFY_INVENTORY_ADJUST", async (payload: any, shopifyStoreId?: string) => {
  if (!shopifyStoreId || !payload.returnRequestId) {
    throw new Error("Invalid payload for SHOPIFY_INVENTORY_ADJUST background job");
  }
  await executeShopifyInventoryAdjust({ shopifyStoreId, entityId: payload.returnRequestId });
});

registerJobHandler("SHOPIFY_DRAFT_ORDER_CREATE", async (payload: any, shopifyStoreId?: string) => {
  if (!shopifyStoreId || !payload.exchangeRequestId) {
    throw new Error("Invalid payload for SHOPIFY_DRAFT_ORDER_CREATE background job");
  }
  await executeShopifyDraftOrderCreate({ shopifyStoreId, entityId: payload.exchangeRequestId });
});

registerJobHandler("SEND_NOTIFICATION", async (payload: any) => {
  if (!payload.notificationLogId) {
    throw new Error("Invalid payload for SEND_NOTIFICATION background job");
  }
  const result = await processNotificationJob(payload);
  if (!result.success && result.status !== "SKIPPED") {
    throw new Error(`Notification dispatch failed: ${result.error}`);
  }
});

/**
 * Processes a single job from the background job queue.
 * Returns true if a job was found and processed, false if queue was empty.
 */
export async function processNextJob(): Promise<boolean> {
  const job = await claimNextJob();
  if (!job) return false;

  console.log(`[Worker] Claimed job ${job.id} (type: ${job.type}, attempt: ${job.attempts}/${job.maxAttempts})`);

  try {
    const handler = jobHandlers.get(job.type);
    if (!handler) {
      throw new Error(`No registered job handler for job type: ${job.type}`);
    }

    await handler(job.payload, job.shopifyStoreId || undefined);
    await completeJob(job.id);
    console.log(`[Worker] Successfully completed job ${job.id}`);
    return true;
  } catch (error: any) {
    console.error(`[Worker] Failed processing job ${job.id}:`, error);
    await failJob(job.id, error);
    return true;
  }
}

/**
 * Starts continuous background job worker daemon.
 */
export function startWorkerDaemon(pollIntervalMs = 2000): () => void {
  console.log(`[Worker Daemon] Starting worker daemon with polling interval ${pollIntervalMs}ms`);
  let isRunning = true;

  const loop = async () => {
    while (isRunning) {
      try {
        const processed = await processNextJob();
        if (!processed) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
      } catch (err) {
        console.error("[Worker Daemon] Loop error:", err);
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }
  };

  loop();

  return () => {
    console.log("[Worker Daemon] Stopping worker daemon");
    isRunning = false;
  };
}

// If executed directly as standalone entry point (e.g. `npm run worker`), start worker daemon loop
if (process.argv[1]?.includes("worker.server.ts")) {
  startWorkerDaemon();
}
