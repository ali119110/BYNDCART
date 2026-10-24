/**
 * In-memory sliding-window rate limiter.
 *
 * IMPORTANT: this state lives in process memory. It works correctly for a
 * single long-running Node instance (e.g. a traditional server or one
 * container). If you deploy across multiple instances/edge workers behind a
 * load balancer, each instance gets its own independent counter — limits
 * will effectively multiply by instance count. Swap the Map below for a
 * Redis-backed store (e.g. Upstash) before scaling horizontally.
 */
const buckets = new Map();

export function rateLimit(key, { limit, windowMs }) {
  const now = Date.now();
  const windowStart = now - windowMs;
  let bucket = buckets.get(key);

  if (!bucket) {
    bucket = { hits: [] };
    buckets.set(key, bucket);
  }

  // Drop hits outside the current window
  bucket.hits = bucket.hits.filter((t) => t > windowStart);
  const allowed = bucket.hits.length < limit;

  if (allowed) {
    bucket.hits.push(now);
  }

  const resetAt =
    bucket.hits.length > 0 ? bucket.hits[0] + windowMs : now + windowMs;

  return {
    allowed,
    remaining: Math.max(0, limit - bucket.hits.length),
    resetAt,
  };
}

/**
 * Periodic cleanup so the Map doesn't grow unbounded from one-off keys
 * (e.g. IPs that only ever hit once). Safe to call on a timer or skip
 * entirely for low-traffic apps — buckets self-trim on next access anyway.
 */
export function cleanupRateLimitBuckets(maxAgeMs = 10 * 60 * 1000) {
  const now = Date.now();

  for (const [key, bucket] of buckets.entries()) {
    if (
      bucket.hits.length === 0 ||
      now - bucket.hits[bucket.hits.length - 1] > maxAgeMs
    ) {
      buckets.delete(key);
    }
  }
}

/**
 * Throws a Response with 429 status if the limit is exceeded — convenient
 * for dropping straight into a loader/action.
 */
export function assertRateLimit(key, options) {
  const result = rateLimit(key, options);

  if (!result.allowed) {
    throw new Response("Too Many Requests", {
      status: 429,
      headers: {
        "Retry-After": String(Math.ceil((result.resetAt - Date.now()) / 1000)),
      },
    });
  }

  return result;
}
