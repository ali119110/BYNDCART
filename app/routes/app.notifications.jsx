import React from "react";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { getStoreByShop } from "../services/store.server";
import {
  getStoreNotificationTemplates,
  upsertNotificationTemplate,
  getNotificationLogs,
  processNotificationJob,
} from "../services/notifications.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await getStoreByShop(session.shop);

  if (!store) {
    throw new Response("Store not found", { status: 404 });
  }

  const templates = await getStoreNotificationTemplates(store.id);
  const logs = await getNotificationLogs(store.id, 20);

  return {
    storeId: store.id,
    templates,
    logs: logs.map((l) => ({
      ...l,
      createdAt: l.createdAt.toISOString(),
      sentAt: l.sentAt ? l.sentAt.toISOString() : null,
    })),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await getStoreByShop(session.shop);

  if (!store) {
    return { success: false, error: "Store not found" };
  }

  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "saveTemplate") {
    const eventType = formData.get("eventType");
    const enabled = formData.get("enabled") === "true";
    const subject = formData.get("subject");
    const body = formData.get("body");

    try {
      await upsertNotificationTemplate(
        store.id,
        eventType,
        "EMAIL",
        enabled,
        subject,
        body,
      );

      return { success: true, message: `Updated template for ${eventType}` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (actionType === "retryLog") {
    const logId = formData.get("logId");
    const log = await prisma.notificationLog.findUnique({
      where: { id: logId },
    });

    if (!log) {
      return { success: false, error: "Notification log not found" };
    }

    try {
      const result = await processNotificationJob({
        notificationLogId: log.id,
        shopifyStoreId: store.id,
        eventType: log.eventType,
        channel: log.channel,
        recipient: log.recipient,
        variables: { order_number: "#RETRY" },
      });

      return {
        success: result.success,
        message: result.success
          ? "Notification retried successfully"
          : result.error,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  return { success: false, error: "Invalid action" };
};

export default function Notifications() {
  const { templates, logs } = useLoaderData();
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state !== "idle";
  const actionData = fetcher.data;
  const [selectedEvent, setSelectedEvent] = React.useState(
    templates[0]?.eventType || "RETURN_SUBMITTED",
  );
  const currentTemplate =
    templates.find((t) => t.eventType === selectedEvent) || templates[0];
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
    <s-page heading="BYNDCART Lifecycle Notifications Engine">
      <s-stack direction="block" gap="large">
        {/* Status Messages */}
        {actionData?.error && (
          <div
            style={{
              padding: "12px 16px",
              backgroundColor: "#fef2f2",
              border: "1px solid #fca5a5",
              borderRadius: "8px",
              color: "#991b1b",
            }}
          >
            <strong>Error:</strong> {actionData.error}
          </div>
        )}
        {actionData?.message && (
          <div
            style={{
              padding: "12px 16px",
              backgroundColor: "#f0fdf4",
              border: "1px solid #86efac",
              borderRadius: "8px",
              color: "#166534",
            }}
          >
            <strong>Success:</strong> {actionData.message}
          </div>
        )}

        {/* Template Configurator */}
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <s-stack direction="block" gap="base">
            <s-heading>Lifecycle Events & Email Templates Editor</s-heading>
            <s-paragraph tone="neutral">
              Customize transactional notification messages sent automatically
              to customer shoppers throughout the return & exchange lifecycle.
            </s-paragraph>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "250px 1fr",
                gap: "20px",
                marginTop: "12px",
              }}
            >
              {/* Event Selector List */}
              <div
                style={{
                  borderRight: "1px solid #cbd5e1",
                  paddingRight: "12px",
                }}
              >
                <strong style={{ fontSize: "13px", color: "#475569" }}>
                  LIFECYCLE EVENTS (12)
                </strong>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                    marginTop: "8px",
                  }}
                >
                  {templates.map((tpl) => (
                    <button
                      key={tpl.eventType}
                      type="button"
                      onClick={() => setSelectedEvent(tpl.eventType)}
                      style={{
                        textAlign: "left",
                        padding: "8px 12px",
                        borderRadius: "6px",
                        border: "none",
                        backgroundColor:
                          selectedEvent === tpl.eventType
                            ? "#3b82f6"
                            : "transparent",
                        color:
                          selectedEvent === tpl.eventType
                            ? "#ffffff"
                            : "#334155",
                        fontWeight:
                          selectedEvent === tpl.eventType ? "bold" : "normal",
                        cursor: "pointer",
                        fontSize: "13px",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <span>{tpl.label}</span>
                      <span
                        style={{
                          fontSize: "10px",
                          padding: "1px 6px",
                          borderRadius: "8px",
                          backgroundColor: tpl.enabled ? "#16a34a" : "#94a3b8",
                          color: "#fff",
                        }}
                      >
                        {tpl.enabled ? "ON" : "OFF"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Event Template Form */}
              <div>
                {currentTemplate && (
                  <fetcher.Form
                    method="post"
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "16px",
                    }}
                  >
                    <input
                      type="hidden"
                      name="actionType"
                      value="saveTemplate"
                    />
                    <input
                      type="hidden"
                      name="eventType"
                      value={currentTemplate.eventType}
                    />

                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <h3>{currentTemplate.label}</h3>
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          cursor: "pointer",
                        }}
                      >
                        <input
                          type="checkbox"
                          name="enabled"
                          value="true"
                          checked={formState.enabled}
                          onChange={(e) =>
                            setFormState({
                              ...formState,
                              enabled: e.target.checked,
                            })
                          }
                        />
                        <strong>Notification Enabled</strong>
                      </label>
                    </div>

                    <div>
                      <label
                        style={{
                          display: "block",
                          fontSize: "13px",
                          fontWeight: "bold",
                          marginBottom: "4px",
                        }}
                      >
                        Subject Line Template
                      </label>
                      <input
                        type="text"
                        name="subject"
                        value={formState.subject}
                        onChange={(e) =>
                          setFormState({
                            ...formState,
                            subject: e.target.value,
                          })
                        }
                        style={{
                          width: "100%",
                          padding: "8px 12px",
                          borderRadius: "6px",
                          border: "1px solid #cbd5e1",
                        }}
                        required
                      />
                    </div>

                    <div>
                      <label
                        style={{
                          display: "block",
                          fontSize: "13px",
                          fontWeight: "bold",
                          marginBottom: "4px",
                        }}
                      >
                        Email Body HTML Template
                      </label>
                      <textarea
                        name="body"
                        rows={8}
                        value={formState.body}
                        onChange={(e) =>
                          setFormState({ ...formState, body: e.target.value })
                        }
                        style={{
                          width: "100%",
                          padding: "8px 12px",
                          borderRadius: "6px",
                          border: "1px solid #cbd5e1",
                          fontFamily: "monospace",
                          fontSize: "12px",
                        }}
                        required
                      />
                    </div>

                    <div
                      style={{
                        background: "#f8fafc",
                        padding: "10px 14px",
                        borderRadius: "6px",
                        fontSize: "12px",
                        color: "#64748b",
                      }}
                    >
                      <strong>Available Variable Substitution Tags:</strong>
                      <br />
                      <code>{"{{customer_name}}"}</code>,{" "}
                      <code>{"{{order_number}}"}</code>,{" "}
                      <code>{"{{tracking_number}}"}</code>,{" "}
                      <code>{"{{carrier}}"}</code>,{" "}
                      <code>{"{{refund_amount}}"}</code>,{" "}
                      <code>{"{{replacement_order}}"}</code>,{" "}
                      <code>{"{{reason}}"}</code>
                    </div>

                    <s-button
                      type="submit"
                      variant="primary"
                      loading={isSubmitting}
                    >
                      Save Template
                    </s-button>
                  </fetcher.Form>
                )}
              </div>
            </div>
          </s-stack>
        </s-box>

        {/* Notification Logs Table */}
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <s-stack direction="block" gap="base">
            <s-heading>Recent Notification Logs (Audit Trail)</s-heading>

            {logs.length === 0 ? (
              <p style={{ color: "#64748b" }}>
                No notification dispatches recorded yet.
              </p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: "13px",
                    textAlign: "left",
                  }}
                >
                  <thead>
                    <tr
                      style={{
                        borderBottom: "2px solid #cbd5e1",
                        color: "#475569",
                      }}
                    >
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
                      <tr
                        key={log.id}
                        style={{ borderBottom: "1px solid #e2e8f0" }}
                      >
                        <td style={{ padding: "8px", fontWeight: "bold" }}>
                          {log.eventType}
                        </td>
                        <td style={{ padding: "8px" }}>{log.channel}</td>
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
                        <td style={{ padding: "8px" }}>
                          {new Date(log.createdAt).toLocaleString()}
                        </td>
                        <td style={{ padding: "8px" }}>
                          {log.status === "FAILED" && (
                            <fetcher.Form method="post">
                              <input
                                type="hidden"
                                name="actionType"
                                value="retryLog"
                              />
                              <input
                                type="hidden"
                                name="logId"
                                value={log.id}
                              />
                              <s-button
                                type="submit"
                                variant="secondary"
                                loading={isSubmitting}
                              >
                                Retry
                              </s-button>
                            </fetcher.Form>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </s-stack>
        </s-box>
      </s-stack>
    </s-page>
  );
}
