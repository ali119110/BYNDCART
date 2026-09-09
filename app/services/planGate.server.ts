import prisma from "../db.server";

export interface PlanConfig {
  code: string;
  name: string;
  price: number;
  currency: string;
  interval: string;
  monthlyReturnLimit: number;
  features: string[];
}

export const PLAN_CONFIGS: Record<string, PlanConfig> = {
  FREE: {
    code: "FREE",
    name: "Free Plan",
    price: 0,
    currency: "USD",
    interval: "EVERY_30_DAYS",
    monthlyReturnLimit: 15,
    features: ["BASIC_RETURNS", "EXCHANGES"],
  },
  BASIC: {
    code: "BASIC",
    name: "Basic Plan",
    price: 19.00,
    currency: "USD",
    interval: "EVERY_30_DAYS",
    monthlyReturnLimit: 100,
    features: ["BASIC_RETURNS", "EXCHANGES", "CUSTOM_RULES"],
  },
  GROWTH: {
    code: "GROWTH",
    name: "Growth Plan",
    price: 49.00,
    currency: "USD",
    interval: "EVERY_30_DAYS",
    monthlyReturnLimit: 500,
    features: ["BASIC_RETURNS", "EXCHANGES", "CUSTOM_RULES", "MULTIPLE_COURIERS", "ADVANCED_ANALYTICS"],
  },
  PRO: {
    code: "PRO",
    name: "Pro Plan",
    price: 99.00,
    currency: "USD",
    interval: "EVERY_30_DAYS",
    monthlyReturnLimit: -1, // Unlimited
    features: ["BASIC_RETURNS", "EXCHANGES", "CUSTOM_RULES", "MULTIPLE_COURIERS", "ADVANCED_ANALYTICS", "PRIORITY_SUPPORT", "UNLIMITED_RETURNS"],
  },
};

/**
 * Resolves the active billing subscription for a tenant shopifyStoreId.
 * Defaults to FREE plan if no subscription exists or if expired.
 */
export async function getStoreSubscription(shopifyStoreId: string) {
  let sub = await prisma.billingSubscription.findUnique({
    where: { shopifyStoreId },
  });

  if (!sub) {
    sub = await prisma.billingSubscription.create({
      data: {
        shopifyStoreId,
        name: PLAN_CONFIGS.FREE.name,
        planCode: PLAN_CONFIGS.FREE.code,
        status: "ACTIVE",
        price: PLAN_CONFIGS.FREE.price,
        currency: PLAN_CONFIGS.FREE.currency,
        interval: PLAN_CONFIGS.FREE.interval,
        monthlyReturnLimit: PLAN_CONFIGS.FREE.monthlyReturnLimit,
      },
    });
  }

  // Handle expired subscriptions safely: revert status to EXPIRED or fallback to Free limits
  if (sub.status === "ACTIVE" && sub.currentPeriodEnd && new Date() > sub.currentPeriodEnd) {
    sub = await prisma.billingSubscription.update({
      where: { id: sub.id },
      data: {
        status: "EXPIRED",
      },
    });
  }

  return sub;
}

/**
 * Checks usage limit for return requests in the current billing period/month.
 */
export async function checkUsageLimit(shopifyStoreId: string) {
  const sub = await getStoreSubscription(shopifyStoreId);

  // If subscription is EXPIRED or CANCELLED, restrict to FREE plan limit (15) unless planCode is FREE
  let effectiveLimit = sub.monthlyReturnLimit;
  if (sub.status === "EXPIRED" || sub.status === "CANCELLED" || sub.status === "DECLINED") {
    effectiveLimit = PLAN_CONFIGS.FREE.monthlyReturnLimit;
  }

  const now = new Date();
  const periodStart = sub.currentPeriodStart || new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = sub.currentPeriodEnd || new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  const usageCount = await prisma.returnRequest.count({
    where: {
      shopifyStoreId,
      createdAt: {
        gte: periodStart,
        lte: periodEnd,
      },
    },
  });

  const isUnlimited = effectiveLimit === -1;
  const allowed = isUnlimited || usageCount < effectiveLimit;

  return {
    allowed,
    usageCount,
    limit: effectiveLimit,
    isUnlimited,
    planCode: sub.planCode,
    planName: sub.name,
    status: sub.status,
    periodStart,
    periodEnd,
  };
}

/**
 * Checks if a specific feature is allowed for the store's current subscription.
 */
export async function checkFeatureAccess(shopifyStoreId: string, featureKey: string): Promise<boolean> {
  const sub = await getStoreSubscription(shopifyStoreId);
  if (sub.status !== "ACTIVE" && sub.status !== "PENDING") {
    // Expired or cancelled falls back to FREE tier features
    return PLAN_CONFIGS.FREE.features.includes(featureKey);
  }

  const config = PLAN_CONFIGS[sub.planCode] || PLAN_CONFIGS.FREE;
  return config.features.includes(featureKey);
}

/**
 * Authoritative server-side assertion function called during return creation.
 * Throws an error if plan usage limit is reached or subscription is invalid.
 */
export async function assertCanCreateReturn(shopifyStoreId: string): Promise<void> {
  const usage = await checkUsageLimit(shopifyStoreId);
  if (!usage.allowed) {
    const error = new Error(
      `Plan usage limit reached. Your ${usage.planName} allows up to ${usage.limit} returns per month (${usage.usageCount} used). Please upgrade your subscription to submit more returns.`
    );
    (error as any).code = "PLAN_USAGE_LIMIT_EXCEEDED";
    throw error;
  }
}
