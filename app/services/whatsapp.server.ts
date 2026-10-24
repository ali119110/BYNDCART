import prisma from "../db.server";
import { encryptCredential, decryptCredential, maskCredential } from "../utils/encryption.server";
import { normalizePakistaniMobile } from "./pakistanLogistics";

export interface SendWhatsAppInput {
  to: string;
  message: string;
  templateName?: string;
  templateVariables?: Record<string, string>;
  eventType?: string;
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

export const META_GRAPH_API_VERSION = /^v\d+\\.\d+$/.test(process.env.META_GRAPH_API_VERSION || "")
  ? String(process.env.META_GRAPH_API_VERSION)
  : "v26.0";

type MetaUtilityTemplateDefinition = { name: string; body: string; variables: string[] };

const META_UTILITY_TEMPLATES: Record<string, MetaUtilityTemplateDefinition> = {
  RETURN_SUBMITTED: { name: "byndcart_return_submitted", body: "Hello {{1}}, we received your return request for order {{2}}. Our team is reviewing your request.", variables: ["customer_name", "order_number"] },
  EXCHANGE_SUBMITTED: { name: "byndcart_exchange_submitted", body: "Hello {{1}}, we received your exchange request for order {{2}}. Our team is reviewing your request.", variables: ["customer_name", "order_number"] },
  RETURN_APPROVED: { name: "byndcart_return_approved", body: "Hello {{1}}, your return request for order {{2}} has been approved. Please check your merchant's return instructions.", variables: ["customer_name", "order_number"] },
  RETURN_REJECTED: { name: "byndcart_return_rejected", body: "Hello {{1}}, your return request for order {{2}} could not be approved. Reason: {{3}}.", variables: ["customer_name", "order_number", "reason"] },
  COURIER_PICKUP_BOOKED: { name: "byndcart_courier_booked", body: "Hello {{1}}, order {{2}} has been booked with {{3}}. Tracking number: {{4}}. COD amount: {{5}}.", variables: ["customer_name", "order_number", "courier_name", "tracking_number", "cod_amount"] },
  TRACKING_UPDATE: { name: "byndcart_tracking_update", body: "Hello {{1}}, the latest shipment status for order {{2}} is {{3}}. Courier: {{4}}. Tracking number: {{5}}.", variables: ["customer_name", "order_number", "status", "courier_name", "tracking_number"] },
  RETURN_RECEIVED: { name: "byndcart_return_received", body: "Hello {{1}}, we received the return parcel for order {{2}} at the warehouse.", variables: ["customer_name", "order_number"] },
  EXCHANGE_RECEIVED: { name: "byndcart_exchange_received", body: "Hello {{1}}, we received the original item for exchange on order {{2}}. Our team will inspect it next.", variables: ["customer_name", "order_number"] },
  INSPECTION_COMPLETED: { name: "byndcart_inspection_completed", body: "Hello {{1}}, inspection for order {{2}} is complete. Condition: {{3}}.", variables: ["customer_name", "order_number", "condition"] },
  EXCHANGE_INSPECTION_COMPLETED: { name: "byndcart_exchange_inspection_completed", body: "Hello {{1}}, inspection for the exchange on order {{2}} is complete. The replacement will follow your store's workflow.", variables: ["customer_name", "order_number"] },
  REFUND_INITIATED: { name: "byndcart_refund_update", body: "Hello {{1}}, the refund update for order {{2}} is {{3}} {{4}} using {{5}}. Reference: {{6}}.", variables: ["customer_name", "order_number", "refund_amount", "refund_currency", "refund_method", "refund_reference"] },
  EXCHANGE_APPROVED: { name: "byndcart_exchange_approved", body: "Hello {{1}}, your exchange request for order {{2}} is approved. Replacement order: {{3}}.", variables: ["customer_name", "order_number", "replacement_order"] },
  REPLACEMENT_CREATED: { name: "byndcart_replacement_created", body: "Hello {{1}}, replacement order {{2}} for original order {{3}} has been created and is queued for fulfillment.", variables: ["customer_name", "replacement_order", "order_number"] },
  REPLACEMENT_DELIVERED: { name: "byndcart_replacement_delivered", body: "Hello {{1}}, replacement order {{2}} for original order {{3}} has been marked delivered.", variables: ["customer_name", "replacement_order", "order_number"] },
  LIFECYCLE_COMPLETED: { name: "byndcart_request_completed", body: "Hello {{1}}, the return or exchange process for order {{2}} has been completed. Thank you.", variables: ["customer_name", "order_number"] },
};

export function getMetaUtilityTemplateName(eventType: string): string | undefined {
  return META_UTILITY_TEMPLATES[eventType]?.name;
}

function metaTemplateParameters(eventType: string, variables: Record<string, any> = {}): string[] {
  const definition = META_UTILITY_TEMPLATES[eventType];
  if (!definition) return [];
  return definition.variables.map((key) => {
    const value = variables[key];
    return value === undefined || value === null || String(value).trim() === "" ? "—" : String(value).trim().slice(0, 500);
  });
}

/**
 * Submit dedicated UTILITY templates to each merchant's own WABA. New submissions
 * remain pending review; local seeding does not mean Meta has approved a template.
 */
export async function ensureMetaUtilityTemplates(wabaId: string, accessToken: string) {
  if (!wabaId.trim() || !accessToken.trim()) throw new Error("A verified WABA ID and access token are required to set up WhatsApp templates.");
  const result = { created: 0, pending: 0, approved: 0, failed: 0, errors: [] as string[] };
  const listUrl = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${encodeURIComponent(wabaId)}/message_templates`);
  listUrl.searchParams.set("fields", "id,name,status,language,category");
  listUrl.searchParams.set("limit", "100");
  const listResponse = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  const listPayload = await listResponse.json().catch(() => ({}));
  if (!listResponse.ok || !Array.isArray(listPayload?.data)) {
    throw new Error(listPayload?.error?.message || "Meta could not list message templates for this WABA.");
  }
  const existing = new Map<string, any>();
  for (const tpl of listPayload.data) {
    if (tpl?.name && (tpl?.language === "en" || tpl?.language === "en_US")) existing.set(String(tpl.name), tpl);
  }
  const examples: Record<string, string> = {
    customer_name: "Customer", order_number: "#1001", reason: "Store policy", courier_name: "Courier",
    tracking_number: "TRACK123", cod_amount: "3990", status: "In transit", condition: "Inspection completed",
    refund_amount: "3990.00", refund_currency: "PKR", refund_method: "Bank transfer",
    refund_reference: "REF123", replacement_order: "#1002",
  };
  for (const definition of Object.values(META_UTILITY_TEMPLATES)) {
    const current = existing.get(definition.name);
    if (current) {
      const status = String(current.status || "").toUpperCase();
      if (status === "APPROVED") result.approved += 1;
      else if (["PENDING", "IN_APPEAL", "PAUSED"].includes(status)) result.pending += 1;
      else { result.failed += 1; result.errors.push(`${definition.name}: Meta status ${status || "unknown"}`); }
      continue;
    }
    const url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${encodeURIComponent(wabaId)}/message_templates`);
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        name: definition.name,
        language: "en_US",
        category: "UTILITY",
        components: [{
          type: "BODY",
          text: definition.body,
          example: { body_text: [definition.variables.map((key) => examples[key] || "Value")] },
        }],
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.error) {
      result.failed += 1;
      result.errors.push(`${definition.name}: ${String(body?.error?.message || `Meta HTTP ${response.status}`)}`);
    } else {
      result.created += 1;
      result.pending += 1;
    }
  }
  return result;
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

    const url = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${phoneId}/messages`;

    let payload: any;

    const effectiveTemplateName = input.templateName || (input.eventType ? getMetaUtilityTemplateName(input.eventType) : undefined);
    if (!effectiveTemplateName) {
      return { success: false, error: "No dedicated Meta utility template is configured for this notification event." };
    }
    const parameterValues = input.eventType
      ? metaTemplateParameters(input.eventType, input.templateVariables || {})
      : Object.values(input.templateVariables || {}).map((value) => String(value || "—").slice(0, 500));
    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: formattedRecipient,
      type: "template",
      template: {
        name: effectiveTemplateName,
        language: { code: "en_US" },
        components: parameterValues.length
          ? [{ type: "body", parameters: parameterValues.map((value) => ({ type: "text", text: value })) }]
          : undefined,
      },
    };

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
 * Exchanges authorization code, validates the WABA and phone, and subscribes the provider app
 * and discovers the merchant's WhatsApp Business Account & Phone Number details.
 */
export async function exchangeMetaEmbeddedSignupCode(
  shopifyStoreId: string,
  code: string,
  embeddedSignup: { wabaId: string; phoneNumberId: string },
  metaAppId?: string,
  metaAppSecret?: string
) {
  const appId = metaAppId || process.env.META_APP_ID || process.env.WHATSAPP_APP_ID;
  const appSecret = metaAppSecret || process.env.META_APP_SECRET || process.env.WHATSAPP_APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error("Meta App ID or App Secret is not configured in server environment.");
  }

  // 1. Exchange code for access token
  const tokenUrl = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&code=${encodeURIComponent(code)}`;
  const tokenRes = await fetch(tokenUrl);
  const tokenData = await tokenRes.json();

  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(tokenData?.error?.message || "Failed to exchange authorization code with Meta.");
  }

  // Exchange the one-time signup code. Prefer a long-lived user token when Meta
  // grants it; if this exchange is unavailable for this app's Embedded Signup token,
  // keep the valid code-exchange token and let API verification expose expiry/permission errors.
  let userAccessToken = String(tokenData.access_token);
  const longLivedUrl = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token`);
  longLivedUrl.searchParams.set("grant_type", "fb_exchange_token");
  longLivedUrl.searchParams.set("client_id", appId);
  longLivedUrl.searchParams.set("client_secret", appSecret);
  longLivedUrl.searchParams.set("fb_exchange_token", userAccessToken);
  try {
    const longLivedRes = await fetch(longLivedUrl);
    const longLivedData = await longLivedRes.json().catch(() => ({}));
    if (longLivedRes.ok && longLivedData?.access_token) {
      userAccessToken = String(longLivedData.access_token);
    }
  } catch {
    // Use the original successful code-exchange token; the first live API validation below
    // still has to succeed before the account is marked connected.
  }

  // Embedded Signup v4 sends the selected WABA and phone-number IDs through the
  // WA_EMBEDDED_SIGNUP FINISH postMessage event. Do not infer the WABA from granular
  // token scopes: a provider/user may have access to multiple business accounts.
  const targetWabaId = String(embeddedSignup?.wabaId || "").trim();
  const phoneNumberId = String(embeddedSignup?.phoneNumberId || "").trim();
  if (!/^\d+$/.test(targetWabaId) || !/^\d+$/.test(phoneNumberId)) {
    throw new Error("Meta Embedded Signup v4 did not return valid WABA and phone-number IDs. Reconnect and finish the WhatsApp setup flow.");
  }

  const debugUrl = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/debug_token`);
  debugUrl.searchParams.set("input_token", userAccessToken);
  debugUrl.searchParams.set("access_token", `${appId}|${appSecret}`);
  const debugRes = await fetch(debugUrl);
  const debugData = await debugRes.json().catch(() => ({}));
  if (!debugRes.ok || debugData?.error || debugData?.data?.is_valid === false) {
    throw new Error(debugData?.error?.message || "Meta did not validate the WhatsApp Embedded Signup token.");
  }

  const phoneUrl = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${encodeURIComponent(phoneNumberId)}`);
  phoneUrl.searchParams.set("fields", "id,display_phone_number,verified_name,quality_rating");
  const phoneRes = await fetch(phoneUrl, { headers: { Authorization: `Bearer ${userAccessToken}`, Accept: "application/json" } });
  const primaryPhone = await phoneRes.json().catch(() => ({}));
  if (!phoneRes.ok || primaryPhone?.error || String(primaryPhone?.id || "") !== phoneNumberId) {
    throw new Error(primaryPhone?.error?.message || "Meta could not verify the Phone Number ID returned by Embedded Signup v4.");
  }

  const linkedNumbersUrl = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${encodeURIComponent(targetWabaId)}/phone_numbers`);
  const linkedNumbersResponse = await fetch(linkedNumbersUrl, {
    headers: { Authorization: `Bearer ${userAccessToken}`, Accept: "application/json" },
  });
  const linkedNumbers = await linkedNumbersResponse.json().catch(() => ({}));
  if (!linkedNumbersResponse.ok || !Array.isArray(linkedNumbers?.data)
    || !linkedNumbers.data.some((item: any) => String(item?.id || "") === phoneNumberId)) {
    throw new Error(linkedNumbers?.error?.message || "The selected phone number is not linked to the WABA returned by Embedded Signup v4.");
  }

  // Subscribe the provider app to this merchant's WABA so webhook events can arrive.
  const subscribeUrl = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${encodeURIComponent(targetWabaId)}/subscribed_apps`);
  const subscribeRes = await fetch(subscribeUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${userAccessToken}`, Accept: "application/json" },
  });
  const subscribeData = await subscribeRes.json().catch(() => ({}));
  if (!subscribeRes.ok || subscribeData?.success !== true) {
    throw new Error(subscribeData?.error?.message || "Meta could not subscribe BYNDCART to this WABA. Check Tech Provider permissions and webhook configuration.");
  }

  // 3. Save credentials only after Meta verified the v4-selected WABA, phone and token.
  const displayPhoneNumber = String(primaryPhone.display_phone_number || "");
  const verifiedName = String(primaryPhone.verified_name || "");
  const qualityRating = String(primaryPhone.quality_rating || "UNKNOWN");

  const saved = await saveWhatsAppConfig(shopifyStoreId, {
    phoneNumberId,
    wabaId: targetWabaId,
    accessToken: userAccessToken,
    displayPhoneNumber: displayPhoneNumber || undefined,
    verifiedName: verifiedName || undefined,
    qualityRating,
    connectionType: "EMBEDDED_SIGNUP",
    enabled: true,
  });

  let templateSetup: any;
  try {
    templateSetup = await ensureMetaUtilityTemplates(targetWabaId, userAccessToken);
  } catch (templateError) {
    // The account can be connected even if template-management permission is missing.
    // Report that separately so the merchant isn't misled into thinking OAuth failed.
    templateSetup = {
      created: 0,
      pending: 0,
      approved: 0,
      failed: Object.keys(META_UTILITY_TEMPLATES).length,
      errors: [templateError instanceof Error ? templateError.message : "Meta template setup failed."],
    };
  }
  return { ...saved, templateSetup };
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
      const adapter = new MetaWhatsAppCloudAdapter(config.phoneNumberId, config.rawAccessToken);
      return await adapter.sendWhatsAppMessage(input);
    }
  }

  // Never mark production delivery as successful through the mock adapter.
  // The mock registry remains available only for isolated test runs.
  if (process.env.NODE_ENV === "test") {
    return await WhatsAppRegistry.getAdapter().sendWhatsAppMessage(input);
  }
  return {
    success: false,
    error: input.shopifyStoreId
      ? "WhatsApp is not connected for this store. Connect the merchant's Meta WhatsApp Business account first."
      : "A store-scoped Meta WhatsApp configuration is required for production delivery.",
  };
}
