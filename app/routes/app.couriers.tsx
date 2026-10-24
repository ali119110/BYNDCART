import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { requireTenantContext } from "../services/tenant.server";
import {
  CourierRegistry,
  getDecryptedCourierCredentials,
  getStoreCourierConfigs,
  saveMerchantCourierConfig,
} from "../services/courier.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopifyStoreId } = await requireTenantContext(request);
  const availableAdapters = CourierRegistry.getRegisteredAdapters();
  const configuredStoreCouriers = await getStoreCourierConfigs(shopifyStoreId);
  return { availableAdapters, configuredStoreCouriers };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return { success: false, error: "Method not allowed." };

  const { shopifyStoreId } = await requireTenantContext(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const providerName = String(formData.get("providerName") || "").trim().toUpperCase();
  const adapter = CourierRegistry.getRegisteredAdapters().find((item) => item.providerName === providerName);
  if (!adapter) return { success: false, error: "Choose a supported courier provider.", intent, providerName };

  if (intent === "SAVE_CONFIG") {
    if (!adapter.fields.length) {
      return { success: false, error: `${adapter.displayName} credentials cannot be configured safely until the current official API contract is supplied.`, intent, providerName };
    }

    let postedCredentials: Record<string, string>;
    try {
      const parsed = JSON.parse(String(formData.get("credentials") || "{}"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid credentials object.");
      postedCredentials = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    } catch {
      return { success: false, error: "Invalid credential form payload.", intent, providerName };
    }

    const allowedKeys = new Set(adapter.fields.map((field) => field.key));
    postedCredentials = Object.fromEntries(Object.entries(postedCredentials).filter(([key, value]) => allowedKeys.has(key) && value.trim().length > 0));
    const [existing, savedCredentials] = await Promise.all([
      getStoreCourierConfigs(shopifyStoreId).then((configs) => configs.find((item) => item.providerName === providerName)),
      getDecryptedCourierCredentials(shopifyStoreId, providerName, true),
    ]);
    const configuredKeys = new Set(existing?.configuredFieldKeys || []);
    const savedFields = (savedCredentials?.credentials && typeof savedCredentials.credentials === "object"
      ? savedCredentials.credentials
      : savedCredentials || {}) as Record<string, unknown>;
    const credentialsChanged = Object.entries(postedCredentials).some(
      ([key, value]) => String(savedFields[key] ?? "").trim() !== value.trim(),
    );
    // Saving an unchanged credential form must not undo a successful API verification.
    // Any actual credential change resets verification so the new values must be tested.
    const retainVerifiedState = Boolean(existing?.enabled && existing?.isLive && !credentialsChanged);
    const missingRequired = adapter.fields.find((field) => field.required && !postedCredentials[field.key] && !configuredKeys.has(field.key));
    if (missingRequired) {
      return { success: false, error: `Enter ${missingRequired.label} for ${adapter.displayName}.`, intent, providerName };
    }
    if (Object.keys(postedCredentials).length === 0 && !existing?.hasToken) {
      return { success: false, error: "Enter at least one credential before saving.", intent, providerName };
    }

    try {
      await saveMerchantCourierConfig(shopifyStoreId, providerName, {
        credentials: postedCredentials,
        accountNumber: postedCredentials.accountNumber,
        enabled: retainVerifiedState,
        isLive: retainVerifiedState,
      });
      return {
        success: true,
        message: retainVerifiedState
          ? `${adapter.displayName} credentials saved. The existing connection verification remains active.`
          : credentialsChanged
            ? `${adapter.displayName} credentials changed and saved. Verify them again to enable booking.`
            : `${adapter.displayName} production credentials saved securely. Verify them to enable this courier for customer bookings.`,
        intent,
        providerName,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Failed to save courier credentials.", intent, providerName };
    }
  }

  if (intent === "TEST_CONNECTION") {
    if (!adapter.isLive) {
      return { success: false, isLive: false, error: `${adapter.displayName} production credential verification is not implemented in BYNDCART yet.`, intent, providerName, testedProvider: providerName };
    }
    let posted: Record<string, string> = {};
    try {
      const parsed = JSON.parse(String(formData.get("credentials") || "{}"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        posted = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0));
      }
    } catch { /* use saved credentials below */ }
    const saved = await getDecryptedCourierCredentials(shopifyStoreId, providerName, true);
    const effectiveCredentials = { ...(saved?.credentials || {}), ...(saved || {}), ...posted } as Record<string, any>;
    const missingRequired = adapter.fields.find((field) => field.required && !String(effectiveCredentials[field.key] || "").trim());
    if (missingRequired) {
      return { success: false, message: `Enter ${missingRequired.label} before verifying ${adapter.displayName} production credentials.`, isLive: false, intent, providerName, testedProvider: providerName };
    }
    try {
      const testResult = await CourierRegistry.get(providerName).testConnection({
        shopifyStoreId,
        config: effectiveCredentials as any,
      });
      if (testResult.success && testResult.isLive) {
        await saveMerchantCourierConfig(shopifyStoreId, providerName, {
          credentials: posted,
          enabled: true,
          isLive: true,
        });
        return { success: true, message: `${testResult.message} Production courier enabled for API booking.`, isLive: true, intent, providerName, testedProvider: providerName };
      }
      return { success: false, message: testResult.message, isLive: false, intent, providerName, testedProvider: providerName };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Connection test failed.", intent, providerName, testedProvider: providerName };
    }
  }

  if (intent === "SET_DEFAULT_REVERSE" || intent === "SET_DEFAULT_FORWARD") {
    const isReverse = intent === "SET_DEFAULT_REVERSE";
    if (!adapter.isLive) {
      return {
        success: false,
        error: `${adapter.displayName} does not have an enabled booking integration, so it cannot be selected as that default.`,
        intent,
        providerName,
      };
    }
    const configured = (await getStoreCourierConfigs(shopifyStoreId)).find((item) => item.providerName === providerName && item.enabled);
    const configuredKeys = new Set(configured?.configuredFieldKeys || []);
    const missingRequired = adapter.fields.find((field) => field.required && !configuredKeys.has(field.key));
    if (!configured || !configured.isLive || missingRequired) return { success: false, error: `Verify the required ${adapter.displayName} production credentials before selecting it as default${missingRequired ? ` (missing ${missingRequired.label})` : ""}.`, intent, providerName };
    try {
      await saveMerchantCourierConfig(shopifyStoreId, providerName, isReverse ? { isDefaultReverse: true } : { isDefaultForward: true });
      return { success: true, message: `${adapter.displayName} is now the default for ${isReverse ? "return pickups" : "forward/exchange shipments"}.`, intent, providerName };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Failed to set default courier.", intent, providerName };
    }
  }

  return { success: false, error: "Invalid courier action.", intent, providerName };
};

export default function Couriers() {
  const { availableAdapters, configuredStoreCouriers } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<any>();
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [credentialInputs, setCredentialInputs] = useState<Record<string, string>>({});
  const isSubmitting = fetcher.state !== "idle";
  const actionData = fetcher.data;
  const configMap = new Map(configuredStoreCouriers.map((config) => [config.providerName, config]));

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success && fetcher.data.intent === "SAVE_CONFIG") {
      setSelectedProvider(null);
      setCredentialInputs({});
    }
  }, [fetcher.state, fetcher.data]);

  const handleEditClick = (adapter: (typeof availableAdapters)[number]) => {
    setSelectedProvider(adapter.providerName);
    const existing = configMap.get(adapter.providerName);
    setCredentialInputs(Object.fromEntries(adapter.fields.map((field) => [
      field.key,
      field.secret ? "" : String(existing?.nonSecretFields?.[field.key] || field.defaultValue || ""),
    ])));
  };

  const submitAction = (intent: string, providerName: string, extra: Record<string, string> = {}) => {
    fetcher.submit({ intent, providerName, ...extra }, { method: "post" });
  };

  const collectCredentials = (providerName: string) => {
    const adapter = availableAdapters.find((item) => item.providerName === providerName);
    const allowedKeys = new Set((adapter?.fields || []).map((field) => field.key));
    return Object.fromEntries(
      Object.entries(credentialInputs).filter(([key, value]) => allowedKeys.has(key) && value.trim().length > 0)
    );
  };

  const handleSave = (providerName: string) => {
    submitAction("SAVE_CONFIG", providerName, { credentials: JSON.stringify(collectCredentials(providerName)) });
  };

  const handleTestConnection = (providerName: string) => {
    submitAction("TEST_CONNECTION", providerName, { credentials: JSON.stringify(collectCredentials(providerName)) });
  };

  return (
    <div className="bc-page bc-couriers-page">
      <header className="bc-header">
        <div className="bc-header-copy">
          <p className="bc-eyebrow">LOGISTICS</p>
          <h1>Couriers</h1>
          <p>Configure production API credentials only. Sender/contact details are managed centrally in Settings → Shipper profiles.</p>
        </div>
      </header>

      <section className="bc-courier-capability-note" aria-label="Courier integration status">
        <div className="bc-courier-capability-icon" aria-hidden="true">i</div>
        <div>
          <strong>API-only booking status</strong>
          <p>PostEx, Leopards, DHL Express, FedEx, and TCS have API-backed integrations. Enter production credentials for your own carrier account and verify them before booking. Sender addresses are maintained in Settings → Shipper profiles. DHL shipment cancellation is not supported by the supplied API contract; TCS tracking has limited scan-event support. TRAX, M&amp;P, Call Courier, and Rider remain disabled pending supported API contracts.</p>
        </div>
      </section>

      {actionData?.intent !== "TEST_CONNECTION" && actionData?.message && <div className={`bc-note ${actionData.success ? "ok" : "bad"}`} role={actionData.success ? "status" : "alert"}>{actionData.message}</div>}
      {actionData?.intent !== "TEST_CONNECTION" && actionData?.error && <div className="bc-note bad" role="alert">{actionData.error}</div>}

      <div className="bc-courier-grid">
        {availableAdapters.map((adapter) => {
          const config = configMap.get(adapter.providerName);
          const configuredKeys = new Set(config?.configuredFieldKeys || []);
          const hasLegacyToken = Boolean(config?.hasToken && !(config?.configuredFieldKeys || []).length);
          const requiredFieldsPresent = adapter.fields.length > 0 && adapter.fields.every((field) => !field.required || configuredKeys.has(field.key) || (field.key === "apiToken" && hasLegacyToken));
          const isConfigured = requiredFieldsPresent;
          const isVerified = Boolean(isConfigured && config?.enabled && config?.isLive);
          const isDefaultReturn = Boolean(isVerified && config?.isDefaultReverse);
          const isDefaultExchange = Boolean(isVerified && config?.isDefaultForward);
          const isEditing = selectedProvider === adapter.providerName;
          const testResultIsForThisCard = actionData?.intent === "TEST_CONNECTION" && actionData.testedProvider === adapter.providerName;
          const canSetReturnDefault = adapter.isLive && isVerified;
          const canSetForwardDefault = adapter.isLive && isVerified;

          return (
            <article key={adapter.providerName} className="bc-card bc-courier-card">
              <div className="bc-courier-card-header">
                <div className="bc-courier-title-wrap"><h2>{adapter.displayName}</h2><span className="bc-courier-code">{adapter.providerName}</span></div>
                <span className={`bc-badge ${isVerified ? "ok" : "warn"}`}>{isVerified ? "Connection verified" : isConfigured ? "Credential verification required" : "Not configured"}</span>
              </div>

              <p className="bc-courier-description">{adapter.description}</p>
              <div className={`bc-courier-capability ${adapter.isLive ? "live" : "pending"}`}>
                <span className="bc-courier-capability-dot" aria-hidden="true" />
                {adapter.apiStatus === "live_booking" ? "Production API integration — credentials verification required" : adapter.apiStatus === "pending_implementation" ? "API implementation pending" : "Disabled pending official API contract"}
              </div>
              <p className="bc-courier-instructions">{adapter.instructions}</p>

              {(isDefaultReturn || isDefaultExchange || config?.maskedToken) && (
                <div className="bc-courier-meta">
                  {isDefaultReturn && <span className="bc-badge">Default return</span>}
                  {isDefaultExchange && <span className="bc-badge">Default exchange</span>}
                  {config?.maskedToken && <span className="bc-courier-masked-token">Saved credential: <code>{config.maskedToken}</code></span>}
                </div>
              )}

              {testResultIsForThisCard && (actionData?.message || actionData?.error) && <div className={`bc-note bc-courier-test-result ${actionData.success ? (actionData.isLive ? "ok" : "warn") : "bad"}`} role={actionData.success ? "status" : "alert"}>{actionData.message || actionData.error}</div>}

              {isEditing ? (
                <div className="bc-courier-editor">
                  <div className="bc-courier-editor-heading"><h3>Configure {adapter.displayName}</h3><p>Credentials are encrypted before storage. Saved secret values are never returned to the browser.</p></div>
                  {adapter.fields.map((field) => {
                    const id = `courier-${adapter.providerName}-${field.key}`;
                    const isSaved = configuredKeys.has(field.key) || (field.key === "apiToken" && hasLegacyToken);
                    return <div className="bc-courier-field" key={field.key}>
                      <label htmlFor={id}>{field.label}{field.required && !isSaved ? <span aria-hidden="true"> *</span> : null}</label>
                      {field.type === "select" ? (
                        <select
                          id={id}
                          value={credentialInputs[field.key] || field.defaultValue || ""}
                          required={field.required && !isSaved}
                          onChange={(event) => setCredentialInputs((current) => ({ ...current, [field.key]: event.target.value }))}
                        >
                          {!field.required && <option value="">Use default ({field.defaultValue || "production"})</option>}
                          {(field.options || []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      ) : (
                        <input
                          id={id}
                          type={field.secret ? "password" : (field.type || "text")}
                          autoComplete={field.secret ? "new-password" : "off"}
                          placeholder={isSaved ? "Saved securely — leave blank to keep the current value" : field.placeholder}
                          value={credentialInputs[field.key] || ""}
                          required={field.required && !isSaved}
                          min={field.type === "number" ? 1 : undefined}
                          step={field.type === "number" ? 1 : undefined}
                          onChange={(event) => setCredentialInputs((current) => ({ ...current, [field.key]: event.target.value }))}
                        />
                      )}
                      {isSaved && <span className="bc-hint">Leave blank to preserve the saved value, or enter a replacement.</span>}
                    </div>;
                  })}
                  <div className="bc-courier-editor-actions">
                    <button type="button" className="bc-btn primary" onClick={() => handleSave(adapter.providerName)} disabled={isSubmitting || !adapter.fields.length}>{isSubmitting && actionData?.intent === "SAVE_CONFIG" ? "Saving…" : "Save credentials"}</button>
                    {adapter.isLive && <button type="button" className="bc-btn" onClick={() => handleTestConnection(adapter.providerName)} disabled={isSubmitting}>{isSubmitting && actionData?.intent === "TEST_CONNECTION" ? "Verifying…" : "Verify production credentials"}</button>}
                    <button type="button" className="bc-btn" onClick={() => setSelectedProvider(null)} disabled={isSubmitting}>Cancel</button>
                  </div>
                  {!isVerified && <p className="bc-hint">Saving credentials does not enable booking. Verify the production credentials to enable this courier for customer bookings.</p>}
                </div>
              ) : (
                <div className="bc-courier-card-actions">
                  {adapter.fields.length > 0 && <button type="button" className="bc-btn" onClick={() => handleEditClick(adapter)}>{isConfigured ? "Edit credentials" : "Configure credentials"}</button>}
                  {adapter.fields.length === 0 && <span className="bc-hint">Credential fields intentionally withheld pending the current official API contract.</span>}
                  {canSetReturnDefault && !isDefaultReturn && <button type="button" className="bc-btn" onClick={() => submitAction("SET_DEFAULT_REVERSE", adapter.providerName)} disabled={isSubmitting}>Set return default</button>}
                  {canSetForwardDefault && !isDefaultExchange && <button type="button" className="bc-btn" onClick={() => submitAction("SET_DEFAULT_FORWARD", adapter.providerName)} disabled={isSubmitting}>Set exchange default</button>}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
