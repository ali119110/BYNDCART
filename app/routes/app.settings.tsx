import React from "react";
import { useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/app.settings";
import { requireTenantContext } from "../utils/tenant.server";
import { getSettings, updateSettings } from "../services/settings.server";
import { getReturnPolicyRule, saveReturnPolicyRule } from "../services/policyEngine.server";

// ===== LOADER: Fetch settings & policy rules from database =====
export async function loader({ request }: Route.LoaderArgs) {
  const { shop, shopifyStoreId, admin } = await requireTenantContext(request);
  const appUrl = (process.env.SHOPIFY_APP_URL || "https://byndcart-production-23f7.up.railway.app").replace(/\/$/, "");
  const portal = {
    storefrontUrl: `${appUrl}/portal?shop=${encodeURIComponent(shop)}`,
  };

  try {
    const settings = await getSettings(shopifyStoreId, admin);
    const policyRule = await getReturnPolicyRule(shopifyStoreId);

    return { settings, policyRule, portal };
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
    <div className="bc-page">
      <header className="bc-header">
        <h1>Settings</h1>
        <p>Set the return rules, then add the customer link to your store footer so shoppers can send a request.</p>
      </header>

      <section className="bc-card bc-stack">
        <div>
          <p className="bc-kicker">Store footer</p>
          <h2 className="bc-title">Let customers request a return or exchange</h2>
          <p className="bc-muted">Paste the customer link into the footer menu. A link like yourstore.com/apps/returns is not a theme page, so the store shows a 404 until you publish the store proxy yourself.</p>
        </div>

        <div className="bc-method">
          <h3 className="bc-title" style={{ fontSize: "1.05rem" }}>Add it to the footer menu</h3>
          <ol className="bc-steps">
            <li>Copy the customer link below.</li>
            <li>In Shopify admin, open <b>Content → Menus</b>.</li>
            <li>Open the footer menu.</li>
            <li>Add a menu item named <b>Returns &amp; exchanges</b> and paste the full link.</li>
            <li>Save the menu. This works on a draft theme and on the live theme.</li>
          </ol>
        </div>

        <div className="bc-stack">
          <span className="bc-kicker">Customer link</span>
          <div className="bc-copy">
            <input readOnly value={portal?.storefrontUrl || ""} aria-label="Customer returns link" />
            <button type="button" className="bc-btn" onClick={copyStorefrontLink}>
              {copied ? "Copied" : "Copy link"}
            </button>
            {portal?.storefrontUrl && (
              <a className="bc-btn primary" href={portal.storefrontUrl} target="_blank" rel="noreferrer">Open customer link</a>
            )}
          </div>
        </div>

        <div className="bc-note">
          A customer clicks the footer link, enters the order number and the email on that order, then enters the verification code. After that they choose the items and submit a return or an exchange.
        </div>
      </section>

      <fetcher.Form method="POST" className="bc-stack">
        <section className="bc-card bc-form">
          <h2 className="bc-title">Return rules</h2>
          <p className="bc-muted">These rules decide which orders a customer can send back from the footer link.</p>
          <div className="bc-fields">
            <label>
              Return window (days)
              <input
                type="number"
                name="returnWindowDays"
                defaultValue={Number(policyRule.returnWindowDays ?? settings.returnWindowDays ?? 30)}
                min={0}
              />
              <span className="bc-hint">Days after the order when a return is still allowed.</span>
            </label>
            <label>
              Restocking fee (%)
              <input
                type="number"
                name="restockingFeePercent"
                defaultValue={Number(settings.restockingFeePercent ?? 0)}
                min={0}
                step="0.01"
              />
              <span className="bc-hint">Percent kept from the refund. Use 0 to refund the full item amount.</span>
            </label>
          </div>
          <label className="bc-check">
            <input type="checkbox" name="returnsAllowed" defaultChecked={policyRule.returnsAllowed ?? true} />
            <span>Allow customers to request returns<span className="bc-hint">Turn this off to hide new return requests.</span></span>
          </label>
          <label className="bc-check">
            <input type="checkbox" name="allowSaleItems" defaultChecked={policyRule.allowSaleItems ?? true} />
            <span>Allow returns on sale or discounted items<span className="bc-hint">Turn this off to block items that were sold at a discount.</span></span>
          </label>
          <label>
            Maximum items per return
            <input
              type="number"
              name="maxReturnQuantity"
              defaultValue={Number(policyRule.maxReturnQuantity ?? 5)}
              min={1}
            />
            <span className="bc-hint">The most units one request can include.</span>
          </label>
          <label className="bc-check">
            <input type="checkbox" name="preventPreviousReturns" defaultChecked={policyRule.preventPreviousReturns ?? true} />
            <span>Block a second request on the same order<span className="bc-hint">A customer cannot open another return or exchange for an order that already has one.</span></span>
          </label>
          <label>
            Excluded SKUs
            <input
              type="text"
              name="excludedSkus"
              defaultValue={(policyRule.excludedSkus || []).join(", ")}
              placeholder="SKU-FINAL-01, UNDERWEAR-M"
            />
            <span className="bc-hint">Separate SKUs with commas. These products cannot be returned.</span>
          </label>
          <label>
            Excluded categories
            <input
              type="text"
              name="excludedCategories"
              defaultValue={(policyRule.excludedCategories || []).join(", ")}
              placeholder="Lingerie, Clearance, Custom Printed"
            />
            <span className="bc-hint">Separate categories with commas.</span>
          </label>
        </section>

        <section className="bc-card bc-form">
          <h2 className="bc-title">Exchange rules</h2>
          <p className="bc-muted">Customers can ask for a different item instead of a refund.</p>
          <label className="bc-check">
            <input type="checkbox" name="exchangesAllowed" defaultChecked={policyRule.exchangesAllowed ?? true} />
            <span>Allow customers to request exchanges<span className="bc-hint">Turn this off if you only accept returns.</span></span>
          </label>
          <div className="bc-fields">
            <label>
              Exchange window (days)
              <input
                type="number"
                name="exchangeWindowDays"
                defaultValue={Number(policyRule.exchangeWindowDays ?? settings.exchangeWindowDays ?? 30)}
                min={0}
              />
              <span className="bc-hint">Days after the order when an exchange is still allowed.</span>
            </label>
            <label>
              Exchange shipping fee (PKR)
              <input
                type="number"
                name="exchangeShippingCost"
                defaultValue={Number(settings.exchangeShippingCost ?? 0)}
                min={0}
                step="1"
              />
              <span className="bc-hint">Amount charged to the customer for the replacement shipment. Use 0 for free exchanges.</span>
            </label>
          </div>
        </section>

        <section className="bc-card bc-form">
          <h2 className="bc-title">Review flags</h2>
          <p className="bc-muted">These counts mark a customer for review. They do not reject the request by themselves.</p>
          <div className="bc-fields">
            <label>
              Lifetime requests
              <input
                type="number"
                name="fraudFlagReturnCount"
                defaultValue={Number(settings.fraudFlagReturnCount ?? 5)}
                min={1}
              />
              <span className="bc-hint">Flag the customer after this many returns and exchanges in total.</span>
            </label>
            <label>
              Recent requests
              <input
                type="number"
                name="fraudFlagWindowCount"
                defaultValue={Number(settings.fraudFlagWindowCount ?? 3)}
                min={1}
              />
              <span className="bc-hint">Flag the customer after this many requests inside the window below.</span>
            </label>
            <label>
              Window (days)
              <input
                type="number"
                name="fraudFlagWindowDays"
                defaultValue={Number(settings.fraudFlagWindowDays ?? 30)}
                min={1}
              />
              <span className="bc-hint">How far back the recent-request count looks.</span>
            </label>
          </div>
        </section>

        <section className="bc-card bc-form">
          <h2 className="bc-title">Merchant email</h2>
          <p className="bc-muted">BYNDCART can email this address when a customer sends a request.</p>
          <label className="bc-check">
            <input type="checkbox" name="emailNotificationsEnabled" defaultChecked={Boolean(settings.emailNotificationsEnabled)} />
            <span>Email me about new requests<span className="bc-hint">Leave this off if you only want to check the Returns and Exchanges screens.</span></span>
          </label>
          <label>
            Notification email
            <input
              type="email"
              name="notificationEmail"
              defaultValue={settings.notificationEmail || ""}
              placeholder="you@store.com"
            />
          </label>
        </section>

        <div className="bc-actions">
          <button type="submit" className="bc-btn primary" disabled={isSaving}>
            {isSaving ? "Saving..." : "Save settings"}
          </button>
          {savedRecently && <span className="bc-badge ok">Saved</span>}
          {fetcher.data?.error && <span className="bc-badge bad">{fetcher.data.error}</span>}
        </div>
      </fetcher.Form>
    </div>
  );
}
