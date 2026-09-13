import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useState } from "react";
import { requireTenantContext } from "../services/tenant.server";
import {
  CourierRegistry,
  getStoreCourierConfigs,
  saveMerchantCourierConfig,
} from "../services/courier.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopifyStoreId } = await requireTenantContext(request);
  const availableAdapters = CourierRegistry.getRegisteredAdapters();
  const configuredStoreCouriers = await getStoreCourierConfigs(shopifyStoreId);

  return { shopifyStoreId, availableAdapters, configuredStoreCouriers };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shopifyStoreId } = await requireTenantContext(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const providerName = (formData.get("providerName") as string) || "";

  if (intent === "SAVE_CONFIG") {
    const apiToken = (formData.get("apiToken") as string) || "";
    const accountNumber = (formData.get("accountNumber") as string) || "";
    const enabled = formData.get("enabled") === "true";
    const isDefaultReverse = formData.get("isDefaultReverse") === "true";
    const isDefaultForward = formData.get("isDefaultForward") === "true";

    try {
      await saveMerchantCourierConfig(shopifyStoreId, providerName, {
        apiToken,
        accountNumber,
        enabled,
        isDefaultReverse,
        isDefaultForward,
      });
      return { success: true, message: `Configuration saved for ${providerName}` };
    } catch (err: any) {
      return { success: false, error: err.message || "Failed to save configuration" };
    }
  }

  if (intent === "TEST_CONNECTION") {
    const apiToken = (formData.get("apiToken") as string) || "";
    const accountNumber = (formData.get("accountNumber") as string) || "";

    try {
      const adapter = CourierRegistry.get(providerName);
      const testResult = await adapter.testConnection({
        shopifyStoreId,
        config: { apiToken, accountNumber },
      });

      return {
        success: testResult.success,
        message: testResult.message,
        isLive: testResult.isLive,
        testedProvider: providerName,
      };
    } catch (err: any) {
      return { success: false, error: err.message || "Connection test failed", testedProvider: providerName };
    }
  }

  if (intent === "TOGGLE_ENABLED") {
    const enabled = formData.get("enabled") === "true";
    try {
      await saveMerchantCourierConfig(shopifyStoreId, providerName, { enabled });
      return { success: true, message: `${providerName} ${enabled ? "enabled" : "disabled"}` };
    } catch (err: any) {
      return { success: false, error: err.message || "Failed to update status" };
    }
  }

  if (intent === "SET_DEFAULT_REVERSE") {
    try {
      await saveMerchantCourierConfig(shopifyStoreId, providerName, { isDefaultReverse: true });
      return { success: true, message: `${providerName} set as default reverse logistics courier` };
    } catch (err: any) {
      return { success: false, error: err.message || "Failed to set default" };
    }
  }

  if (intent === "SET_DEFAULT_FORWARD") {
    try {
      await saveMerchantCourierConfig(shopifyStoreId, providerName, { isDefaultForward: true });
      return { success: true, message: `${providerName} set as default forward logistics courier` };
    } catch (err: any) {
      return { success: false, error: err.message || "Failed to set default" };
    }
  }

  return { success: false, error: "Invalid action intent" };
};

export default function Couriers() {
  const loaderData = useLoaderData<typeof loader>();
  const availableAdapters = loaderData?.availableAdapters ?? [];
  const configuredStoreCouriers = loaderData?.configuredStoreCouriers ?? [];
  const fetcher = useFetcher<any>();

  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [apiTokenInput, setApiTokenInput] = useState("");
  const [accountNumberInput, setAccountNumberInput] = useState("");

  const isSubmitting = fetcher.state !== "idle";
  const actionData = fetcher.data;

  // Build config lookup map
  const configMap = new Map((configuredStoreCouriers || []).map((c) => [c.providerName, c]));

  const handleEditClick = (adapter: any) => {
    setSelectedProvider(adapter.providerName);
    const existing = configMap.get(adapter.providerName);
    setApiTokenInput("");
    setAccountNumberInput(existing?.accountNumber || "");
  };

  const handleSave = (providerName: string) => {
    fetcher.submit(
      {
        intent: "SAVE_CONFIG",
        providerName,
        apiToken: apiTokenInput,
        accountNumber: accountNumberInput,
        enabled: "true",
      },
      { method: "post" }
    );
    setSelectedProvider(null);
  };

  const handleTestConnection = (providerName: string) => {
    fetcher.submit(
      {
        intent: "TEST_CONNECTION",
        providerName,
        apiToken: apiTokenInput,
        accountNumber: accountNumberInput,
      },
      { method: "post" }
    );
  };

  const handleSetDefaultReverse = (providerName: string) => {
    fetcher.submit({ intent: "SET_DEFAULT_REVERSE", providerName }, { method: "post" });
  };

  const handleSetDefaultForward = (providerName: string) => {
    fetcher.submit({ intent: "SET_DEFAULT_FORWARD", providerName }, { method: "post" });
  };

  return (
    <s-page heading="Pakistani Logistics & Courier Manager">
      <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
        <s-stack direction="block" gap="base">
          <s-heading>Pakistani Multi-Courier Framework 🇵🇰</s-heading>
          <s-paragraph>
            Configure your merchant API credentials for Pakistan&apos;s leading logistics providers. Manage separate default couriers for reverse pickup returns and forward exchange deliveries.
          </s-paragraph>

          {/* ACTION ALERT NOTIFICATIONS */}
          {actionData?.message && (
            <div style={{ padding: "12px", backgroundColor: "#f4f9f7", border: "1px solid #008060", borderRadius: "6px", color: "#008060", marginBottom: "16px" }}>
              {actionData.message}
            </div>
          )}

          {actionData?.error && (
            <div style={{ padding: "12px", backgroundColor: "#fdf2f2", border: "1px solid #d72c0d", borderRadius: "6px", color: "#d72c0d", marginBottom: "16px" }}>
              {actionData.error}
            </div>
          )}

          <s-heading>Integrated Pakistani Couriers</s-heading>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "16px", marginTop: "8px" }}>
            {availableAdapters.map((adapter) => {
              const config = configMap.get(adapter.providerName);
              const isConfigured = !!config?.hasToken;
              const isDefaultRev = !!config?.isDefaultReverse;
              const isDefaultFwd = !!config?.isDefaultForward;
              const isEditing = selectedProvider === adapter.providerName;

              return (
                <s-box key={adapter.providerName} padding="base" borderWidth="base" borderRadius="base" background="subdued">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <strong>{adapter.displayName}</strong>
                      <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>
                        Code: <code>{adapter.providerName}</code>
                      </div>
                    </div>
                    <div>
                      {isConfigured ? (
                        <s-badge tone="success">Configured</s-badge>
                      ) : (
                        <s-badge tone="warning">Not Configured</s-badge>
                      )}
                    </div>
                  </div>

                  <div style={{ fontSize: "13px", color: "#5c5f62", margin: "10px 0" }}>
                    {adapter.description}
                  </div>

                  {/* DEFAULTS BADGES */}
                  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", margin: "8px 0" }}>
                    {isDefaultRev && <s-badge tone="info">Default Reverse (Returns)</s-badge>}
                    {isDefaultFwd && <s-badge tone="info">Default Forward (Exchanges)</s-badge>}
                    {config?.maskedToken && (
                      <span style={{ fontSize: "12px", color: "#6d7175" }}>
                        Key: <code>{config.maskedToken}</code>
                      </span>
                    )}
                  </div>

                  {/* CREDENTIAL EDIT MODAL / FORM */}
                  {isEditing ? (
                    <div style={{ backgroundColor: "#fff", padding: "14px", borderRadius: "6px", border: "1px solid #c9cccf", marginTop: "12px" }}>
                      <h4 style={{ margin: "0 0 10px 0", fontSize: "14px" }}>Configure Credentials ({adapter.providerName})</h4>

                      <div style={{ marginBottom: "10px" }}>
                        <label style={{ display: "block", fontSize: "12px", fontWeight: 500, marginBottom: "4px" }}>
                          API Token / Key / Password
                        </label>
                        <input
                          type="password"
                          placeholder={config?.maskedToken || "Enter API Token"}
                          value={apiTokenInput}
                          onChange={(e) => setApiTokenInput(e.target.value)}
                          style={{ width: "100%", padding: "8px", border: "1px solid #c9cccf", borderRadius: "4px", fontSize: "13px" }}
                        />
                      </div>

                      <div style={{ marginBottom: "12px" }}>
                        <label style={{ display: "block", fontSize: "12px", fontWeight: 500, marginBottom: "4px" }}>
                          Account # / Cost Center / User ID
                        </label>
                        <input
                          type="text"
                          placeholder="e.g. 98765"
                          value={accountNumberInput}
                          onChange={(e) => setAccountNumberInput(e.target.value)}
                          style={{ width: "100%", padding: "8px", border: "1px solid #c9cccf", borderRadius: "4px", fontSize: "13px" }}
                        />
                      </div>

                      <div style={{ display: "flex", gap: "8px" }}>
                        <button
                          onClick={() => handleSave(adapter.providerName)}
                          disabled={isSubmitting}
                          style={{ padding: "6px 12px", backgroundColor: "#008060", color: "#fff", border: "none", borderRadius: "4px", fontSize: "12px", fontWeight: "bold", cursor: "pointer" }}
                        >
                          Save Credentials
                        </button>
                        <button
                          onClick={() => handleTestConnection(adapter.providerName)}
                          disabled={isSubmitting}
                          style={{ padding: "6px 12px", backgroundColor: "#2c6ecb", color: "#fff", border: "none", borderRadius: "4px", fontSize: "12px", fontWeight: "bold", cursor: "pointer" }}
                        >
                          Test API
                        </button>
                        <button
                          onClick={() => setSelectedProvider(null)}
                          style={{ padding: "6px 12px", backgroundColor: "#f1f2f3", border: "1px solid #c9cccf", borderRadius: "4px", fontSize: "12px", cursor: "pointer" }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ marginTop: "14px", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                      <button
                        onClick={() => handleEditClick(adapter)}
                        style={{ padding: "6px 12px", backgroundColor: "#fff", border: "1px solid #c9cccf", borderRadius: "4px", fontSize: "12px", fontWeight: 500, cursor: "pointer" }}
                      >
                        {isConfigured ? "Edit Credentials" : "Add Credentials"}
                      </button>

                      {!isDefaultRev && (
                        <button
                          onClick={() => handleSetDefaultReverse(adapter.providerName)}
                          style={{ padding: "6px 10px", backgroundColor: "#f4f9f7", border: "1px solid #008060", color: "#008060", borderRadius: "4px", fontSize: "11px", fontWeight: 500, cursor: "pointer" }}
                        >
                          Set Default Reverse
                        </button>
                      )}

                      {!isDefaultFwd && (
                        <button
                          onClick={() => handleSetDefaultForward(adapter.providerName)}
                          style={{ padding: "6px 10px", backgroundColor: "#f4f8fc", border: "1px solid #2c6ecb", color: "#2c6ecb", borderRadius: "4px", fontSize: "11px", fontWeight: 500, cursor: "pointer" }}
                        >
                          Set Default Forward
                        </button>
                      )}
                    </div>
                  )}
                </s-box>
              );
            })}
          </div>
        </s-stack>
      </s-box>
    </s-page>
  );
}
