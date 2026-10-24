import prisma from "../db.server";
import { getStoreSubscription, checkUsageLimit, PLAN_CONFIGS } from "./planGate.server";
import { getShopifyAdminClient } from "./shopifySync.server";

export interface StorePlanResponse {
  shopifyStoreId: string;
  name: string;
  planCode: string;
  price: number;
  currency: string;
  status: string;
  usageCount: number;
  returnsLimit: number;
  isUnlimited: boolean;
  shopifySubscriptionId?: string | null;
}

/**
 * Gets the current tenant-scoped billing plan status and usage details.
 */
export async function getStorePlan(shopifyStoreId: string): Promise<StorePlanResponse> {
  const sub = await getStoreSubscription(shopifyStoreId);
  const usage = await checkUsageLimit(shopifyStoreId);

  return {
    shopifyStoreId,
    name: sub.name,
    planCode: sub.planCode,
    price: Number(sub.price),
    currency: sub.currency,
    status: sub.status,
    usageCount: usage.usageCount,
    returnsLimit: usage.limit,
    isUnlimited: usage.isUnlimited,
    shopifySubscriptionId: sub.shopifySubscriptionId,
  };
}

/**
 * Initiates recurring app subscription creation via Shopify Admin GraphQL.
 * Idempotently prevents duplicate pending requests for the current active plan.
 */
export async function createAppSubscription(
  shopifyStoreId: string,
  planCode: string,
  returnUrl: string,
  adminContext?: any
) {
  const plan = PLAN_CONFIGS[planCode];
  if (!plan) {
    throw new Error(`Invalid plan code: ${planCode}`);
  }

  const store = await prisma.shopifyStore.findUnique({
    where: { id: shopifyStoreId },
  });
  if (!store) {
    throw new Error(`Shopify store not found for ID: ${shopifyStoreId}`);
  }

  const existingSub = await getStoreSubscription(shopifyStoreId);

  // Idempotency check: if merchant is already on this active plan, return immediately
  if (existingSub.planCode === planCode && existingSub.status === "ACTIVE") {
    return {
      success: true,
      status: "ACTIVE",
      planCode,
      message: `Already subscribed to ${plan.name}`,
      confirmationUrl: returnUrl,
    };
  }

  // Handling Free plan selection directly
  if (planCode === "FREE") {
    // If cancelling paid sub
    if (existingSub.shopifySubscriptionId && adminContext) {
      try {
        await cancelAppSubscription(shopifyStoreId, adminContext);
      } catch (err) {
        console.warn(`[Billing Service] Warning during cancel while downgrading:`, err);
      }
    }

    const updated = await prisma.billingSubscription.upsert({
      where: { shopifyStoreId },
      create: {
        shopifyStoreId,
        name: plan.name,
        planCode: plan.code,
        status: "ACTIVE",
        price: plan.price,
        currency: plan.currency,
        interval: plan.interval,
        monthlyReturnLimit: plan.monthlyReturnLimit,
      },
      update: {
        name: plan.name,
        planCode: plan.code,
        status: "ACTIVE",
        price: plan.price,
        currency: plan.currency,
        interval: plan.interval,
        monthlyReturnLimit: plan.monthlyReturnLimit,
        shopifySubscriptionId: null,
      },
    });

    await prisma.auditLog.create({
      data: {
        shopifyStoreId,
        action: "BILLING_SUBSCRIPTION_CHANGED",
        entityType: "BillingSubscription",
        entityId: updated.id,
        metadata: { planCode: "FREE", status: "ACTIVE" },
      },
    });

    return {
      success: true,
      status: "ACTIVE",
      planCode: "FREE",
      message: "Downgraded to Free Plan",
      confirmationUrl: returnUrl,
    };
  }

  // Test-only fallback is strictly opt-in to the automated test/dev harness. Never
  // fabricate a Shopify subscription ID or report success in a real merchant install.
  const isTestHarness = process.env.NODE_ENV === "test" || process.env.SKIP_AUTH === "true";
  let confirmationUrl = "";
  let graphqlSubId: string | null = null;
  let subStatus = "PENDING";

  if (isTestHarness && !adminContext) {
    confirmationUrl = returnUrl;
    graphqlSubId = null;
    subStatus = "PENDING";
  } else {
    const admin = await getShopifyAdminClient(store.shop, adminContext);
    if (!admin || typeof admin.graphql !== "function") {
      throw new Error("Shopify Admin API is unavailable. Reopen BYNDCART through Shopify Admin and retry billing.");
    }
    const response = await admin.graphql(
      `#graphql
      mutation AppSubscriptionCreate($name: String!, $returnUrl: String!, $lineItems: [AppSubscriptionLineItemInput!]!, $test: Boolean) {
        appSubscriptionCreate(name: $name, returnUrl: $returnUrl, lineItems: $lineItems, test: $test) {
          userErrors { field message }
          confirmationUrl
          appSubscription { id status }
        }
      }`,
      {
        variables: {
          name: plan.name,
          returnUrl,
          test: process.env.NODE_ENV !== "production",
          lineItems: [{
            plan: {
              appRecurringPricingDetails: {
                price: { amount: plan.price, currencyCode: plan.currency },
                interval: plan.interval,
              },
            },
          }],
        },
      },
    );
    const result = await response.json();
    const topErrors = Array.isArray(result?.errors) ? result.errors.map((error: any) => String(error?.message || "")).filter(Boolean) : [];
    if (topErrors.length) throw new Error(`Shopify Billing API error: ${topErrors.join("; ")}`);
    const data = result?.data?.appSubscriptionCreate;
    if (Array.isArray(data?.userErrors) && data.userErrors.length) {
      const messages = data.userErrors.map((error: any) => String(error?.message || "")).filter(Boolean);
      throw new Error(`Shopify Billing Error: ${messages.join("; ") || "Shopify rejected the subscription request."}`);
    }
    confirmationUrl = String(data?.confirmationUrl || "");
    graphqlSubId = typeof data?.appSubscription?.id === "string" ? data.appSubscription.id : null;
    subStatus = String(data?.appSubscription?.status || "PENDING").toUpperCase();
    if (!confirmationUrl || !graphqlSubId) {
      throw new Error("Shopify did not return a subscription confirmation URL and subscription ID. No billing plan was changed.");
    }
  }

  // Persist only a real Shopify subscription, except in the explicit test harness.
  const subscription = await prisma.billingSubscription.upsert({
    where: { shopifyStoreId },
    create: {
      shopifyStoreId,
      shopifySubscriptionId: graphqlSubId,
      name: plan.name,
      planCode: plan.code,
      status: subStatus,
      price: plan.price,
      currency: plan.currency,
      interval: plan.interval,
      monthlyReturnLimit: plan.monthlyReturnLimit,
      test: process.env.NODE_ENV !== "production",
    },
    update: {
      shopifySubscriptionId: graphqlSubId,
      name: plan.name,
      planCode: plan.code,
      status: subStatus,
      price: plan.price,
      currency: plan.currency,
      interval: plan.interval,
      monthlyReturnLimit: plan.monthlyReturnLimit,
      test: process.env.NODE_ENV !== "production",
    },
  });

  await prisma.auditLog.create({
    data: {
      shopifyStoreId,
      action: "BILLING_SUBSCRIPTION_INITIATED",
      entityType: "BillingSubscription",
      entityId: subscription.id,
      metadata: { planCode, status: subStatus, shopifySubscriptionId: graphqlSubId },
    },
  });

  return {
    success: true,
    status: subStatus,
    planCode,
    confirmationUrl,
    shopifySubscriptionId: graphqlSubId,
  };
}

/**
 * Cancels active subscription via Shopify GraphQL and updates database.
 */
export async function cancelAppSubscription(shopifyStoreId: string, adminContext?: any) {
  const sub = await getStoreSubscription(shopifyStoreId);

  const isTestHarness = process.env.NODE_ENV === "test" || process.env.SKIP_AUTH === "true";
  if (
    sub.shopifySubscriptionId
    && sub.shopifySubscriptionId.startsWith("gid://shopify/AppSubscription/")
    && !(isTestHarness && !adminContext)
  ) {
    try {
      const store = await prisma.shopifyStore.findUnique({
        where: { id: shopifyStoreId },
      });
      if (store) {
        const admin = await getShopifyAdminClient(store.shop, adminContext);
        if (!admin || typeof admin.graphql !== "function") {
          throw new Error("Shopify Admin API is unavailable. Reopen BYNDCART through Shopify Admin and retry cancellation.");
        }
        const response = await admin.graphql(
          `#graphql
          mutation AppSubscriptionCancel($id: ID!) {
            appSubscriptionCancel(id: $id) {
              userErrors { field message }
              appSubscription { id status }
            }
          }`,
          { variables: { id: sub.shopifySubscriptionId } },
        );
        const payload = await response.json();
        const topErrors = Array.isArray(payload?.errors) ? payload.errors.map((item: any) => String(item?.message || "")).filter(Boolean) : [];
        const userErrors = payload?.data?.appSubscriptionCancel?.userErrors || [];
        const messages = [...topErrors, ...userErrors.map((item: any) => String(item?.message || "")).filter(Boolean)];
        if (messages.length) throw new Error(messages.join("; "));
        const actualStatus = String(payload?.data?.appSubscriptionCancel?.appSubscription?.status || "").toUpperCase();
        if (actualStatus && actualStatus !== "CANCELLED" && actualStatus !== "DECLINED") {
          throw new Error(`Shopify returned subscription status ${actualStatus}; cancellation was not confirmed.`);
        }
      }
    } catch (err: any) {
      throw new Error(`Shopify could not confirm subscription cancellation: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const freePlan = PLAN_CONFIGS.FREE;
  const updated = await prisma.billingSubscription.update({
    where: { shopifyStoreId },
    data: {
      status: "CANCELLED",
      name: freePlan.name,
      planCode: freePlan.code,
      price: freePlan.price,
      monthlyReturnLimit: freePlan.monthlyReturnLimit,
    },
  });

  await prisma.auditLog.create({
    data: {
      shopifyStoreId,
      action: "BILLING_SUBSCRIPTION_CANCELLED",
      entityType: "BillingSubscription",
      entityId: updated.id,
      metadata: { previousPlan: sub.planCode, status: "CANCELLED" },
    },
  });

  return {
    success: true,
    status: "CANCELLED",
    planCode: "FREE",
    message: "Subscription successfully cancelled.",
  };
}

/**
 * Synchronizes subscription state from Shopify GraphQL API to database.
 */
export async function syncSubscriptionState(shopifyStoreId: string, adminContext?: any) {
  const store = await prisma.shopifyStore.findUnique({
    where: { id: shopifyStoreId },
  });
  if (!store) return null;

  try {
    const admin = await getShopifyAdminClient(store.shop, adminContext);
    const response = await admin.graphql(
      `#graphql
      query GetActiveSubscriptions {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
            createdAt
            currentPeriodEnd
          }
        }
      }`
    );
    const result = await response.json();
    const activeSubs = result?.data?.currentAppInstallation?.activeSubscriptions || [];

    if (activeSubs.length > 0) {
      const active = activeSubs[0];
      let matchedCode = "BASIC";
      if (active.name.toUpperCase().includes("GROWTH")) matchedCode = "GROWTH";
      if (active.name.toUpperCase().includes("PRO")) matchedCode = "PRO";

      const config = PLAN_CONFIGS[matchedCode] || PLAN_CONFIGS.BASIC;

      return await prisma.billingSubscription.upsert({
        where: { shopifyStoreId },
        create: {
          shopifyStoreId,
          shopifySubscriptionId: active.id,
          name: config.name,
          planCode: config.code,
          status: active.status || "ACTIVE",
          price: config.price,
          currency: config.currency,
          interval: config.interval,
          monthlyReturnLimit: config.monthlyReturnLimit,
          currentPeriodEnd: active.currentPeriodEnd ? new Date(active.currentPeriodEnd) : null,
        },
        update: {
          shopifySubscriptionId: active.id,
          name: config.name,
          planCode: config.code,
          status: active.status || "ACTIVE",
          price: config.price,
          currency: config.currency,
          interval: config.interval,
          monthlyReturnLimit: config.monthlyReturnLimit,
          currentPeriodEnd: active.currentPeriodEnd ? new Date(active.currentPeriodEnd) : null,
        },
      });
    }
  } catch (err: any) {
    console.warn(`[Billing Service] syncSubscriptionState note: ${err.message}`);
  }

  return getStoreSubscription(shopifyStoreId);
}

/**
 * Processes incoming app subscription webhooks from Shopify (APP_SUBSCRIPTIONS_UPDATE).
 */
export async function handleSubscriptionWebhook(shop: string, payload: any) {
  const store = await prisma.shopifyStore.findUnique({
    where: { shop },
  });

  if (!store) {
    console.warn(`[Billing Webhook] No shopifyStore found for shop: ${shop}`);
    return;
  }

  const appSub = payload?.app_subscription || payload;
  const status = appSub?.status || "ACTIVE";
  const name = appSub?.name || "Basic Plan";
  const graphqlId = appSub?.admin_graphql_api_id || appSub?.id;

  let planCode = "BASIC";
  if (name.toUpperCase().includes("GROWTH")) planCode = "GROWTH";
  if (name.toUpperCase().includes("PRO")) planCode = "PRO";
  if (name.toUpperCase().includes("FREE")) planCode = "FREE";

  const config = PLAN_CONFIGS[planCode] || PLAN_CONFIGS.BASIC;

  const sub = await prisma.billingSubscription.upsert({
    where: { shopifyStoreId: store.id },
    create: {
      shopifyStoreId: store.id,
      shopifySubscriptionId: graphqlId,
      name: config.name,
      planCode: config.code,
      status,
      price: config.price,
      currency: config.currency,
      interval: config.interval,
      monthlyReturnLimit: config.monthlyReturnLimit,
    },
    update: {
      shopifySubscriptionId: graphqlId,
      name: config.name,
      planCode: config.code,
      status,
      price: config.price,
      currency: config.currency,
      interval: config.interval,
      monthlyReturnLimit: config.monthlyReturnLimit,
    },
  });

  await prisma.auditLog.create({
    data: {
      shopifyStoreId: store.id,
      action: "BILLING_SUBSCRIPTION_WEBHOOK_PROCESSED",
      entityType: "BillingSubscription",
      entityId: sub.id,
      metadata: { status, planCode, shopifySubscriptionId: graphqlId },
    },
  });

  return sub;
}
