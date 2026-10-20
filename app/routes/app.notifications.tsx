import React from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { getStoreByShop } from "../services/store.server";
import {
  getStoreNotificationTemplates,
  upsertNotificationTemplate,
  getNotificationLogs,
  processNotificationJob,
  NotificationEventType,
} from "../services/notifications.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await getStoreByShop(session.shop);
  if (!store) {
    throw new Response("Store not found", { status: 404 });
  }

  try {
    const [templates, logs] = await Promise.all([
      getStoreNotificationTemplates(store.id),
      getNotificationLogs(store.id, 20),
    ]);
    return {
      storeId: store.id,
      templates,
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
      templates: [],
      logs: [],
      loadError: "Notification settings could not be loaded. Check that the latest database migrations have run. Details: " + (error instanceof Error ? error.message : String(error)),
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

  if (actionType === "saveTemplate") {
    const eventType = formData.get("eventType") as NotificationEventType;
    const enabled = formData.get("enabled") === "true";
    const subject = formData.get("subject") as string;
    const body = formData.get("body") as string;

    try {
      await upsertNotificationTemplate(store.id, eventType, "EMAIL", enabled, subject, body);
      return { success: true, message: `Updated template for ${eventType}` };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

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
      return { success: result.success, message: result.success ? "Notification retried successfully" : result.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  return { success: false, error: "Invalid action" };
};

export default function Notifications() {
  const { templates, logs, loadError } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  const isSubmitting = fetcher.state !== "idle";
  const actionData = fetcher.data as { success?: boolean; message?: string; error?: string } | undefined;

  const [selectedEvent, setSelectedEvent] = React.useState<string>(templates[0]?.eventType || "RETURN_SUBMITTED");
  const currentTemplate = templates.find((t) => t.eventType === selectedEvent) || templates[0];

  const [formState, setFormState] = React.useState({
    enabled: currentTemplate?.enabled ?? true,
    subject: currentTemplate?.subject ?? "",
    body: currentTemplate?.body ?? "",
  });

  React.useEffect(() => {
    if (currentTemplate) {
      setFormState({
        enabled: currentTemplate.enabled,
        subject: currentTemplate.subject,
        body: currentTemplate.body,
      });
    }
  }, [selectedEvent, currentTemplate]);

  return (
    <div className="bc-page">
      <header className="bc-header">
        <div className="bc-header-copy">
          <p className="bc-eyebrow">MESSAGES</p>
          <h1>Notifications</h1>
          <p>Edit the emails sent to shoppers during a return or exchange, and review what was sent.</p>
        </div>
      </header>
        {loadError && <div role="alert" className="bc-note bad">{loadError}</div>}
        {actionData?.error && <div className="bc-note bad">{actionData.error}</div>}
        {actionData?.message && <div className="bc-note ok">{actionData.message}</div>}

        <section className="bc-card">
            <h2 className="bc-title">Email templates</h2>
            <p className="bc-muted">Choose an event, then edit the subject and body for that message.</p>

            <div style={{ display: "grid", gridTemplateColumns: "250px 1fr", gap: "20px", marginTop: "12px" }}>
              
              {/* Event Selector List */}
              <div>
                <p className="bc-kicker">Events</p>
                <div className="bc-event-list">
                  {templates.map((tpl) => (
                    <button
                      key={tpl.eventType}
                      type="button"
                      aria-current={selectedEvent === tpl.eventType}
                      onClick={() => setSelectedEvent(tpl.eventType)}
                    >
                      <span>{tpl.label}</span>
                      <span className={tpl.enabled ? "bc-badge ok" : "bc-badge"}>{tpl.enabled ? "On" : "Off"}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Event Template Form */}
              <div>
                {currentTemplate && (
                  <fetcher.Form method="post" className="bc-form" style={{ border: 0, boxShadow: "none", padding: 0 }}>
                    <input type="hidden" name="actionType" value="saveTemplate" />
                    <input type="hidden" name="eventType" value={currentTemplate.eventType} />

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <h3>{currentTemplate.label}</h3>
                      <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          name="enabled"
                          value="true"
                          checked={formState.enabled}
                          onChange={(e) => setFormState({ ...formState, enabled: e.target.checked })}
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
                        value={formState.subject}
                        onChange={(e) => setFormState({ ...formState, subject: e.target.value })}
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
                        value={formState.body}
                        onChange={(e) => setFormState({ ...formState, body: e.target.value })}
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

        <section className="bc-card">
            <h2 className="bc-title">Recent sends</h2>

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
                        <td style={{ padding: "8px" }}>{log.channel}</td>
                        <td style={{ padding: "8px" }}>{log.recipient}</td>
                        <td style={{ padding: "8px" }}>
                          <span
                            style={{
                              padding: "2px 8px",
                              borderRadius: "10px",
                              fontSize: "11px",
                              fontWeight: "bold",
                              backgroundColor: log.status === "SENT" ? "#dcfce7" : log.status === "SKIPPED" ? "#f1f5f9" : "#fee2e2",
                              color: log.status === "SENT" ? "#15803d" : log.status === "SKIPPED" ? "#64748b" : "#b91c1c",
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
                              <button type="submit" className="bc-btn" disabled={isSubmitting}>Retry</button>
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
    <div className="bc-page" role="alert" style={{ maxWidth: 860, margin: "32px auto", padding: 24, background: "#fff", border: "1px solid #e1e3e5", borderRadius: 14 }}>
      <p className="bc-eyebrow">MESSAGES</p>
      <h1>Notifications could not load</h1>
      <p>BYNDCART could not render this page. Reload it once. If the problem continues, share the server log entry with support.</p>
      <details><summary>Technical details</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{message}</pre></details>
    </div>
  );
}
