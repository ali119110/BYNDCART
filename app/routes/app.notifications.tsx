import React, { useState } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { getStoreByShop } from "../services/store.server";
import {
  getStoreNotificationTemplates,
  upsertNotificationTemplate,
  getNotificationLogs,
  processNotificationJob,
  sendEmail,
  NotificationEventType,
} from "../services/notifications.server";
import {
  getWhatsAppConfig,
  saveWhatsAppConfig,
  disconnectWhatsApp,
  seedDefaultWhatsAppTemplates,
  exchangeMetaEmbeddedSignupCode,
  dispatchWhatsAppNotification,
} from "../services/whatsapp.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await getStoreByShop(session.shop);
  if (!store) {
    throw new Response("Store not found", { status: 404 });
  }

  try {
    const [emailTemplates, waTemplates, whatsappConfig, logs] = await Promise.all([
      getStoreNotificationTemplates(store.id, "EMAIL"),
      getStoreNotificationTemplates(store.id, "WHATSAPP"),
      getWhatsAppConfig(store.id),
      getNotificationLogs(store.id, 40),
    ]);

    return {
      storeId: store.id,
      shop: session.shop,
      emailTemplates,
      waTemplates,
      whatsappConfig,
      metaAppId: process.env.META_APP_ID || process.env.WHATSAPP_APP_ID || "",
      metaConfigId: process.env.META_CONFIG_ID || "",
      emailProviderConfigured: Boolean(process.env.RESEND_API_KEY),
      logs: logs.map((l) => ({
        ...l,
        createdAt: l.createdAt.toISOString(),
        sentAt: l.sentAt ? l.sentAt.toISOString() : null,
      })),
      loadError: null as string | null,
    };
  } catch (error) {
    console.error("[Notifications] Panel loader failed:", error);
    return {
      storeId: store.id,
      shop: session.shop,
      emailTemplates: [],
      waTemplates: [],
      whatsappConfig: null,
      metaAppId: "",
      metaConfigId: "",
      emailProviderConfigured: Boolean(process.env.RESEND_API_KEY),
      logs: [],
      loadError:
        "Notification settings could not be loaded. Details: " +
        (error instanceof Error ? error.message : String(error)),
    };
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await getStoreByShop(session.shop);
  if (!store) {
    return { success: false, error: "Store not found" };
  }

  const formData = await request.formData();
  const actionType = formData.get("actionType") as string;

  // 1. Save template (Email or WhatsApp)
  if (actionType === "saveTemplate") {
    const eventType = formData.get("eventType") as NotificationEventType;
    const channel = (formData.get("channel") as string) || "EMAIL";
    const enabled = formData.get("enabled") === "true";
    const subject = (formData.get("subject") as string) || "";
    const body = (formData.get("body") as string) || "";

    try {
      await upsertNotificationTemplate(store.id, eventType, channel, enabled, subject, body);
      return { success: true, message: `Updated ${channel} template for ${eventType}` };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  if (actionType === "sendTestEmail") {
    const recipient = String(formData.get("testEmail") || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      return { success: false, error: "Enter a valid email address for the test.", intent: "sendTestEmail" };
    }
    const result = await sendEmail({
      to: recipient,
      subject: "BYNDCART email delivery test",
      html: "<p>This is a test email from BYNDCART. If you received it, the configured transactional email provider can deliver messages to this address.</p>",
    });
    return result.success
      ? { success: true, message: "Test email accepted by the configured email provider. Check the inbox and spam folder.", intent: "sendTestEmail" }
      : { success: false, error: result.error || "The email provider could not send the test message.", intent: "sendTestEmail" };
  }

  // 2. Toggle template enabled/disabled
  if (actionType === "toggleTemplate") {
    const eventType = formData.get("eventType") as NotificationEventType;
    const channel = (formData.get("channel") as string) || "WHATSAPP";
    const enabled = formData.get("enabled") === "true";

    try {
      const existing = await prisma.notificationTemplate.findUnique({
        where: { shopifyStoreId_eventType_channel: { shopifyStoreId: store.id, eventType, channel } },
      });

      if (existing) {
        await prisma.notificationTemplate.update({
          where: { id: existing.id },
          data: { enabled },
        });
      } else {
        await upsertNotificationTemplate(store.id, eventType, channel, enabled, eventType, "");
      }
      return { success: true, message: `${enabled ? "Enabled" : "Disabled"} ${eventType}` };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  // 3. Connect Meta Embedded Signup (OAuth Code)
  if (actionType === "connectMetaEmbeddedSignup") {
    const code = formData.get("code") as string;
    if (!code) {
      return { success: false, error: "Missing Meta authorization code." };
    }

    try {
      const sessionInfo = {
        wabaId: String(formData.get("wabaId") || "").trim() || undefined,
        phoneNumberId: String(formData.get("phoneNumberId") || "").trim() || undefined,
        businessId: String(formData.get("businessId") || "").trim() || undefined,
      };
      const connection = await exchangeMetaEmbeddedSignupCode(store.id, code, undefined, undefined, sessionInfo);
      return {
        success: true,
        message: "WhatsApp Business account and registered phone verified. BYNDCART templates are available locally; business-initiated template messages require Meta approval and the platform's Tech Provider/partner setup.",
        metaTemplateStatus: (connection as any)?.metaTemplateStatus,
      };
    } catch (err: any) {
      return { success: false, error: err.message || "Failed to link Meta WhatsApp account." };
    }
  }

  // 4. Save manual WhatsApp credentials (Phone Number ID, WABA ID, Access Token)
  if (actionType === "saveWhatsAppConfig") {
    const phoneNumberId = (formData.get("phoneNumberId") as string) || "";
    const wabaId = (formData.get("wabaId") as string) || "";
    const accessToken = (formData.get("accessToken") as string) || "";
    const displayPhoneNumber = (formData.get("displayPhoneNumber") as string) || "";
    const verifiedName = (formData.get("verifiedName") as string) || "";

    if (!phoneNumberId || !accessToken) {
      return { success: false, error: "Phone Number ID and Access Token are required." };
    }

    try {
      await saveWhatsAppConfig(store.id, {
        phoneNumberId,
        wabaId,
        accessToken,
        displayPhoneNumber,
        verifiedName,
        connectionType: "MANUAL_TOKEN",
        enabled: true,
      });
      return { success: true, message: "WhatsApp API connected and default automation templates installed!" };
    } catch (err: any) {
      return { success: false, error: err.message || "Failed to save WhatsApp configuration." };
    }
  }

  // 5. Disconnect WhatsApp
  if (actionType === "disconnectWhatsApp") {
    try {
      await disconnectWhatsApp(store.id);
      return { success: true, message: "WhatsApp account disconnected." };
    } catch (err: any) {
      return { success: false, error: err.message || "Failed to disconnect." };
    }
  }

  // 6. Toggle WhatsApp Entirely On/Off
  if (actionType === "toggleWhatsAppGlobal") {
    const enabled = formData.get("enabled") === "true";
    try {
      await prisma.whatsAppConfig.update({
        where: { shopifyStoreId: store.id },
        data: { enabled },
      });
      return { success: true, message: `WhatsApp automation ${enabled ? "enabled" : "disabled"}.` };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  // 7. Reset / Re-seed WhatsApp templates
  if (actionType === "reseedTemplates") {
    try {
      const res = await seedDefaultWhatsAppTemplates(store.id);
      return { success: true, message: `Reset ${res.count} WhatsApp default templates.` };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  // 8. Send Test WhatsApp Alert
  if (actionType === "sendTestWhatsApp") {
    const testPhone = (formData.get("testPhone") as string) || "";
    if (!testPhone) {
      return { success: false, error: "Recipient mobile number is required." };
    }

    try {
      const testResult = await dispatchWhatsAppNotification({
        to: testPhone,
        message: "Hello! This is a test alert from BYNDCART WhatsApp Cloud API. Your store notifications are functioning properly.",
        shopifyStoreId: store.id,
      });

      if (!testResult.success) {
        return { success: false, error: testResult.error || "Meta rejected test message dispatch." };
      }
      return { success: true, message: `Test WhatsApp message sent to ${testPhone} (ID: ${testResult.messageId || "ok"}).` };
    } catch (err: any) {
      return { success: false, error: err.message || "Test dispatch failed." };
    }
  }

  // 9. Retry Notification Log
  if (actionType === "retryLog") {
    const logId = formData.get("logId") as string;
    const log = await prisma.notificationLog.findFirst({
      where: { id: logId, shopifyStoreId: store.id },
    });

    if (!log) {
      return { success: false, error: "Notification log not found" };
    }

    try {
      const result = await processNotificationJob({
        notificationLogId: log.id,
        shopifyStoreId: store.id,
        eventType: log.eventType as NotificationEventType,
        channel: log.channel as any,
        recipient: log.recipient,
        variables: { order_number: "#RETRY" },
      });
      return {
        success: result.success,
        message: result.success ? "Notification retried successfully" : result.error,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  return { success: false, error: "Invalid action" };
};

export default function Notifications() {
  const {
    emailTemplates,
    waTemplates,
    whatsappConfig,
    emailProviderConfigured,
    metaAppId,
    metaConfigId,
    logs,
    loadError,
  } = useLoaderData<typeof loader>();

  const fetcher = useFetcher();
  const isSubmitting = fetcher.state !== "idle";
  const actionData = fetcher.data as { success?: boolean; message?: string; error?: string } | undefined;

  // Tabs: "whatsapp" or "email"
  const [activeTab, setActiveTab] = useState<"whatsapp" | "email">("whatsapp");

  // Email state
  const [selectedEmailEvent, setSelectedEmailEvent] = useState<string>(
    emailTemplates[0]?.eventType || "RETURN_SUBMITTED"
  );
  const currentEmailTemplate =
    emailTemplates.find((t) => t.eventType === selectedEmailEvent) || emailTemplates[0];

  const [emailFormState, setEmailFormState] = useState({
    enabled: currentEmailTemplate?.enabled ?? true,
    subject: currentEmailTemplate?.subject ?? "",
    body: currentEmailTemplate?.body ?? "",
  });

  React.useEffect(() => {
    if (currentEmailTemplate) {
      setEmailFormState({
        enabled: currentEmailTemplate.enabled,
        subject: currentEmailTemplate.subject,
        body: currentEmailTemplate.body,
      });
    }
  }, [selectedEmailEvent, currentEmailTemplate]);

  // WhatsApp manual modal & editing state
  const [showManualModal, setShowManualModal] = useState(false);
  const [editingWaEvent, setEditingWaEvent] = useState<string | null>(null);
  const [waEditingBody, setWaEditingBody] = useState("");
  const [waEditingEnabled, setWaEditingEnabled] = useState(true);

  const [testPhone, setTestPhone] = useState("");
  const [showTestModal, setShowTestModal] = useState(false);
  const [metaSdkReady, setMetaSdkReady] = useState(false);
  const metaSignupSessionInfoRef = React.useRef<{ wabaId?: string; phoneNumberId?: string; businessId?: string } | null>(null);

  // Embedded Signup may return the asset IDs through a postMessage event, or on the
  // FB.login response extras. Accept these IDs only from known Meta domains.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const onMetaMessage = (event: MessageEvent) => {
      try {
        const origin = new URL(event.origin);
        if (!["facebook.com", "www.facebook.com", "business.facebook.com", "web.facebook.com"].includes(origin.hostname)) return;
        let data: any = event.data;
        if (typeof data === "string") data = JSON.parse(data);
        if (data?.type !== "WA_EMBEDDED_SIGNUP") return;
        const session = data?.data || data;
        const wabaId = String(session?.waba_id || session?.wabaId || "").trim();
        const phoneNumberId = String(session?.phone_number_id || session?.phoneNumberId || "").trim();
        const businessId = String(session?.business_id || session?.businessId || "").trim();
        if (wabaId || phoneNumberId || businessId) {
          metaSignupSessionInfoRef.current = { wabaId: wabaId || undefined, phoneNumberId: phoneNumberId || undefined, businessId: businessId || undefined };
        }
      } catch {
        // Ignore unrelated or malformed window messages.
      }
    };
    window.addEventListener("message", onMetaMessage);
    return () => window.removeEventListener("message", onMetaMessage);
  }, []);

  // Meta Embedded Signup requires the Facebook JavaScript SDK; without loading and
  // initializing it, the Connect button always falls back to manual credentials.
  React.useEffect(() => {
    if (typeof window === "undefined" || !metaAppId) return;
    const w = window as any;
    const initializeMeta = () => {
      if (!w.FB) return false;
      try {
        w.FB.init({
          appId: metaAppId,
          cookie: true,
          xfbml: false,
          version: "v23.0",
        });
        setMetaSdkReady(true);
        return true;
      } catch (error) {
        console.error("[Notifications] Meta SDK initialization failed:", error);
        setMetaSdkReady(false);
        return false;
      }
    };

    if (w.FB && initializeMeta()) return;
    w.fbAsyncInit = () => { initializeMeta(); };
    let script = document.getElementById("byndcart-facebook-jssdk") as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = "byndcart-facebook-jssdk";
      script.src = "https://connect.facebook.net/en_US/sdk.js";
      script.async = true;
      script.defer = true;
      script.crossOrigin = "anonymous";
      script.onload = () => { initializeMeta(); };
      script.onerror = () => {
        setMetaSdkReady(false);
        console.error("[Notifications] Facebook JavaScript SDK could not be loaded.");
      };
      document.head.appendChild(script);
    } else if (w.FB) {
      initializeMeta();
    }
  }, [metaAppId]);

  const isWaConnected = Boolean(
    whatsappConfig?.enabled && whatsappConfig?.phoneNumberId && whatsappConfig?.accessToken
  );

  const openWaEditModal = (tpl: any) => {
    setEditingWaEvent(tpl.eventType);
    setWaEditingBody(tpl.body || "");
    setWaEditingEnabled(tpl.enabled);
  };

  const closeWaEditModal = () => {
    setEditingWaEvent(null);
  };

  const insertVariable = (varName: string) => {
    setWaEditingBody((prev) => `${prev} {{${varName}}}`);
  };

  // Launch Meta Embedded Signup Popup
  const launchMetaEmbeddedSignup = () => {
    if (typeof window === "undefined") return;

    if (!metaAppId || !metaConfigId) {
      alert("Meta App ID and WhatsApp Embedded Signup Configuration ID must be configured by the BYNDCART platform provider before Embedded Signup can start.");
      setShowManualModal(true);
      return;
    }

    const fb = (window as any).FB;
    if (fb && metaSdkReady) {
      fb.login(
        (response: any) => {
          if (response.authResponse?.code) {
            const authExtras = response.authResponse?.extras || response.authResponse || {};
            const messageInfo = metaSignupSessionInfoRef.current || {};
            const wabaId = String(authExtras.waba_id || authExtras.wabaId || messageInfo.wabaId || "").trim();
            const phoneNumberId = String(authExtras.phone_number_id || authExtras.phoneNumberId || messageInfo.phoneNumberId || "").trim();
            const businessId = String(authExtras.business_id || authExtras.businessId || messageInfo.businessId || "").trim();
            const fd = new FormData();
            fd.append("actionType", "connectMetaEmbeddedSignup");
            fd.append("code", response.authResponse.code);
            if (wabaId) fd.append("wabaId", wabaId);
            if (phoneNumberId) fd.append("phoneNumberId", phoneNumberId);
            if (businessId) fd.append("businessId", businessId);
            fetcher.submit(fd, { method: "post" });
          } else {
            console.warn("Meta login cancelled or no code returned", response);
          }
        },
        {
          config_id: metaConfigId || undefined,
          response_type: "code",
          override_default_response_type: true,
          extras: {
            setup: {},
            featureType: "",
            sessionInfoVersion: "2",
          },
        }
      );
    } else {
      // Fallback to manual setup modal if FB JS SDK is not loaded
      setShowManualModal(true);
    }
  };

  return (
    <div className="bc-page">
      <header className="bc-header">
        <div className="bc-header-copy">
          <p className="bc-eyebrow">CUSTOMER MESSAGING & ALERTS</p>
          <h1>Notifications</h1>
          <p>Configure automated WhatsApp alerts and email updates for returns, exchanges, courier bookings, and delivery milestones.</p>
        </div>
      </header>

      {loadError && <div role="alert" className="bc-note bad">{loadError}</div>}
      {actionData?.error && <div className="bc-note bad">{actionData.error}</div>}
      {actionData?.message && <div className="bc-note ok">{actionData.message}</div>}

      {/* Navigation Tab Bar */}
      <div style={{ display: "flex", gap: "8px", borderBottom: "1px solid #e2e8f0", marginBottom: "20px" }}>
        <button
          type="button"
          onClick={() => setActiveTab("whatsapp")}
          style={{
            padding: "10px 18px",
            border: "none",
            borderBottom: activeTab === "whatsapp" ? "2px solid #000" : "2px solid transparent",
            background: "none",
            fontWeight: activeTab === "whatsapp" ? "600" : "400",
            cursor: "pointer",
            fontSize: "14px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span>WhatsApp Alerts (Meta API)</span>
          {isWaConnected ? (
            <span style={{ fontSize: "11px", padding: "2px 6px", background: "#dcfce7", color: "#166534", borderRadius: "4px" }}>Connected</span>
          ) : (
            <span style={{ fontSize: "11px", padding: "2px 6px", background: "#f1f5f9", color: "#64748b", borderRadius: "4px" }}>Optional</span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("email")}
          style={{
            padding: "10px 18px",
            border: "none",
            borderBottom: activeTab === "email" ? "2px solid #000" : "2px solid transparent",
            background: "none",
            fontWeight: activeTab === "email" ? "600" : "400",
            cursor: "pointer",
            fontSize: "14px",
          }}
        >
          Email Notifications
        </button>
      </div>

      {/* ============================================================== */}
      {/* TAB 1: WHATSAPP NOTIFICATIONS (META CLOUD API & WATIX FLOW)    */}
      {/* ============================================================== */}
      {activeTab === "whatsapp" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          
          {/* WhatsApp Connection Card */}
          <section className="bc-card">
            {isWaConnected ? (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px" }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#22c55e", display: "inline-block" }} />
                      <h2 style={{ fontSize: "18px", margin: 0, fontWeight: "600" }}>WhatsApp Connected</h2>
                      <span className="bc-badge ok">Active</span>
                    </div>
                    <p className="bc-muted" style={{ marginTop: "4px", fontSize: "13px" }}>
                      Your Meta WhatsApp Business account is linked and ready to send automated customer updates.
                    </p>
                  </div>

                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="bc-btn"
                      onClick={() => setShowTestModal(true)}
                    >
                      Send Test Alert
                    </button>

                    <fetcher.Form method="post" onSubmit={(e) => {
                      if (!confirm("Reset all WhatsApp templates to BYNDCART defaults?")) e.preventDefault();
                    }}>
                      <input type="hidden" name="actionType" value="reseedTemplates" />
                      <button type="submit" className="bc-btn" disabled={isSubmitting}>
                        Re-sync Templates
                      </button>
                    </fetcher.Form>

                    <fetcher.Form method="post" onSubmit={(e) => {
                      if (!confirm("Are you sure you want to disconnect WhatsApp?")) e.preventDefault();
                    }}>
                      <input type="hidden" name="actionType" value="disconnectWhatsApp" />
                      <button type="submit" className="bc-btn" style={{ color: "#dc2626" }} disabled={isSubmitting}>
                        Disconnect
                      </button>
                    </fetcher.Form>
                  </div>
                </div>

                {/* Connection Stats Grid */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px", marginTop: "16px", background: "#f8fafc", padding: "14px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                  <div>
                    <span style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase", display: "block" }}>Phone Number</span>
                    <strong style={{ fontSize: "14px" }}>{whatsappConfig?.displayPhoneNumber || "Connected Phone"}</strong>
                  </div>
                  <div>
                    <span style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase", display: "block" }}>Business Name</span>
                    <strong style={{ fontSize: "14px" }}>{whatsappConfig?.verifiedName || "Verified Merchant"}</strong>
                  </div>
                  <div>
                    <span style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase", display: "block" }}>Phone ID</span>
                    <code style={{ fontSize: "12px" }}>{whatsappConfig?.phoneNumberId ? `${whatsappConfig.phoneNumberId.slice(0, 8)}...` : "—"}</code>
                  </div>
                  <div>
                    <span style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase", display: "block" }}>Quality Rating</span>
                    <span style={{ fontSize: "12px", fontWeight: "600", color: "#16a34a" }}>{whatsappConfig?.qualityRating || "GREEN"}</span>
                  </div>
                </div>
              </div>
            ) : (
              /* Disconnected State (Hero Card matching Watix) */
              <div style={{ textAlign: "center", padding: "28px 16px" }}>
                <h2 style={{ fontSize: "22px", fontWeight: "700", marginBottom: "8px" }}>WhatsApp Cloud API</h2>
                <p className="bc-muted" style={{ maxWidth: "580px", margin: "0 auto 20px auto", fontSize: "14px", lineHeight: "1.5" }}>
                  Connect your WhatsApp Business and start sending automated order alerts to your customers.
                  Meta Official Cloud API platform that automates returns, exchanges, courier bookings, and delivery milestones.
                </p>

                <div style={{ display: "flex", justifyContent: "center", gap: "12px", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="bc-btn primary"
                    onClick={launchMetaEmbeddedSignup}
                    disabled={!metaSdkReady && Boolean(metaAppId && metaConfigId)}
                    style={{ padding: "10px 24px", fontSize: "14px", opacity: !metaSdkReady && metaAppId && metaConfigId ? 0.65 : 1 }}
                  >
                    {metaSdkReady ? "Connect WhatsApp" : "Loading Meta connection…"}
                  </button>

                  <button
                    type="button"
                    className="bc-btn"
                    onClick={() => setShowManualModal(true)}
                    style={{ padding: "10px 18px", fontSize: "14px" }}
                  >
                    Connect with API Credentials
                  </button>
                </div>

                <p style={{ fontSize: "12px", color: "#94a3b8", marginTop: "14px" }}>
                  Optional feature. Meta utility messaging fees are billed directly to your Meta card with 0 markup.
                </p>
              </div>
            )}
          </section>

          {/* Test Alert Modal */}
          {showTestModal && (
            <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "16px" }}>
              <div style={{ background: "#fff", borderRadius: "10px", maxWidth: "420px", width: "100%", padding: "24px", boxShadow: "0 10px 25px rgba(0,0,0,0.1)" }}>
                <h3 style={{ margin: "0 0 10px 0", fontSize: "17px" }}>Send Test WhatsApp Message</h3>
                <p className="bc-muted" style={{ fontSize: "13px", marginBottom: "16px" }}>
                  Enter any active WhatsApp mobile number (e.g. <code>03001234567</code>) to verify your Meta Cloud API connection.
                </p>

                <fetcher.Form method="post" onSubmit={() => setShowTestModal(false)}>
                  <input type="hidden" name="actionType" value="sendTestWhatsApp" />
                  <div style={{ marginBottom: "16px" }}>
                    <label style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "4px" }}>Recipient Mobile</label>
                    <input
                      type="text"
                      name="testPhone"
                      placeholder="03XXXXXXXXX"
                      value={testPhone}
                      onChange={(e) => setTestPhone(e.target.value)}
                      style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: "6px" }}
                      required
                    />
                  </div>

                  <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                    <button type="button" className="bc-btn" onClick={() => setShowTestModal(false)}>Cancel</button>
                    <button type="submit" className="bc-btn primary" disabled={isSubmitting}>
                      {isSubmitting ? "Sending..." : "Send Test"}
                    </button>
                  </div>
                </fetcher.Form>
              </div>
            </div>
          )}

          {/* Manual Credentials Modal */}
          {showManualModal && (
            <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "16px" }}>
              <div style={{ background: "#fff", borderRadius: "10px", maxWidth: "520px", width: "100%", padding: "24px", boxShadow: "0 10px 25px rgba(0,0,0,0.1)", maxHeight: "90vh", overflowY: "auto" }}>
                <h3 style={{ margin: "0 0 6px 0", fontSize: "18px" }}>Connect WhatsApp Cloud API Credentials</h3>
                <p className="bc-muted" style={{ fontSize: "13px", marginBottom: "18px" }}>
                  Paste your Meta Phone Number ID, WhatsApp Business Account ID (WABA), and System User Token from Meta Business Manager.
                </p>

                <fetcher.Form method="post" onSubmit={() => setShowManualModal(false)} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  <input type="hidden" name="actionType" value="saveWhatsAppConfig" />

                  <div>
                    <label style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "4px" }}>Phone Number ID *</label>
                    <input
                      type="text"
                      name="phoneNumberId"
                      placeholder="e.g. 109876543210987"
                      defaultValue={whatsappConfig?.phoneNumberId || ""}
                      style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: "6px" }}
                      required
                    />
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "4px" }}>WABA ID (WhatsApp Business Account ID)</label>
                    <input
                      type="text"
                      name="wabaId"
                      placeholder="e.g. 987654321098765"
                      defaultValue={whatsappConfig?.wabaId || ""}
                      style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: "6px" }}
                    />
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "4px" }}>Permanent Access Token *</label>
                    <input
                      type="password"
                      name="accessToken"
                      placeholder="EAAG..."
                      defaultValue={whatsappConfig?.rawAccessToken || ""}
                      style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: "6px" }}
                      required
                    />
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                    <div>
                      <label style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "4px" }}>Display Phone Number</label>
                      <input
                        type="text"
                        name="displayPhoneNumber"
                        placeholder="e.g. +92 300 1234567"
                        defaultValue={whatsappConfig?.displayPhoneNumber || ""}
                        style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: "6px" }}
                      />
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "4px" }}>Verified Name</label>
                      <input
                        type="text"
                        name="verifiedName"
                        placeholder="e.g. Brand Name"
                        defaultValue={whatsappConfig?.verifiedName || ""}
                        style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: "6px" }}
                      />
                    </div>
                  </div>

                  <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "14px" }}>
                    <button type="button" className="bc-btn" onClick={() => setShowManualModal(false)}>Cancel</button>
                    <button type="submit" className="bc-btn primary" disabled={isSubmitting}>
                      {isSubmitting ? "Connecting..." : "Save & Connect"}
                    </button>
                  </div>
                </fetcher.Form>
              </div>
            </div>
          )}

          {/* WhatsApp Automation Cards (Watix Style Grid) */}
          <section className="bc-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <div>
                <h2 className="bc-title" style={{ margin: 0 }}>Automated WhatsApp Alerts</h2>
                <p className="bc-muted" style={{ fontSize: "13px", marginTop: "2px" }}>
                  Enable or customize automated customer messages triggered during order fulfillment, courier delivery, and returns.
                </p>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "14px" }}>
              {waTemplates.map((tpl) => (
                <div
                  key={tpl.eventType}
                  style={{
                    border: "1px solid #e2e8f0",
                    borderRadius: "8px",
                    padding: "16px",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    background: tpl.enabled ? "#ffffff" : "#f8fafc",
                  }}
                >
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                      <strong style={{ fontSize: "14px", color: tpl.enabled ? "#0f172a" : "#64748b" }}>{tpl.label}</strong>
                      <span className={tpl.enabled ? "bc-badge ok" : "bc-badge"} style={{ fontSize: "11px" }}>
                        {tpl.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </div>

                    <p style={{ fontSize: "12px", color: "#64748b", margin: "8px 0 12px 0", lineHeight: "1.4" }}>
                      {tpl.eventType === "COURIER_PICKUP_BOOKED" && "Send automated message when order is booked with courier. Shares tracking CN and live link."}
                      {tpl.eventType === "TRACKING_UPDATE" && "Send message when shipment is out for delivery. Alerts customer to keep COD amount ready."}
                      {tpl.eventType === "REPLACEMENT_DELIVERED" && "Send message when shipment or replacement parcel is Delivered."}
                      {tpl.eventType === "RETURN_REJECTED" && "Send message when delivery attempt fails or shipment is Refused."}
                      {tpl.eventType === "RETURN_SUBMITTED" && "Send confirmation when customer submits a return request on the portal."}
                      {tpl.eventType === "RETURN_APPROVED" && "Send approval alert with return parcel packing instructions."}
                      {tpl.eventType === "RETURN_RECEIVED" && "Send message when returned parcel reaches the warehouse."}
                      {tpl.eventType === "INSPECTION_COMPLETED" && "Send message when returned item passes quality inspection."}
                      {tpl.eventType === "REPLACEMENT_CREATED" && "Send confirmation when replacement order is created and dispatched."}
                      {tpl.eventType === "REFUND_INITIATED" && "Send confirmation when refund payout is processed."}
                    </p>
                  </div>

                  <div style={{ display: "flex", gap: "8px", borderTop: "1px solid #f1f5f9", paddingTop: "12px", marginTop: "8px" }}>
                    <fetcher.Form method="post" style={{ margin: 0 }}>
                      <input type="hidden" name="actionType" value="toggleTemplate" />
                      <input type="hidden" name="eventType" value={tpl.eventType} />
                      <input type="hidden" name="channel" value="WHATSAPP" />
                      <input type="hidden" name="enabled" value={tpl.enabled ? "false" : "true"} />
                      <button type="submit" className="bc-btn" style={{ fontSize: "12px", padding: "4px 10px" }} disabled={isSubmitting}>
                        {tpl.enabled ? "Disable" : "Enable"}
                      </button>
                    </fetcher.Form>

                    <button
                      type="button"
                      className="bc-btn"
                      style={{ fontSize: "12px", padding: "4px 10px" }}
                      onClick={() => openWaEditModal(tpl)}
                    >
                      Settings / Edit
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Edit WhatsApp Template Modal */}
          {editingWaEvent && (
            <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "16px" }}>
              <div style={{ background: "#fff", borderRadius: "10px", maxWidth: "600px", width: "100%", padding: "24px", boxShadow: "0 10px 25px rgba(0,0,0,0.1)", maxHeight: "90vh", overflowY: "auto" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
                  <h3 style={{ margin: 0, fontSize: "17px" }}>Edit WhatsApp Message Template</h3>
                  <button type="button" onClick={closeWaEditModal} style={{ background: "none", border: "none", fontSize: "20px", cursor: "pointer" }}>✕</button>
                </div>

                <fetcher.Form method="post" onSubmit={closeWaEditModal} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                  <input type="hidden" name="actionType" value="saveTemplate" />
                  <input type="hidden" name="eventType" value={editingWaEvent} />
                  <input type="hidden" name="channel" value="WHATSAPP" />
                  <input type="hidden" name="subject" value={editingWaEvent} />

                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <input
                      type="checkbox"
                      id="wa-enabled-checkbox"
                      name="enabled"
                      value="true"
                      checked={waEditingEnabled}
                      onChange={(e) => setWaEditingEnabled(e.target.checked)}
                    />
                    <label htmlFor="wa-enabled-checkbox" style={{ fontSize: "13px", fontWeight: "600", cursor: "pointer" }}>
                      Send this automated message when event occurs
                    </label>
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "12px", fontWeight: "600", marginBottom: "6px" }}>
                      Message Content (Supports WhatsApp *bold*, _italic_, and line breaks)
                    </label>
                    <textarea
                      name="body"
                      rows={7}
                      value={waEditingBody}
                      onChange={(e) => setWaEditingBody(e.target.value)}
                      style={{ width: "100%", padding: "10px", border: "1px solid #cbd5e1", borderRadius: "6px", fontFamily: "inherit", fontSize: "13px" }}
                      required
                    />
                  </div>

                  <div>
                    <span style={{ fontSize: "12px", fontWeight: "600", color: "#64748b", display: "block", marginBottom: "6px" }}>
                      Insert Variable Tags:
                    </span>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                      {["customer_name", "order_number", "courier_name", "tracking_number", "tracking_url", "cod_amount", "portal_url", "reason"].map((v) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => insertVariable(v)}
                          style={{
                            padding: "3px 8px",
                            fontSize: "11px",
                            background: "#f1f5f9",
                            border: "1px solid #cbd5e1",
                            borderRadius: "4px",
                            cursor: "pointer",
                          }}
                        >
                          +{`{${v}}`}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "12px" }}>
                    <button type="button" className="bc-btn" onClick={closeWaEditModal}>Cancel</button>
                    <button type="submit" className="bc-btn primary" disabled={isSubmitting}>
                      {isSubmitting ? "Saving..." : "Save Template"}
                    </button>
                  </div>
                </fetcher.Form>
              </div>
            </div>
          )}

        </div>
      )}

      {/* ============================================================== */}
      {/* TAB 2: EMAIL NOTIFICATIONS (EXISTING CORE EMAIL SYSTEM)        */}
      {/* ============================================================== */}
      {activeTab === "email" && (
        <section className="bc-card">
          <h2 className="bc-title">Email templates</h2>
          <p className="bc-muted">Choose an event, then edit the subject and body for that message.</p>
          <div className={`bc-note ${emailProviderConfigured ? "ok" : "bad"}`} role={emailProviderConfigured ? "status" : "alert"}>
            {emailProviderConfigured
              ? "Transactional email provider key is configured. Use the test below to verify delivery."
              : "Transactional email is not configured on the server. Set RESEND_API_KEY and a verified NOTIFICATIONS_FROM_EMAIL before email notifications can be delivered."}
          </div>
          <section style={{border:"1px solid var(--bc-line)",borderRadius:12,padding:16,margin:"16px 0 22px",background:"var(--bc-surface)"}}>
            <h3 style={{marginTop:0}}>Test email delivery</h3>
            <p className="bc-muted">Replies to customer notifications use the merchant email saved in Settings. The sending address must be a verified address/domain; BYNDCART will not spoof an unverified merchant address. Shopify's own order-confirmation email remains sent by Shopify.</p>
            <fetcher.Form method="post" style={{display:"flex",alignItems:"end",gap:10,flexWrap:"wrap"}}>
              <input type="hidden" name="actionType" value="sendTestEmail" />
              <label style={{flex:"1 1 280px",margin:0}}>Send test to
                <input type="email" name="testEmail" autoComplete="email" placeholder="you@example.com" required />
              </label>
              <button type="submit" className="bc-btn primary" disabled={isSubmitting || !emailProviderConfigured}>
                {isSubmitting && (fetcher.formData?.get("actionType") === "sendTestEmail") ? "Sending test…" : "Send test email"}
              </button>
            </fetcher.Form>
          </section>

          <div style={{ display: "grid", gridTemplateColumns: "250px 1fr", gap: "20px", marginTop: "12px" }}>
            {/* Event Selector List */}
            <div>
              <p className="bc-kicker">Events</p>
              <div className="bc-event-list">
                {emailTemplates.map((tpl) => (
                  <button
                    key={tpl.eventType}
                    type="button"
                    aria-current={selectedEmailEvent === tpl.eventType}
                    onClick={() => setSelectedEmailEvent(tpl.eventType)}
                  >
                    <span>{tpl.label}</span>
                    <span className={tpl.enabled ? "bc-badge ok" : "bc-badge"}>{tpl.enabled ? "On" : "Off"}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Event Template Form */}
            <div>
              {currentEmailTemplate && (
                <fetcher.Form method="post" className="bc-form" style={{ border: 0, boxShadow: "none", padding: 0 }}>
                  <input type="hidden" name="actionType" value="saveTemplate" />
                  <input type="hidden" name="channel" value="EMAIL" />
                  <input type="hidden" name="eventType" value={currentEmailTemplate.eventType} />

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h3>{currentEmailTemplate.label}</h3>
                    <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        name="enabled"
                        value="true"
                        checked={emailFormState.enabled}
                        onChange={(e) => setEmailFormState({ ...emailFormState, enabled: e.target.checked })}
                      />
                      <strong>Notification Enabled</strong>
                    </label>
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "13px", fontWeight: "bold", marginBottom: "4px" }}>
                      Subject Line Template
                    </label>
                    <input
                      type="text"
                      name="subject"
                      value={emailFormState.subject}
                      onChange={(e) => setEmailFormState({ ...emailFormState, subject: e.target.value })}
                      style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                      required
                    />
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "13px", fontWeight: "bold", marginBottom: "4px" }}>
                      Email Body HTML Template
                    </label>
                    <textarea
                      name="body"
                      rows={8}
                      value={emailFormState.body}
                      onChange={(e) => setEmailFormState({ ...emailFormState, body: e.target.value })}
                      style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #cbd5e1", fontFamily: "monospace", fontSize: "12px" }}
                      required
                    />
                  </div>

                  <div style={{ background: "#f8fafc", padding: "10px 14px", borderRadius: "6px", fontSize: "12px", color: "#64748b" }}>
                    <strong>Available Variable Substitution Tags:</strong><br />
                    <code>{"{{customer_name}}"}</code>, <code>{"{{order_number}}"}</code>, <code>{"{{tracking_number}}"}</code>, <code>{"{{carrier}}"}</code>, <code>{"{{refund_amount}}"}</code>, <code>{"{{replacement_order}}"}</code>, <code>{"{{reason}}"}</code>
                  </div>

                  <button type="submit" className="bc-btn primary" disabled={isSubmitting}>
                    {isSubmitting ? "Saving..." : "Save template"}
                  </button>
                </fetcher.Form>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ============================================================== */}
      {/* RECENT SENDS LOG (FOR BOTH EMAIL & WHATSAPP)                    */}
      {/* ============================================================== */}
      <section className="bc-card" style={{ marginTop: "24px" }}>
        <h2 className="bc-title">Recent notification logs</h2>
        <p className="bc-muted">Live audit history of sent, skipped, or failed WhatsApp and Email messages.</p>

        {logs.length === 0 ? (
          <p className="bc-muted">No messages have been sent yet.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", textAlign: "left" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #cbd5e1", color: "#475569" }}>
                  <th style={{ padding: "8px" }}>Event Type</th>
                  <th style={{ padding: "8px" }}>Channel</th>
                  <th style={{ padding: "8px" }}>Recipient</th>
                  <th style={{ padding: "8px" }}>Status</th>
                  <th style={{ padding: "8px" }}>Date</th>
                  <th style={{ padding: "8px" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} style={{ borderBottom: "1px solid #e2e8f0" }}>
                    <td style={{ padding: "8px", fontWeight: "bold" }}>{log.eventType}</td>
                    <td style={{ padding: "8px" }}>
                      <span className={log.channel === "WHATSAPP" ? "bc-badge ok" : "bc-badge"}>
                        {log.channel}
                      </span>
                    </td>
                    <td style={{ padding: "8px" }}>{log.recipient}</td>
                    <td style={{ padding: "8px" }}>
                      <span
                        style={{
                          padding: "2px 8px",
                          borderRadius: "10px",
                          fontSize: "11px",
                          fontWeight: "bold",
                          backgroundColor:
                            log.status === "SENT"
                              ? "#dcfce7"
                              : log.status === "SKIPPED"
                              ? "#f1f5f9"
                              : "#fee2e2",
                          color:
                            log.status === "SENT"
                              ? "#15803d"
                              : log.status === "SKIPPED"
                              ? "#64748b"
                              : "#b91c1c",
                        }}
                      >
                        {log.status}
                      </span>
                    </td>
                    <td style={{ padding: "8px" }}>{new Date(log.createdAt).toLocaleString()}</td>
                    <td style={{ padding: "8px" }}>
                      {log.status === "FAILED" && (
                        <fetcher.Form method="post">
                          <input type="hidden" name="actionType" value="retryLog" />
                          <input type="hidden" name="logId" value={log.id} />
                          <button type="submit" className="bc-btn" disabled={isSubmitting}>
                            Retry
                          </button>
                        </fetcher.Form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/** Keep route/runtime failures visible instead of leaving the embedded page blank. */
export function ErrorBoundary() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : "Unknown route error";
  console.error("[Notifications] Route rendering failed:", error);
  return (
    <div
      className="bc-page"
      role="alert"
      style={{
        maxWidth: 860,
        margin: "32px auto",
        padding: 24,
        background: "#fff",
        border: "1px solid #e1e3e5",
        borderRadius: 14,
      }}
    >
      <p className="bc-eyebrow">CUSTOMER MESSAGING & ALERTS</p>
      <h1>Notifications could not load</h1>
      <p>BYNDCART could not render this page. Reload it once. If the problem continues, share the server log entry with support.</p>
      <details>
        <summary>Technical details</summary>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{message}</pre>
      </details>
    </div>
  );
}
