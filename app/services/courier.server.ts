import prisma from "../db.server";
import { createHash } from "node:crypto";
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

  if (s.includes("UNBOOKED") || s.includes("BOOKED") || s.includes("CREATED") || s.includes("LABEL") || s.includes("PENDING") || s.includes("NEW") || s.includes("MERCHANT'S WAREHOUSE") || s.includes("MERCHANTS WAREHOUSE")) {
    return "LABEL_CREATED";
  }
  if (s.includes("POSTEX WAREHOUSE") || s.includes("TRANSIT") || s.includes("DISPATCH") || s.includes("ARRIVED") || s.includes("HUB") || s.includes("DEPARTED") || s.includes("PACKAGE ON ROUTE") || s.includes("PACKAGE ON ROOT")) {
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


function normalizePakistanMobileNumber(raw?: string): string {
  let digits = String(raw || "").replace(/[^0-9]/g, "");
  if (digits.startsWith("0092")) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith("92") && digits.length === 12) digits = `0${digits.slice(2)}`;
  else if (digits.length === 10 && digits.startsWith("3")) digits = `0${digits}`;
  if (!/^03[0-9]{9}$/.test(digits)) {
    throw new Error("Enter a valid Pakistani mobile number, for example 03XXXXXXXXX.");
  }
  return digits;
}

export interface TestConnectionInput {
  shopifyStoreId: string;
  config: Record<string, any> & {
    apiToken?: string;
    apiKey?: string;
    apiPassword?: string;
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
  /** Pakistani city name for the customer pickup/delivery address. */
  cityName?: string;
  /** RETURN uses customer address as origin; FORWARD/EXCHANGE uses destinationAddress. */
  shipmentType?: "RETURN" | "FORWARD" | "EXCHANGE";
  /** Carrier-specific API order type selected in the booking grid, e.g. PostEx Overland. */
  courierServiceType?: string;
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
  /** Base64-encoded carrier label, persisted server-side for authenticated downloads. */
  labelContentBase64?: string;
  labelContentType?: string;
  labelFileName?: string;
  /** Carrier's own initial state, e.g. PostEx "UnBooked" after order creation. */
  carrierStatus?: string;
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
  /** False when the provided provider contract does not expose shipment cancellation. */
  readonly supportsCancellation?: boolean;

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
    error: message || `${courierName} did not confirm the API booking. No shipment was created.`,
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
    message: `${provider} credentials were received by the settings form, but no live API connection was verified.`,
  };
}

export function unconfirmedCancel(provider: string) {
  return {
    success: false,
    message: `${provider} cancellation is not implemented or was not confirmed by the carrier API.`,
  };
}

// -----------------------------------------------------------------------------
// 1. PostEx Courier Adapter (Live REST API Integration)
// Official API Docs: https://api.postex.pk/services/integration/api
// Headers: token: <apiToken>
// -----------------------------------------------------------------------------
const POSTEX_API_ROOT = "https://api.postex.pk/services/integration/api";
const LEOPARDS_PRODUCTION_API_ROOT = "https://merchantapi.leopardscourier.com/api";
const LEOPARDS_STAGING_API_ROOT = "https://merchantapistaging.leopardscourier.com/api";

function leopardsApiRoot(credentials: any): string {
  return credentialValue(credentials, "environment").toLowerCase() === "staging"
    ? LEOPARDS_STAGING_API_ROOT
    : LEOPARDS_PRODUCTION_API_ROOT;
}

type LeopardsCity = { id: number | string; name: string; allow_as_origin?: boolean; allow_as_destination?: boolean };

function credentialValue(credentials: any, key: string): string {
  const value = credentials?.[key] ?? credentials?.credentials?.[key];
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function apiPayloadMessage(payload: any, fallback: string): string {
  return String(payload?.error || payload?.statusMessage || payload?.message || fallback);
}

function extractNumericShopifyId(orderId: string): number {
  const match = String(orderId || "").match(/(\d+)$/);
  if (!match) throw new Error("A valid Shopify order ID is required for Leopards shipment booking.");
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("The Shopify order ID is not a valid numeric shipment ID.");
  return id;
}

async function readJson(response: Response): Promise<any> {
  try { return await response.json(); } catch { return null; }
}

async function loadLeopardsCities(apiKey: string, apiPassword: string, apiRoot = LEOPARDS_PRODUCTION_API_ROOT): Promise<LeopardsCity[]> {
  const response = await fetch(`${apiRoot}/getAllCities/format/json/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ api_key: apiKey, api_password: apiPassword }),
  });
  const payload = await readJson(response);
  if (!response.ok || ![1, "1", true].includes(payload?.status) || !Array.isArray(payload?.city_list) || payload.city_list.length === 0) {
    throw new Error(apiPayloadMessage(payload, "Leopards did not return a valid city list. Verify the API key/password and production access."));
  }
  return payload.city_list as LeopardsCity[];
}

function resolveLeopardsCityId(cities: LeopardsCity[], cityName: string, purpose: "origin" | "destination"): number {
  const normalized = cityName.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  if (!normalized) throw new Error(`Enter the ${purpose} city required by Leopards.`);
  const city = cities.find((candidate) => String(candidate.name || "").trim().toLocaleLowerCase().replace(/\s+/g, " ") === normalized);
  if (!city) {
    const suggestions = cities.map((item) => item.name).filter(Boolean).slice(0, 8).join(", ");
    throw new Error(`Leopards does not recognise city "${cityName}". Check the city spelling against the carrier city list${suggestions ? ` (examples: ${suggestions})` : ""}.`);
  }
  const allowed = purpose === "origin" ? city.allow_as_origin : city.allow_as_destination;
  if (allowed === false || String(allowed).toLowerCase() === "false" || String(allowed) === "0") {
    throw new Error(`Leopards does not allow ${city.name} as a shipment ${purpose}.`);
  }
  const id = Number(city.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Leopards returned an invalid city ID for ${city.name}.`);
  return id;
}

async function validatePostExCity(
  shopifyStoreId: string,
  cityName: string,
  orderType: string,
  fallbackToken?: string,
): Promise<void> {
  const operationalCityType = orderType === "Reverse" || orderType === "Reversed" ? "Pickup" : "Delivery";
  const normalized = cityName.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  if (!normalized) throw new Error("Enter a city supported by PostEx.");

  // Reuse the store's persisted carrier catalog so each booking does not call the city API again.
  let availableCities: string[];
  try {
    const options = await getMerchantCourierBookingOptions(shopifyStoreId, "POSTEX");
    availableCities = operationalCityType === "Pickup" ? options.pickupCities : options.deliveryCities;
  } catch (error) {
    // Direct-token fallback is only for adapter integrations without a saved merchant config
    // (for example API adapter tests). A configured merchant always uses the persisted catalog.
    const message = error instanceof Error ? error.message : "";
    if (!fallbackToken || !message.includes("POSTEX is not configured or enabled")) throw error;
    const response = await fetch(`${POSTEX_API_ROOT}/order/v2/get-operational-city?operationalCityType=${operationalCityType}`, {
      method: "GET",
      headers: { token: fallbackToken, Accept: "application/json" },
    });
    const payload = await readJson(response);
    if (!response.ok || Number(payload?.statusCode) !== 200 || !Array.isArray(payload?.dist)) {
      throw new Error(apiPayloadMessage(payload, "PostEx could not verify its operational city list."));
    }
    const flag = operationalCityType === "Pickup" ? "isPickupCity" : "isDeliveryCity";
    availableCities = uniqueOptionStrings(payload.dist
      .filter((row: any) => row && (row[flag] === undefined || row[flag] === true || String(row[flag]).toLowerCase() === "true" || String(row[flag]) === "1"))
      .map((row: any) => row.operationalCityName || row.cityName || row.name));
  }

  const city = availableCities.find((name) => name.trim().toLocaleLowerCase().replace(/\s+/g, " ") === normalized);
  if (!city) {
    const names = availableCities.slice(0, 8).join(", ");
    throw new Error(
      'PostEx does not list "' + cityName + '" as a ' + operationalCityType.toLowerCase() + " city"
      + (names ? ". Examples returned by PostEx: " + names : "")
      + ". Use the exact city name supplied by the carrier."
    );
  }
}

// -----------------------------------------------------------------------------
// 1. PostEx Merchant API (official guide v4.1.9)
// Token header; create-order v3; tracking, airway-bill and cancellation endpoints.
// -----------------------------------------------------------------------------
export class PostExCourierAdapter implements ICourierAdapter {
  readonly providerName = "POSTEX";
  readonly displayName = "PostEx";
  readonly description = "PostEx Merchant API: reverse returns, normal shipments, replacement shipments, tracking and cancellation.";
  readonly cityHubs = ["Karachi", "Lahore", "Islamabad", "Rawalpindi", "Faisalabad", "Multan", "Peshawar", "Quetta", "Sialkot"];
  readonly isLive = true;

  async testConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
    const token = credentialValue(input.config, "apiToken");
    if (!token) return { success: false, message: "Enter the PostEx merchant API token.", isLive: false };
    try {
      const response = await fetch(`${POSTEX_API_ROOT}/order/v2/get-operational-city`, {
        method: "GET",
        headers: { token, Accept: "application/json" },
      });
      const payload = await readJson(response);
      const success = response.ok
        && Number(payload?.statusCode) === 200
        && String(payload?.statusMessage || "").toUpperCase().includes("SUCCESSFULLY OPERATED")
        && Array.isArray(payload?.dist);
      return success
        ? { success: true, message: "PostEx token verified against the Operational Cities API.", isLive: true }
        : { success: false, message: apiPayloadMessage(payload, "PostEx did not verify the token. Check the token and merchant account access."), isLive: false };
    } catch {
      return { success: false, message: "PostEx could not be reached. Check the connection and retry.", isLive: false };
    }
  }

  private async createOrder(input: ShipmentInput, credentials: any, orderType: string): Promise<LabelResult> {
    const token = credentialValue(credentials, "apiToken");
    if (!token) return unconfirmedBooking(this.providerName, "PostEx merchant API token is missing for this store.");

    const isReturn = orderType === "Reverse" || orderType === "Reversed";
    const address = isReturn ? input.originAddress : input.destinationAddress;
    const customerName = String(input.customerName || "").trim();
    const customerPhoneRaw = String(input.customerPhone || "").trim();
    const customerAddress = String(address?.address1 || address?.address || "").trim();
    const cityName = String(input.cityName || address?.city || "").trim();
    if (!customerName) return unconfirmedBooking(this.providerName, "Customer name is required by PostEx.");
    if (!customerAddress || customerAddress.length < 8) return unconfirmedBooking(this.providerName, "Enter a complete customer address before booking through PostEx.");
    if (!cityName) return unconfirmedBooking(this.providerName, "Enter the customer's city as required by PostEx.");

    let customerPhone: string;
    try { customerPhone = normalizePakistanMobileNumber(customerPhoneRaw); }
    catch (error) { return unconfirmedBooking(this.providerName, error instanceof Error ? error.message : "Enter a valid Pakistani mobile number."); }

    const ref = String(input.orderNumber || input.orderId).trim().slice(0, 80);
    const quantity = Math.max(1, (input.items || []).reduce((sum, item) => sum + Math.max(0, Number(item.quantity) || 0), 0));
    const details = (input.items || []).map((item) => `${item.title} x ${item.quantity}`).join(", ").slice(0, 500);
    const body: Record<string, unknown> = {
      orderRefNumber: ref,
      invoicePayment: String(isReturn ? 0 : Math.max(0, Number(input.codAmountPKR) || 0)),
      orderDetail: details || `BYNDCART ${orderType.toLowerCase()} shipment for ${ref}`,
      customerName,
      customerPhone,
      deliveryAddress: customerAddress,
      transactionNotes: String(input.remarks || `BYNDCART ${orderType.toLowerCase()} shipment for ${ref}`).slice(0, 500),
      cityName,
      invoiceDivision: 1,
      items: quantity,
      // The UI displays "Reversed" as "Reverse"; send the provider's literal type value.
      orderType: orderType === "Reverse" ? "Reversed" : orderType,
    };
    const pickupAddressCode = credentialValue(credentials, "pickupAddressCode");
    const storeAddressCode = credentialValue(credentials, "storeAddressCode");
    if (pickupAddressCode) body.pickupAddressCode = pickupAddressCode;
    if (storeAddressCode) body.storeAddressCode = storeAddressCode;

    try {
      await validatePostExCity(input.shopifyStoreId, cityName, orderType, token);
    } catch (error) {
      return unconfirmedBooking(this.providerName, error instanceof Error ? error.message : "PostEx could not verify the pickup or delivery city.");
    }

    try {
      const response = await fetch(`${POSTEX_API_ROOT}/order/v3/create-order`, {
        method: "POST",
        headers: { token, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await readJson(response);
      const trackingNumber = String(payload?.dist?.trackingNumber || payload?.trackingNumber || "").trim();
      const accepted = response.ok && Number(payload?.statusCode) === 200 && trackingNumber.length > 0;
      if (!accepted) {
        return unconfirmedBooking(this.providerName, apiPayloadMessage(payload, "PostEx did not return statusCode 200 and a tracking number. No shipment record was created."));
      }
      return {
        success: true,
        trackingNumber,
        courierName: this.providerName,
        rawResponse: payload,
        carrierStatus: String(payload?.dist?.orderStatus || ""),
        isLive: true,
        // PostEx's documented create-order response does not contain a label URL. The protected
        // invoice proxy route builds the authenticated download URL for the merchant dashboard.
      };
    } catch {
      return unconfirmedBooking(this.providerName, "PostEx could not be reached. No API-confirmed shipment was recorded.");
    }
  }

  async createReverseShipment(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.createOrder({ ...input, shipmentType: "RETURN" }, credentials, "Reverse");
  }

  async generateReturnLabel(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.createReverseShipment(input, credentials);
  }

  async createForwardShipment(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    const selectedType = String(input.courierServiceType || "").trim();
    const orderType = selectedType && selectedType !== "Reverse" && selectedType !== "Reversed"
      ? selectedType
      : input.shipmentType === "EXCHANGE" ? "Replacement" : "Normal";
    return this.createOrder(input, credentials, orderType);
  }

  async trackShipment(trackingNumber: string, credentials?: any): Promise<TrackingStatusResult> {
    const token = credentialValue(credentials, "apiToken");
    if (!token) throw new Error("PostEx merchant API token is missing for this store.");
    const safeTracking = String(trackingNumber || "").trim();
    if (!safeTracking) throw new Error("A PostEx tracking number is required.");
    const response = await fetch(`${POSTEX_API_ROOT}/order/v1/track-order/${encodeURIComponent(safeTracking)}`, {
      method: "GET",
      headers: { token, Accept: "application/json" },
    });
    const payload = await readJson(response);
    if (!response.ok || Number(payload?.statusCode) !== 200 || !payload?.dist) {
      throw new Error(apiPayloadMessage(payload, "PostEx tracking lookup failed."));
    }
    const dist = payload.dist;
    const history = Array.isArray(dist.transactionStatusHistory) ? dist.transactionStatusHistory : [];
    const statusCandidate = String(dist.transactionStatus || dist.orderStatus || "").trim();
    // The API-level statusMessage is usually "SUCCESSFULLY OPERATED"; it is not a parcel
    // status and must never be normalized as DELIVERED. Use carrier tracking history as a fallback.
    const latestHistoryMessage = String(history[history.length - 1]?.transactionStatusMessage || "").trim();
    const rawStatus = statusCandidate && normalizeCourierStatus(statusCandidate) !== "UNKNOWN"
      ? statusCandidate
      : latestHistoryMessage || statusCandidate || "UNKNOWN";
    const historyEvents = history.map((item: any) => ({
      timestamp: item?.activityDate || item?.createdAt ? new Date(item.activityDate || item.createdAt) : new Date(NaN),
      status: normalizeCourierStatus(String(item?.transactionStatusMessage || item?.transactionStatusMessageCode || "UNKNOWN")),
      description: String(item?.transactionStatusMessage || item?.transactionStatusMessageCode || "Status update"),
    })).filter((item: any) => !Number.isNaN(item.timestamp.getTime()));
    return {
      trackingNumber: safeTracking,
      courierName: this.providerName,
      status: normalizeCourierStatus(rawStatus),
      rawStatus,
      location: dist.cityName ? String(dist.cityName) : undefined,
      updatedAt: new Date(),
      events: historyEvents,
      rawPayload: payload,
    };
  }

  async cancelShipment(trackingNumber: string, credentials?: any): Promise<{ success: boolean; message?: string }> {
    const token = credentialValue(credentials, "apiToken");
    if (!token) return { success: false, message: "PostEx merchant API token is missing for this store." };
    const normalizedTracking = String(trackingNumber || "").trim();
    if (!normalizedTracking) return { success: false, message: "A PostEx tracking number is required." };
    try {
      const response = await fetch(`${POSTEX_API_ROOT}/order/v1/cancel-order`, {
        method: "PUT",
        headers: { token, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ trackingNumber: normalizedTracking }),
      });
      const payload = await readJson(response);
      const bodyCodeExists = payload?.statusCode !== undefined;
      const success = response.ok && (!bodyCodeExists || Number(payload.statusCode) === 200) && payload?.success !== false;
      return success
        ? { success: true, message: "PostEx accepted the cancellation request." }
        : { success: false, message: apiPayloadMessage(payload, `PostEx cancellation failed (HTTP ${response.status}).`) };
    } catch {
      return { success: false, message: "PostEx could not be reached. Cancellation was not confirmed." };
    }
  }
}

// -----------------------------------------------------------------------------
// 2. Leopards Courier Merchant API (eCom Merchant APIs V2 PDF)
// Production endpoints use api_key + api_password in JSON request bodies.
// -----------------------------------------------------------------------------
export class LeopardsCourierAdapter implements ICourierAdapter {
  readonly providerName = "LEOPARDS";
  readonly displayName = "Leopards Courier";
  readonly description = "Leopards Merchant API: booking, CN tracking and cancellation. Configure API key/password plus warehouse details for return pickups.";
  readonly cityHubs = ["Karachi", "Lahore", "Islamabad", "Rawalpindi", "Faisalabad", "Multan", "Peshawar", "Quetta", "Sialkot", "Hyderabad"];
  readonly isLive = true;

  async testConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
    const apiKey = credentialValue(input.config, "apiKey");
    const apiPassword = credentialValue(input.config, "apiPassword");
    if (!apiKey || !apiPassword) return { success: false, message: "Enter both the Leopards API key and API password.", isLive: false };
    try {
      const cities = await loadLeopardsCities(apiKey, apiPassword, leopardsApiRoot(input.config));
      return { success: true, message: `Leopards API credentials verified. ${cities.length} cities were returned.`, isLive: true };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "Leopards API credential verification failed.", isLive: false };
    }
  }

  private async bookPacket(input: ShipmentInput, credentials: any, direction: "RETURN" | "FORWARD" | "EXCHANGE"): Promise<LabelResult> {
    const apiKey = credentialValue(credentials, "apiKey");
    const apiPassword = credentialValue(credentials, "apiPassword");
    if (!apiKey || !apiPassword) return unconfirmedBooking(this.providerName, "Leopards requires both API key and API password for this store.");

    const warehouseCity = credentialValue(credentials, "warehouseCity");
    const warehouseAddress = credentialValue(credentials, "warehouseAddress");
    const warehouseName = credentialValue(credentials, "warehouseContactName");
    const warehousePhoneRaw = credentialValue(credentials, "warehousePhone");
    const warehouseEmail = credentialValue(credentials, "warehouseEmail");
    const weightGrams = Math.round(Number(input.weightKg ? Number(input.weightKg) * 1000 : credentialValue(credentials, "defaultWeightGrams")));
    if (!warehouseCity || !warehouseAddress || !warehouseName || !warehousePhoneRaw) {
      return unconfirmedBooking(this.providerName, "Complete the Leopards warehouse city, address, contact name, and phone in Courier settings before booking.");
    }
    if (!Number.isFinite(weightGrams) || weightGrams <= 0) {
      return unconfirmedBooking(this.providerName, "Set a valid default return parcel weight in grams in Leopards Courier settings. The Leopards API requires weight in grams.");
    }

    const customerName = String(input.customerName || "").trim();
    const customerEmail = String(input.customerEmail || "").trim();
    const customerCity = String(input.cityName || (direction === "RETURN" ? input.originAddress?.city : input.destinationAddress?.city) || "").trim();
    const customerAddress = String((direction === "RETURN" ? input.originAddress : input.destinationAddress)?.address1 || (direction === "RETURN" ? input.originAddress : input.destinationAddress)?.address || "").trim();
    let customerPhone = "";
    let warehousePhone = "";
    try {
      customerPhone = normalizePakistanMobileNumber(input.customerPhone);
      warehousePhone = normalizePakistanMobileNumber(warehousePhoneRaw);
    } catch (error) {
      return unconfirmedBooking(this.providerName, error instanceof Error ? error.message : "Enter valid Pakistani mobile numbers.");
    }
    if (!customerName || customerName.length < 2) return unconfirmedBooking(this.providerName, "A valid customer name is required by Leopards.");
    if (!customerCity) return unconfirmedBooking(this.providerName, "Enter the customer's city before booking through Leopards.");
    if (!customerAddress || customerAddress.length < 8) return unconfirmedBooking(this.providerName, "Enter the full customer address before booking through Leopards.");

    // The supplied Leopards eCom API (v2) documents bookPacket only. It does not publish a
    // separate reverse-pickup endpoint. Returns use that same endpoint with the customer as
    // shipper and the merchant warehouse as consignee. Confirm this mapping in Leopards staging
    // before customer returns go live.
    const reverse = direction === "RETURN";
    const senderCityName = reverse ? customerCity : warehouseCity;
    const receiverCityName = reverse ? warehouseCity : customerCity;
    let cities: LeopardsCity[];
    let originCity: number;
    let destinationCity: number;
    try {
      cities = await getCachedLeopardsCityRecords(input.shopifyStoreId, credentials);
      originCity = resolveLeopardsCityId(cities, senderCityName, "origin");
      destinationCity = resolveLeopardsCityId(cities, receiverCityName, "destination");
    } catch (error) {
      return unconfirmedBooking(this.providerName, error instanceof Error ? error.message : "Could not resolve Leopards origin/destination cities.");
    }

    let shipmentId: number;
    try { shipmentId = extractNumericShopifyId(input.orderId); }
    catch (error) { return unconfirmedBooking(this.providerName, error instanceof Error ? error.message : "Shopify order ID is invalid."); }

    const sender = reverse
      ? { name: customerName, email: customerEmail, phone: customerPhone, address: customerAddress }
      : { name: warehouseName, email: warehouseEmail, phone: warehousePhone, address: warehouseAddress };
    const receiver = reverse
      ? { name: warehouseName, email: warehouseEmail, phone: warehousePhone, address: warehouseAddress }
      : { name: customerName, email: customerEmail, phone: customerPhone, address: customerAddress };

    const pieces = Math.max(1, (input.items || []).reduce((sum, item) => sum + Math.max(0, Number(item.quantity) || 0), 0));
    const totalCod = reverse ? 0 : Math.max(0, Math.round(Number(input.codAmountPKR) || 0));
    const body = {
      api_key: apiKey,
      api_password: apiPassword,
      booked_packet_weight: weightGrams,
      booked_packet_no_piece: pieces,
      booked_packet_collect_amount: totalCod,
      booked_packet_order_id: String(input.orderNumber || input.orderId),
      origin_city: originCity,
      destination_city: destinationCity,
      shipment_id: shipmentId,
      shipment_name_eng: sender.name,
      shipment_email: sender.email,
      shipment_phone: sender.phone,
      shipment_address: sender.address,
      consignment_name_eng: receiver.name,
      consignment_email: receiver.email,
      consignment_phone: receiver.phone,
      consignment_address: receiver.address,
      special_instructions: String(input.remarks || `BYNDCART ${direction.toLowerCase()} shipment`).slice(0, 500),
      ...(reverse ? { return_address: customerAddress, return_city: originCity } : { return_address: warehouseAddress, return_city: originCity }),
    };

    try {
      const response = await fetch(`${apiRoot}/bookPacket/format/json/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await readJson(response);
      const trackingNumber = String(payload?.track_number || payload?.trackNumber || "").trim();
      const accepted = response.ok && [1, "1", true].includes(payload?.status) && trackingNumber.length > 0;
      if (!accepted) {
        return unconfirmedBooking(this.providerName, apiPayloadMessage(payload, "Leopards did not return status 1 and a consignment number. No shipment record was created."));
      }
      return {
        success: true,
        trackingNumber,
        labelUrl: typeof payload?.slip_link === "string" ? payload.slip_link : undefined,
        courierName: this.providerName,
        rawResponse: payload,
        isLive: true,
      };
    } catch {
      return unconfirmedBooking(this.providerName, "Leopards could not be reached. No API-confirmed shipment was recorded.");
    }
  }

  async createReverseShipment(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.bookPacket({ ...input, shipmentType: "RETURN" }, credentials, "RETURN");
  }

  async generateReturnLabel(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.createReverseShipment(input, credentials);
  }

  async createForwardShipment(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.bookPacket(input, credentials, input.shipmentType === "EXCHANGE" ? "EXCHANGE" : "FORWARD");
  }

  async trackShipment(trackingNumber: string, credentials?: any): Promise<TrackingStatusResult> {
    const apiKey = credentialValue(credentials, "apiKey");
    const apiPassword = credentialValue(credentials, "apiPassword");
    const apiRoot = leopardsApiRoot(credentials);
    const safeTracking = String(trackingNumber || "").trim();
    if (!apiKey || !apiPassword) throw new Error("Leopards API key/password are missing for this store.");
    if (!safeTracking) throw new Error("A Leopards consignment number is required.");
    const response = await fetch(`${apiRoot}/trackBookedPacket/format/json/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ api_key: apiKey, api_password: apiPassword, track_numbers: safeTracking }),
    });
    const payload = await readJson(response);
    if (!response.ok || ![1, "1", true].includes(payload?.status) || !Array.isArray(payload?.packet_list)) {
      throw new Error(apiPayloadMessage(payload, "Leopards tracking lookup failed."));
    }
    const packet = payload.packet_list.find((item: any) => String(item?.track_number || "").trim() === safeTracking) || payload.packet_list[0];
    if (!packet) throw new Error("Leopards did not return tracking details for this consignment number.");
    const rawStatus = String(packet.booked_packet_status || packet.status || "UNKNOWN");
    const detail = packet["Tracking Detail"] || packet.TrackingDetail || packet.tracking_detail || [];
    const eventItems = Array.isArray(detail) ? detail.map((event: any) => {
      const statusText = String(event.Status || event.Staus || event.Statuss || rawStatus || "Status update");
      const dateText = event.Activity_Date || event["Activity Date"] || event.activity_date;
      const date = dateText ? new Date(String(dateText)) : null;
      return {
        timestamp: date && !Number.isNaN(date.getTime()) ? date : new Date(NaN),
        status: normalizeCourierStatus(statusText),
        description: [statusText, event.Reason || event.reason].filter(Boolean).join(" — "),
        location: event.Location || event.location,
      };
    }).filter((event: any) => !Number.isNaN(event.timestamp.getTime())) : [];
    return {
      trackingNumber: safeTracking,
      courierName: this.providerName,
      status: normalizeCourierStatus(rawStatus),
      rawStatus,
      location: String(packet.status_remarks || packet.status_reamrks || packet.destination_city_name || "").trim() || undefined,
      updatedAt: new Date(),
      events: eventItems,
      rawPayload: payload,
    };
  }

  async cancelShipment(trackingNumber: string, credentials?: any): Promise<{ success: boolean; message?: string }> {
    const apiKey = credentialValue(credentials, "apiKey");
    const apiPassword = credentialValue(credentials, "apiPassword");
    const apiRoot = leopardsApiRoot(credentials);
    const safeTracking = String(trackingNumber || "").trim();
    if (!apiKey || !apiPassword) return { success: false, message: "Leopards API key/password are missing for this store." };
    if (!safeTracking) return { success: false, message: "A Leopards consignment number is required." };
    try {
      const response = await fetch(`${apiRoot}/cancelBookedPackets/format/json/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ api_key: apiKey, api_password: apiPassword, cn_numbers: safeTracking }),
      });
      const payload = await readJson(response);
      const succeeded = response.ok && [1, "1", true].includes(payload?.status);
      return succeeded
        ? { success: true, message: "Leopards accepted the cancellation request." }
        : { success: false, message: apiPayloadMessage(payload, `Leopards cancellation failed (HTTP ${response.status}).`) };
    } catch {
      return { success: false, message: "Leopards could not be reached. Cancellation was not confirmed." };
    }
  }
}

// -----------------------------------------------------------------------------
// DHL Express MyDHL REST API (3.3.4)
// -----------------------------------------------------------------------------
const DHL_TEST_API_ROOT = "https://express.api.dhl.com/mydhlapi/test";
const DHL_PRODUCTION_API_ROOT = "https://express.api.dhl.com/mydhlapi";

function dhlApiRoot(credentials: any): string {
  return credentialValue(credentials, "environment").toLowerCase() === "production"
    ? DHL_PRODUCTION_API_ROOT
    : DHL_TEST_API_ROOT;
}

function valueFrom(source: any, ...keys: string[]): string {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function credentialAddress(credentials: any) {
  return {
    address1: valueFrom(credentials, "shipperAddress", "warehouseAddress"),
    city: valueFrom(credentials, "shipperCity", "warehouseCity"),
    state: valueFrom(credentials, "shipperState", "warehouseState"),
    postalCode: valueFrom(credentials, "shipperPostalCode", "warehousePostalCode"),
    countryCode: valueFrom(credentials, "shipperCountryCode", "warehouseCountryCode").toUpperCase(),
    name: valueFrom(credentials, "shipperName", "warehouseContactName"),
    phone: valueFrom(credentials, "shipperPhone", "warehousePhone"),
    email: valueFrom(credentials, "shipperEmail", "warehouseEmail"),
    company: valueFrom(credentials, "shipperCompany", "warehouseCompany", "shipperName", "warehouseContactName"),
  };
}

function normalizeDhlAddress(address: any, fallback: any, role: string) {
  const source = address || {};
  const street = valueFrom(source, "addressLine1", "address1", "street", "address", "addressLine") || fallback?.address1 || "";
  const city = valueFrom(source, "cityName", "city", "town") || fallback?.city || "";
  const countryCode = valueFrom(source, "countryCode", "country_code", "country") || fallback?.countryCode || "";
  const postalCode = valueFrom(source, "postalCode", "zip", "zipCode", "postcode") || fallback?.postalCode || "";
  const fullName = valueFrom(source, "fullName", "name", "contactName", "recipientName")
    || [valueFrom(source, "firstName", "first_name"), valueFrom(source, "lastName", "last_name")].filter(Boolean).join(" ")
    || fallback?.name || "";
  const phone = valueFrom(source, "phone", "phoneNumber", "mobilePhone", "telephone") || fallback?.phone || "";
  const email = valueFrom(source, "email", "emailAddress") || fallback?.email || "";
  const companyName = valueFrom(source, "companyName", "company", "businessName") || fallback?.company || fullName;
  if (!street || !city || !countryCode || countryCode.length !== 2 || !fullName || !phone) {
    throw new Error(`DHL ${role} details are incomplete. Enter a full street address, city, two-letter country code, contact name, and phone number; add the required merchant address fields in Courier settings.`);
  }
  return {
    postalAddress: {
      postalCode,
      cityName: city,
      countryCode: countryCode.toUpperCase(),
      addressLine1: street,
      ...(valueFrom(source, "addressLine2", "address2") ? { addressLine2: valueFrom(source, "addressLine2", "address2") } : {}),
      ...(valueFrom(source, "addressLine3", "address3") ? { addressLine3: valueFrom(source, "addressLine3", "address3") } : {}),
      ...(valueFrom(source, "state", "province", "stateOrProvinceCode") ? { provinceCode: valueFrom(source, "state", "province", "stateOrProvinceCode") } : {}),
    },
    contactInformation: {
      fullName,
      phone,
      ...(email ? { email } : {}),
      ...(companyName ? { companyName } : {}),
    },
    typeCode: "business",
  };
}

function httpMessage(payload: any, fallback: string): string {
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    return payload.errors.map((entry: any) => String(entry?.message || entry?.detail || entry)).join("; ");
  }
  return String(payload?.detail || payload?.title || payload?.message || payload?.error || payload?.statusMessage || fallback);
}

export class DHLCourierAdapter implements ICourierAdapter {
  readonly providerName = "DHL";
  readonly displayName = "DHL Express";
  readonly description = "DHL Express MyDHL REST API: account-authenticated shipment labels and tracking. The supplied REST contract does not expose shipment cancellation; it only documents pickup cancellation.";
  readonly isLive = true;
  readonly supportsCancellation = false;

  async testConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
    const username = credentialValue(input.config, "username");
    const password = credentialValue(input.config, "password");
    const accountNumber = credentialValue(input.config, "accountNumber");
    if (!username || !password || !accountNumber) {
      return { success: false, message: "DHL API username, password, and shipper account number are required.", isLive: false };
    }
    try {
      const response = await fetch(`${dhlApiRoot(input.config)}/reference-data?datasetName=country`, {
        headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`, Accept: "application/json" },
      });
      const payload = await readJson(response);
      return response.ok
        ? { success: true, message: "DHL MyDHL API authentication was accepted. Booking still depends on the account, product code, route, and shipment data being valid.", isLive: true }
        : { success: false, message: httpMessage(payload, `DHL authentication check failed (HTTP ${response.status}).`), isLive: false };
    } catch {
      return { success: false, message: "DHL MyDHL API could not be reached. Check the environment and retry.", isLive: false };
    }
  }

  private async createShipment(input: ShipmentInput, credentials: any, direction: "RETURN" | "FORWARD" | "EXCHANGE"): Promise<LabelResult> {
    const username = credentialValue(credentials, "username");
    const password = credentialValue(credentials, "password");
    const accountNumber = credentialValue(credentials, "accountNumber");
    if (!username || !password || !accountNumber) return unconfirmedBooking(this.providerName, "DHL API username, password, and shipper account number are required for this store.");

    const merchantAddress = credentialAddress(credentials);
    let shipperDetails: any;
    let receiverDetails: any;
    try {
      if (direction === "RETURN") {
        shipperDetails = normalizeDhlAddress(input.originAddress, null, "customer pickup");
        receiverDetails = normalizeDhlAddress(input.destinationAddress, merchantAddress, "merchant delivery");
      } else {
        shipperDetails = normalizeDhlAddress(input.originAddress, merchantAddress, "merchant dispatch");
        receiverDetails = normalizeDhlAddress(input.destinationAddress, null, "customer delivery");
      }
    } catch (error) {
      return unconfirmedBooking(this.providerName, error instanceof Error ? error.message : "DHL address details are incomplete.");
    }

    const originCountry = String(shipperDetails.postalAddress.countryCode).toUpperCase();
    const destinationCountry = String(receiverDetails.postalAddress.countryCode).toUpperCase();
    const customsDeclarable = credentialValue(credentials, "isCustomsDeclarable").toLowerCase() === "true";
    // The current shipment input does not include per-item customs origin, net weight, HS codes, or tariff line data.
    // Fail closed rather than inventing customs declarations for cross-border shipments.
    if (originCountry !== destinationCountry && !customsDeclarable) {
      return unconfirmedBooking(this.providerName, "DHL requires customs-declarable shipment data for cross-border routes. Enable customs handling only after line-level customs values and commodity data are supplied; no shipment was booked.");
    }
    if (customsDeclarable) {
      return unconfirmedBooking(this.providerName, "DHL customs-declarable booking is not enabled because this app's shipment payload does not yet carry validated customs line items. No shipment was booked.");
    }

    const weight = Number(input.weightKg || credentialValue(credentials, "defaultWeightKg") || 1);
    if (!Number.isFinite(weight) || weight <= 0) return unconfirmedBooking(this.providerName, "Enter a positive parcel weight in kilograms in the shipment or DHL settings.");
    const now = new Date();
    now.setUTCDate(now.getUTCDate() + 1);
    const plannedShippingDateAndTime = `${now.toISOString().slice(0, 19)} GMT+00:00`;
    const description = (input.items || []).map((item) => item.title).filter(Boolean).join(", ").slice(0, 70) || "Merchandise";
    const body = {
      plannedShippingDateAndTime,
      pickup: { isRequested: false },
      productCode: credentialValue(credentials, "productCode") || "P",
      getRateEstimates: false,
      accounts: [{ typeCode: "shipper", number: accountNumber }],
      outputImageProperties: {
        printerDPI: 300,
        encodingFormat: "pdf",
        imageOptions: [{ typeCode: "label", templateName: "ECOM26_84_001", isRequested: true }],
        splitTransportAndWaybillDocLabels: true,
        allDocumentsInOneImage: false,
      },
      customerDetails: { shipperDetails, receiverDetails },
      content: {
        packages: [{ typeCode: credentialValue(credentials, "packageType") || "2BP", weight }],
        isCustomsDeclarable: false,
        description,
        incoterm: credentialValue(credentials, "incoterm") || "DAP",
        unitOfMeasurement: "metric",
      },
      estimatedDeliveryDate: { isRequested: true, typeCode: "QDDC" },
    };

    try {
      const response = await fetch(`${dhlApiRoot(credentials)}/shipments`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Message-Reference": `${input.shopifyStoreId.slice(0, 8)}-${Date.now()}`.slice(0, 36),
        },
        body: JSON.stringify(body),
      });
      const payload = await readJson(response);
      const trackingNumber = String(payload?.shipmentTrackingNumber || payload?.packages?.[0]?.trackingNumber || "").trim();
      if (!response.ok || !trackingNumber) {
        return unconfirmedBooking(this.providerName, httpMessage(payload, `DHL did not confirm the shipment (HTTP ${response.status}); no shipment was recorded.`));
      }
      const docs = Array.isArray(payload?.documents) ? payload.documents : [];
      const labelDoc = docs.find((doc: any) => String(doc?.typeCode || "").toLowerCase() === "label") || docs.find((doc: any) => String(doc?.imageFormat || "").toUpperCase() === "PDF");
      const labelContentBase64 = typeof labelDoc?.content === "string" ? labelDoc.content : undefined;
      return {
        success: true,
        trackingNumber,
        courierName: this.displayName,
        labelUrl: labelContentBase64 ? `/app/shipments-label?trackingNumber=${encodeURIComponent(trackingNumber)}&documentType=LABEL` : "",
        labelContentBase64,
        labelContentType: labelDoc?.imageFormat?.toLowerCase() === "png" ? "image/png" : "application/pdf",
        labelFileName: `DHL-${trackingNumber}.pdf`,
        carrierStatus: "SHIPMENT_CREATED",
        isLive: true,
        rawResponse: { shipmentTrackingNumber: trackingNumber, trackingUrl: payload?.trackingUrl || null, warnings: payload?.warnings || [] },
      };
    } catch {
      return unconfirmedBooking(this.providerName, "DHL MyDHL API could not be reached. No shipment was recorded.");
    }
  }

  async createReverseShipment(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.createShipment(input, credentials || {}, "RETURN");
  }
  async generateReturnLabel(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.createShipment(input, credentials || {}, "RETURN");
  }
  async createForwardShipment(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.createShipment(input, credentials || {}, input.shipmentType === "EXCHANGE" ? "EXCHANGE" : "FORWARD");
  }

  async trackShipment(trackingNumber: string, credentials?: any): Promise<TrackingStatusResult> {
    const username = credentialValue(credentials, "username");
    const password = credentialValue(credentials, "password");
    const accountNumber = credentialValue(credentials, "accountNumber");
    const safeTracking = String(trackingNumber || "").trim();
    if (!username || !password || !accountNumber) throw new Error("DHL username, password, and account number are required for tracking.");
    if (!safeTracking) throw new Error("A DHL tracking number is required.");
    const url = new URL(`${dhlApiRoot(credentials)}/shipments/${encodeURIComponent(safeTracking)}/tracking`);
    url.searchParams.set("shipperAccountNumber", accountNumber);
    url.searchParams.set("trackingView", "all-checkpoints");
    url.searchParams.set("levelOfDetail", "all");
    const response = await fetch(url, {
      headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`, Accept: "application/json" },
    });
    const payload = await readJson(response);
    if (!response.ok) throw new Error(httpMessage(payload, `DHL tracking failed (HTTP ${response.status}).`));
    const shipment = Array.isArray(payload?.shipments) ? payload.shipments[0] : payload?.shipment || payload;
    const events = Array.isArray(shipment?.events) ? shipment.events : [];
    const latest = events.length ? events[events.length - 1] : null;
    const rawStatus = valueFrom(latest, "description", "status", "typeCode") || valueFrom(shipment, "status", "description", "statusCode") || "UNKNOWN";
    const status = normalizeCourierStatus(rawStatus);
    const serviceArea = latest?.serviceArea || latest?.serviceAreaDescription || {};
    const location = typeof serviceArea === "string" ? serviceArea : valueFrom(serviceArea, "description", "facilityName", "cityName");
    const eventRows = events.map((event: any) => ({
      timestamp: new Date(valueFrom(event, "date", "timestamp") || Date.now()),
      status: normalizeCourierStatus(valueFrom(event, "description", "status", "typeCode")),
      description: valueFrom(event, "description", "status", "typeCode") || "DHL tracking event",
      location: valueFrom(event?.serviceArea, "description", "facilityName", "cityName") || undefined,
    }));
    return { trackingNumber: safeTracking, courierName: this.displayName, status, rawStatus, location: location || undefined, updatedAt: new Date(), events: eventRows, rawPayload: payload };
  }

  async cancelShipment(trackingNumber: string): Promise<{ success: boolean; message?: string }> {
    return { success: false, message: "The supplied DHL REST contract documents cancellation of a pickup request, not cancellation of a shipment by tracking number. BYNDCART will not claim this shipment was cancelled." };
  }
}

// -----------------------------------------------------------------------------
// FedEx Ship API + Track API
// OAuth endpoint is documented by FedEx; shipment/tracking paths follow the supplied specs.
// -----------------------------------------------------------------------------
const FEDEX_TOKEN_CACHE = new Map<string, { token: string; expiresAt: number }>();
function fedexApiRoot(credentials: any): string {
  return credentialValue(credentials, "environment").toLowerCase() === "production"
    ? "https://apis.fedex.com"
    : "https://apis-sandbox.fedex.com";
}

function normalizeFedExParty(address: any, fallback: any, role: string) {
  const source = address || {};
  const rawStreet = source.streetLines;
  const streetLines = Array.isArray(rawStreet) ? rawStreet.map((line: any) => String(line).trim()).filter(Boolean) : [];
  const street = valueFrom(source, "address1", "addressLine1", "address", "street") || fallback?.address1 || "";
  if (!streetLines.length && street) streetLines.push(street);
  const city = valueFrom(source, "city", "cityName", "town") || fallback?.city || "";
  const countryCode = (valueFrom(source, "countryCode", "country_code", "country") || fallback?.countryCode || "").toUpperCase();
  const postalCode = valueFrom(source, "postalCode", "postcode", "zip", "zipCode") || fallback?.postalCode || "";
  const stateOrProvinceCode = valueFrom(source, "stateOrProvinceCode", "state", "province") || fallback?.state || "";
  const personName = valueFrom(source, "personName", "fullName", "name", "contactName", "recipientName")
    || [valueFrom(source, "firstName", "first_name"), valueFrom(source, "lastName", "last_name")].filter(Boolean).join(" ")
    || fallback?.name || "";
  const companyName = valueFrom(source, "companyName", "company", "businessName") || fallback?.company || personName;
  const phoneNumber = valueFrom(source, "phoneNumber", "phone", "mobilePhone", "telephone") || fallback?.phone || "";
  const emailAddress = valueFrom(source, "emailAddress", "email") || fallback?.email || "";
  if (!streetLines.length || !city || countryCode.length !== 2 || !personName || !phoneNumber) {
    throw new Error(`FedEx ${role} details are incomplete. A street address, city, two-letter country code, contact name, and phone number are required; check the customer address and merchant shipper fields in Courier settings.`);
  }
  return {
    address: {
      streetLines: streetLines.slice(0, 3), city, countryCode,
      ...(stateOrProvinceCode ? { stateOrProvinceCode } : {}),
      ...(postalCode ? { postalCode } : {}),
      residential: Boolean(source.residential ?? true),
    },
    contact: { personName, phoneNumber, ...(emailAddress ? { emailAddress } : {}), ...(companyName ? { companyName } : {}) },
  };
}

function fedexApiError(payload: any, fallback: string) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const notifications = payload?.output?.alerts || payload?.output?.transactionShipments?.[0]?.alerts || [];
  if (errors.length) return errors.map((error: any) => String(error?.message || error?.code || error)).join("; ");
  const errorAlerts = Array.isArray(notifications) ? notifications.filter((alert: any) => String(alert?.severity || "").toLowerCase() === "error") : [];
  if (errorAlerts.length) return errorAlerts.map((alert: any) => String(alert?.message || alert?.code || alert)).join("; ");
  return String(payload?.message || payload?.detail || fallback);
}

function recursiveFedExFind(root: any, keys: string[], visited = new Set<any>()): any {
  if (!root || typeof root !== "object" || visited.has(root)) return undefined;
  visited.add(root);
  for (const key of keys) {
    const value = root[key];
    if (value !== undefined && value !== null && (typeof value === "string" || typeof value === "number")) return value;
  }
  const values = Array.isArray(root) ? root : Object.values(root);
  for (const value of values) {
    const result = recursiveFedExFind(value, keys, visited);
    if (result !== undefined) return result;
  }
  return undefined;
}

export class FedExCourierAdapter implements ICourierAdapter {
  readonly providerName = "FEDEX";
  readonly displayName = "FedEx";
  readonly description = "FedEx Ship and Track APIs with OAuth 2.0, PDF label handling, shipment cancellation, and return shipment labels. Confirm the account and selected service in FedEx UAT before production use.";
  readonly isLive = true;
  readonly supportsCancellation = true;

  private async getAccessToken(credentials: any): Promise<string> {
    const clientId = credentialValue(credentials, "clientId");
    const clientSecret = credentialValue(credentials, "clientSecret");
    if (!clientId || !clientSecret) throw new Error("FedEx API client ID and client secret are required.");
    const root = fedexApiRoot(credentials);
    const secretFingerprint = createHash("sha256").update(clientSecret).digest("hex");
    const cacheKey = `${credentialValue(credentials, "environment")}:${clientId}:${secretFingerprint}`;
    const cached = FEDEX_TOKEN_CACHE.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const grantType = credentialValue(credentials, "grantType") || "client_credentials";
    const form = new URLSearchParams({ grant_type: grantType, client_id: clientId, client_secret: clientSecret });
    const childId = credentialValue(credentials, "childId");
    const childSecret = credentialValue(credentials, "childSecret");
    if (grantType !== "client_credentials") {
      if (!childId || !childSecret) throw new Error("The selected FedEx OAuth grant requires the customer child ID and child secret.");
      form.set("child_key", childId);
      form.set("child_secret", childSecret);
    }
    const response = await fetch(`${root}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form,
    });
    const payload = await readJson(response);
    if (!response.ok || !payload?.access_token) throw new Error(httpMessage(payload, `FedEx OAuth failed (HTTP ${response.status}).`));
    const expiresIn = Math.max(120, Number(payload.expires_in) || 3600);
    FEDEX_TOKEN_CACHE.set(cacheKey, { token: String(payload.access_token), expiresAt: Date.now() + expiresIn * 1000 });
    return String(payload.access_token);
  }

  async testConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
    const credentials = input.config;
    for (const key of ["clientId", "clientSecret", "accountNumber"]) {
      if (!credentialValue(credentials, key)) return { success: false, message: `FedEx ${key === "clientId" ? "API client ID" : key === "clientSecret" ? "API client secret" : "account number"} is required.`, isLive: false };
    }
    try {
      await this.getAccessToken(credentials);
      return { success: true, message: "FedEx OAuth credentials were accepted. FedEx account and service availability will be verified when a shipment is validated/booked.", isLive: true };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "FedEx connection test failed.", isLive: false };
    }
  }

  private async createShipment(input: ShipmentInput, credentials: any, isReturn: boolean): Promise<LabelResult> {
    let token: string;
    try { token = await this.getAccessToken(credentials); }
    catch (error) { return unconfirmedBooking(this.providerName, error instanceof Error ? error.message : "FedEx OAuth failed."); }
    const accountNumber = credentialValue(credentials, "accountNumber");
    const merchantAddress = credentialAddress(credentials);
    let shipper: any;
    let recipient: any;
    try {
      if (isReturn) {
        shipper = normalizeFedExParty(input.originAddress, null, "customer pickup/return sender");
        recipient = normalizeFedExParty(input.destinationAddress, merchantAddress, "merchant return destination");
      } else {
        shipper = normalizeFedExParty(input.originAddress, merchantAddress, "merchant shipper");
        recipient = normalizeFedExParty(input.destinationAddress, null, "customer recipient");
      }
    } catch (error) {
      return unconfirmedBooking(this.providerName, error instanceof Error ? error.message : "FedEx shipment addresses are incomplete.");
    }
    const weight = Number(input.weightKg || credentialValue(credentials, "defaultWeightKg") || 1);
    if (!Number.isFinite(weight) || weight <= 0) return unconfirmedBooking(this.providerName, "Enter a positive parcel weight in kilograms in the shipment or FedEx settings.");
    const requestedShipment: any = {
      shipDatestamp: new Date().toISOString().slice(0, 10),
      pickupType: credentialValue(credentials, "pickupType") || "DROPOFF_AT_FEDEX_LOCATION",
      serviceType: credentialValue(credentials, "serviceType") || "FEDEX_INTERNATIONAL_PRIORITY",
      packagingType: credentialValue(credentials, "packagingType") || "YOUR_PACKAGING",
      shipper,
      recipients: [recipient],
      shippingChargesPayment: { paymentType: "SENDER" },
      labelSpecification: { imageType: "PDF", labelStockType: "PAPER_4X6", labelFormatType: "COMMON2D" },
      requestedPackageLineItems: [{ weight: { units: "KG", value: Number(weight.toFixed(1)) }, itemDescription: (input.items || []).map((item) => item.title).filter(Boolean).join(", ").slice(0, 50) || "Merchandise" }],
      totalWeight: Number(weight.toFixed(1)),
    };
    if (isReturn) {
      requestedShipment.shipmentSpecialServices = {
        specialServiceTypes: ["RETURN_SHIPMENT"],
        returnShipmentDetail: { returnType: "PRINT_RETURN_LABEL" },
      };
    }
    const body = { labelResponseOptions: "LABEL", accountNumber: { value: accountNumber }, requestedShipment };
    try {
      const response = await fetch(`${fedexApiRoot(credentials)}/ship/v1/shipments`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", "x-customer-transaction-id": `${input.shopifyStoreId.slice(0, 8)}-${Date.now()}`.slice(0, 36) },
        body: JSON.stringify(body),
      });
      const payload = await readJson(response);
      if (!response.ok || payload?.errors?.length) return unconfirmedBooking(this.providerName, fedexApiError(payload, `FedEx shipment creation failed (HTTP ${response.status}).`));
      const transaction = payload?.output?.transactionShipments?.[0];
      const piece = transaction?.pieceResponses?.[0];
      const trackingNumber = String(transaction?.masterTrackingNumber || piece?.trackingNumber || piece?.masterTrackingNumber || "").trim();
      if (!trackingNumber) return unconfirmedBooking(this.providerName, "FedEx returned no tracking number. No shipment was recorded.");
      const documents = [
        ...(Array.isArray(transaction?.shipmentDocuments) ? transaction.shipmentDocuments : []),
        ...(Array.isArray(piece?.packageDocuments) ? piece.packageDocuments : []),
      ];
      const label = documents.find((document: any) => String(document?.contentType || "").toUpperCase() === "LABEL") || documents.find((document: any) => document?.encodedLabel || document?.url);
      const encodedLabel = typeof label?.encodedLabel === "string" ? label.encodedLabel : undefined;
      const remoteUrl = typeof label?.url === "string" ? label.url : undefined;
      return {
        success: true,
        trackingNumber,
        courierName: this.displayName,
        labelUrl: encodedLabel ? `/app/shipments-label?trackingNumber=${encodeURIComponent(trackingNumber)}&documentType=LABEL` : (remoteUrl || ""),
        labelContentBase64: encodedLabel,
        labelContentType: String(label?.docType || "PDF").toUpperCase() === "PDF" ? "application/pdf" : "application/octet-stream",
        labelFileName: `FedEx-${trackingNumber}.pdf`,
        isLive: true,
        carrierStatus: "SHIPMENT_CREATED",
        rawResponse: { trackingNumber, serviceType: transaction?.serviceType || requestedShipment.serviceType, alerts: transaction?.alerts || [] },
      };
    } catch {
      return unconfirmedBooking(this.providerName, "FedEx Ship API could not be reached. No shipment was recorded.");
    }
  }

  async createReverseShipment(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.createShipment(input, credentials || {}, true);
  }
  async generateReturnLabel(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.createShipment(input, credentials || {}, true);
  }
  async createForwardShipment(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.createShipment(input, credentials || {}, false);
  }

  async trackShipment(trackingNumber: string, credentials?: any): Promise<TrackingStatusResult> {
    const token = await this.getAccessToken(credentials || {});
    const safeTracking = String(trackingNumber || "").trim();
    if (!safeTracking) throw new Error("A FedEx tracking number is required.");
    const response = await fetch(`${fedexApiRoot(credentials)}/track/v1/trackingnumbers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ includeDetailedScans: true, trackingInfo: [{ trackingNumberInfo: { trackingNumber: safeTracking } }] }),
    });
    const payload = await readJson(response);
    if (!response.ok || payload?.errors?.length) throw new Error(fedexApiError(payload, `FedEx tracking failed (HTTP ${response.status}).`));
    const statusDescription = recursiveFedExFind(payload, ["statusByLocale", "statusDescription", "eventDescription", "description", "derivedStatus"]);
    const rawStatus = typeof statusDescription === "string" ? statusDescription : "UNKNOWN";
    const location = recursiveFedExFind(payload, ["city", "cityName", "locationDescription"]);
    const updatedTimestamp = recursiveFedExFind(payload, ["dateTime", "scanDateTime", "date"]);
    const timestamp = typeof updatedTimestamp === "string" && !Number.isNaN(Date.parse(updatedTimestamp)) ? new Date(updatedTimestamp) : new Date();
    return { trackingNumber: safeTracking, courierName: this.displayName, status: normalizeCourierStatus(rawStatus), rawStatus, location: typeof location === "string" ? location : undefined, updatedAt: timestamp, rawPayload: payload };
  }

  async cancelShipment(trackingNumber: string, credentials?: any): Promise<{ success: boolean; message?: string }> {
    const safeTracking = String(trackingNumber || "").trim();
    if (!safeTracking) return { success: false, message: "A FedEx tracking number is required." };
    try {
      const token = await this.getAccessToken(credentials || {});
      const response = await fetch(`${fedexApiRoot(credentials)}/ship/v1/shipments/cancel`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ accountNumber: { value: credentialValue(credentials, "accountNumber") }, trackingNumber: safeTracking, emailShipment: false, deletionControl: "DELETE_ALL_PACKAGES", ...(credentialValue(credentials, "shipperCountryCode") ? { senderCountryCode: credentialValue(credentials, "shipperCountryCode").toUpperCase() } : {}), version: { major: 1, minor: 0, patch: 0 } }),
      });
      const payload = await readJson(response);
      const errors = Array.isArray(payload?.errors) ? payload.errors : [];
      return response.ok && !errors.length
        ? { success: true, message: "FedEx accepted the shipment cancellation request." }
        : { success: false, message: fedexApiError(payload, `FedEx cancellation failed (HTTP ${response.status}).`) };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "FedEx cancellation could not be confirmed." };
    }
  }
}

// -----------------------------------------------------------------------------
// 3. Trax Courier Adapter (Smart Returns REST API)
// Official API Docs: https://api.trax.pk/v1
// -----------------------------------------------------------------------------
export class TraxCourierAdapter implements ICourierAdapter {
  readonly providerName = "TRAX";
  readonly displayName = "Trax Express Smart Returns";
  readonly description = "API setup is pending a current, official Pakistan TRAX merchant API specification.";
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
// TCS COD API (the supplied separate Transit API is an ETA calculator, not scan tracking)
// -----------------------------------------------------------------------------
const TCS_COD_API_ROOT = "https://api.tcscourier.com/production/v1/cod";

function tcsHeaders(credentials: any) {
  return {
    "X-IBM-Client-Id": credentialValue(credentials, "clientId"),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function tcsReturnStatusSucceeded(payload: any): boolean {
  const status = payload?.returnStatus;
  return !status || (String(status.code) === "0200" && String(status.status || "").toUpperCase() === "SUCCESS");
}

function tcsReturnedNumber(payload: any): string {
  return String(
    payload?.CN || payload?.cn || payload?.consignmentNumber || payload?.consignmentNo ||
    payload?.bookingReply?.CN || payload?.data?.CN || payload?.data?.bookingReply?.CN || ""
  ).trim();
}

export class TCSCourierAdapter implements ICourierAdapter {
  readonly providerName = "TCS";
  readonly displayName = "TCS Courier";
  readonly description = "TCS COD API: standard consignment booking, consignment lookup, cancellation, and reverse logistics when the original order has a TCS consignment number. The supplied API does not return scan-level tracking events or shipping labels.";
  readonly cityHubs = ["Karachi", "Lahore", "Islamabad", "Rawalpindi", "Faisalabad", "Multan", "Peshawar", "Quetta"];
  readonly isLive = true;
  readonly supportsCancellation = true;

  async testConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
    const clientId = credentialValue(input.config, "clientId");
    const userName = credentialValue(input.config, "userName");
    const password = credentialValue(input.config, "password");
    const costCenterCode = credentialValue(input.config, "costCenterCode");
    if (!clientId || !userName || !password || !costCenterCode) {
      return { success: false, message: "TCS Client ID, username, password, and cost center code are required.", isLive: false };
    }
    try {
      const response = await fetch(`${TCS_COD_API_ROOT}/cities`, { headers: tcsHeaders(input.config) });
      const payload = await readJson(response);
      const cities = payload?.city || payload?.cities || payload?.data?.city;
      if (response.ok && Array.isArray(cities) && cities.length > 0) {
        return { success: true, message: "TCS API Client ID/subscription verified through the Cities endpoint. The supplied contract has no non-mutating username/password test; TCS validates booking credentials when a booking is attempted.", isLive: true };
      }
      return { success: false, message: httpMessage(payload, `TCS connection test failed (HTTP ${response.status}). Check the Client ID and API subscription. `), isLive: false };
    } catch {
      return { success: false, message: "TCS COD API could not be reached. Check the API subscription and retry.", isLive: false };
    }
  }

  private async bookForward(input: ShipmentInput, credentials: any): Promise<LabelResult> {
    const userName = credentialValue(credentials, "userName");
    const password = credentialValue(credentials, "password");
    const costCenterCode = credentialValue(credentials, "costCenterCode");
    const warehouseCity = credentialValue(credentials, "warehouseCity") || valueFrom(input.originAddress, "city", "cityName");
    const customer = input.destinationAddress || {};
    const customerCity = valueFrom(input, "cityName") || valueFrom(customer, "city", "cityName");
    const consigneeName = valueFrom(customer, "name", "fullName", "contactName") || input.customerName || "";
    const consigneeAddress = valueFrom(customer, "address1", "address", "street", "addressLine1");
    let consigneeMobNo = valueFrom(customer, "phone", "phoneNumber", "mobilePhone") || input.customerPhone || "";
    const consigneeEmail = valueFrom(customer, "email", "emailAddress") || input.customerEmail || "";
    const weight = Number(input.weightKg || credentialValue(credentials, "defaultWeightKg"));
    if (!userName || !password || !costCenterCode) return unconfirmedBooking(this.providerName, "Configure TCS username, password, and cost center code first.");
    if (!warehouseCity || !customerCity) return unconfirmedBooking(this.providerName, "TCS requires both the merchant warehouse city and customer destination city.");
    if (!consigneeName || !consigneeAddress || !consigneeEmail) return unconfirmedBooking(this.providerName, "TCS requires the customer's name, full address, and email address before booking.");
    if (!Number.isFinite(weight) || weight <= 0) return unconfirmedBooking(this.providerName, "Enter a positive parcel weight in kilograms in the shipment or TCS settings.");
    try { consigneeMobNo = normalizePakistanMobileNumber(consigneeMobNo); }
    catch (error) { return unconfirmedBooking(this.providerName, error instanceof Error ? error.message : "A valid customer mobile number is required by TCS."); }
    const itemsDescription = (input.items || []).map((item) => `${item.quantity}x ${item.title}`).filter(Boolean).join(", ").slice(0, 240) || "Merchandise";
    const codAmount = Number.isFinite(Number(input.codAmountPKR)) ? Math.max(0, Number(input.codAmountPKR)) : 0;
    const body = {
      userName, password, costCenterCode,
      consigneeName,
      consigneeAddress,
      consigneeMobNo,
      consigneeEmail,
      originCityName: warehouseCity,
      destinationCityName: customerCity,
      weight: Number(weight.toFixed(2)),
      pieces: 1,
      codAmount: codAmount.toFixed(2),
      customerReferenceNo: input.orderNumber,
      services: credentialValue(credentials, "services") || "O",
      productDetails: itemsDescription,
      fragile: credentialValue(credentials, "fragile") || "No",
      remarks: String(input.remarks || "").slice(0, 250),
    };
    try {
      const response = await fetch(`${TCS_COD_API_ROOT}/create-order`, { method: "POST", headers: tcsHeaders(credentials), body: JSON.stringify(body) });
      const payload = await readJson(response);
      const consignmentNumber = tcsReturnedNumber(payload);
      if (!response.ok || !tcsReturnStatusSucceeded(payload) || !consignmentNumber) {
        return unconfirmedBooking(this.providerName, httpMessage(payload, `TCS did not confirm booking (HTTP ${response.status}); no shipment was recorded.`));
      }
      return { success: true, trackingNumber: consignmentNumber, courierName: this.displayName, isLive: true, carrierStatus: "BOOKED", rawResponse: { CN: consignmentNumber, returnStatus: payload?.returnStatus || null } };
    } catch {
      return unconfirmedBooking(this.providerName, "TCS booking endpoint could not be reached. No shipment was recorded.");
    }
  }

  async createReverseShipment(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    const config = credentials || {};
    const userName = credentialValue(config, "userName");
    const password = credentialValue(config, "password");
    const costCenterCode = credentialValue(config, "costCenterCode");
    let customerPhone = input.customerPhone || valueFrom(input.originAddress, "phone", "phoneNumber", "mobilePhone");
    if (!userName || !password || !costCenterCode) return unconfirmedBooking(this.providerName, "Configure TCS username, password, and cost center code first.");
    // reverse-logistics requires a pre-existing TCS consignment number. Never substitute a Shopify order ID.
    const originalTcsShipment = await prisma.shipmentTrack.findFirst({
      where: { shopifyStoreId: input.shopifyStoreId, shopifyOrderId: input.orderId, courier: "TCS" },
      orderBy: { createdAt: "desc" }, select: { trackingNumber: true },
    });
    if (!originalTcsShipment?.trackingNumber) {
      return unconfirmedBooking(this.providerName, "TCS reverse-logistics requires the original TCS consignment number. This order has no prior TCS shipment in BYNDCART, so no reverse request was sent.");
    }
    try { customerPhone = normalizePakistanMobileNumber(customerPhone); }
    catch (error) { return unconfirmedBooking(this.providerName, error instanceof Error ? error.message : "A valid customer phone is required by TCS."); }
    try {
      const response = await fetch(`${TCS_COD_API_ROOT}/reverse-logistics`, {
        method: "POST", headers: tcsHeaders(config),
        body: JSON.stringify({ userName, password, costCenterCode, consignmentNo: originalTcsShipment.trackingNumber, consigneeMobNo: customerPhone }),
      });
      const payload = await readJson(response);
      const consignmentNumber = tcsReturnedNumber(payload);
      if (!response.ok || !tcsReturnStatusSucceeded(payload) || !consignmentNumber) {
        return unconfirmedBooking(this.providerName, httpMessage(payload, `TCS reverse logistics failed (HTTP ${response.status}); no shipment was recorded.`));
      }
      return { success: true, trackingNumber: consignmentNumber, courierName: this.displayName, isLive: true, carrierStatus: "REVERSE_REQUESTED", rawResponse: { CN: consignmentNumber, returnStatus: payload?.returnStatus || null } };
    } catch {
      return unconfirmedBooking(this.providerName, "TCS reverse-logistics endpoint could not be reached. No shipment was recorded.");
    }
  }

  async generateReturnLabel(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.createReverseShipment(input, credentials);
  }

  async createForwardShipment(input: ShipmentInput, credentials?: any): Promise<LabelResult> {
    return this.bookForward(input, credentials || {});
  }

  async trackShipment(trackingNumber: string, credentials?: any): Promise<TrackingStatusResult> {
    const config = credentials || {};
    const userName = credentialValue(config, "userName");
    const password = credentialValue(config, "password");
    const clientId = credentialValue(config, "clientId");
    const safeTracking = String(trackingNumber || "").trim();
    if (!userName || !password || !clientId) throw new Error("TCS Client ID, username, and password are required for tracking.");
    if (!safeTracking) throw new Error("A TCS consignment/reference number is required.");
    const url = new URL(`${TCS_COD_API_ROOT}/track-order`);
    url.searchParams.set("userName", userName);
    url.searchParams.set("password", password);
    url.searchParams.set("referenceNo", safeTracking);
    let response: Response;
    try {
      response = await fetch(url, { headers: { "X-IBM-Client-Id": clientId, Accept: "application/json" } });
    } catch {
      throw new Error("TCS consignment lookup could not be reached.");
    }
    const payload = await readJson(response);
    if (!response.ok || !tcsReturnStatusSucceeded(payload)) throw new Error(httpMessage(payload, `TCS consignment lookup failed (HTTP ${response.status}).`));
    const rows = Array.isArray(payload?.cnDetail) ? payload.cnDetail : [];
    const detail = rows.find((row: any) => String(row?.consignmentNumber || "") === safeTracking) || rows[0];
    if (!detail) throw new Error("TCS returned no consignment details for this reference.");
    const rawStatus = valueFrom(detail, "status", "consignmentStatus", "shipmentStatus", "statusDescription") || "Consignment details available; scan status not included in the supplied TCS COD contract";
    const status = normalizeCourierStatus(rawStatus);
    return {
      trackingNumber: safeTracking,
      courierName: this.displayName,
      status,
      rawStatus,
      location: valueFrom(detail, "destination", "origin") || undefined,
      updatedAt: new Date(),
      rawPayload: payload,
    };
  }

  async cancelShipment(trackingNumber: string, credentials?: any): Promise<{ success: boolean; message?: string }> {
    const config = credentials || {};
    const userName = credentialValue(config, "userName");
    const password = credentialValue(config, "password");
    const safeTracking = String(trackingNumber || "").trim();
    if (!userName || !password || !credentialValue(config, "clientId")) return { success: false, message: "TCS Client ID, username, and password are required for cancellation." };
    if (!safeTracking) return { success: false, message: "A TCS consignment number is required for cancellation." };
    try {
      const response = await fetch(`${TCS_COD_API_ROOT}/cancel-order`, {
        method: "PUT", headers: tcsHeaders(config), body: JSON.stringify({ userName, password, consignmentNumber: safeTracking }),
      });
      const payload = await readJson(response);
      const status = payload?.returnStatus;
      const succeeded = response.ok && String(status?.code || "") === "0200" && String(status?.status || "").toUpperCase() === "SUCCESS";
      return succeeded
        ? { success: true, message: String(status?.message || "TCS accepted the cancellation request.") }
        : { success: false, message: httpMessage(payload, `TCS cancellation failed (HTTP ${response.status}).`) };
    } catch {
      return { success: false, message: "TCS cancellation endpoint could not be reached. Cancellation was not confirmed." };
    }
  }
}

// -----------------------------------------------------------------------------
// 5. M&P Courier Adapter (Muller & Phipps Express API)
// -----------------------------------------------------------------------------
export class MnPCourierAdapter implements ICourierAdapter {
  readonly providerName = "MNP";
  readonly displayName = "M&P Courier (Muller & Phipps)";
  readonly description = "API setup is pending current official M&P merchant API documentation and account-specific configuration.";
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
  readonly description = "API setup is pending confirmation of the current Call Courier HTTPS booking and authentication contract.";
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
  key: string;
  label: string;
  placeholder: string;
  required: boolean;
  secret?: boolean;
  type?: "text" | "number" | "tel" | "email" | "select";
  options?: Array<{ label: string; value: string }>;
  defaultValue?: string;
}

export type CourierApiStatus = "live_booking" | "pending_vendor_docs" | "pending_implementation";

const COURIER_SETUP: Record<string, { instructions: string; apiStatus: CourierApiStatus; fields: CourierSetupField[] }> = {
  DHL: {
    apiStatus: "live_booking",
    instructions: "Uses DHL Express MyDHL REST API with Basic Authentication and the store's shipper account. Supports label creation and tracking. The supplied REST contract does not document shipment cancellation, and cross-border customs bookings are blocked until validated customs line data is supplied.",
    fields: [
      { key: "environment", label: "API environment", placeholder: "Choose environment", required: true, type: "select", defaultValue: "test", options: [{ label: "Test", value: "test" }, { label: "Production", value: "production" }] },
      { key: "username", label: "MyDHL API username", placeholder: "DHL API username", required: true, secret: true },
      { key: "password", label: "MyDHL API password", placeholder: "DHL API password", required: true, secret: true },
      { key: "accountNumber", label: "DHL shipper account number", placeholder: "DHL Express account number", required: true, secret: true },
      { key: "shipperName", label: "Merchant contact name", placeholder: "Warehouse contact name", required: true },
      { key: "shipperPhone", label: "Merchant phone", placeholder: "International phone number", required: true, type: "tel" },
      { key: "shipperEmail", label: "Merchant email", placeholder: "warehouse@example.com", required: false, type: "email" },
      { key: "shipperAddress", label: "Merchant street address", placeholder: "Full warehouse address", required: true },
      { key: "shipperCity", label: "Merchant city", placeholder: "City", required: true },
      { key: "shipperPostalCode", label: "Merchant postal code", placeholder: "Postal code", required: false },
      { key: "shipperCountryCode", label: "Merchant country code", placeholder: "Two-letter code, e.g. PK", required: true },
      { key: "productCode", label: "DHL product code", placeholder: "Carrier-approved product code", required: true, defaultValue: "P" },
      { key: "packageType", label: "DHL package type code", placeholder: "Carrier-approved package type", required: true, defaultValue: "2BP" },
      { key: "defaultWeightKg", label: "Default weight (kg)", placeholder: "e.g. 1", required: true, type: "number", defaultValue: "1" },
      { key: "incoterm", label: "Incoterm", placeholder: "e.g. DAP", required: true, defaultValue: "DAP" },
      { key: "isCustomsDeclarable", label: "Customs-declarable shipment", placeholder: "Choose", required: true, type: "select", defaultValue: "false", options: [{ label: "No (domestic only)", value: "false" }, { label: "Yes (blocked until customs lines are supported)", value: "true" }] },
    ],
  },
  FEDEX: {
    apiStatus: "live_booking",
    instructions: "Uses FedEx OAuth 2.0 plus Ship and Track APIs. Configure API key/secret, FedEx account number, merchant address, and the service type enabled on the account. Reverse requests use FedEx PRINT_RETURN_LABEL shipment services; perform account-specific UAT before live bookings.",
    fields: [
      { key: "environment", label: "API environment", placeholder: "Choose environment", required: true, type: "select", defaultValue: "sandbox", options: [{ label: "Sandbox", value: "sandbox" }, { label: "Production", value: "production" }] },
      { key: "grantType", label: "OAuth grant type", placeholder: "Choose grant type", required: true, type: "select", defaultValue: "client_credentials", options: [{ label: "Client credentials", value: "client_credentials" }, { label: "CSP credentials", value: "csp_credentials" }, { label: "Parent-child credentials", value: "client_pc_credentials" }] },
      { key: "clientId", label: "FedEx API key / client ID", placeholder: "FedEx API key", required: true, secret: true },
      { key: "clientSecret", label: "FedEx secret key", placeholder: "FedEx secret key", required: true, secret: true },
      { key: "childId", label: "FedEx customer child key (optional)", placeholder: "Required by some grant types", required: false, secret: true },
      { key: "childSecret", label: "FedEx customer child secret (optional)", placeholder: "Required by some grant types", required: false, secret: true },
      { key: "accountNumber", label: "FedEx account number", placeholder: "FedEx shipper account number", required: true, secret: true },
      { key: "shipperName", label: "Merchant contact name", placeholder: "Warehouse contact name", required: true },
      { key: "shipperPhone", label: "Merchant phone", placeholder: "International phone number", required: true, type: "tel" },
      { key: "shipperEmail", label: "Merchant email", placeholder: "warehouse@example.com", required: false, type: "email" },
      { key: "shipperAddress", label: "Merchant street address", placeholder: "Full warehouse address", required: true },
      { key: "shipperCity", label: "Merchant city", placeholder: "City", required: true },
      { key: "shipperState", label: "Merchant state/province code", placeholder: "Required for some countries", required: false },
      { key: "shipperPostalCode", label: "Merchant postal code", placeholder: "Postal code", required: false },
      { key: "shipperCountryCode", label: "Merchant country code", placeholder: "Two-letter code, e.g. PK", required: true },
      { key: "serviceType", label: "FedEx service type", placeholder: "Account-approved service code", required: true, defaultValue: "FEDEX_INTERNATIONAL_PRIORITY" },
      { key: "packagingType", label: "FedEx packaging type", placeholder: "e.g. YOUR_PACKAGING", required: true, defaultValue: "YOUR_PACKAGING" },
      { key: "pickupType", label: "Pickup type", placeholder: "Choose pickup type", required: true, type: "select", defaultValue: "DROPOFF_AT_FEDEX_LOCATION", options: [{ label: "Drop off at FedEx location", value: "DROPOFF_AT_FEDEX_LOCATION" }, { label: "Use scheduled pickup", value: "USE_SCHEDULED_PICKUP" }, { label: "Contact FedEx to schedule", value: "CONTACT_FEDEX_TO_SCHEDULE" }] },
      { key: "defaultWeightKg", label: "Default weight (kg)", placeholder: "e.g. 1", required: true, type: "number", defaultValue: "1" },
    ],
  },
  TCS: {
    apiStatus: "live_booking",
    instructions: "Uses the supplied TCS COD API. Client ID/subscription is checked through the Cities API; username/password/cost center are checked by booking/cancellation endpoints. Returns require a prior TCS consignment number. The supplied contract does not expose scan-event tracking or a label endpoint.",
    fields: [
      { key: "clientId", label: "TCS API Client ID", placeholder: "X-IBM-Client-Id", required: true, secret: true },
      { key: "userName", label: "TCS COD username", placeholder: "API username", required: true, secret: true },
      { key: "password", label: "TCS COD password", placeholder: "API password", required: true, secret: true },
      { key: "costCenterCode", label: "TCS cost center code", placeholder: "Assigned cost center code", required: true, secret: true },
      { key: "warehouseCity", label: "Merchant origin city", placeholder: "e.g. Karachi", required: true },
      { key: "defaultWeightKg", label: "Default parcel weight (kg)", placeholder: "e.g. 1", required: true, type: "number", defaultValue: "1" },
      { key: "services", label: "TCS service code", placeholder: "Carrier-provided service code", required: true, defaultValue: "O" },
      { key: "fragile", label: "Fragile parcel", placeholder: "Choose", required: true, type: "select", defaultValue: "No", options: [{ label: "No", value: "No" }, { label: "Yes", value: "Yes" }] },
    ],
  },
  POSTEX: {
    apiStatus: "live_booking",
    instructions: "Uses the official PostEx Merchant API with this store's token header. create-order v3 maps returns to Reverse, forward parcels to Normal, and exchanges to Replacement; the create response may initially report UnBooked. Tracking, cancellation, invoice PDF and load-sheet PDF APIs are implemented. Complete merchant UAT before production rollout.",
    fields: [
      { key: "apiToken", label: "Merchant API token", placeholder: "Paste the PostEx token", required: true, secret: true },
      { key: "pickupAddressCode", label: "Pickup address code (optional)", placeholder: "PostEx pickup address code", required: false },
      { key: "storeAddressCode", label: "Store address code (optional)", placeholder: "PostEx store address code", required: false },
    ],
  },
  LEOPARDS: {
    apiStatus: "live_booking",
    instructions: "Uses the official Leopards eCom Merchant API with api_key and api_password. Select the same environment as the key/password. Return booking requires a valid customer city plus merchant warehouse city/address/contact and default packet weight. City IDs are resolved from getAllCities at booking time.",
    fields: [
      { key: "environment", label: "API environment", placeholder: "Choose API environment", required: false, type: "select", defaultValue: "production", options: [{ label: "Production", value: "production" }, { label: "Staging / UAT", value: "staging" }] },
      { key: "apiKey", label: "Merchant API key", placeholder: "Leopards API key", required: true, secret: true },
      { key: "apiPassword", label: "Merchant API password", placeholder: "Leopards API password", required: true, secret: true },
      { key: "warehouseCity", label: "Warehouse city", placeholder: "e.g. Karachi", required: true },
      { key: "warehouseAddress", label: "Warehouse address", placeholder: "Full merchant warehouse address", required: true },
      { key: "warehouseContactName", label: "Warehouse contact name", placeholder: "Name of warehouse contact", required: true },
      { key: "warehousePhone", label: "Warehouse phone", placeholder: "03XXXXXXXXX", required: true, type: "tel" },
      { key: "warehouseEmail", label: "Warehouse email", placeholder: "warehouse@store.com", required: true, type: "email" },
      { key: "defaultWeightGrams", label: "Default parcel weight (grams)", placeholder: "e.g. 1000", required: true, type: "number" },
    ],
  },
};

export class CourierRegistry {
  private static adapters = new Map<string, ICourierAdapter>();
  private static defaultAdapter: ICourierAdapter = new PostExCourierAdapter();

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
    supportsCancellation: boolean;
    apiStatus: CourierApiStatus;
    instructions: string;
    fields: CourierSetupField[];
  }> {
    return Array.from(this.adapters.values()).map((a) => ({
      providerName: a.providerName,
      displayName: a.displayName,
      description: a.description,
      cityHubs: a.cityHubs,
      isLive: a.isLive,
      supportsCancellation: a.supportsCancellation !== false,
      apiStatus: COURIER_SETUP[a.providerName]?.apiStatus || "pending_vendor_docs",
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
  readonly description = "API setup is pending Rider Logistics' current merchant API documentation and test credentials.";
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

// Register only carriers with adapters implemented from the supplied API contracts.
CourierRegistry.register(new PostExCourierAdapter());
CourierRegistry.register(new LeopardsCourierAdapter());
CourierRegistry.register(new DHLCourierAdapter());
CourierRegistry.register(new FedExCourierAdapter());
CourierRegistry.register(new TCSCourierAdapter());

type StoredCourierCredentialEnvelope = {
  __byndcartCredentialBundle: 1;
  fields: Record<string, string>;
};

function readCredentialBundle(encryptedValue: string | null | undefined): Record<string, string> {
  if (!encryptedValue) return {};
  try {
    const decrypted = decryptCredential(encryptedValue);
    try {
      const parsed = JSON.parse(decrypted) as Partial<StoredCourierCredentialEnvelope>;
      if (parsed && parsed.__byndcartCredentialBundle === 1 && parsed.fields && typeof parsed.fields === "object") {
        return Object.fromEntries(Object.entries(parsed.fields).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      }
    } catch {
      // Legacy database rows encrypted a single API token as plain text.
    }
    return { apiToken: decrypted };
  } catch {
    return {};
  }
}

/**
 * Saves tenant-scoped courier credentials. All secret/identity fields supplied through the
 * generic credential UI are packed into the existing encryptedApiToken column, avoiding a
 * database migration while remaining compatible with legacy rows containing a single token.
 */
export async function saveMerchantCourierConfig(
  shopifyStoreId: string,
  providerName: string,
  data: {
    apiToken?: string;
    accountNumber?: string;
    credentials?: Record<string, string>;
    additionalConfig?: any;
    enabled?: boolean;
    isDefaultReverse?: boolean;
    isDefaultForward?: boolean;
    isLive?: boolean;
  }
) {
  const normalizedProvider = providerName.trim().toUpperCase();
  if (!normalizedProvider || !CourierRegistry.has(normalizedProvider)) {
    throw new Error("Unsupported courier provider.");
  }

  const existing = await prisma.merchantCourierConfig.findUnique({
    where: { shopifyStoreId_providerName: { shopifyStoreId, providerName: normalizedProvider } },
    select: { encryptedApiToken: true },
  });
  const currentFields = readCredentialBundle(existing?.encryptedApiToken);
  const incomingFields = Object.fromEntries(
    Object.entries(data.credentials || {}).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
      .map(([key, value]) => [key, value.trim()])
  );
  if (data.apiToken?.trim()) incomingFields.apiToken = data.apiToken.trim();
  const mergedFields = { ...currentFields, ...incomingFields };
  const hasCredentialPayload = Object.keys(mergedFields).length > 0;
  const encryptedApiToken = hasCredentialPayload
    ? encryptCredential(JSON.stringify({ __byndcartCredentialBundle: 1, fields: mergedFields } satisfies StoredCourierCredentialEnvelope))
    : "";

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

  // Credentials must pass the provider's documented connection test before this config is marked live.
  const isLive = data.isLive === true;
  const config = await prisma.merchantCourierConfig.upsert({
    where: { shopifyStoreId_providerName: { shopifyStoreId, providerName: normalizedProvider } },
    update: {
      ...(hasCredentialPayload ? { encryptedApiToken } : {}),
      ...(data.accountNumber !== undefined ? { accountNumber: data.accountNumber || null } : {}),
      ...(data.additionalConfig !== undefined ? { additionalConfig: data.additionalConfig } : {}),
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      ...(data.isDefaultReverse !== undefined ? { isDefaultReverse: data.isDefaultReverse } : {}),
      ...(data.isDefaultForward !== undefined ? { isDefaultForward: data.isDefaultForward } : {}),
      ...(data.isLive !== undefined ? { isLive: data.isLive } : {}),
    },
    create: {
      shopifyStoreId,
      providerName: normalizedProvider,
      encryptedApiToken: hasCredentialPayload ? encryptedApiToken : "",
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
      metadata: { providerName: normalizedProvider, enabled: config.enabled, credentialFieldNames: Object.keys(mergedFields) },
    },
  });
  return config;
}

/** Loads courier configurations for UI display without exposing decrypted credential values. */
export async function getStoreCourierConfigs(shopifyStoreId: string) {
  const configs = await prisma.merchantCourierConfig.findMany({ where: { shopifyStoreId } });
  return configs.map((config) => {
    const credentials = readCredentialBundle(config.encryptedApiToken);
    const configuredFieldKeys = Object.keys(credentials);
    const setupFields = COURIER_SETUP[config.providerName]?.fields || [];
    const secretField = setupFields.find((field) => field.secret && credentials[field.key]);
    const nonSecretFields = Object.fromEntries(setupFields
      .filter((field) => !field.secret && typeof credentials[field.key] === "string")
      .map((field) => [field.key, credentials[field.key]]));
    const tokenForMask = secretField ? credentials[secretField.key] : credentials.apiToken || "";
    return {
      id: config.id,
      providerName: config.providerName,
      accountNumber: config.accountNumber,
      maskedToken: tokenForMask ? maskCredential(tokenForMask) : "",
      hasToken: configuredFieldKeys.length > 0,
      configuredFieldKeys,
      nonSecretFields,
      enabled: config.enabled,
      isDefaultReverse: config.isDefaultReverse,
      isDefaultForward: config.isDefaultForward,
      isLive: config.isLive,
      updatedAt: config.updatedAt,
    };
  });
}

/** Returns decrypted credentials only for the requested merchant/provider pair. */
export async function getDecryptedCourierCredentials(shopifyStoreId: string, providerName: string, includeDisabled = false) {
  try {
    const config = await prisma.merchantCourierConfig.findUnique({
      where: { shopifyStoreId_providerName: { shopifyStoreId, providerName: providerName.toUpperCase() } },
    });
    if (!config || (!config.enabled && !includeDisabled)) return null;
    const fields = readCredentialBundle(config.encryptedApiToken);
    return {
      ...fields,
      apiToken: fields.apiToken || "",
      accountNumber: fields.accountNumber || config.accountNumber || "",
      credentials: fields,
      additionalConfig: config.additionalConfig,
      isLive: config.isLive,
    };
  } catch {
    return null;
  }
}

export interface MerchantCourierBookingOptions {
  providerName: string;
  pickupCities: string[];
  deliveryCities: string[];
  serviceTypes: string[];
  citySource: "carrier_api" | "local";
  serviceTypeSource: "carrier_api" | "integration";
}

type FetchedMerchantCourierBookingOptions = MerchantCourierBookingOptions & {
  cityRecords?: LeopardsCity[];
};

type PersistedMerchantCourierBookingOptions = FetchedMerchantCourierBookingOptions & {
  credentialFingerprint: string;
  cachedAt: string;
};

function uniqueOptionStrings(values: unknown[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));
}

function normalizePostExOrderType(value: unknown): string | null {
  const label = String(value || "").trim();
  if (!label) return null;
  const normalized = label.toLowerCase();
  if (normalized === "normal") return "Normal";
  if (normalized === "reverse" || normalized === "reversed") return "Reverse";
  if (normalized === "replacement") return "Replacement";
  if (normalized === "overland") return "Overland";
  // Preserve additional values returned by this merchant's own PostEx account rather than dropping them.
  return label;
}

/**
 * Retrieves booking cities and shipment operation types from each carrier where its API exposes
 * those lists. Some carrier contracts do not expose a service-type list endpoint; those modes are
 * restricted to the operations implemented by that carrier adapter instead of invented API data.
 */
async function fetchMerchantCourierBookingOptionsUncached(
  shopifyStoreId: string,
  providerName: string,
): Promise<FetchedMerchantCourierBookingOptions> {
  const provider = providerName.trim().toUpperCase();
  if (provider === "RIDER") {
    return {
      providerName: provider,
      pickupCities: [],
      deliveryCities: [],
      serviceTypes: ["Normal"],
      citySource: "local",
      serviceTypeSource: "integration",
    };
  }

  const credentials = await getDecryptedCourierCredentials(shopifyStoreId, provider);
  if (!credentials) {
    throw new Error(`${provider} is not configured or enabled. Open Courier Settings, verify the saved API credentials, and retry.`);
  }

  if (provider === "POSTEX") {
    const token = credentialValue(credentials, "apiToken");
    if (!token) throw new Error("PostEx merchant API token is missing. Reconfigure PostEx in Courier Settings.");

    const fetchCityList = async (direction: "Pickup" | "Delivery"): Promise<string[]> => {
      const response = await fetch(`${POSTEX_API_ROOT}/order/v2/get-operational-city?operationalCityType=${direction}`, {
        method: "GET",
        headers: { token, Accept: "application/json" },
      });
      const payload = await readJson(response);
      if (!response.ok || Number(payload?.statusCode) !== 200 || !Array.isArray(payload?.dist)) {
        throw new Error(apiPayloadMessage(payload, `PostEx could not load its ${direction.toLowerCase()} city list (HTTP ${response.status}).`));
      }
      const flag = direction === "Pickup" ? "isPickupCity" : "isDeliveryCity";
      return uniqueOptionStrings(payload.dist
        .filter((row: any) => row && (row[flag] === undefined || row[flag] === true || String(row[flag]).toLowerCase() === "true" || String(row[flag]) === "1"))
        .map((row: any) => row.operationalCityName || row.cityName || row.name));
    };

    const cityResults = await Promise.allSettled([fetchCityList("Pickup"), fetchCityList("Delivery")]);
    const pickupResult = cityResults[0];
    const deliveryResult = cityResults[1];
    if (pickupResult.status === "rejected" && deliveryResult.status === "rejected") {
      throw new Error(`PostEx city lookup failed: ${pickupResult.reason instanceof Error ? pickupResult.reason.message : "API request failed"}`);
    }

    const typesResponse = await fetch(`${POSTEX_API_ROOT}/order/v1/get-order-types`, {
      method: "GET",
      headers: { token, Accept: "application/json" },
    });
    const typesPayload = await readJson(typesResponse);
    if (!typesResponse.ok || Number(typesPayload?.statusCode) !== 200 || !Array.isArray(typesPayload?.dist)) {
      throw new Error(apiPayloadMessage(typesPayload, `PostEx could not load its supported order types (HTTP ${typesResponse.status}).`));
    }
    const serviceTypes = uniqueOptionStrings(typesPayload.dist
      .map((item: any) => normalizePostExOrderType(typeof item === "string" ? item : item?.orderType || item?.type || item?.name))
      .filter(Boolean));
    if (!serviceTypes.length) throw new Error("PostEx returned an empty supported-order-type list.");

    return {
      providerName: provider,
      pickupCities: pickupResult.status === "fulfilled" ? pickupResult.value : [],
      deliveryCities: deliveryResult.status === "fulfilled" ? deliveryResult.value : [],
      serviceTypes,
      citySource: "carrier_api",
      serviceTypeSource: "carrier_api",
    };
  }

  if (provider === "LEOPARDS") {
    const apiKey = credentialValue(credentials, "apiKey");
    const apiPassword = credentialValue(credentials, "apiPassword");
    if (!apiKey || !apiPassword) throw new Error("Leopards API key and password are required. Reconfigure Leopards in Courier Settings.");
    const cities = await loadLeopardsCities(apiKey, apiPassword, leopardsApiRoot(credentials));
    const pickupCities = uniqueOptionStrings(cities
      .filter((city) => city.allow_as_origin !== false && String(city.allow_as_origin).toLowerCase() !== "false" && String(city.allow_as_origin) !== "0")
      .map((city) => city.name));
    const deliveryCities = uniqueOptionStrings(cities
      .filter((city) => city.allow_as_destination !== false && String(city.allow_as_destination).toLowerCase() !== "false" && String(city.allow_as_destination) !== "0")
      .map((city) => city.name));
    return {
      providerName: provider,
      pickupCities,
      deliveryCities,
      serviceTypes: ["Normal", "Reverse", "Replacement"],
      citySource: "carrier_api",
      serviceTypeSource: "integration",
      cityRecords: cities,
    };
  }

  if (provider === "TCS") {
    const response = await fetch(`${TCS_COD_API_ROOT}/cities`, { headers: tcsHeaders(credentials) });
    const payload = await readJson(response);
    const rows = payload?.city || payload?.cities || payload?.data?.city;
    if (!response.ok || !Array.isArray(rows) || !rows.length) {
      throw new Error(httpMessage(payload, `TCS did not return a valid city list (HTTP ${response.status}). Check the Client ID and API subscription.`));
    }
    const names = uniqueOptionStrings(rows.map((row: any) =>
      typeof row === "string" ? row : row?.cityName || row?.cityname || row?.name || row?.city || row?.CityName
    ));
    if (!names.length) throw new Error("TCS returned city records without readable city names.");
    return {
      providerName: provider,
      pickupCities: names,
      deliveryCities: names,
      serviceTypes: ["Normal", "Reverse", "Replacement"],
      citySource: "carrier_api",
      serviceTypeSource: "integration",
    };
  }

  throw new Error(`Live booking options are not implemented for ${provider}.`);
}

function bookingOptionsObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function bookingOptionsCredentialFingerprint(provider: string, credentials: Record<string, any>): string {
  const keys = provider === "POSTEX"
    ? ["apiToken"]
    : provider === "LEOPARDS"
      ? ["apiKey", "apiPassword", "environment"]
      : ["clientId", "userName", "password", "costCenterCode"];
  const identity = Object.fromEntries(keys.map((key) => [key, credentialValue(credentials, key)]));
  return createHash("sha256").update(JSON.stringify({ provider, identity })).digest("hex");
}

function isValidPersistedBookingOptions(
  value: any,
  provider: string,
  fingerprint: string,
): value is PersistedMerchantCourierBookingOptions {
  return Boolean(
    value
    && value.providerName === provider
    && value.credentialFingerprint === fingerprint
    && typeof value.cachedAt === "string"
    && Array.isArray(value.pickupCities)
    && Array.isArray(value.deliveryCities)
    && Array.isArray(value.serviceTypes)
    && (value.pickupCities.length > 0 || value.deliveryCities.length > 0)
    && value.serviceTypes.length > 0
    && (provider !== "LEOPARDS" || (Array.isArray(value.cityRecords) && value.cityRecords.length > 0))
  );
}

/**
 * Uses a store-scoped persistent city/type catalog. Carrier city endpoints are requested only
 * for the first selection (or when the courier credentials/environment change), not on every
 * page render or individual shipment booking.
 */
export async function getMerchantCourierBookingOptions(
  shopifyStoreId: string,
  providerName: string,
): Promise<MerchantCourierBookingOptions> {
  const provider = providerName.trim().toUpperCase();
  if (provider === "RIDER") {
    return {
      providerName: provider,
      pickupCities: [],
      deliveryCities: [],
      serviceTypes: ["Normal"],
      citySource: "local",
      serviceTypeSource: "integration",
    };
  }

  const credentials = await getDecryptedCourierCredentials(shopifyStoreId, provider);
  if (!credentials) {
    throw new Error(`${provider} is not configured or enabled. Open Courier Settings, verify the saved API credentials, and retry.`);
  }

  const credentialFingerprint = bookingOptionsCredentialFingerprint(provider, credentials);
  const configKey = { shopifyStoreId_providerName: { shopifyStoreId, providerName: provider } };
  const existing = await prisma.merchantCourierConfig.findUnique({
    where: configKey,
    select: { additionalConfig: true },
  });
  const currentAdditionalConfig = bookingOptionsObject(existing?.additionalConfig);
  const cached = currentAdditionalConfig.byndcartBookingOptionsCache;

  if (isValidPersistedBookingOptions(cached, provider, credentialFingerprint)) {
    return {
      providerName: cached.providerName,
      pickupCities: cached.pickupCities,
      deliveryCities: cached.deliveryCities,
      serviceTypes: cached.serviceTypes,
      citySource: cached.citySource,
      serviceTypeSource: cached.serviceTypeSource,
    };
  }

  const fetched = await fetchMerchantCourierBookingOptionsUncached(shopifyStoreId, provider);
  const persisted: PersistedMerchantCourierBookingOptions = {
    ...fetched,
    credentialFingerprint,
    cachedAt: new Date().toISOString(),
  };

  // Re-read before update so unrelated courier settings in additionalConfig are preserved.
  const latest = await prisma.merchantCourierConfig.findUnique({
    where: configKey,
    select: { additionalConfig: true },
  });
  await prisma.merchantCourierConfig.update({
    where: configKey,
    data: {
      additionalConfig: {
        ...bookingOptionsObject(latest?.additionalConfig),
        byndcartBookingOptionsCache: persisted,
      },
    },
  });

  return {
    providerName: fetched.providerName,
    pickupCities: fetched.pickupCities,
    deliveryCities: fetched.deliveryCities,
    serviceTypes: fetched.serviceTypes,
    citySource: fetched.citySource,
    serviceTypeSource: fetched.serviceTypeSource,
  };
}

async function getCachedLeopardsCityRecords(shopifyStoreId: string, credentials?: any): Promise<LeopardsCity[]> {
  // This call fetches once if the catalog is missing or credentials have changed.
  try {
    await getMerchantCourierBookingOptions(shopifyStoreId, "LEOPARDS");
  } catch (error) {
    // Adapter calls without a saved merchant config can still use the supplied credentials.
    const message = error instanceof Error ? error.message : "";
    if (!credentials || !message.includes("LEOPARDS is not configured or enabled")) throw error;
    return loadLeopardsCities(
      credentialValue(credentials, "apiKey"),
      credentialValue(credentials, "apiPassword"),
      leopardsApiRoot(credentials),
    );
  }

  const config = await prisma.merchantCourierConfig.findUnique({
    where: { shopifyStoreId_providerName: { shopifyStoreId, providerName: "LEOPARDS" } },
    select: { additionalConfig: true },
  });
  const cache = bookingOptionsObject(bookingOptionsObject(config?.additionalConfig).byndcartBookingOptionsCache);
  if (Array.isArray(cache.cityRecords) && cache.cityRecords.length > 0) {
    return cache.cityRecords as LeopardsCity[];
  }
  throw new Error("Leopards city catalog is not cached. Reopen the Booking page after verifying the courier connection.");
}

/**
 * Resolves the merchant's default configured courier for reverse or forward shipments.
 */
export async function getDefaultMerchantCourier(shopifyStoreId: string, type: "REVERSE" | "FORWARD" = "REVERSE") {
  const field = type === "REVERSE" ? "isDefaultReverse" : "isDefaultForward";
  try {
    const configs = await prisma.merchantCourierConfig.findMany({
      where: { shopifyStoreId, enabled: true, isLive: true, [field]: true },
      orderBy: { updatedAt: "desc" },
    });
    for (const config of configs) {
      if (!CourierRegistry.has(config.providerName)) continue;
      const adapter = CourierRegistry.get(config.providerName);
      const credentials = await getDecryptedCourierCredentials(shopifyStoreId, adapter.providerName);
      const requiredFields = (COURIER_SETUP[adapter.providerName]?.fields || []).filter((item) => item.required);
      if (config.isLive && adapter.isLive && credentials && requiredFields.every((item) => credentialValue(credentials, item.key))) return adapter;
    }
    const enabledConfigs = await prisma.merchantCourierConfig.findMany({
      where: { shopifyStoreId, enabled: true, isLive: true },
      orderBy: { updatedAt: "desc" },
    });
    for (const config of enabledConfigs) {
      if (!CourierRegistry.has(config.providerName)) continue;
      const adapter = CourierRegistry.get(config.providerName);
      const credentials = await getDecryptedCourierCredentials(shopifyStoreId, adapter.providerName);
      const requiredFields = (COURIER_SETUP[adapter.providerName]?.fields || []).filter((item) => item.required);
      if (config.isLive && adapter.isLive && credentials && requiredFields.every((item) => credentialValue(credentials, item.key))) return adapter;
    }
  } catch {
    // Fall through to PostEx; all callers still validate store-specific credentials before booking.
  }
  return CourierRegistry.get("POSTEX");
}

