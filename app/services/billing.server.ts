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
    if (existingSub.shopifySubscriptionId && existingSub.status === "ACTIVE") {
      // Never switch local feature access to Free while Shopify still has an active paid charge.
      // A cancellation failure is surfaced and the current plan remains authoritative.
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

  // Test/dev fixtures may explicitly run without Shopify Admin context; never fabricate a
  // subscription in production, because a fake ID would make Billing appear enabled without a charge.
  const isTestFixture = process.env.NODE_ENV === "test" && !adminContext;
  if (!isTestFixture && !adminContext) {
    throw new Error("Shopify Admin authorization is unavailable. Reopen BYNDCART from Shopify Admin and try again.");
  }

  let confirmationUrl = isTestFixture ? `${returnUrl}?charge_id=test_fixture` : "";
  let graphqlSubId: string | null = null;
  let subStatus = "PENDING";

  if (!isTestFixture) {
    const admin = await getShopifyAdminClient(store.shop, adminContext);
    const response = await admin.graphql(
      `#graphql
      mutation AppSubscriptionCreate($name: String!, $returnUrl: String!, $lineItems: [AppSubscriptionLineItemInput!]!, $test: Boolean) {
        appSubscriptionCreate(name: $name, returnUrl: $returnUrl, lineItems: $lineItems, test: $test) {
          userErrors {
            field
            message
          }
          confirmationUrl
          appSubscription {
            id
            status
          }
        }
      }`,
      {
        variables: {
          name: plan.name,
          returnUrl,
          test: process.env.NODE_ENV !== "production",
          lineItems: [
            {
              plan: {
                appRecurringPricingDetails: {
                  price: { amount: plan.price, currencyCode: plan.currency },
                  interval: plan.interval,
                },
              },
            },
          ],
        },
      }
    );

    const result = await response.json();
    const topLevelErrors = Array.isArray(result?.errors) ? result.errors.map((e: any) => e?.message).filter(Boolean) : [];
    if (topLevelErrors.length) throw new Error(`Shopify Billing API error: ${topLevelErrors.join("; ")}`);
    const data = result?.data?.appSubscriptionCreate;
    if (!data) throw new Error("Shopify returned no appSubscriptionCreate result.");

    if (data.userErrors?.length) {
      const errMsg = data.userErrors.map((e: any) => e.message).filter(Boolean).join(", ");
      throw new Error(`Shopify Billing Error: ${errMsg}`);
    }
    if (!data.confirmationUrl || !data.appSubscription?.id) {
      throw new Error("Shopify did not return a billing confirmation URL and subscription ID. No local subscription was created.");
    }

    confirmationUrl = String(data.confirmationUrl);
    graphqlSubId = String(data.appSubscription.id);
    subStatus = String(data.appSubscription.status || "PENDING");
  }

  if (!isTestFixture && (!confirmationUrl || !graphqlSubId)) {
    throw new Error("Shopify did not confirm the new subscription. No local subscription was created.");
  }

  // Persist the subscription returned by Shopify in database
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
      test: isTestFixture || process.env.NODE_ENV !== "production",
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
    const isTestFixture = process.env.NODE_ENV === "test" && !adminContext;
    if (!adminContext && !isTestFixture) {
      throw new Error("Shopify Admin authorization is unavailable. Reopen BYNDCART from Shopify Admin to cancel billing.");
    }
    if (!isTestFixture) {
      const store = await prisma.shopifyStore.findUnique({ where: { id: shopifyStoreId } });
      if (!store) throw new Error("Shopify store not found while cancelling the subscription.");
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
      const payload = await response.json();
      const topLevelErrors = Array.isArray(payload?.errors) ? payload.errors.map((e: any) => e?.message).filter(Boolean) : [];
      const data = payload?.data?.appSubscriptionCancel;
      if (topLevelErrors.length) throw new Error(`Shopify cancellation API error: ${topLevelErrors.join("; ")}`);
      if (data?.userErrors?.length) throw new Error(`Shopify cancellation rejected: ${data.userErrors.map((e: any) => e.message).join("; ")}`);
      if (!data?.appSubscription?.id || !["CANCELLED", "DECLINED", "EXPIRED"].includes(String(data.appSubscription.status || "").toUpperCase())) {
        throw new Error("Shopify did not confirm cancellation. The local billing status was not changed.");
      }
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
  const store = await prisma.shopifyStore.findUnique({ where: { id: shopifyStoreId } });
  if (!store) throw new Error("Shopify store not found while syncing billing.");

  const local = await getStoreSubscription(shopifyStoreId);
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
    }`,
  );
  const result = await response.json();
  const topLevelErrors = Array.isArray(result?.errors) ? result.errors.map((error: any) => error?.message).filter(Boolean) : [];
  if (topLevelErrors.length) throw new Error(`Shopify subscription sync failed: ${topLevelErrors.join("; ")}`);

  const activeSubs = Array.isArray(result?.data?.currentAppInstallation?.activeSubscriptions)
    ? result.data.currentAppInstallation.activeSubscriptions
    : [];
  if (!Array.isArray(result?.data?.currentAppInstallation?.activeSubscriptions)) {
    throw new Error("Shopify returned no readable activeSubscriptions field. Local billing was not changed.");
  }

  if (activeSubs.length > 0) {
    // Prefer the locally-associated active subscription if it is still active;
    // otherwise select the newest subscription returned by Shopify.
    const active = activeSubs.find((item: any) => item.id === local.shopifySubscriptionId) || activeSubs[0];
    const normalizedName = String(active.name || "").toUpperCase();
    const matchedCode = normalizedName.includes("PRO")
      ? "PRO"
      : normalizedName.includes("GROWTH")
        ? "GROWTH"
        : normalizedName.includes("BASIC")
          ? "BASIC"
          : null;
    if (!matchedCode) {
      throw new Error(`Shopify reports active subscription "${active.name || active.id}" but BYNDCART cannot map it to a configured plan. Contact support before changing access.`);
    }
    const config = PLAN_CONFIGS[matchedCode];
    return prisma.billingSubscription.upsert({
      where: { shopifyStoreId },
      create: {
        shopifyStoreId,
        shopifySubscriptionId: active.id,
        name: config.name,
        planCode: config.code,
        status: String(active.status || "ACTIVE"),
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
        status: String(active.status || "ACTIVE"),
        price: config.price,
        currency: config.currency,
        interval: config.interval,
        monthlyReturnLimit: config.monthlyReturnLimit,
        currentPeriodEnd: active.currentPeriodEnd ? new Date(active.currentPeriodEnd) : null,
      },
    });
  }

  // Shopify lists only active subscriptions above. If the local record points at an
  // AppSubscription, query its actual status before downgrading local entitlements.
  if (local.shopifySubscriptionId?.startsWith("gid://shopify/AppSubscription/")) {
    const statusResponse = await admin.graphql(
      `#graphql
      query GetBillingSubscriptionStatus($id: ID!) {
        node(id: $id) {
          ... on AppSubscription {
            id
            name
            status
          }
        }
      }`,
      { variables: { id: local.shopifySubscriptionId } },
    );
    const statusPayload = await statusResponse.json();
    const statusErrors = Array.isArray(statusPayload?.errors) ? statusPayload.errors.map((error: any) => error?.message).filter(Boolean) : [];
    if (statusErrors.length) throw new Error(`Could not verify existing Shopify subscription: ${statusErrors.join("; ")}`);

    const remote = statusPayload?.data?.node;
    const remoteStatus = String(remote?.status || "").toUpperCase();
    if (remote?.id && remoteStatus === "PENDING") {
      return prisma.billingSubscription.update({
        where: { shopifyStoreId },
        data: { status: "PENDING", name: remote.name || local.name },
      });
    }
    if (remote?.id && remoteStatus === "ACTIVE") {
      throw new Error("Shopify reported an active subscription that was not present in activeSubscriptions. Local plan was left unchanged; retry billing sync or contact support.");
    }
    if (remote?.id && !["CANCELLED", "DECLINED", "EXPIRED", "FROZEN"].includes(remoteStatus)) {
      throw new Error(`Shopify returned an unrecognized subscription status (${remoteStatus || "unknown"}). Local plan was left unchanged.`);
    }
  }

  const free = PLAN_CONFIGS.FREE;
  const current = await prisma.billingSubscription.findUnique({ where: { shopifyStoreId } });
  if (!current) return getStoreSubscription(shopifyStoreId);
  return prisma.billingSubscription.update({
    where: { shopifyStoreId },
    data: {
      shopifySubscriptionId: null,
      name: free.name,
      planCode: free.code,
      status: "ACTIVE",
      price: free.price,
      currency: free.currency,
      interval: free.interval,
      monthlyReturnLimit: free.monthlyReturnLimit,
      currentPeriodEnd: null,
    },
  });
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
