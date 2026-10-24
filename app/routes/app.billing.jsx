import React from "react";
import { useLoaderData, useFetcher } from "react-router";
import { requireTenantContext } from "../services/tenant.server";
import {
  getStorePlan,
  createAppSubscription,
  cancelAppSubscription,
} from "../services/billing.server";
import { PLAN_CONFIGS } from "../services/planGate.server";
import { planPriceInPKR } from "../utils/pricing";

export const loader = async ({ request }) => {
  const { shopifyStoreId } = await requireTenantContext(request);
  const storePlan = await getStorePlan(shopifyStoreId);

  return {
    storePlan,
    plans: Object.values(PLAN_CONFIGS),
  };
};

export const action = async ({ request }) => {
  const { shopifyStoreId, admin } = await requireTenantContext(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType");
  const planCode = formData.get("planCode");

  if (actionType === "subscribe") {
    const origin = new URL(request.url).origin;
    const returnUrl = `${origin}/app/billing`;

    try {
      const result = await createAppSubscription(
        shopifyStoreId,
        planCode,
        returnUrl,
        admin,
      );

      if (result.confirmationUrl && result.status === "PENDING") {
        return { success: true, redirectUrl: result.confirmationUrl };
      }

      return {
        success: true,
        message: result.message || `Subscribed to ${planCode}`,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (actionType === "cancel") {
    try {
      const result = await cancelAppSubscription(shopifyStoreId, admin);

      return { success: true, message: result.message };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  return { success: false, error: "Invalid action" };
};

export default function Billing() {
  const { storePlan: rawStorePlan, plans } = useLoaderData();
  const fetcher = useFetcher();
  const storePlan = rawStorePlan ?? {
    shopifyStoreId: "",
    name: "Free Plan",
    planCode: "FREE",
    price: 0,
    currency: "PKR",
    status: "ACTIVE",
    usageCount: 0,
    returnsLimit: 50,
    isUnlimited: false,
  };
  const isSubmitting = fetcher.state !== "idle";
  const actionData = fetcher.data;

  React.useEffect(() => {
    if (actionData?.redirectUrl) {
      window.top?.location.assign(actionData.redirectUrl);
    }
  }, [actionData]);
  const usagePercent = storePlan.isUnlimited
    ? 0
    : Math.min(
        100,
        Math.round(
          ((storePlan.usageCount ?? 0) /
            Math.max(1, storePlan.returnsLimit ?? 50)) *
            100,
        ),
      );

  return (
    <div className="bc-page">
      <header className="bc-header">
        <div className="bc-header-copy">
          <p className="bc-eyebrow">ACCOUNT</p>
          <h1>Billing</h1>
          <p>
            The current plan and how many return and exchange orders this store
            has used.
          </p>
        </div>
      </header>
      {actionData?.error && (
        <div className="bc-note bad">{actionData.error}</div>
      )}
      {actionData?.message && (
        <div className="bc-note ok">{actionData.message}</div>
      )}

      {/* Current Active Plan Overview Card */}
      <section className="bc-card">
        <div className="bc-page-bar">
          <div>
            <h2 className="bc-title">
              Current plan: {storePlan.name ?? "Free"}
            </h2>
            <p style={{ margin: "4px 0 0 0", color: "#475569" }}>
              Status:{" "}
              <strong
                style={{
                  color: storePlan.status === "ACTIVE" ? "#008000" : "#d97706",
                }}
              >
                {storePlan.status ?? "ACTIVE"}
              </strong>{" "}
              — PKR {planPriceInPKR(storePlan.price ?? 0).toLocaleString()} /
              month
              {(storePlan.price ?? 0) > 0
                ? ` (USD ${(storePlan.price ?? 0).toFixed(2)} reference)`
                : ""}
            </p>
          </div>

          {storePlan.planCode !== "FREE" && (
            <fetcher.Form method="post">
              <input type="hidden" name="actionType" value="cancel" />
              <button type="submit" className="bc-btn" disabled={isSubmitting}>
                Cancel plan
              </button>
            </fetcher.Form>
          )}
        </div>
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>Processed orders (returns and exchanges together)</span>
            <span>
              <strong>{storePlan.usageCount}</strong> /{" "}
              {storePlan.isUnlimited
                ? "Unlimited"
                : `${storePlan.returnsLimit} orders`}
            </span>
          </div>
          {!storePlan.isUnlimited && (
            <div className="bc-usage" style={{ marginTop: "8px" }}>
              <span
                style={{
                  width: `${usagePercent}%`,
                  background:
                    usagePercent > 90
                      ? "#b42318"
                      : usagePercent > 75
                        ? "#916a00"
                        : undefined,
                }}
              />
            </div>
          )}
        </div>
      </section>

      <section className="bc-stack">
        <div>
          <h2 className="bc-title">Plans</h2>
          <p className="bc-muted">
            Choose the plan for this store&apos;s return and exchange volume.
          </p>
        </div>

        <div className="bc-split-cards">
          {plans.map((plan) => {
            const isCurrent = storePlan.planCode === plan.code;

            return (
              <article
                key={plan.code}
                className="bc-card"
                style={isCurrent ? { borderColor: "#263f8c" } : undefined}
              >
                {isCurrent && <span className="bc-badge">Current plan</span>}
                <h3 className="bc-title">{plan.name}</h3>
                <div
                  style={{
                    fontSize: "24px",
                    fontWeight: "bold",
                    margin: "8px 0",
                  }}
                >
                  PKR {planPriceInPKR(plan.price).toLocaleString()}{" "}
                  <span
                    style={{
                      fontSize: "14px",
                      fontWeight: "normal",
                      color: "#64748b",
                    }}
                  >
                    / mo
                  </span>
                </div>
                {plan.price > 0 && (
                  <div
                    style={{
                      fontSize: "12px",
                      color: "#64748b",
                      marginBottom: "8px",
                    }}
                  >
                    USD {plan.price.toFixed(2)} reference
                  </div>
                )}
                <p className="bc-muted">
                  {plan.code === "FREE"
                    ? "50 orders total, counting returns and exchanges together"
                    : plan.monthlyReturnLimit === -1
                      ? "Unlimited processed orders"
                      : `Up to ${plan.monthlyReturnLimit} processed orders per month, counting returns and exchanges together`}
                </p>

                <div style={{ margin: "12px 0" }}>
                  <ul
                    style={{
                      paddingLeft: "18px",
                      margin: 0,
                      fontSize: "13px",
                      color: "#475569",
                    }}
                  >
                    {plan.features.map((feat) => (
                      <li key={feat} style={{ marginBottom: "4px" }}>
                        {feat.replace(/_/g, " ")}
                      </li>
                    ))}
                  </ul>
                </div>
                <fetcher.Form method="post" style={{ marginTop: "16px" }}>
                  <input type="hidden" name="actionType" value="subscribe" />
                  <input type="hidden" name="planCode" value={plan.code} />
                  <button
                    type="submit"
                    className={isCurrent ? "bc-btn" : "bc-btn primary"}
                    disabled={isCurrent || isSubmitting}
                  >
                    {isCurrent
                      ? "Current plan"
                      : plan.price === 0
                        ? "Use free plan"
                        : `Select ${plan.name}`}
                  </button>
                </fetcher.Form>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
