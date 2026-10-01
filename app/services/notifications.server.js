import prisma from "../db.server";
import { getSettings } from "./settings.server";
import { enqueueJob } from "./jobs.server";
import { WhatsAppRegistry } from "./whatsapp.server";

const RESEND_API_URL = "https://api.resend.com/emails";
const FROM_ADDRESS =
  process.env.NOTIFICATIONS_FROM_EMAIL ||
  "BYNDCART <notifications@byndcart.app>";

/**
 * Low-level email dispatch via Resend. Never throws.
 */
export async function sendEmail(input) {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.warn(
      "[Notifications] RESEND_API_KEY not set — skipping email send.",
    );

    return { success: false, error: "RESEND_API_KEY not configured" };
  }

  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: input.to,
        subject: input.subject,
        html: input.html,
      }),
    });

    if (!response.ok) {
      const body = await response.text();

      console.error(
        `[Notifications] Resend API error ${response.status}: ${body}`,
      );

      return { success: false, error: `Resend API error ${response.status}` };
    }

    const data = await response.json();

    return { success: true, messageId: data.id };
  } catch (error) {
    console.error("[Notifications] Failed to send email:", error);

    return { success: false, error: String(error) };
  }
}

export const DEFAULT_TEMPLATES = {
  RETURN_SUBMITTED: {
    eventType: "RETURN_SUBMITTED",
    label: "Return Request Submitted",
    subject: "Return Request Received for Order {{order_number}}",
    body: "<p>Dear {{customer_name}},</p><p>We have received your return request for order <strong>{{order_number}}</strong>. Our team is currently reviewing your request.</p><p>Thank you for shopping with us!</p>",
  },
  RETURN_APPROVED: {
    eventType: "RETURN_APPROVED",
    label: "Return Approved",
    subject: "Return Request Approved — Order {{order_number}}",
    body: "<p>Dear {{customer_name}},</p><p>Great news! Your return request for order <strong>{{order_number}}</strong> has been approved. A courier pickup will be dispatched shortly.</p>",
  },
  RETURN_REJECTED: {
    eventType: "RETURN_REJECTED",
    label: "Return Request Rejected",
    subject: "Return Request Status for Order {{order_number}}",
    body: "<p>Dear {{customer_name}},</p><p>Regrettably, your return request for order <strong>{{order_number}}</strong> could not be approved at this time. Reason: {{reason}}.</p>",
  },
  COURIER_PICKUP_BOOKED: {
    eventType: "COURIER_PICKUP_BOOKED",
    label: "Courier Pickup Booked",
    subject: "Courier Pickup Scheduled for Order {{order_number}}",
    body: "<p>Dear {{customer_name}},</p><p>Pickup for order <strong>{{order_number}}</strong> has been booked with <strong>{{carrier}}</strong>. Tracking Number: <strong>{{tracking_number}}</strong>.</p>",
  },
  TRACKING_UPDATE: {
    eventType: "TRACKING_UPDATE",
    label: "Shipment Tracking Update",
    subject: "Shipment Update for Order {{order_number}}",
    body: "<p>Dear {{customer_name}},</p><p>Your shipment status for order <strong>{{order_number}}</strong> is now: <strong>{{status}}</strong>. Tracking: {{tracking_number}}.</p>",
  },
  RETURN_RECEIVED: {
    eventType: "RETURN_RECEIVED",
    label: "Return Package Received",
    subject: "Return Package Delivered to Warehouse — Order {{order_number}}",
    body: "<p>Dear {{customer_name}},</p><p>We have safely received your returned package at our processing warehouse for order <strong>{{order_number}}</strong>.</p>",
  },
  INSPECTION_COMPLETED: {
    eventType: "INSPECTION_COMPLETED",
    label: "Warehouse Inspection Completed",
    subject: "Item Inspection Completed for Order {{order_number}}",
    body: "<p>Dear {{customer_name}},</p><p>Quality inspection for order <strong>{{order_number}}</strong> has been completed. Condition: {{condition}}.</p>",
  },
  REFUND_INITIATED: {
    eventType: "REFUND_INITIATED",
    label: "Refund Initiated",
    subject: "Refund Processed for Order {{order_number}}",
    body: "<p>Dear {{customer_name}},</p><p>A refund of <strong>PKR {{refund_amount}}</strong> has been initiated for order <strong>{{order_number}}</strong> via Shopify.</p>",
  },
  EXCHANGE_APPROVED: {
    eventType: "EXCHANGE_APPROVED",
    label: "Exchange Request Approved",
    subject: "Exchange Approved for Order {{order_number}}",
    body: "<p>Dear {{customer_name}},</p><p>Your exchange request for order <strong>{{order_number}}</strong> has been approved. Your replacement order is being prepared.</p>",
  },
  REPLACEMENT_CREATED: {
    eventType: "REPLACEMENT_CREATED",
    label: "Replacement Order Created",
    subject:
      "Replacement Order {{replacement_order}} Created for Order {{order_number}}",
    body: "<p>Dear {{customer_name}},</p><p>Your replacement order <strong>{{replacement_order}}</strong> has been generated and queued for fulfillment.</p>",
  },
  REPLACEMENT_DELIVERED: {
    eventType: "REPLACEMENT_DELIVERED",
    label: "Replacement Delivered",
    subject: "Replacement Order {{replacement_order}} Delivered",
    body: "<p>Dear {{customer_name}},</p><p>Your replacement order <strong>{{replacement_order}}</strong> has been delivered. Enjoy your new item!</p>",
  },
  LIFECYCLE_COMPLETED: {
    eventType: "LIFECYCLE_COMPLETED",
    label: "Return / Exchange Completed",
    subject: "Return / Exchange Completed for Order {{order_number}}",
    body: "<p>Dear {{customer_name}},</p><p>The return/exchange process for order <strong>{{order_number}}</strong> has been successfully finalized. Thank you for choosing BYNDCART!</p>",
  },
};

/**
 * Replaces {{variables}} in template string safely.
 */
export function renderTemplate(template, variables) {
  let result = template;

  for (const [key, val] of Object.entries(variables)) {
    const valueStr = val !== undefined && val !== null ? String(val) : "";
    const reg = new RegExp(`{{\\s*${key}\\s*}}`, "g");

    result = result.replace(reg, valueStr);
  }

  return result;
}

/**
 * Sanitizes template/log body to mask any passwords, secrets, or OTPs.
 */
export function sanitizeLogBody(body) {
  if (!body) return "";

  // Mask OTP codes, API keys, or secret patterns if present
  return body
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s&"<']+/gi, "$1••••••••")
    .replace(/(secret\s*[:=]\s*)[^\s&"<']+/gi, "$1••••••••")
    .replace(/(password\s*[:=]\s*)[^\s&"<']+/gi, "$1••••••••");
}

/**
 * Centralized Notification Service entry point.
 * Idempotently enqueues a BackgroundJob for async delivery.
 * NEVER throws an error to avoid interrupting state transitions.
 */
export async function triggerLifecycleNotification(input) {
  const channel = input.channel || "EMAIL";
  const recipient =
    channel === "EMAIL"
      ? input.recipientEmail
      : input.recipientPhone || input.recipientEmail;
  const idempotencyKey = `notify:${input.shopifyStoreId}:${input.eventType}:${input.entityId}:${channel}`;

  try {
    // Check if notification already logged as SENT or SKIPPED
    const existingLog = await prisma.notificationLog.findUnique({
      where: { idempotencyKey },
    });

    if (
      existingLog &&
      (existingLog.status === "SENT" ||
        existingLog.status === "SKIPPED" ||
        existingLog.status === "PENDING")
    ) {
      console.log(
        `[Notifications] Idempotent skip for ${idempotencyKey} (Status: ${existingLog.status})`,
      );

      return { status: "IDEMPOTENT_SKIP", logId: existingLog.id };
    }

    // Create or find PENDING notification log
    const log = await prisma.notificationLog.upsert({
      where: { idempotencyKey },
      create: {
        shopifyStoreId: input.shopifyStoreId,
        eventType: input.eventType,
        channel,
        recipient,
        idempotencyKey,
        status: "PENDING",
      },
      update: {
        recipient,
        status: "PENDING",
        error: null,
      },
    });
    // Enqueue background job for delivery
    const job = await enqueueJob({
      shopifyStoreId: input.shopifyStoreId,
      type: "SEND_NOTIFICATION",
      payload: {
        notificationLogId: log.id,
        shopifyStoreId: input.shopifyStoreId,
        eventType: input.eventType,
        channel,
        recipient,
        variables: input.variables,
      },
    });

    // Run in-band execution immediately for immediate delivery
    await processNotificationJob({
      notificationLogId: log.id,
      shopifyStoreId: input.shopifyStoreId,
      eventType: input.eventType,
      channel,
      recipient,
      variables: input.variables,
    });

    return { status: "QUEUED", jobId: job.id, logId: log.id };
  } catch (err) {
    console.error(
      `[Notifications] Error triggering notification for ${input.eventType}:`,
      err,
    );

    return { status: "FAILED_TRIGGER", error: err.message };
  }
}

/**
 * Processes a notification background job.
 */
export async function processNotificationJob(payload) {
  const {
    notificationLogId,
    shopifyStoreId,
    eventType,
    channel,
    recipient,
    variables,
  } = payload;

  try {
    // Resolve template (DB custom or default fallback)
    const customTemplate = await prisma.notificationTemplate.findUnique({
      where: {
        shopifyStoreId_eventType_channel: {
          shopifyStoreId,
          eventType,
          channel,
        },
      },
    });
    const defaultConfig =
      DEFAULT_TEMPLATES[eventType] || DEFAULT_TEMPLATES.RETURN_SUBMITTED;
    const isEnabled = customTemplate ? customTemplate.enabled : true;
    const subjectTemplate = customTemplate
      ? customTemplate.subject
      : defaultConfig.subject;
    const bodyTemplate = customTemplate
      ? customTemplate.body
      : defaultConfig.body;

    // Check if notification event is disabled by merchant
    if (!isEnabled) {
      console.log(
        `[Notifications] Event ${eventType} is disabled for store ${shopifyStoreId}. Skipping.`,
      );
      await prisma.notificationLog.update({
        where: { id: notificationLogId },
        data: {
          status: "SKIPPED",
          error: "Disabled by merchant settings",
        },
      });

      return { success: true, status: "SKIPPED" };
    }

    if (!recipient || recipient.trim() === "") {
      await prisma.notificationLog.update({
        where: { id: notificationLogId },
        data: {
          status: "FAILED",
          error: "Invalid or empty recipient address",
        },
      });

      return { success: false, error: "Invalid recipient" };
    }

    const renderedSubject = renderTemplate(subjectTemplate, variables);
    const renderedBody = renderTemplate(bodyTemplate, variables);
    const sanitizedBody = sanitizeLogBody(renderedBody);
    let sendResult = { success: false };

    if (channel === "EMAIL") {
      sendResult = await sendEmail({
        to: recipient,
        subject: renderedSubject,
        html: renderedBody,
      });
    } else if (channel === "WHATSAPP") {
      const adapter = WhatsAppRegistry.getAdapter();

      sendResult = await adapter.sendWhatsAppMessage({
        to: recipient,
        message: renderedBody,
      });
    }

    if (sendResult.success) {
      await prisma.notificationLog.update({
        where: { id: notificationLogId },
        data: {
          status: "SENT",
          subject: renderedSubject,
          body: sanitizedBody,
          sentAt: new Date(),
          error: null,
        },
      });

      return { success: true, status: "SENT" };
    } else {
      await prisma.notificationLog.update({
        where: { id: notificationLogId },
        data: {
          status: "FAILED",
          subject: renderedSubject,
          body: sanitizedBody,
          error: sendResult.error || "Delivery failed",
        },
      });

      return { success: false, status: "FAILED", error: sendResult.error };
    }
  } catch (err) {
    console.error(
      `[Notifications] Exception during processNotificationJob:`,
      err,
    );

    try {
      await prisma.notificationLog.update({
        where: { id: notificationLogId },
        data: {
          status: "FAILED",
          error: err.message,
        },
      });
    } catch (_) {}

    return { success: false, error: err.message };
  }
}

/**
 * Merchant template management service handlers
 */
export async function getStoreNotificationTemplates(shopifyStoreId) {
  const dbTemplates = await prisma.notificationTemplate.findMany({
    where: { shopifyStoreId },
  });

  return Object.values(DEFAULT_TEMPLATES).map((def) => {
    const custom = dbTemplates.find(
      (t) => t.eventType === def.eventType && t.channel === "EMAIL",
    );

    return {
      eventType: def.eventType,
      label: def.label,
      channel: "EMAIL",
      enabled: custom ? custom.enabled : true,
      subject: custom ? custom.subject : def.subject,
      body: custom ? custom.body : def.body,
      isCustomized: Boolean(custom),
    };
  });
}

export async function upsertNotificationTemplate(
  shopifyStoreId,
  eventType,
  channel,
  enabled,
  subject,
  body,
) {
  return prisma.notificationTemplate.upsert({
    where: {
      shopifyStoreId_eventType_channel: {
        shopifyStoreId,
        eventType,
        channel,
      },
    },
    create: {
      shopifyStoreId,
      eventType,
      channel,
      enabled,
      subject,
      body,
    },
    update: {
      enabled,
      subject,
      body,
    },
  });
}

export async function getNotificationLogs(shopifyStoreId, limit = 20) {
  return prisma.notificationLog.findMany({
    where: { shopifyStoreId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/**
 * Backward compatibility helpers
 */
export async function notifyStatusChange(input) {
  let settings;

  try {
    settings = await getSettings(input.shopifyStoreId);
  } catch (error) {
    return { skipped: true, reason: "settings_load_failed" };
  }

  if (!settings?.emailNotificationsEnabled || !settings?.notificationEmail) {
    return { skipped: true, reason: "notifications_disabled" };
  }

  const subject = `${input.entity} ${input.orderNumber} — status changed to ${input.newStatus}`;
  const html = `<p>Status changed from <strong>${input.previousStatus}</strong> to <strong>${input.newStatus}</strong> for order ${input.orderNumber}</p>`;

  return sendEmail({ to: settings.notificationEmail, subject, html });
}

export async function sendCustomerOTPNotification(input) {
  const subject = `Your Verification Code for Order ${input.orderNumber}`;
  const html = `<p>Use code <strong>${input.otpCode}</strong> to log in for order ${input.orderNumber}.</p>`;

  return sendEmail({ to: input.destination, subject, html });
}
