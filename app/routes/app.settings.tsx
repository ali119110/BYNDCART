import React from "react";
import { Link, useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/app.settings";
import { requireTenantContext } from "../utils/tenant.server";
import {
  buildCustomerPortalUrl,
  getSettings,
  updateSettings,
  DEFAULT_COURIER_OPERATIONS_SETTINGS,
  normalizeCourierOperationsSettings,
  type ShipperProfile,
} from "../services/settings.server";
import { getReturnPolicyRule, saveReturnPolicyRule } from "../services/policyEngine.server";
import { checkFeatureAccess } from "../services/planGate.server";

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
      orderTrackingUrl: `https://${shop}/apps/track`,
      baseUrlConfigured: Boolean(hostedPortalUrl),
    };
    const [policyRule, aiFeaturesAvailable] = await Promise.all([
      getReturnPolicyRule(shopifyStoreId),
      checkFeatureAccess(shopifyStoreId, "COURIER_AI_CHECKS"),
    ]);

    return { settings, policyRule, portal, aiFeaturesAvailable };
  } catch (error) {
    console.error("Failed to fetch settings:", error);
    const portal = {
      slug: null,
      storefrontUrl: "",
      shopifyProxyUrl: `https://${shop}/apps/returns`,
      orderTrackingUrl: `https://${shop}/apps/track`,
      baseUrlConfigured: false,
    };
    return {
      aiFeaturesAvailable: false,
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
        codTaxPercent: 4,
        codDeliveryCharge: 280,
        courierOperationsSettings: DEFAULT_COURIER_OPERATIONS_SETTINGS,
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

  const { shopifyStoreId, admin } = await requireTenantContext(request);
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
  const codTaxPercent = Number(formData.get("codTaxPercent") ?? 4);
  const codDeliveryCharge = Number(formData.get("codDeliveryCharge") ?? 280);
  if (!Number.isFinite(codTaxPercent) || codTaxPercent < 0 || codTaxPercent > 100) {
    return { error: "COD tax percent must be between 0 and 100." };
  }
  if (!Number.isFinite(codDeliveryCharge) || codDeliveryCharge < 0) {
    return { error: "COD delivery charge must be zero or more." };
  }

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

  const storeLogoUrl = String(formData.get("storeLogoUrl") || "").trim() || null;
  const supportEmail = String(formData.get("supportEmail") || "").trim() || null;
  const whatsappNumber = String(formData.get("whatsappNumber") || "").trim() || null;
  const returnAddress = String(formData.get("returnAddress") || "").trim() || null;

  const aiFeaturesAllowedForSave = await checkFeatureAccess(shopifyStoreId, "COURIER_AI_CHECKS");
  const shipperProfiles = [0, 1, 2].map((index) => ({
    name: String(formData.get(`shipperProfile${index}Name`) || "").trim(),
    phone: String(formData.get(`shipperProfile${index}Phone`) || "").trim(),
    city: String(formData.get(`shipperProfile${index}City`) || "").trim(),
    address: String(formData.get(`shipperProfile${index}Address`) || "").trim(),
  }));
  const courierOperationsSettings = normalizeCourierOperationsSettings({
    autoCourierTracking: formData.get("autoCourierTracking") === "on",
    sendDeliveryUpdates: formData.get("sendDeliveryUpdates") === "on",
    deliveryUpdatePage: String(formData.get("deliveryUpdatePage") || "COURIER_LOGS"),
    deliveryUpdateTemplate: String(formData.get("deliveryUpdateTemplate") || ""),
    fraudCheckEnabled: aiFeaturesAllowedForSave && formData.get("fraudCheckEnabled") === "on",
    fraudTagDefinition: String(formData.get("fraudTagDefinition") || DEFAULT_COURIER_OPERATIONS_SETTINGS.fraudTagDefinition),
    duplicateCheckEnabled: aiFeaturesAllowedForSave && formData.get("duplicateCheckEnabled") === "on",
    duplicateCheckDurationMinutes: Number(formData.get("duplicateCheckDurationMinutes") || 30),
    labelWebsite: String(formData.get("labelWebsite") || ""),
    labelLogoUrl: String(formData.get("labelLogoUrl") || ""),
    labelSize: String(formData.get("labelSize") || "A4_3"),
    defaultShipperProfileIndex: Number(formData.get("defaultShipperProfileIndex") || 0),
    shipperProfiles,
  });
  if (courierOperationsSettings.labelLogoUrl && !/^https:\/\//i.test(courierOperationsSettings.labelLogoUrl)) {
    return { error: "Label logo URL must start with https://." };
  }
  if (
    courierOperationsSettings.shipperProfiles.some((profile) =>
      profile.phone && !/^[+0-9() .-]{7,40}$/.test(profile.phone)
    )
  ) {
    return { error: "Enter a valid phone number for each shipper profile." };
  }

  try {
    let freshPolicies = undefined;
    if (admin) {
      const { fetchShopPolicies } = await import("../services/settings.server");
      const p = await fetchShopPolicies(admin);
      if (p) freshPolicies = p;
    }

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
      codTaxPercent,
      codDeliveryCharge,
      storeLogoUrl,
      supportEmail,
      whatsappNumber,
      returnAddress,
      courierOperationsSettings: courierOperationsSettings as any,
      ...(freshPolicies ? { policies: freshPolicies } : {}),
    });

    if (courierOperationsSettings.autoCourierTracking) {
      try {
        const { ensureCourierTrackingScheduled } = await import("../worker.server");
        await ensureCourierTrackingScheduled(shopifyStoreId);
      } catch (scheduleError) {
        console.warn("[Settings] Saved tracking preference, but could not queue the first tracking refresh:", scheduleError);
      }
    }

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
  const { settings, policyRule, portal, aiFeaturesAvailable } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const [copied, setCopied] = React.useState(false);
  const [copiedTracking, setCopiedTracking] = React.useState(false);

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

  const copyTrackingLink = async () => {
    if (!portal?.orderTrackingUrl) return;

    try {
      await navigator.clipboard.writeText(portal.orderTrackingUrl);
      setCopiedTracking(true);
    } catch {
      setCopiedTracking(false);
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

      {/* Storefront Order Tracking Proxy */}
      <section className="bc-card bc-portal-card bc-stack" aria-labelledby="bc-tracking-title">
        <div className="bc-portal-heading">
          <div className="bc-portal-heading-copy">
            <p className="bc-kicker">STOREFRONT TRACKING</p>
            <h2 className="bc-title" id="bc-tracking-title">Customer Order Tracking Page</h2>
            <p className="bc-muted">
              Live branded order tracking on your store. Customers can enter their Shopify order number or courier tracking number to see delivery milestones and live courier events.
            </p>
          </div>
        </div>

        <div className="bc-portal-link-block">
          <div className="bc-link-label-row">
            <label className="bc-field-label" htmlFor="bc-tracking-page-url">Storefront tracking URL</label>
            <span className="bc-inline-status"><span className="bc-status-dot" /> App Proxy</span>
          </div>
          <div className="bc-copy">
            <input
              id="bc-tracking-page-url"
              type="text"
              readOnly
              value={portal?.orderTrackingUrl || ""}
              aria-label="Storefront order tracking link"
              onFocus={(event) => event.currentTarget.select()}
            />
            <button type="button" className="bc-btn" onClick={copyTrackingLink}>
              {copiedTracking ? "Copied" : "Copy link"}
            </button>
            {portal?.orderTrackingUrl && (
              <a className="bc-btn primary" href={portal.orderTrackingUrl} target="_blank" rel="noreferrer">
                Open tracking page
              </a>
            )}
          </div>
          <p className="bc-copy-feedback" aria-live="polite">
            {copiedTracking ? "Tracking link copied to clipboard." : "Add this App Proxy URL to your navigation menu or order confirmation emails."}
          </p>
        </div>
      </section>

      <fetcher.Form method="POST" className="bc-settings-form">
        <style>{`
          .bco-section { border: 1px solid #dbe3ee; border-radius: 12px; background: #fff; margin-bottom: 16px; overflow: hidden; }
          .bco-heading { padding: 16px 20px; display: flex; align-items: flex-start; gap: 12px; border-bottom: 1px solid #e2e8f0; background: #f8fafc; }
          .bco-heading h2 { margin: 0; color: #0f172a; font-size: 16px; line-height: 1.35; font-weight: 750; }
          .bco-heading p { margin: 4px 0 0; color: #64748b; font-size: 12px; line-height: 1.5; }
          .bco-icon { display: flex; align-items: center; justify-content: center; flex: 0 0 34px; width: 34px; height: 34px; border: 1px solid #dbeafe; border-radius: 9px; color: #2563eb; background: #eff6ff; font-size: 17px; }
          .bco-body { padding: 18px 20px; }
          .bco-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
          .bco-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
          .bco-field label, .bco-field-label { color: #334155; font-size: 12px; line-height: 1.35; font-weight: 700; }
          .bco-field input:not([type="checkbox"]), .bco-field textarea, .bco-field select { box-sizing: border-box; width: 100%; min-width: 0; border: 1px solid #cbd5e1; border-radius: 7px; background: #fff; color: #0f172a; padding: 9px 10px; font: inherit; font-size: 13px; }
          .bco-field textarea { resize: vertical; min-height: 130px; line-height: 1.45; }
          .bco-help { color: #64748b; font-size: 11px; line-height: 1.45; }
          .bco-toggle-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
          .bco-toggle { display: flex; align-items: flex-start; gap: 11px; padding: 12px; border: 1px solid #e2e8f0; border-radius: 9px; background: #fff; cursor: pointer; }
          .bco-toggle input { position: absolute; opacity: 0; width: 1px; height: 1px; }
          .bco-switch { position: relative; flex: 0 0 38px; width: 38px; height: 22px; border-radius: 999px; background: #cbd5e1; transition: background 120ms ease; margin-top: 1px; }
          .bco-switch::after { content: ""; position: absolute; left: 3px; top: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.2); transition: transform 120ms ease; }
          .bco-toggle input:checked + .bco-switch { background: #1677ff; }
          .bco-toggle input:checked + .bco-switch::after { transform: translateX(16px); }
          .bco-toggle input:focus-visible + .bco-switch { outline: 3px solid #bfdbfe; outline-offset: 2px; }
          .bco-toggle-copy { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
          .bco-toggle-title { color: #0f172a; font-size: 13px; font-weight: 750; }
          .bco-note { margin-top: 14px; padding: 10px 12px; border-radius: 8px; background: #f8fafc; color: #64748b; font-size: 11px; line-height: 1.5; }
          .bco-profile { padding: 14px; border: 1px solid #e2e8f0; border-radius: 10px; background: #fff; min-width: 0; }
          .bco-profile h3 { margin: 0 0 12px; font-size: 13px; font-weight: 750; color: #0f172a; }
          .bco-profile-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px; }
          @media (max-width: 760px) { .bco-grid, .bco-toggle-list, .bco-profile-grid { grid-template-columns: minmax(0, 1fr); } .bco-heading { padding: 14px; } .bco-body { padding: 14px; } }
        `}</style>

        <div style={{ margin: "2px 0 14px" }}>
          <p className="bc-eyebrow" style={{ marginBottom: "5px" }}>COURIER WORKSPACE</p>
          <h2 style={{ margin: 0, color: "#0f172a", fontSize: "20px", fontWeight: 800 }}>Courier &amp; label settings</h2>
          <p className="bc-muted" style={{ margin: "5px 0 0", maxWidth: "760px" }}>
            Configure shared defaults once. These preferences belong to your store and are available across all configured courier integrations.
          </p>
        </div>

        <section className="bco-section" aria-labelledby="bco-tracking-title">
          <div className="bco-heading">
            <span className="bco-icon" aria-hidden="true">♧</span>
            <div><h2 id="bco-tracking-title">Tracking &amp; customer notifications</h2><p>Control live tracking and when shipment updates are sent to customers.</p></div>
          </div>
          <div className="bco-body">
            <div className="bco-toggle-list">
              <label className="bco-toggle">
                <input type="checkbox" name="autoCourierTracking" defaultChecked={Boolean(settings.courierOperationsSettings?.autoCourierTracking ?? true)} />
                <span className="bco-switch" aria-hidden="true" />
                <span className="bco-toggle-copy"><span className="bco-toggle-title">Auto Courier Tracking</span><span className="bco-help">Refresh active shipment status in the background every 15 minutes across enabled couriers, and when a customer checks tracking.</span></span>
              </label>
              <label className="bco-toggle">
                <input type="checkbox" name="sendDeliveryUpdates" defaultChecked={Boolean(settings.courierOperationsSettings?.sendDeliveryUpdates ?? false)} />
                <span className="bco-switch" aria-hidden="true" />
                <span className="bco-toggle-copy"><span className="bco-toggle-title">Send delivery updates to customers</span><span className="bco-help">Use your saved WhatsApp template for courier tracking updates when the channel is connected.</span></span>
              </label>
            </div>
            <div className="bco-note">WhatsApp delivery messages require a connected WhatsApp Business API account and an eligible message type. These settings apply across the courier providers you enable.</div>
          </div>
        </section>

        <section className="bco-section" aria-labelledby="bco-message-title">
          <div className="bco-heading">
            <span className="bco-icon" aria-hidden="true">◉</span>
            <div><h2 id="bco-message-title">WhatsApp delivery message</h2><p>One shared message template for courier events, instead of configuring the same text separately for each provider.</p></div>
          </div>
          <div className="bco-body">
            <p style={{ margin: "0 0 9px", color: "#64748b", fontSize: "12px", fontWeight: 700 }}>Page: Courier Logs</p>
            <div className="bco-field">
              <label htmlFor="deliveryUpdateTemplate">Message template</label>
              <textarea id="deliveryUpdateTemplate" name="deliveryUpdateTemplate" rows={5} defaultValue={settings.courierOperationsSettings?.deliveryUpdateTemplate || DEFAULT_COURIER_OPERATIONS_SETTINGS.deliveryUpdateTemplate} />
              <span className="bco-help">Variables: {"{{customer_name}}"}, {"{{customer_phone}}"}, {"{{order_number}}"}, {"{{order_amount}}"}, {"{{courier_name}}"}, {"{{tracking_number}}"}, {"{{tracking_url}}"}.</span>
            </div>
          </div>
        </section>

        <section className="bco-section" aria-labelledby="bco-ai-title">
          <div className="bco-heading">
            <span className="bco-icon" aria-hidden="true">✧</span>
            <div>
              <h2 id="bco-ai-title">AI assistant &amp; order checks</h2>
              <p>Shared rules for customer history and repeat-order review across the courier workspace.</p>
              <span className="bco-help" style={{ display: "inline-block", marginTop: "5px", fontWeight: 700 }}>{aiFeaturesAvailable ? "Available on your paid plan" : "Available on Paid Plans"}</span>
            </div>
          </div>
          <div className="bco-body">
            <div className="bco-toggle-list">
              <label className="bco-toggle">
                <input type="checkbox" name="fraudCheckEnabled" disabled={!aiFeaturesAvailable} defaultChecked={aiFeaturesAvailable && Boolean(settings.courierOperationsSettings?.fraudCheckEnabled)} />
                <span className="bco-switch" aria-hidden="true" />
                <span className="bco-toggle-copy"><span className="bco-toggle-title">Fraud / trust check</span><span className="bco-help">Use delivery history from BYNDCART shipment records to identify trusted customers.</span></span>
              </label>
              <label className="bco-toggle">
                <input type="checkbox" name="duplicateCheckEnabled" disabled={!aiFeaturesAvailable} defaultChecked={aiFeaturesAvailable && Boolean(settings.courierOperationsSettings?.duplicateCheckEnabled)} />
                <span className="bco-switch" aria-hidden="true" />
                <span className="bco-toggle-copy"><span className="bco-toggle-title">Duplicate order check</span><span className="bco-help">Flag multiple orders from the same phone number within the selected time window.</span></span>
              </label>
            </div>
            <div className="bco-grid">
              <div className="bco-field">
                <label htmlFor="fraudTagDefinition">Trust tag rule</label>
                <select id="fraudTagDefinition" name="fraudTagDefinition" disabled={!aiFeaturesAvailable} defaultValue={settings.courierOperationsSettings?.fraudTagDefinition || DEFAULT_COURIER_OPERATIONS_SETTINGS.fraudTagDefinition}>
                  <option value="courier: Trusted - if customer delivery ratio > 85%">courier: Trusted — delivery ratio above 85%</option>
                  <option value="courier: Trusted - if customer delivery ratio > 90%">courier: Trusted — delivery ratio above 90%</option>
                  <option value="courier: Review - low delivery ratio">courier: Review — low delivery ratio</option>
                </select>
                <span className="bco-help">Select the tag/rule definition to use for cross-courier customer history checks.</span>
              </div>
              <div className="bco-field">
                <label htmlFor="duplicateCheckDurationMinutes">Duplicate time window</label>
                <select id="duplicateCheckDurationMinutes" name="duplicateCheckDurationMinutes" disabled={!aiFeaturesAvailable} defaultValue={String(settings.courierOperationsSettings?.duplicateCheckDurationMinutes || 30)}>
                  <option value="15">15 minutes</option>
                  <option value="30">30 minutes</option>
                  <option value="60">1 hour</option>
                  <option value="120">2 hours</option>
                  <option value="240">4 hours</option>
                </select>
                <span className="bco-help">Orders with the same customer phone inside this period can be flagged.</span>
              </div>
            </div>
            <div className="bco-note">
              {aiFeaturesAvailable
                ? "These controls are store-wide, not tied to a particular courier. Checks use available BYNDCART order and shipment history; the merchant's selected rule determines the tag behavior."
                : <>Upgrade your plan to enable shared customer trust and duplicate-order checks. <Link to="/app/billing" style={{ color: "#2563eb", fontWeight: 700 }}>View plans</Link>.</>}
            </div>
          </div>
        </section>

        <section className="bco-section" aria-labelledby="bco-label-title">
          <div className="bco-heading">
            <span className="bco-icon" aria-hidden="true">▱</span>
            <div><h2 id="bco-label-title">Label settings</h2><p>Set the default branding and print format for BYNDCART airway-bill labels.</p></div>
          </div>
          <div className="bco-body">
            <div className="bco-grid">
              <div className="bco-field">
                <label htmlFor="labelWebsite">Website</label>
                <input id="labelWebsite" name="labelWebsite" type="text" maxLength={200} placeholder="yourstore.com" defaultValue={settings.courierOperationsSettings?.labelWebsite || ""} />
                <span className="bco-help">Printed on the shared BYNDCART label template.</span>
              </div>
              <div className="bco-field">
                <label htmlFor="labelLogoUrl">Logo URL (recommended 300 × 100 px)</label>
                <input id="labelLogoUrl" name="labelLogoUrl" type="url" maxLength={1000} placeholder="https://cdn.shopify.com/..." defaultValue={settings.courierOperationsSettings?.labelLogoUrl || ""} />
                <span className="bco-help">Use a public HTTPS image URL. If empty, the portal/store logo can be used.</span>
              </div>
              <div className="bco-field">
                <label htmlFor="labelSize">Label size</label>
                <select id="labelSize" name="labelSize" defaultValue={settings.courierOperationsSettings?.labelSize || "A4_3"}>
                  <option value="A4_3">A4 — 3 labels per page</option>
                  <option value="A4_4">A4 — 4 labels per page</option>
                  <option value="THERMAL_4X6">Thermal — 4 × 6 inches</option>
                </select>
              </div>
              <div className="bco-field">
                <label htmlFor="defaultShipperProfileIndex">Default shipper profile</label>
                <select id="defaultShipperProfileIndex" name="defaultShipperProfileIndex" defaultValue={String(settings.courierOperationsSettings?.defaultShipperProfileIndex ?? 0)}>
                  {(settings.courierOperationsSettings?.shipperProfiles || DEFAULT_COURIER_OPERATIONS_SETTINGS.shipperProfiles).map((profile: ShipperProfile, index: number) => (
                    <option key={index} value={index}>{profile.name || `Shipper profile #${index + 1}`}{profile.city ? ` — ${profile.city}` : ""}</option>
                  ))}
                </select>
                <span className="bco-help">Used as the initial shipper profile in the Booking panel and on shared labels.</span>
              </div>
            </div>
          </div>
        </section>

        <section className="bco-section" aria-labelledby="bco-shipper-title">
          <div className="bco-heading">
            <span className="bco-icon" aria-hidden="true">▤</span>
            <div><h2 id="bco-shipper-title">Shipper profiles</h2><p>Save up to three sender profiles, then use the same profiles in Booking across every configured courier.</p></div>
          </div>
          <div className="bco-body">
            <div className="bco-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
              {(settings.courierOperationsSettings?.shipperProfiles || DEFAULT_COURIER_OPERATIONS_SETTINGS.shipperProfiles).map((profile: ShipperProfile, index: number) => (
                <div className="bco-profile" key={index}>
                  <h3>{profile.name || `Profile #${index + 1}`}</h3>
                  <div className="bco-profile-grid">
                    <div className="bco-field">
                      <label htmlFor={`shipperProfile${index}Name`}>Name</label>
                      <input id={`shipperProfile${index}Name`} name={`shipperProfile${index}Name`} maxLength={100} defaultValue={profile.name} placeholder={`Profile #${index + 1}`} />
                    </div>
                    <div className="bco-field">
                      <label htmlFor={`shipperProfile${index}Phone`}>Phone</label>
                      <input id={`shipperProfile${index}Phone`} name={`shipperProfile${index}Phone`} maxLength={40} defaultValue={profile.phone} placeholder="03XXXXXXXXX" />
                    </div>
                    <div className="bco-field">
                      <label htmlFor={`shipperProfile${index}City`}>City</label>
                      <input id={`shipperProfile${index}City`} name={`shipperProfile${index}City`} maxLength={100} defaultValue={profile.city} placeholder="Karachi" />
                    </div>
                    <div className="bco-field">
                      <label htmlFor={`shipperProfile${index}Address`}>Address</label>
                      <input id={`shipperProfile${index}Address`} name={`shipperProfile${index}Address`} maxLength={500} defaultValue={profile.address} placeholder="Warehouse, street, area" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="bco-note">Sender profiles and label settings are shared across couriers. Courier API pickup-address codes remain provider-specific because each carrier registers its own pickup locations.</div>
          </div>
        </section>

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
            <label>
              <span className="bc-field-label">COD tax <span className="bc-unit">Percent</span></span>
              <input type="number" name="codTaxPercent" defaultValue={Number(settings.codTaxPercent ?? 4)} min={0} max={100} step="0.01" />
              <span className="bc-hint">Used on the COD page to estimate tax on unpaid and settled amounts.</span>
            </label>
            <label>
              <span className="bc-field-label">COD delivery charge <span className="bc-unit">PKR</span></span>
              <input type="number" name="codDeliveryCharge" defaultValue={Number(settings.codDeliveryCharge ?? 280)} min={0} step="0.01" />
              <span className="bc-hint">Estimated charge for each delivered order that is still unpaid.</span>
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

        <section className="bc-card bc-form" aria-labelledby="bc-merchant-branding-title">
          <div className="bc-section-heading">
            <div className="bc-section-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Z" stroke="currentColor" strokeWidth="1.7" />
                <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" />
                <path d="m20 15-5-5-8 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <h2 className="bc-title" id="bc-merchant-branding-title">Customer portal branding &amp; support</h2>
              <p className="bc-muted">Configure your logo, customer contacts, return address, and view auto-synced Shopify store policies.</p>
            </div>
          </div>

          <div className="bc-fields">
            <label>
              <span className="bc-field-label">Store logo URL</span>
              <input
                type="url"
                name="storeLogoUrl"
                defaultValue={settings.storeLogoUrl || ""}
                placeholder="https://example.com/logo.png"
              />
              <span className="bc-hint">Direct link to your store logo (PNG, SVG, or JPG) for the portal header.</span>
            </label>
            <label>
              <span className="bc-field-label">Customer support email</span>
              <input
                type="email"
                name="supportEmail"
                defaultValue={settings.supportEmail || ""}
                placeholder="support@yourstore.com"
                autoComplete="email"
              />
              <span className="bc-hint">Shown in the customer portal footer for shopper inquiries.</span>
            </label>
            <label>
              <span className="bc-field-label">WhatsApp support number</span>
              <input
                type="text"
                name="whatsappNumber"
                defaultValue={settings.whatsappNumber || ""}
                placeholder="+92 300 1234567"
              />
              <span className="bc-hint">Direct WhatsApp link rendered in the portal footer.</span>
            </label>
          </div>

          <div className="bc-fields bc-fields-full">
            <label>
              <span className="bc-field-label">Warehouse return address</span>
              <textarea
                name="returnAddress"
                defaultValue={settings.returnAddress || ""}
                rows={3}
                placeholder="Warehouse name, Street address, City, Postal code, Pakistan"
              />
              <span className="bc-hint">The physical return address displayed to customers for sending back items after approval.</span>
            </label>
          </div>

          <div className="bc-policies-preview">
            <span className="bc-field-label">Shopify store policies</span>
            <p className="bc-hint">Retrieved automatically from your Shopify store settings. Displayed in the customer portal footer.</p>
            <div className="bc-policies-tags">
              {settings.policies && typeof settings.policies === "object" && Object.keys(settings.policies).length > 0 ? (
                Object.entries(settings.policies as Record<string, { title?: string; url?: string }>).map(([key, policy]) => (
                  policy?.url ? (
                    <a key={key} href={policy.url} target="_blank" rel="noopener noreferrer" className="bc-policy-tag">
                      {policy.title || key} ↗
                    </a>
                  ) : null
                ))
              ) : (
                <span className="bc-muted">No policies detected yet. Policies set in Shopify Admin → Settings → Policies will appear here.</span>
              )}
            </div>
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
