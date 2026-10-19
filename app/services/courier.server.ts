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

async function validatePostExCity(token: string, cityName: string, orderType: "Normal" | "Reverse" | "Replacement"): Promise<void> {
  const operationalCityType = orderType === "Reverse" ? "Pickup" : "Delivery";
  const normalized = cityName.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  if (!normalized) throw new Error("Enter a city supported by PostEx.");
  const response = await fetch(`${POSTEX_API_ROOT}/order/v2/get-operational-city?operationalCityType=${operationalCityType}`, {
    method: "GET",
    headers: { token, Accept: "application/json" },
  });
  const payload = await readJson(response);
  if (!response.ok || Number(payload?.statusCode) !== 200 || !Array.isArray(payload?.dist)) {
    throw new Error(apiPayloadMessage(payload, "PostEx could not verify its operational city list. Retry before booking."));
  }
  const availableCities = payload.dist as Array<Record<string, any>>;
  const city = availableCities.find((item) => String(item?.operationalCityName || "").trim().toLocaleLowerCase().replace(/\s+/g, " ") === normalized);
  if (!city) {
    const names = availableCities.map((item) => String(item?.operationalCityName || "").trim()).filter(Boolean).slice(0, 8).join(", ");
    throw new Error(`PostEx does not list "${cityName}" as a ${operationalCityType.toLowerCase()} city${names ? `. Examples returned by PostEx: ${names}` : ""}. Use the exact city name supplied by the carrier.`);
  }
  const supportValue = operationalCityType === "Pickup" ? city.isPickupCity : city.isDeliveryCity;
  if (supportValue === false || String(supportValue).toLowerCase() === "false" || String(supportValue) === "0") {
    throw new Error(`PostEx does not support ${operationalCityType.toLowerCase()} service in ${cityName}.`);
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

  private async createOrder(input: ShipmentInput, credentials: any, orderType: "Normal" | "Reverse" | "Replacement"): Promise<LabelResult> {
    const token = credentialValue(credentials, "apiToken");
    if (!token) return unconfirmedBooking(this.providerName, "PostEx merchant API token is missing for this store.");

    const isReturn = orderType === "Reverse";
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
      orderType,
    };
    const pickupAddressCode = credentialValue(credentials, "pickupAddressCode");
    const storeAddressCode = credentialValue(credentials, "storeAddressCode");
    if (pickupAddressCode) body.pickupAddressCode = pickupAddressCode;
    if (storeAddressCode) body.storeAddressCode = storeAddressCode;

    try {
      await validatePostExCity(token, cityName, orderType);
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
    return this.createOrder(input, credentials, input.shipmentType === "EXCHANGE" ? "Replacement" : "Normal");
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
    const apiRoot = leopardsApiRoot(credentials);
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
      cities = await loadLeopardsCities(apiKey, apiPassword, apiRoot);
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
// 4. TCS Courier Adapter (Corporate Reverse Logistics REST API)
// Official API Docs: https://atnetservices.tcscourier.com/api
// -----------------------------------------------------------------------------
export class TCSCourierAdapter implements ICourierAdapter {
  readonly providerName = "TCS";
  readonly displayName = "TCS Express Reverse Logistics";
  readonly description = "TCS ECOM API booking, tracking, and label behavior must be implemented and UAT-verified before enabling this carrier.";
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

// Only the two integrations backed by the supplied official API guides are registered.
// Other adapter classes remain dormant and cannot be selected or called via CourierRegistry.
CourierRegistry.register(new PostExCourierAdapter());
CourierRegistry.register(new LeopardsCourierAdapter());

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

