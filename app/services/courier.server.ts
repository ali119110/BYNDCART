import prisma from "../db.server";
import { encryptCredential, decryptCredential, maskCredential } from "../utils/encryption.server";

export type StandardShipmentStatus =
  | "LABEL_CREATED"
  | "IN_TRANSIT"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "FAILED"
  | "CANCELLED"
  | "UNKNOWN";

/**
 * Normalizes raw courier status strings into standard BYNDCART shipment status values.
 */
export function normalizeCourierStatus(rawStatus?: string): StandardShipmentStatus {
  if (!rawStatus) return "UNKNOWN";
  const s = rawStatus.trim().toUpperCase();

  if (s.includes("BOOKED") || s.includes("CREATED") || s.includes("LABEL") || s.includes("PENDING") || s.includes("NEW")) {
    return "LABEL_CREATED";
  }
  if (s.includes("TRANSIT") || s.includes("DISPATCH") || s.includes("ARRIVED") || s.includes("HUB") || s.includes("DEPARTED")) {
    return "IN_TRANSIT";
  }
  if (s.includes("OUT FOR DELIVERY") || s.includes("RIDER") || s.includes("ON WAY")) {
    return "OUT_FOR_DELIVERY";
  }
  if (s.includes("DELIVERED") || s.includes("COMPLETED") || s.includes("SUCCESS")) {
    return "DELIVERED";
  }
  if (s.includes("CANCEL") || s.includes("VOID")) {
    return "CANCELLED";
  }
  if (s.includes("FAIL") || s.includes("RETURN") || s.includes("REJECT") || s.includes("UNABLE")) {
    return "FAILED";
  }

  return "UNKNOWN";
}

export interface TestConnectionInput {
  shopifyStoreId: string;
  config: {
    apiToken: string;
    accountNumber?: string;
    additionalConfig?: any;
  };
}

export interface TestConnectionResult {
  success: boolean;
  message: string;
  isLive: boolean;
}

export interface ShipmentInput {
  shopifyStoreId: string;
  orderId: string;
  orderNumber: string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  originAddress?: any;
  destinationAddress?: any;
  weightKg?: number;
  items?: Array<{ title: string; quantity: number; price?: number; sku?: string | number }>;
  codAmountPKR?: number;
  remarks?: string;
}

export interface LabelResult {
  success: boolean;
  trackingNumber: string;
  labelUrl?: string;
  courierName: string;
  estimatedDeliveryDate?: Date;
  costPKR?: number;
  rawResponse?: any;
  error?: string;
  isLive: boolean;
}

export interface TrackingStatusResult {
  trackingNumber: string;
  courierName: string;
  status: StandardShipmentStatus;
  rawStatus?: string;
  location?: string;
  updatedAt: Date;
  events?: Array<{ timestamp: Date; status: StandardShipmentStatus; description: string; location?: string }>;
  rawPayload?: any;
}

export interface ICourierAdapter {
  readonly providerName: string;
  readonly displayName: string;
  readonly description: string;
  readonly cityHubs?: string[];
  readonly isLive: boolean;

  testConnection(input: TestConnectionInput): Promise<TestConnectionResult>;
  createReverseShipment(input: ShipmentInput, credentials?: any): Promise<LabelResult>;
  createForwardShipment(input: ShipmentInput, credentials?: any): Promise<LabelResult>;
  generateReturnLabel(input: ShipmentInput, credentials?: any): Promise<LabelResult>;
  trackShipment(trackingNumber: string, credentials?: any): Promise<TrackingStatusResult>;
  cancelShipment(trackingNumber: string, credentials?: any): Promise<{ success: boolean; message?: string }>;
  getLabel?(trackingNumber: string, credentials?: any): Promise<{ labelUrl: string }>;
}

export function unconfirmedBooking(courierName: string, message?: string): LabelResult {
  return {
    success: false,
    trackingNumber: "",
    courierName,
    isLive: false,
    error: message || `${courierName} did not confirm this shipment. Enter the airway bill manually.`,
  };
}

export function unconfirmedTracking(courierName: string, trackingNumber: string): TrackingStatusResult {
  return {
    trackingNumber,
    courierName,
    status: "UNKNOWN",
    rawStatus: "UNCONFIRMED",
    updatedAt: new Date(),
  };
}

export function credentialsStored(provider: string): TestConnectionResult {
  return {
    success: true,
    isLive: false,
    message: `${provider} credentials were provided, but BYNDCART did not verify a live API connection. This carrier still requires a manually entered airway bill.`,
  };
}

export function unconfirmedCancel(provider: string) {
  return {
    success: false,
    message: `${provider} did not confirm a cancellation. Update the shipment manually if the courier voided it.`,
  };
}

// -----------------------------------------------------------------------------
// 1. PostEx Courier Adapter (Live REST API Integration)
// Official API Docs: https://api.postex.pk/services/integration/api
// Headers: token: <apiToken>
// -----------------------------------------------------------------------------
export class PostExCourierAdapter implements ICourierAdapter {
  readonly providerName = "POSTEX";
  readonly displayName = "PostEx";
  readonly description = "Live API booking is implemented for return pickups only. Forward/exchange booking and live tracking are not implemented.";
  readonly cityHubs = ["Lahore", "Karachi", "Islamabad", "Faisalabad", "Multan", "Sialkot"];
  // This flag describes implemented live booking support for the customer return flow, not live tracking.
  readonly isLive = true;

  async testConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
    if (!input.config.apiToken || input.config.apiToken.startsWith("invalid")) {
      return { success: false, message: "PostEx API token is required or invalid.", isLive: false };
    }
    try {
      const response = await fetch("https://api.postex.pk/services/integration/api/order/get-operational-cities", {
        method: "GET",
        headers: { token: input.config.apiToken },
      });
      if (response.ok) {
        return { success: true, message: "PostEx API connection verified successfully.", isLive: true };
      }
      return { success: false, message: "PostEx rejected the API token. The connection was not verified.", isLive: false };
    } catch {
      return { success: false, message: "PostEx could not be reached, so the connection was not verified.", isLive: false };
    }
  }


  async createReverseShipment(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    // Never fall back to a global app token: each merchant must book with its own tenant-scoped credential.
    const apiToken = typeof credentials?.apiToken === "string" ? credentials.apiToken.trim() : "";
    if (!apiToken) {
      return unconfirmedBooking(this.providerName, "PostEx is not configured for this store. Save this store's PostEx API token or enter the airway bill manually.");
    }

    const customerPhone = input.customerPhone?.trim();
    const pickupAddress = input.originAddress?.address1?.trim();
    if (!customerPhone || !pickupAddress) {
      return unconfirmedBooking(this.providerName, "PostEx needs the customer's pickup phone number and pickup address. Add those details or enter the airway bill manually.");
    }

    try {
      const response = await fetch("https://api.postex.pk/services/integration/api/order/create-return-order", {
        method: "POST",
        headers: {
          token: apiToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          orderRefNum: input.orderNumber,
          customerName: input.customerName || "Customer",
          customerPhone,
          pickupAddress,
          orderType: "RETURN",
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const trackingNumber = data.distTrackingNumber || data.trackingNumber;
        if (trackingNumber) {
          return {
            success: true,
            trackingNumber: String(trackingNumber),
            labelUrl: data.labelUrl || undefined,
            courierName: this.providerName,
            rawResponse: data,
            isLive: true,
          };
        }
      }
    } catch {
      return unconfirmedBooking(this.providerName, "PostEx could not be reached. No shipment was confirmed; enter the airway bill manually after booking with PostEx.");
    }

    return unconfirmedBooking(this.providerName, "PostEx did not return a confirmed tracking number. No shipment was recorded as booked; enter the airway bill manually after confirming it with PostEx.");
  }

  async createForwardShipment(_input: ShipmentInput, _credentials?: any): Promise<LabelResult> {
    return unconfirmedBooking(this.providerName, "BYNDCART does not yet implement PostEx forward/exchange booking. Create the shipment in PostEx and enter the airway bill manually.");
  }

  async generateReturnLabel(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.createReverseShipment(input, credentials);
  }


  async trackShipment(trackingNumber: string): Promise<TrackingStatusResult> {
    return unconfirmedTracking(this.providerName, trackingNumber);
  }

  async cancelShipment(_trackingNumber?: string): Promise<{ success: boolean; message?: string }> {
    return unconfirmedCancel(this.providerName);
  }
}

// -----------------------------------------------------------------------------
// 2. Leopards Courier Adapter (Merchant API Integration)
// Official API Docs: https://merchantapi.leopardscourier.com/api
// -----------------------------------------------------------------------------
export class LeopardsCourierAdapter implements ICourierAdapter {
  readonly providerName = "LEOPARDS";
  readonly displayName = "Leopards Courier Service";
  readonly description = "Credentials can be saved, but BYNDCART does not currently book or track Leopards shipments. Enter the airway bill manually.";
  readonly cityHubs = ["Karachi", "Lahore", "Islamabad", "Sialkot", "Gujranwala", "Hyderabad", "Sukkur"];
  readonly isLive = false;

  async testConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
    if (!input.config.apiToken) {
      return { success: false, message: "Leopards API key/password is required.", isLive: false };
    }
    return credentialsStored("Leopards");
  }

  async createReverseShipment(_input?: ShipmentInput, _credentials?: unknown): Promise<LabelResult> {
    return unconfirmedBooking(this.providerName);
  }

  async createForwardShipment(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.createReverseShipment(input, credentials);
  }


  async generateReturnLabel(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.createReverseShipment(input, credentials);
  }


  async trackShipment(trackingNumber: string): Promise<TrackingStatusResult> {
    return unconfirmedTracking(this.providerName, trackingNumber);
  }

  async cancelShipment(_trackingNumber?: string): Promise<{ success: boolean; message?: string }> {
    return unconfirmedCancel(this.providerName);
  }
}

// -----------------------------------------------------------------------------
// 3. Trax Courier Adapter (Smart Returns REST API)
// Official API Docs: https://api.trax.pk/v1
// -----------------------------------------------------------------------------
export class TraxCourierAdapter implements ICourierAdapter {
  readonly providerName = "TRAX";
  readonly displayName = "Trax Express Smart Returns";
  readonly description = "Credentials can be saved, but Trax booking and tracking are not currently integrated in BYNDCART. Enter the airway bill manually.";
  readonly cityHubs = ["Karachi", "Lahore", "Islamabad", "Faisalabad", "Multan", "Peshawar"];
  readonly isLive = false;

  async testConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
    if (!input.config.apiToken) {
      return { success: false, message: "Trax API token is required.", isLive: false };
    }
    return credentialsStored("Trax");
  }

  async createReverseShipment(_input?: ShipmentInput, _credentials?: unknown): Promise<LabelResult> {
    return unconfirmedBooking(this.providerName);
  }

  async createForwardShipment(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.createReverseShipment(input, credentials);
  }

  async generateReturnLabel(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.createReverseShipment(input, credentials);
  }

  async trackShipment(trackingNumber: string): Promise<TrackingStatusResult> {
    return unconfirmedTracking(this.providerName, trackingNumber);
  }

  async cancelShipment(_trackingNumber?: string): Promise<{ success: boolean; message?: string }> {
    return unconfirmedCancel(this.providerName);
  }
}

// -----------------------------------------------------------------------------
// 4. TCS Courier Adapter (Corporate Reverse Logistics REST API)
// Official API Docs: https://atnetservices.tcscourier.com/api
// -----------------------------------------------------------------------------
export class TCSCourierAdapter implements ICourierAdapter {
  readonly providerName = "TCS";
  readonly displayName = "TCS Express Reverse Logistics";
  readonly description = "Credentials can be saved, but BYNDCART does not currently book or track TCS shipments. Enter the airway bill manually.";
  readonly cityHubs = ["Karachi", "Lahore", "Islamabad", "Rawalpindi", "Faisalabad", "Multan", "Peshawar", "Quetta"];
  readonly isLive = false;

  async testConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
    if (!input.config.apiToken || !input.config.accountNumber) {
      return { success: false, message: "TCS API key and cost center code are both required.", isLive: false };
    }
    return credentialsStored("TCS");
  }

  async createReverseShipment(_input?: ShipmentInput, _credentials?: unknown): Promise<LabelResult> {
    return unconfirmedBooking(this.providerName);
  }

  async createForwardShipment(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.createReverseShipment(input, credentials);
  }

  async generateReturnLabel(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.createReverseShipment(input, credentials);
  }

  async trackShipment(trackingNumber: string): Promise<TrackingStatusResult> {
    return unconfirmedTracking(this.providerName, trackingNumber);
  }

  async cancelShipment(_trackingNumber?: string): Promise<{ success: boolean; message?: string }> {
    return unconfirmedCancel(this.providerName);
  }
}

// -----------------------------------------------------------------------------
// 5. M&P Courier Adapter (Muller & Phipps Express API)
// -----------------------------------------------------------------------------
export class MnPCourierAdapter implements ICourierAdapter {
  readonly providerName = "MNP";
  readonly displayName = "M&P Courier (Muller & Phipps)";
  readonly description = "Credentials can be saved, but M&P booking and tracking are not currently integrated in BYNDCART. Enter the airway bill manually.";
  readonly cityHubs = ["Karachi", "Lahore", "Islamabad", "Rawalpindi", "Faisalabad", "Sargodha"];
  readonly isLive = false;

  async testConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
    if (!input.config.apiToken) {
      return { success: false, message: "M&P Account credentials are required.", isLive: false };
    }
    return credentialsStored("M&P");
  }

  async createReverseShipment(_input?: ShipmentInput, _credentials?: unknown): Promise<LabelResult> {
    return unconfirmedBooking(this.providerName);
  }

  async createForwardShipment(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.createReverseShipment(input, credentials);
  }

  async generateReturnLabel(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.createReverseShipment(input, credentials);
  }

  async trackShipment(trackingNumber: string): Promise<TrackingStatusResult> {
    return unconfirmedTracking(this.providerName, trackingNumber);
  }

  async cancelShipment(_trackingNumber?: string): Promise<{ success: boolean; message?: string }> {
    return unconfirmedCancel(this.providerName);
  }
}

// -----------------------------------------------------------------------------
// 6. CallCourier Adapter (Doorstep Pickup Merchant API)
// -----------------------------------------------------------------------------
export class CallCourierAdapter implements ICourierAdapter {
  readonly providerName = "CALLCOURIER";
  readonly displayName = "CallCourier Express Returns";
  readonly description = "Credentials can be saved, but CallCourier booking and tracking are not currently integrated in BYNDCART. Enter the airway bill manually.";
  readonly cityHubs = ["Lahore", "Karachi", "Rawalpindi", "Peshawar", "Quetta", "Bahawalpur"];
  readonly isLive = false;

  async testConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
    if (!input.config.apiToken) {
      return { success: false, message: "CallCourier login credentials are required.", isLive: false };
    }
    return credentialsStored("CallCourier");
  }

  async createReverseShipment(_input?: ShipmentInput, _credentials?: unknown): Promise<LabelResult> {
    return unconfirmedBooking(this.providerName);
  }

  async createForwardShipment(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.createReverseShipment(input, credentials);
  }

  async generateReturnLabel(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.createReverseShipment(input, credentials);
  }

  async trackShipment(trackingNumber: string): Promise<TrackingStatusResult> {
    return unconfirmedTracking(this.providerName, trackingNumber);
  }

  async cancelShipment(_trackingNumber?: string): Promise<{ success: boolean; message?: string }> {
    return unconfirmedCancel(this.providerName);
  }
}

// -----------------------------------------------------------------------------
// Courier Registry & Database Configuration Resolvers
// -----------------------------------------------------------------------------
export interface CourierSetupField {
  key: "apiToken" | "accountNumber";
  label: string;
  placeholder: string;
  required: boolean;
  secret?: boolean;
}

const COURIER_SETUP: Record<string, { instructions: string; fields: CourierSetupField[] }> = {
  POSTEX: {
    instructions: "PostEx return booking is the only live booking integration currently implemented. Save the store's API token, test the connection, and collect a real pickup phone number and full pickup address. Forward/exchange booking, tracking, and cancellation are not integrated. Vendor docs: https://api.postex.pk/services/integration/api",
    fields: [{ key: "apiToken", label: "API Token", placeholder: "PostEx API token", required: true, secret: true }],
  },
  LEOPARDS: {
    instructions: "Save the Leopards merchant API key/password here for reference. BYNDCART does not currently verify this credential or create/track Leopards shipments; book with Leopards and enter the airway bill manually. Vendor docs: https://merchantapi.leopardscourier.com/api",
    fields: [{ key: "apiToken", label: "API Key / Password", placeholder: "Leopards API key or password", required: true, secret: true }],
  },
  TRAX: {
    instructions: "Save the Trax merchant API token here for reference. BYNDCART does not currently verify this credential or create/track Trax shipments; book with Trax and enter the airway bill manually. Vendor docs: https://api.trax.pk/v1",
    fields: [{ key: "apiToken", label: "API Token", placeholder: "Trax API token", required: true, secret: true }],
  },
  TCS: {
    instructions: "Save the TCS API key and cost center code here for reference. BYNDCART does not currently verify these credentials or create/track TCS shipments; book with TCS and enter the airway bill manually. Vendor docs: https://atnetservices.tcscourier.com/api",
    fields: [
      { key: "apiToken", label: "API Key", placeholder: "TCS API key", required: true, secret: true },
      { key: "accountNumber", label: "Cost Center Code", placeholder: "TCS cost center code", required: true },
    ],
  },
  MNP: {
    instructions: "Save the M&P merchant API token here for reference. BYNDCART does not currently verify this credential or create/track M&P shipments; book with M&P and enter the airway bill manually.",
    fields: [{ key: "apiToken", label: "API Token", placeholder: "M&P API token", required: true, secret: true }],
  },
  CALLCOURIER: {
    instructions: "Save the CallCourier login/API credential here for reference. BYNDCART does not currently verify this credential or create/track CallCourier shipments; book with CallCourier and enter the airway bill manually.",
    fields: [{ key: "apiToken", label: "Login / API Credential", placeholder: "CallCourier API credential", required: true, secret: true }],
  },
  RIDER: {
    instructions: "No Rider booking or tracking API is connected in BYNDCART. You can save an account reference, then enter airway bills manually.",
    fields: [{ key: "apiToken", label: "Account reference", placeholder: "Rider account reference", required: false, secret: true }],
  },
};

export class CourierRegistry {
  private static adapters = new Map<string, ICourierAdapter>();
  private static defaultAdapter: ICourierAdapter = new TCSCourierAdapter();

  static register(adapter: ICourierAdapter) {
    this.adapters.set(adapter.providerName.toUpperCase(), adapter);
  }

  static get(providerName?: string): ICourierAdapter {
    if (!providerName) return this.defaultAdapter;
    const normalized = providerName.trim().toUpperCase();
    const adapter = this.adapters.get(normalized);
    if (!adapter) throw new Error(`Unsupported courier provider: ${normalized}`);
    return adapter;
  }

  static has(providerName: string): boolean {
    return this.adapters.has(providerName.trim().toUpperCase());
  }

  static getRegisteredAdapters(): Array<{
    providerName: string;
    displayName: string;
    description: string;
    cityHubs?: string[];
    isLive: boolean;
    instructions: string;
    fields: CourierSetupField[];
  }> {
    return Array.from(this.adapters.values()).map((a) => ({
      providerName: a.providerName,
      displayName: a.displayName,
      description: a.description,
      cityHubs: a.cityHubs,
      isLive: a.isLive,
      instructions: COURIER_SETUP[a.providerName]?.instructions || a.description,
      fields: COURIER_SETUP[a.providerName]?.fields || [
        { key: "apiToken", label: "API Token", placeholder: "API token", required: true, secret: true },
      ],
    }));
  }
}

export class RiderCourierAdapter implements ICourierAdapter {
  readonly providerName = "RIDER";
  readonly displayName = "Rider";
  readonly description = "Manual airway-bill workflow only. No Rider booking or tracking API is connected in BYNDCART.";
  readonly cityHubs = ["Karachi", "Lahore", "Islamabad"];
  readonly isLive = false;

  async testConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
    if (!input.config.apiToken) {
      return { success: false, message: "A Rider account reference is required to save this courier.", isLive: false };
    }
    return credentialsStored("Rider");
  }

  async createReverseShipment(_input?: ShipmentInput, _credentials?: unknown): Promise<LabelResult> {
    return unconfirmedBooking(this.providerName);
  }

  async createForwardShipment(): Promise<LabelResult> {
    return unconfirmedBooking(this.providerName);
  }

  async generateReturnLabel(): Promise<LabelResult> {
    return unconfirmedBooking(this.providerName);
  }

  async trackShipment(trackingNumber: string): Promise<TrackingStatusResult> {
    return unconfirmedTracking(this.providerName, trackingNumber);
  }

  async cancelShipment(_trackingNumber?: string): Promise<{ success: boolean; message?: string }> {
    return unconfirmedCancel(this.providerName);
  }
}

// Register Pakistani courier adapters. Only PostEx attempts a live booking call.
CourierRegistry.register(new TCSCourierAdapter());
CourierRegistry.register(new LeopardsCourierAdapter());
CourierRegistry.register(new TraxCourierAdapter());
CourierRegistry.register(new MnPCourierAdapter());
CourierRegistry.register(new PostExCourierAdapter());
CourierRegistry.register(new CallCourierAdapter());
CourierRegistry.register(new RiderCourierAdapter());

/**
 * Saves/updates tenant-scoped merchant courier configuration with encrypted credentials.
 */
export async function saveMerchantCourierConfig(
  shopifyStoreId: string,
  providerName: string,
  data: {
    apiToken?: string;
    accountNumber?: string;
    additionalConfig?: any;
    enabled?: boolean;
    isDefaultReverse?: boolean;
    isDefaultForward?: boolean;
  }
) {
  const normalizedProvider = providerName.trim().toUpperCase();
  if (!normalizedProvider || !CourierRegistry.has(normalizedProvider)) {
    throw new Error("Unsupported courier provider.");
  }
  const trimmedToken = data.apiToken?.trim() || "";
  const encryptedApiToken = trimmedToken ? encryptCredential(trimmedToken) : "";

  // If setting default reverse/forward, un-set existing defaults for this store
  if (data.isDefaultReverse) {
    await prisma.merchantCourierConfig.updateMany({
      where: { shopifyStoreId, isDefaultReverse: true },
      data: { isDefaultReverse: false },
    });
  }

  if (data.isDefaultForward) {
    await prisma.merchantCourierConfig.updateMany({
      where: { shopifyStoreId, isDefaultForward: true },
      data: { isDefaultForward: false },
    });
  }

  const isLive = false;

  const config = await prisma.merchantCourierConfig.upsert({
    where: {
      shopifyStoreId_providerName: {
        shopifyStoreId,
        providerName: normalizedProvider,
      },
    },
    update: {
      ...(trimmedToken ? { encryptedApiToken } : {}),
      ...(data.accountNumber !== undefined ? { accountNumber: data.accountNumber } : {}),
      ...(data.additionalConfig !== undefined ? { additionalConfig: data.additionalConfig } : {}),
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      ...(data.isDefaultReverse !== undefined ? { isDefaultReverse: data.isDefaultReverse } : {}),
      ...(data.isDefaultForward !== undefined ? { isDefaultForward: data.isDefaultForward } : {}),
      isLive,
    },
    create: {
      shopifyStoreId,
      providerName: normalizedProvider,
      encryptedApiToken: encryptedApiToken || "",
      accountNumber: data.accountNumber || null,
      additionalConfig: data.additionalConfig || null,
      enabled: data.enabled !== undefined ? data.enabled : true,
      isDefaultReverse: !!data.isDefaultReverse,
      isDefaultForward: !!data.isDefaultForward,
      isLive,
    },
  });

  await prisma.auditLog.create({
    data: {
      shopifyStoreId,
      action: "COURIER_CONFIG_UPDATED",
      entityType: "MerchantCourierConfig",
      entityId: config.id,
      metadata: { providerName: normalizedProvider, enabled: config.enabled },
    },
  });

  return config;
}

/**
 * Loads merchant courier configurations for UI display, masking API credentials.
 */
export async function getStoreCourierConfigs(shopifyStoreId: string) {
  const configs = await prisma.merchantCourierConfig.findMany({
    where: { shopifyStoreId },
  });

  return configs.map((c) => {
    let maskedToken = "";
    if (c.encryptedApiToken) {
      try {
        maskedToken = maskCredential(c.encryptedApiToken);
      } catch {
        maskedToken = "";
      }
    }
    return {
      id: c.id,
      providerName: c.providerName,
      accountNumber: c.accountNumber,
      maskedToken,
      hasToken: !!c.encryptedApiToken,
      enabled: c.enabled,
      isDefaultReverse: c.isDefaultReverse,
      isDefaultForward: c.isDefaultForward,
      isLive: c.isLive,
      updatedAt: c.updatedAt,
    };
  });
}

/**
 * Retrieves decrypted merchant credentials for courier API execution.
 */
export async function getDecryptedCourierCredentials(shopifyStoreId: string, providerName: string) {
  try {
    const config = await prisma.merchantCourierConfig.findUnique({
      where: {
        shopifyStoreId_providerName: {
          shopifyStoreId,
          providerName: providerName.toUpperCase(),
        },
      },
    });

    if (!config || !config.enabled) return null;

    return {
      apiToken: decryptCredential(config.encryptedApiToken),
      accountNumber: config.accountNumber,
      additionalConfig: config.additionalConfig,
      isLive: config.isLive,
    };
  } catch {
    return null;
  }
}

/**
 * Resolves the merchant's default configured courier for reverse or forward shipments.
 */
export async function getDefaultMerchantCourier(shopifyStoreId: string, type: "REVERSE" | "FORWARD" = "REVERSE") {
  const field = type === "REVERSE" ? "isDefaultReverse" : "isDefaultForward";

  try {
    const defaultConfig = await prisma.merchantCourierConfig.findFirst({
      where: {
        shopifyStoreId,
        [field]: true,
        enabled: true,
      },
    });

    if (defaultConfig) {
      return CourierRegistry.get(defaultConfig.providerName);
    }

    const firstEnabled = await prisma.merchantCourierConfig.findFirst({
      where: { shopifyStoreId, enabled: true },
    });

    if (firstEnabled) {
      return CourierRegistry.get(firstEnabled.providerName);
    }
  } catch {
    // Offline unit test fallback
  }

  return CourierRegistry.get("TCS");
}

