import React from "react";
import { useLoaderData, useFetcher } from "react-router";
import { requireTenantContext } from "../utils/tenant.server";
import { getSettings, updateSettings } from "../services/settings.server";
import {
  getReturnPolicyRule,
  saveReturnPolicyRule,
} from "../services/policyEngine.server";

// ===== LOADER: Fetch settings & policy rules from database =====
export async function loader({ request }) {
  const { shopifyStoreId, admin } = await requireTenantContext(request);

  try {
    const settings = await getSettings(shopifyStoreId, admin);
    const policyRule = await getReturnPolicyRule(shopifyStoreId);

    return { settings, policyRule };
  } catch (error) {
    console.error("Failed to fetch settings:", error);

    return {
      settings: {
        returnWindowDays: 30,
        restockingFeePercent: 0,
        exchangeWindowDays: 30,
        exchangeShippingCost: 0,
        notificationEmail: "",
        emailNotificationsEnabled: false,
      },
      policyRule: {
        returnWindowDays: 30,
        exchangeWindowDays: 30,
        returnsAllowed: true,
        exchangesAllowed: true,
        allowSaleItems: true,
        maxReturnQuantity: 5,
        preventPreviousReturns: true,
        excludedSkus: [],
        excludedCategories: [],
      },
    };
  }
}

// ===== ACTION: Handle settings & policy updates =====
export async function action({ request }) {
  if (request.method !== "POST") {
    return { error: "Method not allowed" };
  }

  const { shopifyStoreId } = await requireTenantContext(request);
  const formData = await request.formData();
  const returnWindowDays = Number(formData.get("returnWindowDays"));
  const restockingFeePercent = Number(formData.get("restockingFeePercent"));
  const exchangeWindowDays = Number(formData.get("exchangeWindowDays"));
  const exchangeShippingCost = Number(formData.get("exchangeShippingCost"));
  const notificationEmail = formData.get("notificationEmail");
  const emailNotificationsEnabled =
    formData.get("emailNotificationsEnabled") === "on";
  const fraudFlagReturnCount = Number(
    formData.get("fraudFlagReturnCount") || 5,
  );
  const fraudFlagWindowDays = Number(formData.get("fraudFlagWindowDays") || 30);
  const fraudFlagWindowCount = Number(
    formData.get("fraudFlagWindowCount") || 3,
  );
  // Policy Rule fields
  const returnsAllowed = formData.get("returnsAllowed") === "on";
  const exchangesAllowed = formData.get("exchangesAllowed") === "on";
  const allowSaleItems = formData.get("allowSaleItems") === "on";
  const maxReturnQuantity = Number(formData.get("maxReturnQuantity") || 5);
  const preventPreviousReturns =
    formData.get("preventPreviousReturns") === "on";
  const excludedSkus = (formData.get("excludedSkus") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const excludedCategories = (formData.get("excludedCategories") || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  try {
    const updatedSettings = await updateSettings(shopifyStoreId, {
      returnWindowDays,
      restockingFeePercent,
      exchangeWindowDays,
      exchangeShippingCost,
      notificationEmail: notificationEmail || null,
      emailNotificationsEnabled,
      fraudFlagReturnCount,
      fraudFlagWindowDays,
      fraudFlagWindowCount,
    });
    const updatedPolicyRule = await saveReturnPolicyRule(shopifyStoreId, {
      returnWindowDays,
      exchangeWindowDays,
      returnsAllowed,
      exchangesAllowed,
      allowSaleItems,
      maxReturnQuantity,
      preventPreviousReturns,
      excludedSkus,
      excludedCategories,
    });

    return {
      success: true,
      settings: updatedSettings,
      policyRule: updatedPolicyRule,
    };
  } catch (error) {
    console.error("Failed to update settings:", error);

    return { error: String(error) };
  }
}

// ===== COMPONENT =====
export default function Settings() {
  const { settings, policyRule } = useLoaderData();
  const fetcher = useFetcher();
  const formRef = React.useRef(null);
  const isSaving = fetcher.state === "submitting";
  const savedRecently = fetcher.state === "idle" && fetcher.data?.success;

  const handleSave = () => {
    if (formRef.current) {
      fetcher.submit(formRef.current);
    }
  };

  return (
    <s-page heading="Store Settings & Return Policy Engine">
      <fetcher.Form method="POST" ref={formRef}>
        <s-section heading="Return Policy Rules">
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "16px",
              maxWidth: "540px",
            }}
          >
            <div style={{ display: "flex", gap: "16px" }}>
              <div style={{ flex: 1 }}>
                <label
                  style={{
                    display: "block",
                    fontSize: "13px",
                    marginBottom: "4px",
                  }}
                >
                  Return Window (days)
                </label>
                <input
                  type="number"
                  name="returnWindowDays"
                  defaultValue={Number(
                    policyRule.returnWindowDays ??
                      settings.returnWindowDays ??
                      30,
                  )}
                  min={0}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    border: "1px solid #c9cccf",
                    borderRadius: "4px",
                  }}
                />
              </div>

              <div style={{ flex: 1 }}>
                <label
                  style={{
                    display: "block",
                    fontSize: "13px",
                    marginBottom: "4px",
                  }}
                >
                  Restocking Fee (%)
                </label>
                <input
                  type="number"
                  name="restockingFeePercent"
                  defaultValue={Number(settings.restockingFeePercent ?? 0)}
                  min={0}
                  step="0.01"
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    border: "1px solid #c9cccf",
                    borderRadius: "4px",
                  }}
                />
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <input
                type="checkbox"
                id="returnsAllowed"
                name="returnsAllowed"
                defaultChecked={policyRule.returnsAllowed ?? true}
                style={{ width: "16px", height: "16px" }}
              />
              <label htmlFor="returnsAllowed" style={{ fontSize: "13px" }}>
                Enable Online Returns for Shoppers
              </label>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <input
                type="checkbox"
                id="allowSaleItems"
                name="allowSaleItems"
                defaultChecked={policyRule.allowSaleItems ?? true}
                style={{ width: "16px", height: "16px" }}
              />
              <label htmlFor="allowSaleItems" style={{ fontSize: "13px" }}>
                Allow Returns on Sale / Discounted Items
              </label>
            </div>

            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "13px",
                  marginBottom: "4px",
                }}
              >
                Max Return Quantity per Order
              </label>
              <input
                type="number"
                name="maxReturnQuantity"
                defaultValue={Number(policyRule.maxReturnQuantity ?? 5)}
                min={1}
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  border: "1px solid #c9cccf",
                  borderRadius: "4px",
                }}
              />
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <input
                type="checkbox"
                id="preventPreviousReturns"
                name="preventPreviousReturns"
                defaultChecked={policyRule.preventPreviousReturns ?? true}
                style={{ width: "16px", height: "16px" }}
              />
              <label
                htmlFor="preventPreviousReturns"
                style={{ fontSize: "13px" }}
              >
                Prevent Multiple Return/Exchange Requests on Same Order
              </label>
            </div>

            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "13px",
                  marginBottom: "4px",
                }}
              >
                Excluded SKUs (Comma-separated)
              </label>
              <input
                type="text"
                name="excludedSkus"
                defaultValue={(policyRule.excludedSkus || []).join(", ")}
                placeholder="SKU-FINAL-01, UNDERWEAR-M"
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  border: "1px solid #c9cccf",
                  borderRadius: "4px",
                }}
              />
            </div>

            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "13px",
                  marginBottom: "4px",
                }}
              >
                Excluded Product Categories (Comma-separated)
              </label>
              <input
                type="text"
                name="excludedCategories"
                defaultValue={(policyRule.excludedCategories || []).join(", ")}
                placeholder="Lingerie, Clearance, Custom Printed"
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  border: "1px solid #c9cccf",
                  borderRadius: "4px",
                }}
              />
            </div>
          </div>
        </s-section>

        <s-section heading="Exchange Policy Rules">
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "16px",
              maxWidth: "540px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <input
                type="checkbox"
                id="exchangesAllowed"
                name="exchangesAllowed"
                defaultChecked={policyRule.exchangesAllowed ?? true}
                style={{ width: "16px", height: "16px" }}
              />
              <label htmlFor="exchangesAllowed" style={{ fontSize: "13px" }}>
                Enable Online Exchanges for Shoppers
              </label>
            </div>

            <div style={{ display: "flex", gap: "16px" }}>
              <div style={{ flex: 1 }}>
                <label
                  style={{
                    display: "block",
                    fontSize: "13px",
                    marginBottom: "4px",
                  }}
                >
                  Exchange Window (days)
                </label>
                <input
                  type="number"
                  name="exchangeWindowDays"
                  defaultValue={Number(
                    policyRule.exchangeWindowDays ??
                      settings.exchangeWindowDays ??
                      30,
                  )}
                  min={0}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    border: "1px solid #c9cccf",
                    borderRadius: "4px",
                  }}
                />
              </div>

              <div style={{ flex: 1 }}>
                <label
                  style={{
                    display: "block",
                    fontSize: "13px",
                    marginBottom: "4px",
                  }}
                >
                  Exchange Shipping Fee (PKR Rs.)
                </label>
                <input
                  type="number"
                  name="exchangeShippingCost"
                  defaultValue={Number(settings.exchangeShippingCost ?? 0)}
                  min={0}
                  step="1"
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    border: "1px solid #c9cccf",
                    borderRadius: "4px",
                  }}
                />
              </div>
            </div>
          </div>
        </s-section>

        <s-section heading="Fraud & Abuse Risk Policy">
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "16px",
              maxWidth: "540px",
            }}
          >
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "13px",
                  marginBottom: "4px",
                }}
              >
                Lifetime Return Threshold (Count)
              </label>
              <input
                type="number"
                name="fraudFlagReturnCount"
                defaultValue={Number(settings.fraudFlagReturnCount ?? 5)}
                min={1}
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  border: "1px solid #c9cccf",
                  borderRadius: "4px",
                }}
              />
            </div>
          </div>
        </s-section>

        <div
          style={{
            marginTop: "20px",
            display: "flex",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <s-button variant="primary" onClick={handleSave} disabled={isSaving}>
            {isSaving ? "Saving..." : "Save Settings & Policy Rules"}
          </s-button>
          {savedRecently && <s-text tone="success">Saved successfully.</s-text>}
          {fetcher.data?.error && (
            <s-text tone="critical">{fetcher.data.error}</s-text>
          )}
        </div>
      </fetcher.Form>
    </s-page>
  );
}
