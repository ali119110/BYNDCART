// Load test for the BYNDCART webhook endpoint and a couple of key app routes.
//
// Setup:
//   npm install --save-dev autocannon
//
// Usage (app must be running — npm run dev or npm start — against a real
// or seeded store; SKIP_AUTH=true recommended so /app/* routes don't
// redirect to Shopify OAuth):
//   node scripts/load-test.mjs
//
// Override target/duration:
//   TARGET_URL=http://localhost:3000 DURATION=30 node scripts/load-test.mjs

import autocannon from "autocannon";

const TARGET_URL = process.env.TARGET_URL || "http://localhost:3000";
const DURATION = Number(process.env.DURATION || 20);
const CONNECTIONS = Number(process.env.CONNECTIONS || 10);

function runTest(opts) {
  return new Promise((resolve, reject) => {
    const instance = autocannon(opts, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
    autocannon.track(instance, { renderProgressBar: true });
  });
}

async function main() {
  console.log(`\nLoad testing against ${TARGET_URL} (${CONNECTIONS} connections, ${DURATION}s each)\n`);

  // 1. Webhook endpoint — the one real externally-facing endpoint.
  // NOTE: this will fail HMAC verification (expected — we're not signing
  // the payload here) and hit our rate limiter after 120 req/min. That's
  // useful: it tells you the 429 path holds up under load, not just the
  // happy path. For a true end-to-end webhook load test, use
  // `shopify app webhook trigger` in a loop instead, which sends properly
  // signed requests.
  console.log("=== 1/2: Webhook endpoint (expect HMAC 401s + eventual 429s — this is testing rejection-path throughput) ===");
  const webhookResult = await runTest({
    url: `${TARGET_URL}/webhooks`,
    method: "POST",
    connections: CONNECTIONS,
    duration: DURATION,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Topic": "orders/create",
      "X-Shopify-Shop-Domain": "loadtest-store.myshopify.com",
      "X-Shopify-Webhook-Id": "loadtest-static-id", // static on purpose: also exercises dedup path
      "X-Shopify-Hmac-Sha256": "invalid-signature-for-load-test",
    },
    body: JSON.stringify({ id: 123456789, name: "#9999", line_items: [] }),
  });
  printSummary("Webhook endpoint", webhookResult);

  // 2. A representative read-heavy app route (Analytics — runs several
  // aggregate queries including a raw SQL join). Requires SKIP_AUTH=true.
  console.log("\n=== 2/2: /app/analytics (SKIP_AUTH mode) ===");
  const analyticsResult = await runTest({
    url: `${TARGET_URL}/app/analytics`,
    method: "GET",
    connections: CONNECTIONS,
    duration: DURATION,
  });
  printSummary("/app/analytics", analyticsResult);
}

function printSummary(label, result) {
  console.log(`\n--- ${label} ---`);
  console.log(`Requests/sec: ${result.requests.average}`);
  console.log(`Latency (avg/p99): ${result.latency.average}ms / ${result.latency.p99}ms`);
  console.log(`2xx: ${result["2xx"]}  Non-2xx/errors: ${result.non2xx + result.errors}`);
}

main().catch((err) => {
  console.error("Load test failed:", err);
  process.exit(1);
});
