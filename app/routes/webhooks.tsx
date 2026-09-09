import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ingestWebhook } from "../services/webhooks.server";
import { assertRateLimit } from "../utils/rateLimit.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    // 1. Authenticate and validate signature
    const { shop, topic, payload, admin } = await authenticate.webhook(request);

    // Cap at 120 webhooks/min per shop — generous for legitimate traffic
    // (even bulk product syncs), enough to blunt a retry storm or replay abuse.
    assertRateLimit(`webhook:${shop}`, { limit: 120, windowMs: 60_000 });

    // 2. Extract Webhook ID from headers
    const webhookId = request.headers.get("x-shopify-webhook-id") || "";

    if (!webhookId) {
      console.warn(`[Webhook] Missing X-Shopify-Webhook-Id for shop ${shop}, topic ${topic}`);
      return new Response("Missing Webhook ID", { status: 400 });
    }

    console.log(`[Webhook Route] Received ${topic} webhook for ${shop} with ID: ${webhookId}`);

    // 3. Delegate to central ingest service for duplicate detection and handler routing
    const result = await ingestWebhook(webhookId, shop, topic, payload, admin);

    if (result.duplicate) {
      return new Response("Duplicate webhook skipped", { status: 200 });
    }

    if (!result.success) {
      // Return 200 to Shopify anyway so they don't retry, but we log the issue
      console.warn(`[Webhook Route] Handler failed to process topic ${topic}`);
    }

    return new Response("Webhook received and processed", { status: 200 });
  } catch (error) {
    if (error instanceof Response) throw error; // rate limit 429, pass through as-is
    console.error("[Webhook Route] Fatal error processing webhook:", error);
    return new Response("Webhook execution error", { status: 500 });
  }
};
