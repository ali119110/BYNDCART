import prisma from "../db.server";
import { encryptCredential, decryptCredential, maskCredential } from "../utils/encryption.server";
import { normalizePakistaniMobile } from "./pakistanLogistics";

export interface SendWhatsAppInput {
  to: string;
  message: string;
  templateName?: string;
  templateVariables?: Record<string, string>;
  shopifyStoreId?: string;
}

export interface SendWhatsAppResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface IWhatsAppAdapter {
  providerName: string;
  sendWhatsAppMessage(input: SendWhatsAppInput): Promise<SendWhatsAppResult>;
}

/**
 * Standard Pakistani / International phone number formatter for Meta Cloud API.
 * Meta requires digits without '+' or leading zeros (e.g., 03001234567 -> 923001234567).
 */
export function formatPhoneForMeta(rawPhone: string): string {
  let cleaned = String(rawPhone || "").replace(/[^0-9]/g, "");
  if (cleaned.startsWith("00")) {
    cleaned = cleaned.slice(2);
  }
  if (cleaned.startsWith("03") && cleaned.length === 11) {
    // Standard Pakistani mobile 03XXXXXXXXX -> 923XXXXXXXXX
    cleaned = `92${cleaned.slice(1)}`;
  } else if (cleaned.startsWith("3") && cleaned.length === 10) {
    cleaned = `92${cleaned}`;
  }
  return cleaned;
}

/**
 * Official Meta WhatsApp Cloud API Adapter (Option 2)
 */
export class MetaWhatsAppCloudAdapter implements IWhatsAppAdapter {
  providerName = "META_CLOUD_API";

  private phoneNumberId?: string;
  private accessToken?: string;

  constructor(phoneNumberId?: string, accessToken?: string) {
    this.phoneNumberId = phoneNumberId;
    this.accessToken = accessToken;
  }

  async sendWhatsAppMessage(input: SendWhatsAppInput): Promise<SendWhatsAppResult> {
    const phoneId = this.phoneNumberId;
    const token = this.accessToken;

    if (!phoneId || !token) {
      return {
        success: false,
        error: "Meta WhatsApp credentials (Phone Number ID or Access Token) are missing.",
      };
    }

    const formattedRecipient = formatPhoneForMeta(input.to);
    if (!formattedRecipient || formattedRecipient.length < 8) {
      return {
        success: false,
        error: `Invalid recipient phone number format: ${input.to}`,
      };
    }

    const url = `https://graph.facebook.com/v23.0/${phoneId}/messages`;

    let payload: any;

    if (input.templateName) {
      // HSM Approved Utility Template
      const parameters = input.templateVariables
        ? Object.entries(input.templateVariables).map(([_, val]) => ({
            type: "text",
            text: String(val || ""),
          }))
        : [];

      payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: formattedRecipient,
        type: "template",
        template: {
          name: input.templateName,
          language: { code: "en" },
          components: parameters.length
            ? [
                {
                  type: "body",
                  parameters,
                },
              ]
            : undefined,
        },
      };
    } else {
      // Direct Interactive / Formatted Text Message
      payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: formattedRecipient,
        type: "text",
        text: {
          preview_url: true,
          body: input.message,
        },
      };
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const responseData = await response.json().catch(() => ({}));

      if (!response.ok) {
        const errorMsg =
          responseData?.error?.message ||
          responseData?.error?.error_user_msg ||
          `Meta API error HTTP ${response.status}`;
        console.error("[Meta WhatsApp Cloud API] Dispatch error:", responseData);
        return {
          success: false,
          error: errorMsg,
        };
      }

      const messageId = responseData?.messages?.[0]?.id || `wamid_${Date.now()}`;
      return {
        success: true,
        messageId,
      };
    } catch (err: any) {
      console.error("[Meta WhatsApp Cloud API] Network error:", err);
      return {
        success: false,
        error: err.message || "Failed to communicate with Meta Graph API",
      };
    }
  }
}

export class MockWhatsAppAdapter implements IWhatsAppAdapter {
  providerName = "MOCK_WHATSAPP";

  async sendWhatsAppMessage(input: SendWhatsAppInput): Promise<SendWhatsAppResult> {
    console.log(`[WhatsApp Adapter Mock] Sending WhatsApp message to ${input.to}: ${input.message.slice(0, 50)}...`);
    return {
      success: true,
      messageId: `wa_msg_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    };
  }
}

class WhatsAppRegistryService {
  private adapter: IWhatsAppAdapter = new MockWhatsAppAdapter();

  public getAdapter(): IWhatsAppAdapter {
    return this.adapter;
  }

  public setAdapter(adapter: IWhatsAppAdapter): void {
    this.adapter = adapter;
  }
}

export const WhatsAppRegistry = new WhatsAppRegistryService();

/**
 * Retrieves the WhatsApp configuration for a given store, decrypting the access token.
 */
export async function getWhatsAppConfig(shopifyStoreId: string) {
  try {
    const config = await prisma.whatsAppConfig.findUnique({
      where: { shopifyStoreId },
    });

    if (!config) {
      return null;
    }

    return {
      ...config,
      rawAccessToken: config.accessToken ? decryptCredential(config.accessToken) : null,
      maskedAccessToken: config.accessToken ? maskCredential(config.accessToken) : null,
    };
  } catch (error) {
    console.error("[WhatsApp Config] Failed to fetch config:", error);
    return null;
  }
}

/**
 * Default WhatsApp automation templates matching the 10 core lifecycle events.
 */
export const DEFAULT_WHATSAPP_AUTOMATIONS = [
  {
    eventType: "COURIER_PICKUP_BOOKED",
    subject: "Order Fulfillment / Courier Booked",
    body: "Hello *{{customer_name}}*, your order *{{order_number}}* has been booked with *{{courier_name}}*.\n\nTracking CN: *{{tracking_number}}*\nAmount to Pay (COD): *Rs. {{cod_amount}}*\n\nTrack your parcel live here:\n{{tracking_url}}",
  },
  {
    eventType: "TRACKING_UPDATE",
    subject: "Out For Delivery Order Message",
    body: "Hello *{{customer_name}}*, your order *{{order_number}}* is *Out For Delivery* today with *{{courier_name}}*.\n\nPlease keep *Rs. {{cod_amount}}* ready for the rider.\n\nTrack live: {{tracking_url}}",
  },
  {
    eventType: "REPLACEMENT_DELIVERED",
    subject: "Delivered Order Message",
    body: "Hello *{{customer_name}}*, your order *{{order_number}}* has been successfully delivered!\n\nThank you for shopping with us. If you ever need an exchange or assistance, we are always here.",
  },
  {
    eventType: "RETURN_REJECTED",
    subject: "Refused / Returned Order Message",
    body: "Hello *{{customer_name}}*, the delivery attempt for order *{{order_number}}* by {{courier_name}} could not be completed.\n\nReason: {{reason}}\n\nPlease reply to this message or contact support so we can reschedule.",
  },
  {
    eventType: "RETURN_SUBMITTED",
    subject: "Return Request Submitted",
    body: "Hello *{{customer_name}}*, we have received your return request for order *{{order_number}}*.\n\nOur team is reviewing it. You can check live status on your customer portal:\n{{portal_url}}",
  },
  {
    eventType: "RETURN_APPROVED",
    subject: "Return Request Approved",
    body: "Hello *{{customer_name}}*, your return request for order *{{order_number}}* has been approved!\n\nPlease pack the items securely. You can view return instructions and courier guidelines on your portal:\n{{portal_url}}",
  },
  {
    eventType: "RETURN_RECEIVED",
    subject: "Return Package Received at Warehouse",
    body: "Hello *{{customer_name}}*, your returned parcel for order *{{order_number}}* has arrived at our warehouse and is queued for quality inspection.",
  },
  {
    eventType: "INSPECTION_COMPLETED",
    subject: "Warehouse Inspection Completed",
    body: "Hello *{{customer_name}}*, the inspection for returned order *{{order_number}}* has been completed successfully.",
  },
  {
    eventType: "REPLACEMENT_CREATED",
    subject: "Exchange Replacement Dispatched",
    body: "Hello *{{customer_name}}*, your exchange replacement order *{{replacement_order}}* (for order {{order_number}}) has been created and will be dispatched to you shortly!",
  },
  {
    eventType: "REFUND_INITIATED",
    subject: "Refund Processed",
    body: "Hello *{{customer_name}}*, your refund of *Rs. {{refund_amount}}* for order *{{order_number}}* has been processed via *{{refund_method}}*.",
  },
];

type MetaTemplateStatus = { name: string; status: string; created: boolean; error?: string };
const metaTemplateStatusCache = new Map<string, { status: string; expiresAt: number }>();

export function buildMetaTemplatePayload(eventType: string, variables: Record<string, any>) {
  const definition = DEFAULT_WHATSAPP_AUTOMATIONS.find((template) => template.eventType === eventType);
  if (!definition) return null;
  const names: string[] = [];
  const body = definition.body.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, name: string) => {
    if (!names.includes(name)) names.push(name);
    return `{{${names.indexOf(name) + 1}}}`;
  }).replace(/\*([^*]+)\*/g, "$1").slice(0, 1024);
  const samples: Record<string, string> = {
    customer_name: "Customer",
    order_number: "#1001",
    courier_name: "PostEx",
    tracking_number: "1234567890",
    tracking_url: "https://example.com/track",
    portal_url: "https://example.com/returns",
    cod_amount: "3990",
    reason: "Request update",
    replacement_order: "#1002",
    refund_amount: "1000",
    refund_method: "bank transfer",
  };
  const orderedValues = names.map((name) => String(variables[name] ?? samples[name] ?? ""));
  return {
    templateName: `byndcart_${eventType.toLowerCase()}`,
    language: "en_US",
    templateVariables: Object.fromEntries(names.map((name, index) => [name, orderedValues[index]])),
    definition,
    body,
    orderedValues,
  };
}

/**
 * Submit per-event Utility templates to the merchant's own WABA. These remain pending
 * until Meta approves them; local app templates are not a substitute for Meta approval.
 */
export async function provisionMetaWhatsAppTemplates(wabaId: string, accessToken: string) {
  const templateNames = DEFAULT_WHATSAPP_AUTOMATIONS.map((template) => `byndcart_${template.eventType.toLowerCase()}`);
  const root = `https://graph.facebook.com/v23.0/${encodeURIComponent(wabaId)}/message_templates`;
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json" };
  const statuses: MetaTemplateStatus[] = [];

  const existingUrl = new URL(root);
  existingUrl.searchParams.set("fields", "name,status,language,category");
  existingUrl.searchParams.set("limit", "100");
  try {
    const existingResponse = await fetch(existingUrl, { headers });
    const existingPayload = await existingResponse.json().catch(() => ({}));
    if (!existingResponse.ok || existingPayload?.error) {
      return {
        total: templateNames.length,
        approved: 0,
        pending: 0,
        errors: [String(existingPayload?.error?.message || "Meta could not list existing message templates; confirm WhatsApp business_management permissions.")],
        templates: [] as MetaTemplateStatus[],
      };
    }

    const existing = Array.isArray(existingPayload?.data) ? existingPayload.data : [];
    for (const definition of DEFAULT_WHATSAPP_AUTOMATIONS) {
      const prepared = buildMetaTemplatePayload(definition.eventType, {});
      if (!prepared) continue;
      const found = existing.find((item: any) =>
        item?.name === prepared.templateName
        && String(item?.language || "en_US").toLowerCase() === "en_us"
      );
      if (found) {
        const status = String(found.status || "PENDING").toUpperCase();
        statuses.push({ name: prepared.templateName, status, created: false });
        metaTemplateStatusCache.set(`${wabaId}:${prepared.templateName}`, { status, expiresAt: Date.now() + 10 * 60 * 1000 });
        continue;
      }

      const components: any[] = [{ type: "BODY", text: prepared.body }];
      if (prepared.orderedValues.length) {
        components[0].example = { body_text: [prepared.orderedValues] };
      }
      const response = await fetch(root, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: prepared.templateName,
          language: "en_US",
          category: "UTILITY",
          components,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.error) {
        const error = String(payload?.error?.message || `Meta rejected the template submission (HTTP ${response.status}).`);
        statuses.push({ name: prepared.templateName, status: "ERROR", created: false, error });
        continue;
      }
      const status = String(payload?.status || "PENDING").toUpperCase();
      statuses.push({ name: prepared.templateName, status, created: true });
      metaTemplateStatusCache.set(`${wabaId}:${prepared.templateName}`, { status, expiresAt: Date.now() + 10 * 60 * 1000 });
    }
  } catch (error) {
    return {
      total: templateNames.length,
      approved: 0,
      pending: 0,
      errors: [error instanceof Error ? error.message : "Failed to contact Meta to submit WhatsApp templates."],
      templates: statuses,
    };
  }

  return {
    total: statuses.length,
    approved: statuses.filter((template) => template.status === "APPROVED").length,
    pending: statuses.filter((template) => ["PENDING", "IN_APPEAL", "PENDING_REVIEW"].includes(template.status)).length,
    errors: statuses.filter((template) => template.error).map((template) => `${template.name}: ${template.error}`),
    templates: statuses,
  };
}

async function getMetaWhatsAppTemplateStatus(wabaId: string, accessToken: string, templateName: string): Promise<string> {
  const key = `${wabaId}:${templateName}`;
  const cached = metaTemplateStatusCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.status;

  const url = new URL(`https://graph.facebook.com/v23.0/${encodeURIComponent(wabaId)}/message_templates`);
  url.searchParams.set("name", templateName);
  url.searchParams.set("fields", "name,status,language");
  url.searchParams.set("limit", "100");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    throw new Error(String(payload?.error?.message || "Meta template status lookup failed."));
  }
  const found = (Array.isArray(payload?.data) ? payload.data : []).find((item: any) =>
    item?.name === templateName && String(item?.language || "en_US").toLowerCase() === "en_us"
  );
  const status = String(found?.status || "MISSING").toUpperCase();
  metaTemplateStatusCache.set(key, { status, expiresAt: Date.now() + 10 * 60 * 1000 });
  return status;
}

/**
 * Auto-installs / seeds default WhatsApp templates when a merchant connects their WhatsApp account.
 */
export async function seedDefaultWhatsAppTemplates(shopifyStoreId: string) {
  try {
    const promises = DEFAULT_WHATSAPP_AUTOMATIONS.map((tpl) =>
      prisma.notificationTemplate.upsert({
        where: {
          shopifyStoreId_eventType_channel: {
            shopifyStoreId,
            eventType: tpl.eventType,
            channel: "WHATSAPP",
          },
        },
        create: {
          shopifyStoreId,
          eventType: tpl.eventType,
          channel: "WHATSAPP",
          enabled: true,
          subject: tpl.subject,
          body: tpl.body,
        },
        update: {
          // If already existing, don't overwrite custom merchant edits, just ensure enabled is active
          enabled: true,
        },
      })
    );

    await Promise.all(promises);
    console.log(`[WhatsApp Auto-Install] Seeded ${DEFAULT_WHATSAPP_AUTOMATIONS.length} default WhatsApp templates for store ${shopifyStoreId}`);
    return { success: true, count: DEFAULT_WHATSAPP_AUTOMATIONS.length };
  } catch (err) {
    console.error("[WhatsApp Auto-Install] Failed to seed default templates:", err);
    return { success: false, error: err };
  }
}

/**
 * Saves or updates a store's WhatsApp configuration.
 * Automatically seeds default templates upon initial connection.
 */
export async function saveWhatsAppConfig(
  shopifyStoreId: string,
  data: {
    phoneNumberId?: string;
    wabaId?: string;
    accessToken?: string;
    displayPhoneNumber?: string;
    verifiedName?: string;
    qualityRating?: string;
    connectionType?: string;
    enabled?: boolean;
  }
) {
  const existing = await prisma.whatsAppConfig.findUnique({
    where: { shopifyStoreId },
  });

  const encryptedToken = data.accessToken
    ? encryptCredential(data.accessToken.trim())
    : existing?.accessToken;

  const config = await prisma.whatsAppConfig.upsert({
    where: { shopifyStoreId },
    create: {
      shopifyStoreId,
      enabled: data.enabled ?? true,
      phoneNumberId: data.phoneNumberId?.trim() || null,
      wabaId: data.wabaId?.trim() || null,
      accessToken: encryptedToken || null,
      displayPhoneNumber: data.displayPhoneNumber?.trim() || null,
      verifiedName: data.verifiedName?.trim() || null,
      qualityRating: data.qualityRating?.trim() || "GREEN",
      connectionType: data.connectionType || "EMBEDDED_SIGNUP",
      connectedAt: new Date(),
    },
    update: {
      enabled: data.enabled !== undefined ? data.enabled : true,
      ...(data.phoneNumberId !== undefined ? { phoneNumberId: data.phoneNumberId?.trim() || null } : {}),
      ...(data.wabaId !== undefined ? { wabaId: data.wabaId?.trim() || null } : {}),
      ...(encryptedToken !== undefined ? { accessToken: encryptedToken } : {}),
      ...(data.displayPhoneNumber !== undefined ? { displayPhoneNumber: data.displayPhoneNumber?.trim() || null } : {}),
      ...(data.verifiedName !== undefined ? { verifiedName: data.verifiedName?.trim() || null } : {}),
      ...(data.qualityRating !== undefined ? { qualityRating: data.qualityRating?.trim() || "GREEN" } : {}),
      ...(data.connectionType !== undefined ? { connectionType: data.connectionType } : {}),
      connectedAt: new Date(),
    },
  });

  // Automatically install the default automation templates on connect
  if (config.enabled && config.phoneNumberId && config.accessToken) {
    await seedDefaultWhatsAppTemplates(shopifyStoreId);
  }

  return config;
}

/**
 * Disconnects WhatsApp from a store, clearing credentials and disabling alerts.
 */
export async function disconnectWhatsApp(shopifyStoreId: string) {
  try {
    await prisma.whatsAppConfig.update({
      where: { shopifyStoreId },
      data: {
        enabled: false,
        accessToken: null,
        phoneNumberId: null,
        wabaId: null,
        displayPhoneNumber: null,
        verifiedName: null,
        qualityRating: "UNKNOWN",
      },
    });
    return { success: true };
  } catch (error) {
    console.error("[WhatsApp Disconnect] Error:", error);
    return { success: false, error };
  }
}

/**
 * Meta Embedded Signup OAuth Code Exchange
 * Exchanges authorization code from Meta Embedded Signup popup for permanent access token
 * and discovers the merchant's WhatsApp Business Account & Phone Number details.
 */
export async function exchangeMetaEmbeddedSignupCode(
  shopifyStoreId: string,
  code: string,
  metaAppId?: string,
  metaAppSecret?: string,
  sessionInfo?: { wabaId?: string; phoneNumberId?: string; businessId?: string },
) {
  const appId = metaAppId || process.env.META_APP_ID || process.env.WHATSAPP_APP_ID;
  const appSecret = metaAppSecret || process.env.META_APP_SECRET || process.env.WHATSAPP_APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error("Meta App ID or App Secret is not configured in server environment.");
  }

  // 1. Exchange code for access token
  const tokenUrl = `https://graph.facebook.com/v23.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&code=${encodeURIComponent(code)}`;
  const tokenRes = await fetch(tokenUrl);
  const tokenData = await tokenRes.json();

  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(tokenData?.error?.message || "Failed to exchange authorization code with Meta.");
  }

  const userAccessToken = String(tokenData.access_token);

  // 2. Inspect the token and validate that Embedded Signup granted WhatsApp management access.
  const debugUrl = new URL("https://graph.facebook.com/v23.0/debug_token");
  debugUrl.searchParams.set("input_token", userAccessToken);
  debugUrl.searchParams.set("access_token", `${appId}|${appSecret}`);
  const debugRes = await fetch(debugUrl);
  const debugData = await debugRes.json();
  if (!debugRes.ok || debugData?.error || debugData?.data?.is_valid === false) {
    throw new Error(debugData?.error?.message || "Meta returned an invalid WhatsApp access token. Reconnect and approve the requested permissions.");
  }

  const granularScopes = Array.isArray(debugData?.data?.granular_scopes) ? debugData.data.granular_scopes : [];
  const wabaScope = granularScopes.find((scope: any) => scope?.scope === "whatsapp_business_management");
  const wabaIdFromToken = String(wabaScope?.target_ids?.[0] || "").trim();
  const requestedWabaId = String(sessionInfo?.wabaId || "").trim();
  const targetWabaId = requestedWabaId || wabaIdFromToken;
  if (!targetWabaId) {
    throw new Error("Meta did not return the WhatsApp Business Account ID. Finish Embedded Signup and retry; the WABA ID is needed to connect the merchant's own account.");
  }
  if (wabaIdFromToken && requestedWabaId && wabaIdFromToken !== requestedWabaId) {
    // Some partner flows do not expose WABA IDs in granular scopes; when they do, enforce the match.
    throw new Error("The WhatsApp Business Account returned by Embedded Signup does not match the account authorized in Meta.");
  }

  // 3. Discover the exact merchant phone number returned by the Embedded Signup session.
  const phoneUrl = new URL(`https://graph.facebook.com/v23.0/${encodeURIComponent(targetWabaId)}/phone_numbers`);
  phoneUrl.searchParams.set("access_token", userAccessToken);
  const phoneRes = await fetch(phoneUrl);
  const phoneData = await phoneRes.json();
  if (!phoneRes.ok || phoneData?.error) {
    throw new Error(phoneData?.error?.message || "Meta could not list phone numbers for the connected WhatsApp Business Account.");
  }
  const phoneNumbers = Array.isArray(phoneData?.data) ? phoneData.data : [];
  const requestedPhoneNumberId = String(sessionInfo?.phoneNumberId || "").trim();
  const primaryPhone = requestedPhoneNumberId
    ? phoneNumbers.find((phone: any) => String(phone?.id || "") === requestedPhoneNumberId)
    : phoneNumbers[0];
  if (requestedPhoneNumberId && !primaryPhone) {
    throw new Error("The phone number returned by Embedded Signup does not belong to the authorized WhatsApp Business Account.");
  }
  const phoneNumberId = String(primaryPhone?.id || "").trim();
  const displayPhoneNumber = String(primaryPhone?.display_phone_number || "").trim();
  const verifiedName = String(primaryPhone?.verified_name || "").trim();
  const qualityRating = String(primaryPhone?.quality_rating || "GREEN");
  if (!phoneNumberId) {
    throw new Error("Meta connected the WhatsApp Business Account but returned no phone number ID. Finish registering a WhatsApp phone number in Meta Business Manager, then reconnect.");
  }

  // 4. Save the verified merchant connection and seed local workflow templates.
  const saved = await saveWhatsAppConfig(shopifyStoreId, {
    phoneNumberId,
    wabaId: String(targetWabaId),
    accessToken: userAccessToken,
    displayPhoneNumber: displayPhoneNumber || undefined,
    verifiedName: verifiedName || undefined,
    qualityRating,
    connectionType: "EMBEDDED_SIGNUP",
    enabled: true,
  });

  // Submit dedicated templates to the merchant's WABA. Meta approval is asynchronous;
  // template submission errors do not erase a verified account connection.
  const metaTemplateStatus = await provisionMetaWhatsAppTemplates(String(targetWabaId), userAccessToken);
  try {
    await prisma.auditLog.create({
      data: {
        shopifyStoreId,
        action: "WHATSAPP_META_TEMPLATES_SUBMITTED",
        entityType: "WhatsAppConfig",
        entityId: String(saved.id || shopifyStoreId),
        metadata: {
          wabaId: String(targetWabaId),
          phoneNumberId,
          total: metaTemplateStatus.total,
          approved: metaTemplateStatus.approved,
          pending: metaTemplateStatus.pending,
          errors: metaTemplateStatus.errors,
        },
      },
    });
  } catch {
    // Audit write failure does not disconnect an already verified WhatsApp account.
  }

  return { ...saved, metaTemplateStatus };
}

/**
 * Dispatcher function for notifications service.
 * Inspects whether the store has active WhatsApp credentials; if so, uses Meta Cloud API.
 * Otherwise falls back to mock/registry in tests, or returns an error.
 */
export async function dispatchWhatsAppNotification(input: SendWhatsAppInput): Promise<SendWhatsAppResult> {
  if (input.shopifyStoreId) {
    const config = await getWhatsAppConfig(input.shopifyStoreId);
    if (config?.enabled && config.phoneNumberId && config.rawAccessToken) {
      if (input.templateName) {
        if (!config.wabaId) {
          return { success: false, error: "The connected WhatsApp account is missing its WABA ID. Reconnect WhatsApp in BYNDCART." };
        }
        let templateStatus = "";
        try {
          templateStatus = await getMetaWhatsAppTemplateStatus(config.wabaId, config.rawAccessToken, input.templateName);
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : "Could not verify Meta template approval." };
        }
        if (templateStatus !== "APPROVED") {
          return {
            success: false,
            error: templateStatus === "MISSING"
              ? `Meta template "${input.templateName}" has not been created. Reconnect WhatsApp to submit BYNDCART's default templates.`
              : `Meta template "${input.templateName}" is ${templateStatus.toLowerCase()}, not approved yet. Check template status in Meta Business Manager.`,
          };
        }
      }
      const adapter = new MetaWhatsAppCloudAdapter(config.phoneNumberId, config.rawAccessToken);
      return await adapter.sendWhatsAppMessage(input);
    }
  }

  // The mock adapter is strictly test-only. Never mark a real merchant notification
  // as sent when this store has not connected its own WhatsApp Business account.
  if (process.env.NODE_ENV === "test" || process.env.SKIP_AUTH === "true") {
    const registryAdapter = WhatsAppRegistry.getAdapter();
    return await registryAdapter.sendWhatsAppMessage(input);
  }
  return {
    success: false,
    error: "This merchant has not connected a WhatsApp Business number. Connect WhatsApp in Notifications before trying again.",
  };
}
