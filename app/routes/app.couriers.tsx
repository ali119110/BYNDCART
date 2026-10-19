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
  if (request.method !== "POST") {
    return { success: false, error: "Method not allowed." };
  }

  const { shopifyStoreId } = await requireTenantContext(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const providerName = String(formData.get("providerName") || "").trim().toUpperCase();
  const adapter = CourierRegistry.getRegisteredAdapters().find((item) => item.providerName === providerName);

  if (!adapter) {
    return { success: false, error: "Choose a supported courier provider.", intent, providerName };
  }

  if (intent === "SAVE_CONFIG") {
    const apiToken = String(formData.get("apiToken") || "").trim();
    const accountNumber = String(formData.get("accountNumber") || "").trim();
    const existing = (await getStoreCourierConfigs(shopifyStoreId)).find((item) => item.providerName === providerName);
    const requiredToken = adapter.fields.some((field) => field.key === "apiToken" && field.required);
    const requiredAccountNumber = adapter.fields.some((field) => field.key === "accountNumber" && field.required);

    if (requiredToken && !apiToken && !existing?.hasToken) {
      return { success: false, error: `Enter the required credential for ${adapter.displayName}.`, intent, providerName };
    }
    if (requiredAccountNumber && !accountNumber) {
      return { success: false, error: `Enter the required account number or cost centre for ${adapter.displayName}.`, intent, providerName };
    }

    try {
      await saveMerchantCourierConfig(shopifyStoreId, providerName, {
        apiToken,
        accountNumber,
        enabled: true,
      });
      return { success: true, message: `${adapter.displayName} configuration saved.`, intent, providerName };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to save courier configuration.",
        intent,
        providerName,
      };
    }
  }

  if (intent === "TEST_CONNECTION") {
    if (!adapter.isLive) {
      return {
        success: true,
        isLive: false,
        message: `${adapter.displayName} connection testing and live booking are not implemented in BYNDCART. Use the manual airway-bill workflow.`,
        intent,
        providerName,
        testedProvider: providerName,
      };
    }

    const postedToken = String(formData.get("apiToken") || "").trim();
    const accountNumber = String(formData.get("accountNumber") || "").trim();
    const savedCredentials = postedToken ? null : await getDecryptedCourierCredentials(shopifyStoreId, providerName);

    try {
      const testResult = await CourierRegistry.get(providerName).testConnection({
        shopifyStoreId,
        config: {
          apiToken: postedToken || savedCredentials?.apiToken || "",
          accountNumber: accountNumber || savedCredentials?.accountNumber || "",
        },
      });
      return {
        success: testResult.success,
        message: testResult.message,
        isLive: testResult.isLive,
        intent,
        providerName,
        testedProvider: providerName,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Connection test failed.",
        intent,
        providerName,
        testedProvider: providerName,
      };
    }
  }

  if (intent === "TOGGLE_ENABLED") {
    const enabled = formData.get("enabled") === "true";
    try {
      await saveMerchantCourierConfig(shopifyStoreId, providerName, { enabled });
      return { success: true, message: `${adapter.displayName} ${enabled ? "enabled" : "disabled"}.`, intent, providerName };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Failed to update courier status.", intent, providerName };
    }
  }

  if (intent === "SET_DEFAULT_REVERSE" || intent === "SET_DEFAULT_FORWARD") {
    const isReverse = intent === "SET_DEFAULT_REVERSE";
    try {
      await saveMerchantCourierConfig(shopifyStoreId, providerName, isReverse
        ? { isDefaultReverse: true }
        : { isDefaultForward: true });
      return {
        success: true,
        message: `${adapter.displayName} is now the default courier for ${isReverse ? "returns / inbound pickups" : "exchanges / outbound replacements"}.`,
        intent,
        providerName,
      };
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
  const [apiTokenInput, setApiTokenInput] = useState("");
  const [accountNumberInput, setAccountNumberInput] = useState("");

  const isSubmitting = fetcher.state !== "idle";
  const actionData = fetcher.data;
  const configMap = new Map(configuredStoreCouriers.map((config) => [config.providerName, config]));

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success && fetcher.data.intent === "SAVE_CONFIG") {
      setSelectedProvider(null);
      setApiTokenInput("");
      setAccountNumberInput("");
    }
  }, [fetcher.state, fetcher.data]);

  const handleEditClick = (providerName: string) => {
    const config = configMap.get(providerName);
    setSelectedProvider(providerName);
    setApiTokenInput("");
    setAccountNumberInput(config?.accountNumber || "");
  };

  const submitAction = (intent: string, providerName: string, extra: Record<string, string> = {}) => {
    fetcher.submit({ intent, providerName, ...extra }, { method: "post" });
  };

  const handleSave = (providerName: string) => {
    const adapter = availableAdapters.find((item) => item.providerName === providerName);
    const usesAccountNumber = (adapter?.fields || []).some((field) => field.key === "accountNumber");
    submitAction("SAVE_CONFIG", providerName, {
      apiToken: apiTokenInput,
      accountNumber: usesAccountNumber ? accountNumberInput : "",
    });
  };

  const handleTestConnection = (providerName: string) => {
    submitAction("TEST_CONNECTION", providerName, {
      apiToken: apiTokenInput,
      accountNumber: accountNumberInput,
    });
  };

  return (
    <div className="bc-page bc-couriers-page">
      <header className="bc-header">
        <div className="bc-header-copy">
          <p className="bc-eyebrow">LOGISTICS</p>
          <h1>Couriers</h1>
          <p>Store each courier's credentials, choose defaults, and see which workflows are actually connected.</p>
        </div>
      </header>

      <section className="bc-courier-capability-note" aria-label="Courier integration status">
        <div className="bc-courier-capability-icon" aria-hidden="true">i</div>
        <div>
          <strong>Integration status</strong>
          <p>PostEx return booking is the only live booking integration in this version. The other couriers can be saved as defaults, but their shipments must be booked with the carrier and their airway bills entered manually. Live tracking and cancellation are not integrated yet.</p>
        </div>
      </section>

      {actionData?.intent !== "TEST_CONNECTION" && actionData?.message && (
        <div className={`bc-note ${actionData.success ? "ok" : "bad"}`} role={actionData.success ? "status" : "alert"}>{actionData.message}</div>
      )}
      {actionData?.intent !== "TEST_CONNECTION" && actionData?.error && (
        <div className="bc-note bad" role="alert">{actionData.error}</div>
      )}

      <div className="bc-courier-grid">
        {availableAdapters.map((adapter) => {
          const config = configMap.get(adapter.providerName);
          const hasSavedToken = Boolean(config?.hasToken);
          const requiredFieldsPresent = adapter.fields.every((field) =>
            !field.required || (field.key === "apiToken" ? hasSavedToken : Boolean(config?.accountNumber))
          );
          const isConfigured = hasSavedToken && requiredFieldsPresent;
          const isDefaultReturn = Boolean(config?.isDefaultReverse);
          const isDefaultExchange = Boolean(config?.isDefaultForward);
          const isEditing = selectedProvider === adapter.providerName;
          const testResultIsForThisCard = actionData?.intent === "TEST_CONNECTION" && actionData.testedProvider === adapter.providerName;

          return (
            <article key={adapter.providerName} className="bc-card bc-courier-card">
              <div className="bc-courier-card-header">
                <div className="bc-courier-title-wrap">
                  <h2>{adapter.displayName}</h2>
                  <span className="bc-courier-code">{adapter.providerName}</span>
                </div>
                <span className={`bc-badge ${isConfigured ? "ok" : "warn"}`}>
                  {isConfigured ? "Credentials saved" : "Not configured"}
                </span>
              </div>

              <p className="bc-courier-description">{adapter.description}</p>
              <div className={`bc-courier-capability ${adapter.isLive ? "live" : "manual"}`}>
                <span className="bc-courier-capability-dot" aria-hidden="true" />
                {adapter.isLive ? "Live return booking supported" : "Manual airway bill required"}
              </div>
              <p className="bc-courier-instructions">{adapter.instructions}</p>

              {(isDefaultReturn || isDefaultExchange || config?.maskedToken) && (
                <div className="bc-courier-meta">
                  {isDefaultReturn && <span className="bc-badge">Default return</span>}
                  {isDefaultExchange && <span className="bc-badge">Default exchange</span>}
                  {config?.maskedToken && <span className="bc-courier-masked-token">Saved key: <code>{config.maskedToken}</code></span>}
                </div>
              )}

              {testResultIsForThisCard && (actionData?.message || actionData?.error) && (
                <div className={`bc-note bc-courier-test-result ${actionData.success ? (actionData.isLive ? "ok" : "warn") : "bad"}`} role={actionData.success ? "status" : "alert"}>
                  {actionData.message || actionData.error}
                </div>
              )}

              {isEditing ? (
                <div className="bc-courier-editor">
                  <div className="bc-courier-editor-heading">
                    <h3>Configure {adapter.displayName}</h3>
                    <p>Credentials are encrypted before they are stored. The saved secret cannot be read back into this form.</p>
                  </div>

                  {(adapter.fields || []).map((field) => {
                    const id = `courier-${adapter.providerName}-${field.key}`;
                    const hasSavedToken = field.key === "apiToken" && Boolean(config?.hasToken);
                    return (
                      <div className="bc-courier-field" key={field.key}>
                        <label htmlFor={id}>
                          {field.label}{field.required && !hasSavedToken ? <span aria-hidden="true"> *</span> : null}
                        </label>
                        <input
                          id={id}
                          type={field.secret ? "password" : "text"}
                          autoComplete={field.secret ? "new-password" : "off"}
                          placeholder={hasSavedToken ? "Saved securely — leave blank to keep the current value" : field.placeholder}
                          value={field.key === "apiToken" ? apiTokenInput : accountNumberInput}
                          required={field.required && !hasSavedToken}
                          onChange={(event) => field.key === "apiToken" ? setApiTokenInput(event.target.value) : setAccountNumberInput(event.target.value)}
                        />
                        {hasSavedToken && <span className="bc-hint">Leave this blank to preserve the saved credential, or enter a new value to replace it.</span>}
                      </div>
                    );
                  })}

                  <div className="bc-courier-editor-actions">
                    <button type="button" className="bc-btn primary" onClick={() => handleSave(adapter.providerName)} disabled={isSubmitting}>
                      {isSubmitting && actionData?.intent === "SAVE_CONFIG" ? "Saving…" : "Save credentials"}
                    </button>
                    {adapter.isLive && (
                      <button type="button" className="bc-btn" onClick={() => handleTestConnection(adapter.providerName)} disabled={isSubmitting}>
                        {isSubmitting && actionData?.intent === "TEST_CONNECTION" ? "Testing…" : "Test connection"}
                      </button>
                    )}
                    <button type="button" className="bc-btn" onClick={() => setSelectedProvider(null)} disabled={isSubmitting}>Cancel</button>
                  </div>
                  {!adapter.isLive && <p className="bc-hint">A connection test is not available because this carrier's API is not connected to BYNDCART yet.</p>}
                </div>
              ) : (
                <div className="bc-courier-card-actions">
                  <button type="button" className="bc-btn" onClick={() => handleEditClick(adapter.providerName)}>
                    {isConfigured ? "Edit credentials" : "Add credentials"}
                  </button>
                  {!isDefaultReturn && (
                    <button type="button" className="bc-btn" onClick={() => submitAction("SET_DEFAULT_REVERSE", adapter.providerName)} disabled={isSubmitting}>
                      Set return default
                    </button>
                  )}
                  {!isDefaultExchange && (
                    <button type="button" className="bc-btn" onClick={() => submitAction("SET_DEFAULT_FORWARD", adapter.providerName)} disabled={isSubmitting}>
                      Set exchange default
                    </button>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
