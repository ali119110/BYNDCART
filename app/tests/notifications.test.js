process.env.SHOPIFY_API_KEY = "mock_api_key";
process.env.SHOPIFY_API_SECRET = "mock_api_secret";
process.env.SHOPIFY_APP_URL = "https://byndcart-mock.app";
process.env.SCOPES = "read_orders,write_returns";
process.env.DATABASE_URL = "postgresql://mock:mock@localhost:5432/mock";
process.env.NODE_ENV = "test";
import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db.server";
import {
  triggerLifecycleNotification,
  renderTemplate,
  sanitizeLogBody,
  upsertNotificationTemplate,
  getStoreNotificationTemplates,
} from "../services/notifications.server";
import {
  formatPhoneForMeta,
  seedDefaultWhatsAppTemplates,
  MetaWhatsAppCloudAdapter,
  getMetaUtilityTemplateName,
} from "../services/whatsapp.server";
import { transitionReturnStatus } from "../services/stateMachine.server";
// In-Memory Mock Database Storage
let mockTemplates = [];
let mockLogs = [];
let mockJobs = [];
let mockReturns = [];
let mockAuditLogs = [];

prisma.notificationTemplate = {
  findMany: async (args) => {
    const storeId = args?.where?.shopifyStoreId;

    return mockTemplates.filter((t) => t.shopifyStoreId === storeId);
  },
  findUnique: async (args) => {
    if (args.where.shopifyStoreId_eventType_channel) {
      const { shopifyStoreId, eventType, channel } =
        args.where.shopifyStoreId_eventType_channel;

      return (
        mockTemplates.find(
          (t) =>
            t.shopifyStoreId === shopifyStoreId &&
            t.eventType === eventType &&
            t.channel === channel,
        ) || null
      );
    }

    return null;
  },
  upsert: async (args) => {
    const { shopifyStoreId, eventType, channel } =
      args.where.shopifyStoreId_eventType_channel;
    const idx = mockTemplates.findIndex(
      (t) =>
        t.shopifyStoreId === shopifyStoreId &&
        t.eventType === eventType &&
        t.channel === channel,
    );

    if (idx >= 0) {
      mockTemplates[idx] = {
        ...mockTemplates[idx],
        ...args.update,
        updatedAt: new Date(),
      };

      return mockTemplates[idx];
    } else {
      const tpl = {
        id: `tpl-${Date.now()}-${Math.random()}`,
        shopifyStoreId,
        ...args.create,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockTemplates.push(tpl);

      return tpl;
    }
  },
};
prisma.notificationLog = {
  findMany: async (args) => {
    const storeId = args?.where?.shopifyStoreId;

    return mockLogs.filter((l) => l.shopifyStoreId === storeId);
  },
  findUnique: async (args) => {
    if (args.where.idempotencyKey) {
      return (
        mockLogs.find((l) => l.idempotencyKey === args.where.idempotencyKey) ||
        null
      );
    }

    if (args.where.id) {
      return mockLogs.find((l) => l.id === args.where.id) || null;
    }

    return null;
  },
  create: async (args) => {
    const log = {
      id: `log-${Date.now()}-${Math.random()}`,
      ...args.data,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockLogs.push(log);

    return log;
  },
  update: async (args) => {
    const idx = mockLogs.findIndex((l) => l.id === args.where.id);

    if (idx >= 0) {
      mockLogs[idx] = { ...mockLogs[idx], ...args.data, updatedAt: new Date() };

      return mockLogs[idx];
    }

    throw new Error("Log not found");
  },
  upsert: async (args) => {
    const key = args.where.idempotencyKey;
    const idx = mockLogs.findIndex((l) => l.idempotencyKey === key);

    if (idx >= 0) {
      mockLogs[idx] = {
        ...mockLogs[idx],
        ...args.update,
        updatedAt: new Date(),
      };

      return mockLogs[idx];
    } else {
      const log = {
        id: `log-${Date.now()}-${Math.random()}`,
        ...args.create,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockLogs.push(log);

      return log;
    }
  },
};
prisma.backgroundJob = {
  create: async (args) => {
    const job = {
      id: `job-${Date.now()}-${Math.random()}`,
      ...args.data,
      status: "PENDING",
      createdAt: new Date(),
    };

    mockJobs.push(job);

    return job;
  },
};
prisma.returnRequest = {
  findFirst: async (args) => {
    return mockReturns.find((r) => r.id === args.where.id) || null;
  },
  update: async (args) => {
    const idx = mockReturns.findIndex((r) => r.id === args.where.id);

    if (idx >= 0) {
      mockReturns[idx] = {
        ...mockReturns[idx],
        ...args.data,
        updatedAt: new Date(),
      };

      return mockReturns[idx];
    }

    throw new Error("Return not found");
  },
};
prisma.returnItem = {
  updateMany: async () => ({ count: 1 }),
};
prisma.auditLog = {
  create: async (args) => {
    const log = {
      id: `log-${Date.now()}`,
      ...args.data,
      createdAt: new Date(),
    };

    mockAuditLogs.push(log);

    return log;
  },
};
prisma.$transaction = async (cb) => cb(prisma);
test("Notifications Engine — Template Variable Rendering & Secret Sanitization", async () => {
  const rendered = renderTemplate(
    "Hello {{customer_name}}, order {{order_number}} total PKR {{refund_amount}}.",
    {
      customer_name: "Fatima Noor",
      order_number: "#1099",
      refund_amount: 4500,
    },
  );

  assert.equal(rendered, "Hello Fatima Noor, order #1099 total PKR 4500.");
  const bracketRendered = renderTemplate(
    "Dear [customer_name] - [customer_phone], order [order_number].[line][line]*Tracking:* [tracking_number]",
    {
      customer_name: "Fatima Noor",
      customer_phone: "03001234567",
      order_number: "#1099",
      tracking_number: "PE123456",
    },
  );

  assert.equal(
    bracketRendered,
    "Dear Fatima Noor - 03001234567, order #1099.\n\n*Tracking:* PE123456",
  );
  const sanitized = sanitizeLogBody(
    "Your api_key: secret_123456 pass password=my_secret_pass",
  );

  assert.equal(sanitized.includes("secret_123456"), false);
  assert.equal(sanitized.includes("••••••••"), true);
});
test("Notifications Engine — Successful Delivery via Resend / Email & WhatsApp", async () => {
  const storeId = "store-notif-1";
  // Test EMAIL delivery
  const emailTrigger = await triggerLifecycleNotification({
    shopifyStoreId: storeId,
    eventType: "RETURN_SUBMITTED",
    entityId: "ret-100",
    recipientEmail: "shopper@example.pk",
    channel: "EMAIL",
    variables: {
      customer_name: "Ali Khan",
      order_number: "#1001",
    },
  });

  assert.equal(emailTrigger.status, "QUEUED");
  assert.ok(emailTrigger.logId);
  const log = mockLogs.find((l) => l.id === emailTrigger.logId);

  assert.ok(log);
  // Skipped/Sent depending on RESEND_API_KEY; in mock test env without key it marks FAILED or SENT cleanly
  assert.ok(log.status === "SENT" || log.status === "FAILED");
  // Test WHATSAPP delivery via MockWhatsAppAdapter
  const waTrigger = await triggerLifecycleNotification({
    shopifyStoreId: storeId,
    eventType: "COURIER_PICKUP_BOOKED",
    entityId: "ret-100",
    recipientEmail: "shopper@example.pk",
    recipientPhone: "+923001234567",
    channel: "WHATSAPP",
    variables: {
      customer_name: "Ali Khan",
      order_number: "#1001",
      tracking_number: "TCS-998877",
      carrier: "TCS Express",
    },
  });

  assert.equal(waTrigger.status, "QUEUED");
  const waLog = mockLogs.find((l) => l.id === waTrigger.logId);

  assert.equal(waLog?.status, "SENT");
});
test("Notifications Engine — Disabled Notification Event Handling", async () => {
  const storeId = "store-notif-disabled";

  // Disable RETURN_REJECTED template
  await upsertNotificationTemplate(
    storeId,
    "RETURN_REJECTED",
    "EMAIL",
    false,
    "Return Rejected {{order_number}}",
    "Body",
  );
  const trigger = await triggerLifecycleNotification({
    shopifyStoreId: storeId,
    eventType: "RETURN_REJECTED",
    entityId: "ret-disabled-1",
    recipientEmail: "disabled@example.pk",
    variables: {
      customer_name: "Test User",
      order_number: "#9999",
      reason: "Item worn",
    },
  });
  const log = mockLogs.find((l) => l.id === trigger.logId);

  assert.equal(log?.status, "SKIPPED");
  assert.equal(log?.error, "Disabled by merchant settings");
});
test("Notifications Engine — Duplicate Event Idempotency", async () => {
  const storeId = "store-notif-idempotent";
  const trigger1 = await triggerLifecycleNotification({
    shopifyStoreId: storeId,
    eventType: "REFUND_INITIATED",
    entityId: "ret-idem-1",
    recipientEmail: "idem@example.pk",
    recipientPhone: "+923001112233",
    channel: "WHATSAPP",
    variables: { customer_name: "Idem User", order_number: "#5001" },
  });
  // Re-trigger identical event
  const trigger2 = await triggerLifecycleNotification({
    shopifyStoreId: storeId,
    eventType: "REFUND_INITIATED",
    entityId: "ret-idem-1",
    recipientEmail: "idem@example.pk",
    recipientPhone: "+923001112233",
    channel: "WHATSAPP",
    variables: { customer_name: "Idem User", order_number: "#5001" },
  });

  assert.equal(trigger2.status, "IDEMPOTENT_SKIP");
  assert.equal(trigger1.logId, trigger2.logId);
});
test("Notifications Engine — Invalid Recipient Handling", async () => {
  const storeId = "store-notif-invalid";
  const trigger = await triggerLifecycleNotification({
    shopifyStoreId: storeId,
    eventType: "RETURN_APPROVED",
    entityId: "ret-invalid-recip",
    recipientEmail: "",
    variables: { customer_name: "No Email User", order_number: "#0000" },
  });
  const log = mockLogs.find((l) => l.id === trigger.logId);

  assert.equal(log?.status, "FAILED");
  assert.equal(log?.error, "Invalid or empty recipient address");
});
test("Notifications Engine — Cross-Merchant Tenant Isolation", async () => {
  const storeA = "store-tenant-alpha";
  const storeB = "store-tenant-beta";

  await upsertNotificationTemplate(
    storeA,
    "RETURN_APPROVED",
    "EMAIL",
    true,
    "Alpha Subject",
    "Alpha Body",
  );
  await upsertNotificationTemplate(
    storeB,
    "RETURN_APPROVED",
    "EMAIL",
    true,
    "Beta Subject",
    "Beta Body",
  );
  const templatesA = await getStoreNotificationTemplates(storeA);
  const templatesB = await getStoreNotificationTemplates(storeB);
  const tplA = templatesA.find((t) => t.eventType === "RETURN_APPROVED");
  const tplB = templatesB.find((t) => t.eventType === "RETURN_APPROVED");

  assert.equal(tplA?.subject, "Alpha Subject");
  assert.equal(tplB?.subject, "Beta Subject");
});
test("Notifications Engine — Notification Failure Does Not Block State Machine", async () => {
  const storeId = "store-notif-nonblocking";

  mockReturns.push({
    id: "ret-state-fail-1",
    shopifyStoreId: storeId,
    orderNumber: "#7777",
    customerEmail: "failing-notify@example.pk",
    status: "PENDING",
  });
  // Execute state transition — notification engine handles failures non-blockingly
  const updated = await transitionReturnStatus({
    id: "ret-state-fail-1",
    shopifyStoreId: storeId,
    targetStatus: "APPROVED",
  });

  assert.equal(updated.status, "APPROVED");
});
test("WhatsApp Engine — Phone Number Formatting for Meta Cloud API", () => {
  // Local Pakistani mobile with leading 0
  assert.equal(formatPhoneForMeta("03001234567"), "923001234567");
  assert.equal(formatPhoneForMeta("0321-9876543"), "923219876543");
  // International format with +92 or 0092
  assert.equal(formatPhoneForMeta("+923001234567"), "923001234567");
  assert.equal(formatPhoneForMeta("00923001234567"), "923001234567");
  // 10-digit format starting with 3
  assert.equal(formatPhoneForMeta("3001234567"), "923001234567");
});
test("WhatsApp Engine — Production dispatch uses a dedicated Meta template, never arbitrary text", async () => {
  const originalFetch = globalThis.fetch;
  let payload = null;
  const urls = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);

    urls.push(url);
    payload = init?.body ? JSON.parse(String(init.body)) : null;

    return new Response(
      JSON.stringify({ messages: [{ id: "wamid.test-123" }] }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const adapter = new MetaWhatsAppCloudAdapter(
      "phone-number-123",
      "merchant-access-token",
    );
    const sent = await adapter.sendWhatsAppMessage({
      to: "03001234567",
      message:
        "This free-form body should not be sent outside the WhatsApp service window.",
      eventType: "RETURN_SUBMITTED",
      templateVariables: { customer_name: "Ali Khan", order_number: "#1001" },
      shopifyStoreId: "store-1",
    });

    assert.strictEqual(sent.success, true);
    assert.strictEqual(sent.messageId, "wamid.test-123");
    assert.strictEqual(payload.type, "template");
    assert.strictEqual(payload.template.name, "byndcart_return_submitted");
    assert.strictEqual(payload.template.language.code, "en_US");
    assert.deepStrictEqual(
      payload.template.components[0].parameters.map((item) => item.text),
      ["Ali Khan", "#1001"],
    );
    assert.ok(urls[0].endsWith("/phone-number-123/messages"));
    assert.strictEqual(getMetaUtilityTemplateName("UNKNOWN_EVENT"), undefined);
    const before = urls.length;
    const unsupported = await adapter.sendWhatsAppMessage({
      to: "03001234567",
      message: "No approved template name",
      shopifyStoreId: "store-1",
    });

    assert.strictEqual(unsupported.success, false);
    assert.match(unsupported.error || "", /template/i);
    assert.strictEqual(
      urls.length,
      before,
      "Unsupported events must not reach Meta as free-form production messages.",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("WhatsApp Engine — Auto-seed default templates and query WhatsApp channel", async () => {
  const storeId = "store-whatsapp-seed-test";
  const seedResult = await seedDefaultWhatsAppTemplates(storeId);

  assert.equal(seedResult.success, true);
  assert.equal(seedResult.count, 10);
  // Retrieve WhatsApp templates for this store
  const waTemplates = await getStoreNotificationTemplates(storeId, "WHATSAPP");

  assert.equal(waTemplates.length, 10);
  assert.ok(waTemplates.some((t) => t.eventType === "COURIER_PICKUP_BOOKED"));
  assert.ok(waTemplates.some((t) => t.eventType === "RETURN_APPROVED"));
  assert.ok(waTemplates.some((t) => t.eventType === "REFUND_INITIATED"));
});
test("WhatsApp Engine — Meta Cloud Adapter rejects empty credentials cleanly", async () => {
  const adapterWithoutCreds = new MetaWhatsAppCloudAdapter("", "");
  const result = await adapterWithoutCreds.sendWhatsAppMessage({
    to: "03001234567",
    message: "Test message",
  });

  assert.equal(result.success, false);
  assert.ok(result.error?.includes("missing"));
});
