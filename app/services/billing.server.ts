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
      // Do not grant a downgrade in the local database if Shopify still has the paid
      // subscription active; the cancellation must be confirmed first.
      await cancelAppSubscription(shopifyStoreId, adminContext);
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

  // Shopify is the source of truth for paid subscriptions. Never invent a subscription ID
  // or confirmation URL when the Admin API fails; that would show a paid plan without a charge.
  const admin = await getShopifyAdminClient(store.shop, adminContext);
  if (!admin || typeof admin.graphql !== "function") {
    throw new Error("Shopify Billing is unavailable for this installation. Reopen the embedded app and retry.");
  }

  const billingTestMode = process.env.NODE_ENV !== "production";
  const response = await admin.graphql(
    `#graphql
    mutation AppSubscriptionCreate($name: String!, $returnUrl: URL!, $lineItems: [AppSubscriptionLineItemInput!]!, $test: Boolean) {
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
        test: billingTestMode,
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
  const topLevelErrors = Array.isArray(result?.errors)
    ? result.errors.map((error: any) => String(error?.message || "Shopify GraphQL request failed."))
    : [];
  if (topLevelErrors.length) throw new Error(`Shopify Billing request failed: ${topLevelErrors.join("; ")}`);

  const data = result?.data?.appSubscriptionCreate;
  const userErrors = Array.isArray(data?.userErrors) ? data.userErrors : [];
  if (userErrors.length) {
    throw new Error(`Shopify Billing Error: ${userErrors.map((error: any) => {
      const field = Array.isArray(error?.field) ? error.field.join(".") : "";
      return [field, error?.message].filter(Boolean).join(": ");
    }).join("; ")}`);
  }

  const graphqlSubId = String(data?.appSubscription?.id || "");
  const confirmationUrl = String(data?.confirmationUrl || "");
  const subStatus = String(data?.appSubscription?.status || "PENDING");
  if (!graphqlSubId.startsWith("gid://shopify/AppSubscription/")) {
    throw new Error("Shopify did not return a valid app subscription ID. No local paid plan was recorded.");
  }
  if (!confirmationUrl && subStatus !== "ACTIVE") {
    throw new Error("Shopify created no approval URL for this subscription. The plan has not been activated; retry from Billing.");
  }

  // Keep the subscription PENDING until Shopify's approval callback/webhook confirms it.
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
      test: billingTestMode,
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
      test: billingTestMode,
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

  if (sub.shopifySubscriptionId && sub.shopifySubscriptionId.startsWith("gid://shopify/AppSubscription/")) {
    try {
      const store = await prisma.shopifyStore.findUnique({
        where: { id: shopifyStoreId },
      });
      if (store) {
        const admin = await getShopifyAdminClient(store.shop, adminContext);
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
        const result = await response.json();
        const topErrors = Array.isArray(result?.errors) ? result.errors.map((error: any) => error?.message).filter(Boolean) : [];
        const data = result?.data?.appSubscriptionCancel;
        const userErrors = Array.isArray(data?.userErrors) ? data.userErrors : [];
        if (topErrors.length || userErrors.length) {
          throw new Error([...topErrors, ...userErrors.map((error: any) => error?.message)].filter(Boolean).join("; "));
        }
        if (data?.appSubscription?.status && !["CANCELLED", "DECLINED", "EXPIRED"].includes(String(data.appSubscription.status).toUpperCase())) {
          throw new Error(`Shopify returned subscription status ${data.appSubscription.status} after cancellation.`);
        }
      }
    } catch (err: any) {
      throw new Error(`Shopify could not confirm subscription cancellation. Your current plan was not changed: ${err instanceof Error ? err.message : "Unknown Shopify billing error"}`);
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
