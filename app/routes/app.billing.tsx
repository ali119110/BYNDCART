import React from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { getStoreByShop } from "../services/store.server";
import { getStorePlan, createAppSubscription, cancelAppSubscription } from "../services/billing.server";
import { PLAN_CONFIGS } from "../services/planGate.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await getStoreByShop(session.shop);
  if (!store) {
    throw new Response("Store not found", { status: 404 });
  }

  const storePlan = await getStorePlan(store.id);

  return {
    storePlan,
    plans: Object.values(PLAN_CONFIGS),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const store = await getStoreByShop(session.shop);
  if (!store) {
    return { success: false, error: "Store not found" };
  }

  const formData = await request.formData();
  const actionType = formData.get("actionType") as string;
  const planCode = formData.get("planCode") as string;

  if (actionType === "subscribe") {
    const origin = new URL(request.url).origin;
    const returnUrl = `${origin}/app/billing`;
    try {
      const result = await createAppSubscription(store.id, planCode, returnUrl, admin);
      if (result.confirmationUrl && result.status === "PENDING") {
        return { success: true, redirectUrl: result.confirmationUrl };
      }
      return { success: true, message: result.message || `Subscribed to ${planCode}` };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  if (actionType === "cancel") {
    try {
      const result = await cancelAppSubscription(store.id, admin);
      return { success: true, message: result.message };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  return { success: false, error: "Invalid action" };
};

export default function Billing() {
  const { storePlan, plans } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  const isSubmitting = fetcher.state !== "idle";
  const actionData = fetcher.data as { success?: boolean; error?: string; message?: string; redirectUrl?: string } | undefined;

  React.useEffect(() => {
    if (actionData?.redirectUrl) {
      window.top?.location.assign(actionData.redirectUrl);
    }
  }, [actionData]);

  const usagePercent = storePlan.isUnlimited
    ? 0
    : Math.min(100, Math.round((storePlan.usageCount / Math.max(1, storePlan.returnsLimit)) * 100));

  return (
    <s-page heading="BYNDCART Billing & Subscription Plans">
      <s-stack direction="block" gap="large">
        
        {/* Status Messages */}
        {actionData?.error && (
          <div style={{ padding: "12px 16px", backgroundColor: "#fef2f2", border: "1px solid #fca5a5", borderRadius: "8px", color: "#991b1b" }}>
            <strong>Error:</strong> {actionData.error}
          </div>
        )}
        {actionData?.message && (
          <div style={{ padding: "12px 16px", backgroundColor: "#f0fdf4", border: "1px solid #86efac", borderRadius: "8px", color: "#166534" }}>
            <strong>Success:</strong> {actionData.message}
          </div>
        )}

        {/* Current Active Plan Overview Card */}
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-stack direction="block" gap="base">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <s-heading>Current Subscription: {storePlan.name}</s-heading>
                <p style={{ margin: "4px 0 0 0", color: "#475569" }}>
                  Status: <strong style={{ color: storePlan.status === "ACTIVE" ? "#008000" : "#d97706" }}>{storePlan.status}</strong> — ${storePlan.price.toFixed(2)} / month
                </p>
              </div>

              {storePlan.planCode !== "FREE" && (
                <fetcher.Form method="post">
                  <input type="hidden" name="actionType" value="cancel" />
                  <s-button type="submit" tone="critical" loading={isSubmitting}>
                    Cancel Subscription
                  </s-button>
                </fetcher.Form>
              )}
            </div>

            {/* Monthly Return Usage Bar */}
            <div style={{ marginTop: "12px", background: "#ffffff", padding: "12px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Monthly Return Requests Usage</span>
                <span>
                  <strong>{storePlan.usageCount}</strong> / {storePlan.isUnlimited ? "Unlimited" : `${storePlan.returnsLimit} returns`}
                </span>
              </div>
              {!storePlan.isUnlimited && (
                <div style={{ width: "100%", height: "10px", backgroundColor: "#cbd5e1", borderRadius: "5px", marginTop: "8px", overflow: "hidden" }}>
                  <div
                    style={{
                      width: `${usagePercent}%`,
                      height: "100%",
                      backgroundColor: usagePercent > 90 ? "#ef4444" : usagePercent > 75 ? "#f59e0b" : "#3b82f6",
                      transition: "width 0.3s ease",
                    }}
                  />
                </div>
              )}
            </div>
          </s-stack>
        </s-box>

        {/* Pricing Tiers Grid */}
        <s-box padding="base">
          <s-heading>Available SaaS Tiers</s-heading>
          <s-paragraph tone="neutral">
            Choose the best plan for your store's return volume and reverse logistics requirements.
          </s-paragraph>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "20px", marginTop: "16px" }}>
            {plans.map((plan) => {
              const isCurrent = storePlan.planCode === plan.code;

              return (
                <div
                  key={plan.code}
                  style={{
                    border: isCurrent ? "2px solid #3b82f6" : "1px solid #e2e8f0",
                    borderRadius: "10px",
                    padding: "20px",
                    backgroundColor: isCurrent ? "#f8fafc" : "#ffffff",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
                  }}
                >
                  <s-stack direction="block" gap="small">
                    {isCurrent && (
                      <span style={{ fontSize: "12px", background: "#3b82f6", color: "#fff", padding: "2px 8px", borderRadius: "12px", width: "fit-content", fontWeight: "bold" }}>
                        Active Tier
                      </span>
                    )}
                    <strong>{plan.name}</strong>
                    <div style={{ fontSize: "24px", fontWeight: "bold", margin: "8px 0" }}>
                      ${plan.price.toFixed(2)} <span style={{ fontSize: "14px", fontWeight: "normal", color: "#64748b" }}>/ mo</span>
                    </div>
                    <s-paragraph tone="neutral">
                      {plan.monthlyReturnLimit === -1
                        ? "Unlimited return requests per month"
                        : `Up to ${plan.monthlyReturnLimit} return requests per month`}
                    </s-paragraph>

                    <div style={{ margin: "12px 0" }}>
                      <ul style={{ paddingLeft: "18px", margin: 0, fontSize: "13px", color: "#475569" }}>
                        {plan.features.map((feat) => (
                          <li key={feat} style={{ marginBottom: "4px" }}>
                            {feat.replace(/_/g, " ")}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </s-stack>

                  <fetcher.Form method="post" style={{ marginTop: "16px" }}>
                    <input type="hidden" name="actionType" value="subscribe" />
                    <input type="hidden" name="planCode" value={plan.code} />
                    <s-button
                      type="submit"
                      variant={isCurrent ? "secondary" : "primary"}
                      disabled={isCurrent || isSubmitting}
                      loading={isSubmitting && fetcher.formData?.get("planCode") === plan.code}
                    >
                      {isCurrent ? "Current Plan" : plan.price === 0 ? "Downgrade to Free" : `Select ${plan.name}`}
                    </s-button>
                  </fetcher.Form>
                </div>
              );
            })}
          </div>
        </s-box>

      </s-stack>
    </s-page>
  );
}
