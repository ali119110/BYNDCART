import React from "react";
import { useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/app.settings";
import { requireTenantContext } from "../utils/tenant.server";
import { buildCustomerPortalUrl, getSettings, updateSettings } from "../services/settings.server";
import { getReturnPolicyRule, saveReturnPolicyRule } from "../services/policyEngine.server";

// ===== LOADER: Fetch settings & policy rules from database =====
export async function loader({ request }: Route.LoaderArgs) {
  const { shop, shopifyStoreId, admin } = await requireTenantContext(request);
  try {
    const settings = await getSettings(shopifyStoreId, admin);
    const hostedPortalUrl = buildCustomerPortalUrl(settings.portalSlug);
    const portal = {
      slug: settings.portalSlug || null,
      storefrontUrl: hostedPortalUrl || "",
      shopifyProxyUrl: `https://${shop}/apps/returns`,
      baseUrlConfigured: Boolean(hostedPortalUrl),
    };
    const policyRule = await getReturnPolicyRule(shopifyStoreId);

    return { settings, policyRule, portal };
  } catch (error) {
    console.error("Failed to fetch settings:", error);
    const portal = {
      slug: null,
      storefrontUrl: "",
      shopifyProxyUrl: `https://${shop}/apps/returns`,
      baseUrlConfigured: false,
    };
    return {
      settings: {
        portalSlug: null,
        returnWindowDays: 30,
        restockingFeePercent: 0,
        exchangeWindowDays: 30,
        exchangeShippingCost: 0,
        notificationEmail: "",
        emailNotificationsEnabled: false,
        refundExecutionMode: "MANUAL",
        exchangeReplacementTiming: "AFTER_INSPECTION",
      },
      portal,
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
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return { error: "Method not allowed" };
  }

  const { shopifyStoreId } = await requireTenantContext(request);
  const formData = await request.formData();

  const returnWindowDays = Number(formData.get("returnWindowDays"));
  const restockingFeePercent = Number(formData.get("restockingFeePercent"));
  const exchangeWindowDays = Number(formData.get("exchangeWindowDays"));
  const exchangeShippingCost = Number(formData.get("exchangeShippingCost"));
  const notificationEmail = formData.get("notificationEmail") as string | null;
  const emailNotificationsEnabled = formData.get("emailNotificationsEnabled") === "on";
  const refundExecutionMode = String(formData.get("refundExecutionMode") || "MANUAL");
  const exchangeReplacementTiming = String(formData.get("exchangeReplacementTiming") || "AFTER_INSPECTION");
  if (!["SHOPIFY_API", "MANUAL"].includes(refundExecutionMode)) return { error: "Invalid refund execution mode." };
  if (!["AFTER_APPROVAL", "AFTER_INSPECTION"].includes(exchangeReplacementTiming)) return { error: "Invalid replacement-order timing." };

  const fraudFlagReturnCount = Number(formData.get("fraudFlagReturnCount") || 5);
  const fraudFlagWindowDays = Number(formData.get("fraudFlagWindowDays") || 30);
  const fraudFlagWindowCount = Number(formData.get("fraudFlagWindowCount") || 3);

  // Policy Rule fields
  const returnsAllowed = formData.get("returnsAllowed") === "on";
  const exchangesAllowed = formData.get("exchangesAllowed") === "on";
  const allowSaleItems = formData.get("allowSaleItems") === "on";
  const maxReturnQuantity = Number(formData.get("maxReturnQuantity") || 5);
  const preventPreviousReturns = formData.get("preventPreviousReturns") === "on";
  const excludedSkus = (formData.get("excludedSkus") as string || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const excludedCategories = (formData.get("excludedCategories") as string || "")
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
      refundExecutionMode: refundExecutionMode as "SHOPIFY_API" | "MANUAL",
      exchangeReplacementTiming: exchangeReplacementTiming as "AFTER_APPROVAL" | "AFTER_INSPECTION",
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

    return { success: true, settings: updatedSettings, policyRule: updatedPolicyRule };
  } catch (error) {
    console.error("Failed to update settings:", error);
    return { error: String(error) };
  }
}

// ===== COMPONENT =====
export default function Settings() {
  const { settings, policyRule, portal } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const [copied, setCopied] = React.useState(false);

  const isSaving = fetcher.state === "submitting";
  const savedRecently = fetcher.state === "idle" && fetcher.data?.success;

  const copyStorefrontLink = async () => {
    if (!portal?.storefrontUrl) return;

    try {
      await navigator.clipboard.writeText(portal.storefrontUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="bc-page bc-settings-page">
      <header className="bc-header">
        <div className="bc-header-copy">
          <p className="bc-eyebrow">STORE CONFIGURATION</p>
          <h1>Settings</h1>
          <p>
            Configure your return and exchange policy, customer portal, and request notifications.
          </p>
        </div>
      </header>

      <section className="bc-card bc-portal-card bc-stack" aria-labelledby="bc-portal-title">
        <div className="bc-portal-heading">
          <div className="bc-portal-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M10 13.5 14 9.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M8.25 15.25H7a4 4 0 0 1 0-8h4a4 4 0 0 1 3.85 2.9M15.75 8.75H17a4 4 0 0 1 0 8h-4a4 4 0 0 1-3.85-2.9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </div>
          <div className="bc-portal-heading-copy">
            <p className="bc-kicker">CUSTOMER PORTAL</p>
            <h2 className="bc-title" id="bc-portal-title">Make returns and exchanges easy to find</h2>
            <p className="bc-muted">
              Add a link to your storefront so customers can submit a request without entering the Shopify admin.
            </p>
          </div>
        </div>

        <div className="bc-method">
          <div className="bc-method-heading">
            <span className="bc-step-indicator" aria-hidden="true">1</span>
            <div>
              <h3 className="bc-subtitle">Add the link to your store footer</h3>
              <p className="bc-muted">Follow these steps in Shopify admin.</p>
            </div>
          </div>
          <ol className="bc-steps">
            <li>Copy your customer portal link below.</li>
            <li>In Shopify admin, open <b>Content → Menus</b>.</li>
            <li>Open your store's footer menu.</li>
            <li>Add a menu item named <b>Returns &amp; exchanges</b> and paste the link.</li>
            <li>Save the menu. You can do this on a draft theme or your live theme.</li>
          </ol>
        </div>

        <div className="bc-portal-link-block">
          <div className="bc-link-label-row">
            <label className="bc-field-label" htmlFor="bc-customer-portal-url">Customer portal URL</label>
            <span className="bc-inline-status"><span className="bc-status-dot" /> Hosted portal</span>
          </div>
          <div className="bc-copy">
            <input
              id="bc-customer-portal-url"
              type="text"
              readOnly
              value={portal?.storefrontUrl || ""}
              aria-label="Customer returns link"
              onFocus={(event) => event.currentTarget.select()}
            />
            <button type="button" className="bc-btn" onClick={copyStorefrontLink}>
              {copied ? "Copied" : "Copy link"}
            </button>
            {portal?.storefrontUrl && (
              <a className="bc-btn primary" href={portal.storefrontUrl} target="_blank" rel="noreferrer">
                Open customer link
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M11 4h5v5M16 4l-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M14 11v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </a>
            )}
          </div>
          {!portal?.baseUrlConfigured && (
            <p className="bc-hint" role="status">
              Set CUSTOMER_PORTAL_BASE_URL to your public Railway service URL, or ensure RAILWAY_PUBLIC_DOMAIN is available, then redeploy to generate this link.
            </p>
          )}
          <p className="bc-copy-feedback" aria-live="polite">
            {copied ? "Customer portal link copied to clipboard." : "Add this hosted BYNDCART URL to your Shopify storefront footer menu."}
          </p>
        </div>

        <div className="bc-note" role="note">
          <span className="bc-note-icon" aria-hidden="true">i</span>
          <p>
            Customers enter their order number and the email on the order, verify their identity, then submit a return or exchange request. This portal is hosted by BYNDCART on your Railway app domain. Add the link above to your Shopify footer menu. Your existing Shopify App Proxy URL remains available separately if you want a portal under your storefront domain.
          </p>
        </div>
      </section>

      <fetcher.Form method="POST" className="bc-settings-form">
        <section className="bc-card bc-form" aria-labelledby="bc-return-rules-title">
          <div className="bc-section-heading">
            <div className="bc-section-icon bc-icon-return" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M9 8 5 12l4 4M5.5 12H14a5 5 0 0 1 5 5v1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M8 4h8a3 3 0 0 1 3 3v2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </div>
            <div>
              <h2 className="bc-title" id="bc-return-rules-title">Return rules</h2>
              <p className="bc-muted">Control when an order qualifies for a return and which items are eligible.</p>
            </div>
          </div>

          <div className="bc-fields">
            <label>
              <span className="bc-field-label">Return window <span className="bc-unit">Days</span></span>
              <input
                type="number"
                name="returnWindowDays"
                defaultValue={Number(policyRule.returnWindowDays ?? settings.returnWindowDays ?? 30)}
                min={0}
              />
              <span className="bc-hint">How many days after the order a return is allowed.</span>
            </label>
            <label>
              <span className="bc-field-label">Restocking fee <span className="bc-unit">%</span></span>
              <input
                type="number"
                name="restockingFeePercent"
                defaultValue={Number(settings.restockingFeePercent ?? 0)}
                min={0}
                step="0.01"
              />
              <span className="bc-hint">The percentage deducted from a refund. Set to 0 for no fee.</span>
            </label>
          </div>

          <div className="bc-setting-list">
            <label className="bc-check">
              <input type="checkbox" name="returnsAllowed" defaultChecked={policyRule.returnsAllowed ?? true} />
              <span className="bc-check-copy">
                <span className="bc-check-title">Allow return requests</span>
                <span className="bc-hint">Customers can submit new return requests through the portal.</span>
              </span>
            </label>
            <label className="bc-check">
              <input type="checkbox" name="allowSaleItems" defaultChecked={policyRule.allowSaleItems ?? true} />
              <span className="bc-check-copy">
                <span className="bc-check-title">Allow returns on sale items</span>
                <span className="bc-hint">Turn this off to exclude discounted or sale products from returns.</span>
              </span>
            </label>
          </div>

          <div className="bc-fields">
            <label>
              <span className="bc-field-label">Maximum items per return</span>
              <input
                type="number"
                name="maxReturnQuantity"
                defaultValue={Number(policyRule.maxReturnQuantity ?? 5)}
                min={1}
              />
              <span className="bc-hint">The maximum number of units a customer can include in one request.</span>
            </label>
          </div>

          <div className="bc-setting-list">
            <label className="bc-check">
              <input type="checkbox" name="preventPreviousReturns" defaultChecked={policyRule.preventPreviousReturns ?? true} />
              <span className="bc-check-copy">
                <span className="bc-check-title">Prevent duplicate requests</span>
                <span className="bc-hint">Block another return or exchange request for an order that already has one.</span>
              </span>
            </label>
          </div>

          <div className="bc-fields bc-fields-full">
            <label>
              <span className="bc-field-label">Excluded SKUs</span>
              <input
                type="text"
                name="excludedSkus"
                defaultValue={(policyRule.excludedSkus || []).join(", ")}
                placeholder="SKU-FINAL-01, UNDERWEAR-M"
              />
              <span className="bc-hint">Separate product SKUs with commas. These products cannot be returned.</span>
            </label>
            <label>
              <span className="bc-field-label">Excluded categories</span>
              <input
                type="text"
                name="excludedCategories"
                defaultValue={(policyRule.excludedCategories || []).join(", ")}
                placeholder="Lingerie, Clearance, Custom Printed"
              />
              <span className="bc-hint">Separate category names with commas.</span>
            </label>
          </div>
        </section>

        <section className="bc-card bc-form" aria-labelledby="bc-exchange-rules-title">
          <div className="bc-section-heading">
            <div className="bc-section-icon bc-icon-exchange" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M7 7h12l-3-3M17 17H5l3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M19 7v5M5 17v-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </div>
            <div>
              <h2 className="bc-title" id="bc-exchange-rules-title">Exchange rules</h2>
              <p className="bc-muted">Set the conditions for customers who want a replacement instead of a refund.</p>
            </div>
          </div>

          <div className="bc-setting-list">
            <label className="bc-check">
              <input type="checkbox" name="exchangesAllowed" defaultChecked={policyRule.exchangesAllowed ?? true} />
              <span className="bc-check-copy">
                <span className="bc-check-title">Allow exchange requests</span>
                <span className="bc-hint">Turn this off if your store only accepts returns.</span>
              </span>
            </label>
          </div>

          <div className="bc-fields">
            <label>
              <span className="bc-field-label">Exchange window <span className="bc-unit">Days</span></span>
              <input
                type="number"
                name="exchangeWindowDays"
                defaultValue={Number(policyRule.exchangeWindowDays ?? settings.exchangeWindowDays ?? 30)}
                min={0}
              />
              <span className="bc-hint">How many days after the order an exchange is allowed.</span>
            </label>
            <label>
              <span className="bc-field-label">Exchange shipping fee <span className="bc-unit">PKR</span></span>
              <input
                type="number"
                name="exchangeShippingCost"
                defaultValue={Number(settings.exchangeShippingCost ?? 0)}
                min={0}
                step="1"
              />
              <span className="bc-hint">The amount charged for shipping a replacement. Set to 0 for free exchanges.</span>
            </label>
          </div>
        </section>

        <section className="bc-card bc-form" aria-labelledby="bc-review-flags-title">
          <div className="bc-section-heading">
            <div className="bc-section-icon bc-icon-review" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M12 3.5 14.6 8.8l5.9.9-4.25 4.15 1 5.85L12 16.9l-5.25 2.8 1-5.85L3.5 9.7l5.9-.9L12 3.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <h2 className="bc-title" id="bc-review-flags-title">Review flags</h2>
              <p className="bc-muted">Flag unusually frequent return activity for manual review. These thresholds do not automatically reject requests.</p>
            </div>
          </div>

          <div className="bc-fields bc-fields-three">
            <label>
              <span className="bc-field-label">Lifetime requests</span>
              <input
                type="number"
                name="fraudFlagReturnCount"
                defaultValue={Number(settings.fraudFlagReturnCount ?? 5)}
                min={1}
              />
              <span className="bc-hint">Flag after this many total returns and exchanges.</span>
            </label>
            <label>
              <span className="bc-field-label">Recent requests</span>
              <input
                type="number"
                name="fraudFlagWindowCount"
                defaultValue={Number(settings.fraudFlagWindowCount ?? 3)}
                min={1}
              />
              <span className="bc-hint">Flag after this many requests within the window.</span>
            </label>
            <label>
              <span className="bc-field-label">Review window <span className="bc-unit">Days</span></span>
              <input
                type="number"
                name="fraudFlagWindowDays"
                defaultValue={Number(settings.fraudFlagWindowDays ?? 30)}
                min={1}
              />
              <span className="bc-hint">How far back to count recent requests.</span>
            </label>
          </div>
        </section>

        <section className="bc-card bc-form" aria-labelledby="bc-workflow-settings-title">
          <div className="bc-section-heading">
            <div className="bc-section-icon bc-icon-return" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none"><path d="M4 7h16M7 4v6m10-6v6M5 12h14v8H5z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </div>
            <div>
              <h2 className="bc-title" id="bc-workflow-settings-title">Processing workflow</h2>
              <p className="bc-muted">Returns and exchanges always require warehouse receipt and inspection before final processing.</p>
            </div>
          </div>
          <div className="bc-fields">
            <label>
              <span className="bc-field-label">Refund execution</span>
              <select name="refundExecutionMode" defaultValue={settings.refundExecutionMode || "MANUAL"}>
                <option value="MANUAL">Manual refund confirmation</option>
                <option value="SHOPIFY_API">Create refund through Shopify Admin API</option>
              </select>
              <span className="bc-hint">Shopify API mode creates a Shopify refund using the order’s available payment transaction. Confirm gateway behavior in a test store before production.</span>
            </label>
            <label>
              <span className="bc-field-label">Create exchange replacement order</span>
              <select name="exchangeReplacementTiming" defaultValue={settings.exchangeReplacementTiming || "AFTER_INSPECTION"}>
                <option value="AFTER_APPROVAL">After merchant approval</option>
                <option value="AFTER_INSPECTION">After the original item is received and inspected</option>
              </select>
              <span className="bc-hint">BYNDCART will not book a courier shipment. Merchants and customers manage shipping with their chosen carrier.</span>
            </label>
          </div>
        </section>

        <section className="bc-card bc-form" aria-labelledby="bc-merchant-email-title">
          <div className="bc-section-heading">
            <div className="bc-section-icon bc-icon-email" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <rect x="3.5" y="5" width="17" height="14" rx="2" stroke="currentColor" strokeWidth="1.7" />
                <path d="m5 7 7 5.5L19 7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <h2 className="bc-title" id="bc-merchant-email-title">Merchant email</h2>
              <p className="bc-muted">Choose where BYNDCART sends notifications when a customer submits a request.</p>
            </div>
          </div>

          <div className="bc-setting-list">
            <label className="bc-check">
              <input type="checkbox" name="emailNotificationsEnabled" defaultChecked={Boolean(settings.emailNotificationsEnabled)} />
              <span className="bc-check-copy">
                <span className="bc-check-title">Email me about new requests</span>
                <span className="bc-hint">Enable email notifications for new return and exchange requests.</span>
              </span>
            </label>
          </div>

          <div className="bc-fields bc-fields-full">
            <label>
              <span className="bc-field-label">Notification email</span>
              <input
                type="email"
                name="notificationEmail"
                defaultValue={settings.notificationEmail || ""}
                placeholder="you@store.com"
                autoComplete="email"
              />
              <span className="bc-hint">Use an inbox monitored by your store team.</span>
            </label>
          </div>
        </section>

        <div className="bc-save-area">
          <div className="bc-save-copy" aria-live="polite">
            {isSaving ? (
              <span className="bc-save-message"><span className="bc-spinner" aria-hidden="true" /> Saving your settings…</span>
            ) : savedRecently ? (
              <span className="bc-save-message bc-save-success"><span className="bc-success-mark" aria-hidden="true">✓</span> All changes saved</span>
            ) : fetcher.data?.error ? (
              <span className="bc-save-message bc-save-error">Unable to save: {fetcher.data.error}</span>
            ) : (
              <span className="bc-save-hint">Changes apply to new customer requests after saving.</span>
            )}
          </div>
          <button type="submit" className="bc-btn primary bc-save-btn" disabled={isSaving}>
            {isSaving ? "Saving…" : "Save settings"}
            {!isSaving && (
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M4 10h12M10 4l6 6-6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </div>
      </fetcher.Form>
    </div>
  );
}
