import { createHash } from "node:crypto";
import prisma from "../db.server";
import {
  encryptCredential,
  decryptCredential,
  maskCredential,
} from "../utils/encryption.server";

/**
 * Normalizes raw courier status strings into standard BYNDCART shipment status values.
 */
export function normalizeCourierStatus(rawStatus) {
  if (!rawStatus) return "UNKNOWN";
  const s = rawStatus.trim().toUpperCase();

  if (
    s.includes("UNBOOKED") ||
    s.includes("BOOKED") ||
    s.includes("CREATED") ||
    s.includes("LABEL") ||
    s.includes("PENDING") ||
    s.includes("NEW") ||
    s.includes("MERCHANT'S WAREHOUSE") ||
    s.includes("MERCHANTS WAREHOUSE")
  ) {
    return "LABEL_CREATED";
  }

  if (
    s.includes("POSTEX WAREHOUSE") ||
    s.includes("TRANSIT") ||
    s.includes("DISPATCH") ||
    s.includes("ARRIVED") ||
    s.includes("HUB") ||
    s.includes("DEPARTED") ||
    s.includes("PACKAGE ON ROUTE") ||
    s.includes("PACKAGE ON ROOT")
  ) {
    return "IN_TRANSIT";
  }

  if (
    s.includes("OUT FOR DELIVERY") ||
    s.includes("RIDER") ||
    s.includes("ON WAY")
  ) {
    return "OUT_FOR_DELIVERY";
  }

  if (
    s.includes("DELIVERED") ||
    s.includes("COMPLETED") ||
    s.includes("SUCCESS")
  ) {
    return "DELIVERED";
  }

  if (s.includes("CANCEL") || s.includes("VOID")) {
    return "CANCELLED";
  }

  if (
    s.includes("FAIL") ||
    s.includes("RETURN") ||
    s.includes("REJECT") ||
    s.includes("UNABLE")
  ) {
    return "FAILED";
  }

  return "UNKNOWN";
}

function normalizePakistanMobileNumber(raw) {
  let digits = String(raw || "").replace(/[^0-9]/g, "");

  if (digits.startsWith("0092")) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith("92") && digits.length === 12)
    digits = `0${digits.slice(2)}`;
  else if (digits.length === 10 && digits.startsWith("3"))
    digits = `0${digits}`;

  if (!/^03[0-9]{9}$/.test(digits)) {
    throw new Error(
      "Enter a valid Pakistani mobile number, for example 03XXXXXXXXX.",
    );
  }

  return digits;
}

export function unconfirmedBooking(courierName, message) {
  return {
    success: false,
    trackingNumber: "",
    courierName,
    isLive: false,
    error:
      message ||
      `${courierName} did not confirm the API booking. No shipment was created.`,
  };
}

export function unconfirmedTracking(courierName, trackingNumber) {
  return {
    trackingNumber,
    courierName,
    status: "UNKNOWN",
    rawStatus: "UNCONFIRMED",
    updatedAt: new Date(),
  };
}

export function credentialsStored(provider) {
  return {
    success: true,
    isLive: false,
    message: `${provider} credentials were received by the settings form, but no live API connection was verified.`,
  };
}

export function unconfirmedCancel(provider) {
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
const LEOPARDS_PRODUCTION_API_ROOT =
  "https://merchantapi.leopardscourier.com/api";

// Courier configuration is production-only. Ignore legacy environment values saved by older UI versions.
function leopardsApiRoot(_credentials) {
  return LEOPARDS_PRODUCTION_API_ROOT;
}

function credentialValue(credentials, key) {
  const value = credentials?.[key] ?? credentials?.credentials?.[key];

  return typeof value === "string"
    ? value.trim()
    : value == null
      ? ""
      : String(value).trim();
}

function apiPayloadMessage(payload, fallback) {
  return String(
    payload?.error || payload?.statusMessage || payload?.message || fallback,
  );
}

function extractNumericShopifyId(orderId) {
  const match = String(orderId || "").match(/(\d+)$/);

  if (!match)
    throw new Error(
      "A valid Shopify order ID is required for Leopards shipment booking.",
    );
  const id = Number(match[1]);

  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error("The Shopify order ID is not a valid numeric shipment ID.");

  return id;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function loadLeopardsCities(
  apiKey,
  apiPassword,
  apiRoot = LEOPARDS_PRODUCTION_API_ROOT,
) {
  const response = await fetch(`${apiRoot}/getAllCities/format/json/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ api_key: apiKey, api_password: apiPassword }),
  });
  const payload = await readJson(response);

  if (
    !response.ok ||
    ![1, "1", true].includes(payload?.status) ||
    !Array.isArray(payload?.city_list) ||
    payload.city_list.length === 0
  ) {
    throw new Error(
      apiPayloadMessage(
        payload,
        "Leopards did not return a valid city list. Verify the API key/password and production access.",
      ),
    );
  }

  return payload.city_list;
}

function leopardsCityShipmentTypes(city) {
  const rawTypes = city?.shipment_type;
  const candidates = Array.isArray(rawTypes)
    ? rawTypes
    : typeof rawTypes === "string"
      ? rawTypes.split(/[,;|]/)
      : [];

  return uniqueOptionStringsInOrder(
    candidates.map((value) => String(value || "").trim()),
  );
}

function sameLeopardsCityName(left, right) {
  return (
    left.trim().toLocaleLowerCase().replace(/\s+/g, " ") ===
    right.trim().toLocaleLowerCase().replace(/\s+/g, " ")
  );
}

function resolveLeopardsCityId(cities, cityName, purpose) {
  const normalized = cityName.trim().toLocaleLowerCase().replace(/\s+/g, " ");

  if (!normalized)
    throw new Error(`Enter the ${purpose} city required by Leopards.`);
  const city = cities.find(
    (candidate) =>
      String(candidate.name || "")
        .trim()
        .toLocaleLowerCase()
        .replace(/\s+/g, " ") === normalized,
  );

  if (!city) {
    const suggestions = cities
      .map((item) => item.name)
      .filter(Boolean)
      .slice(0, 8)
      .join(", ");

    throw new Error(
      `Leopards does not recognise city "${cityName}". Check the city spelling against the carrier city list${suggestions ? ` (examples: ${suggestions})` : ""}.`,
    );
  }

  const allowed =
    purpose === "origin" ? city.allow_as_origin : city.allow_as_destination;

  if (
    allowed === false ||
    String(allowed).toLowerCase() === "false" ||
    String(allowed) === "0"
  ) {
    throw new Error(
      `Leopards does not allow ${city.name} as a shipment ${purpose}.`,
    );
  }

  const id = Number(city.id);

  if (!Number.isInteger(id) || id <= 0)
    throw new Error(`Leopards returned an invalid city ID for ${city.name}.`);

  return id;
}

async function validatePostExCity(
  shopifyStoreId,
  cityName,
  orderType,
  fallbackToken,
) {
  const operationalCityType =
    orderType === "Reverse" || orderType === "Reversed" ? "Pickup" : "Delivery";
  const normalized = cityName.trim().toLocaleLowerCase().replace(/\s+/g, " ");

  if (!normalized) throw new Error("Enter a city supported by PostEx.");
  // Reuse the store's persisted carrier catalog so each booking does not call the city API again.
  let availableCities;

  try {
    const options = await getMerchantCourierBookingOptions(
      shopifyStoreId,
      "POSTEX",
    );

    availableCities =
      operationalCityType === "Pickup"
        ? options.pickupCities
        : options.deliveryCities;
  } catch (error) {
    // Direct-token fallback is only for adapter integrations without a saved merchant config
    // (for example API adapter tests). A configured merchant always uses the persisted catalog.
    const message = error instanceof Error ? error.message : "";

    if (
      !fallbackToken ||
      !message.includes("POSTEX is not configured or enabled")
    )
      throw error;
    const response = await fetch(
      `${POSTEX_API_ROOT}/order/v2/get-operational-city`,
      {
        method: "GET",
        headers: { token: fallbackToken, Accept: "application/json" },
      },
    );
    const payload = await readJson(response);

    if (
      !response.ok ||
      Number(payload?.statusCode) !== 200 ||
      !Array.isArray(payload?.dist)
    ) {
      throw new Error(
        apiPayloadMessage(
          payload,
          "PostEx could not verify its operational city list.",
        ),
      );
    }

    const flag =
      operationalCityType === "Pickup" ? "isPickupCity" : "isDeliveryCity";

    availableCities = uniqueOptionStrings(
      payload.dist
        .filter(
          (row) =>
            row &&
            (row[flag] === undefined ||
              row[flag] === true ||
              String(row[flag]).toLowerCase() === "true" ||
              String(row[flag]) === "1"),
        )
        .map((row) => row.operationalCityName || row.cityName || row.name),
    );
  }

  const city = availableCities.find(
    (name) =>
      name.trim().toLocaleLowerCase().replace(/\s+/g, " ") === normalized,
  );

  if (!city) {
    const names = availableCities.slice(0, 8).join(", ");

    throw new Error(
      'PostEx does not list "' +
        cityName +
        '" as a ' +
        operationalCityType.toLowerCase() +
        " city" +
        (names ? ". Examples returned by PostEx: " + names : "") +
        ". Use the exact city name supplied by the carrier.",
    );
  }
}

function postExAddressRows(payload) {
  const candidate =
    payload?.dist ?? payload?.data?.dist ?? payload?.data ?? payload?.addresses;

  if (Array.isArray(candidate))
    return candidate.filter((item) => item && typeof item === "object");
  if (candidate && typeof candidate === "object") return [candidate];

  return [];
}

function postExAddressCodeFromRow(row) {
  return String(
    row.pickupAddressCode ||
      row.addressCode ||
      row.merchantAddressCode ||
      row.pickup_address_code ||
      row.address_code ||
      "",
  ).trim();
}

function postExStoreAddressCodeFromRow(row) {
  return String(row.storeAddressCode || row.store_address_code || "").trim();
}

function postExAddressTypeFromRow(row) {
  return String(
    row.addressType ||
      row.addressTypeName ||
      row.type ||
      row.name ||
      row.addressName ||
      "",
  )
    .trim()
    .toLowerCase();
}

/**
 * PostEx create-order v3 rejects a request if both pickupAddressCode and storeAddressCode
 * are missing. Prefer a code explicitly saved in Courier Settings; otherwise retrieve a
 * registered address code from the merchant API and cache it for the store/token.
 */
async function resolvePostExAddressCodes(
  shopifyStoreId,
  credentials,
  orderType,
) {
  const explicitPickup = credentialValue(credentials, "pickupAddressCode");
  const explicitStore = credentialValue(credentials, "storeAddressCode");

  if (explicitPickup || explicitStore) {
    return {
      pickupAddressCode: explicitPickup,
      storeAddressCode: explicitStore,
    };
  }

  const token = credentialValue(credentials, "apiToken");

  if (!token)
    throw new Error("PostEx merchant API token is missing for this store.");
  const tokenFingerprint = createHash("sha256").update(token).digest("hex");
  const configKey = {
    shopifyStoreId_providerName: { shopifyStoreId, providerName: "POSTEX" },
  };
  let currentConfig = null;

  try {
    currentConfig = await prisma.merchantCourierConfig.findUnique({
      where: configKey,
      select: { additionalConfig: true },
    });
  } catch {
    // Allows direct adapter integrations/tests with a token but no persisted merchant config.
  }

  const currentAdditionalConfig =
    currentConfig?.additionalConfig &&
    typeof currentConfig.additionalConfig === "object"
      ? currentConfig.additionalConfig
      : {};
  const cached = currentAdditionalConfig.byndcartPostExAddressCodes;

  if (
    cached &&
    cached.tokenFingerprint === tokenFingerprint &&
    (String(cached.pickupAddressCode || "").trim() ||
      String(cached.storeAddressCode || "").trim())
  ) {
    return {
      pickupAddressCode: String(cached.pickupAddressCode || "").trim(),
      storeAddressCode: String(cached.storeAddressCode || "").trim(),
    };
  }

  // PostEx's documented v4.1.9 endpoint is get-merchant-address.
  // cityName is optional, so omit it to retrieve the merchant's registered addresses.
  const endpoints = [`${POSTEX_API_ROOT}/order/v1/get-merchant-address`];
  const lookupErrors = [];
  let resolved = null;

  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { token, Accept: "application/json" },
      });
      const payload = await readJson(response);

      if (!response.ok || Number(payload?.statusCode) !== 200) {
        lookupErrors.push(
          apiPayloadMessage(
            payload,
            `HTTP ${response.status} from PostEx address lookup`,
          ),
        );
        continue;
      }

      const rows = postExAddressRows(payload);
      const rowsWithCodes = rows
        .map((row) => ({
          row,
          pickup: postExAddressCodeFromRow(row),
          store: postExStoreAddressCodeFromRow(row),
          type: postExAddressTypeFromRow(row),
        }))
        .filter((entry) => entry.pickup || entry.store);
      const rootPickup = String(
        payload?.pickupAddressCode || payload?.dist?.pickupAddressCode || "",
      ).trim();
      const rootStore = String(
        payload?.storeAddressCode || payload?.dist?.storeAddressCode || "",
      ).trim();

      if (rootPickup || rootStore) {
        resolved = {
          pickupAddressCode: rootPickup,
          storeAddressCode: rootStore,
        };
        break;
      }

      if (rowsWithCodes.length) {
        const isReturn = orderType === "Reverse" || orderType === "Reversed";
        const preferred = isReturn
          ? rowsWithCodes.find((entry) => /return|reverse/.test(entry.type))
          : rowsWithCodes.find((entry) =>
              /pickup|default|shipper/.test(entry.type),
            );
        const chosen = preferred || rowsWithCodes[0];

        resolved = {
          pickupAddressCode:
            chosen.pickup ||
            rowsWithCodes.find((entry) => entry.pickup)?.pickup ||
            "",
          storeAddressCode:
            chosen.store ||
            rowsWithCodes.find((entry) => entry.store)?.store ||
            "",
        };
        if (resolved.pickupAddressCode || resolved.storeAddressCode) break;
      }

      lookupErrors.push(
        "PostEx address endpoint succeeded but returned no usable address code.",
      );
    } catch {
      lookupErrors.push(
        "Could not reach PostEx's get-merchant-address endpoint.",
      );
    }
  }

  if (
    !resolved ||
    (!resolved.pickupAddressCode && !resolved.storeAddressCode)
  ) {
    const detail = lookupErrors.find(Boolean);

    throw new Error(
      "PostEx requires a registered pickup address code or store address code. BYNDCART could not resolve one from your PostEx account. " +
        "Add the code in Courier Settings or register a pickup address in PostEx, then retry." +
        (detail ? ` PostEx lookup detail: ${detail}` : ""),
    );
  }

  // Persist the resolved values without replacing the city/type catalog or other courier settings.
  if (currentConfig) {
    try {
      const latest = await prisma.merchantCourierConfig.findUnique({
        where: configKey,
        select: { additionalConfig: true },
      });
      const latestAdditionalConfig =
        latest?.additionalConfig && typeof latest.additionalConfig === "object"
          ? latest.additionalConfig
          : {};
      const latestCache = {
        pickupAddressCode: resolved.pickupAddressCode,
        storeAddressCode: resolved.storeAddressCode,
        tokenFingerprint,
        cachedAt: new Date().toISOString(),
      };

      await prisma.merchantCourierConfig.update({
        where: configKey,
        data: {
          additionalConfig: JSON.parse(
            JSON.stringify({
              ...latestAdditionalConfig,
              byndcartPostExAddressCodes: latestCache,
            }),
          ),
        },
      });
    } catch {
      // Booking can proceed with the API-validated code even if the optional cache write fails.
    }
  }

  return resolved;
}

// -----------------------------------------------------------------------------
// 1. PostEx Merchant API (official guide v4.1.9)
// Token header; create-order v3; tracking, airway-bill and cancellation endpoints.
// -----------------------------------------------------------------------------
export class PostExCourierAdapter {
  providerName = "POSTEX";
  displayName = "PostEx";
  description =
    "PostEx Merchant API: reverse returns, normal shipments, replacement shipments, tracking and cancellation.";
  cityHubs = [
    "Karachi",
    "Lahore",
    "Islamabad",
    "Rawalpindi",
    "Faisalabad",
    "Multan",
    "Peshawar",
    "Quetta",
    "Sialkot",
  ];
  isLive = true;
  async testConnection(input) {
    const token = credentialValue(input.config, "apiToken");

    if (!token)
      return {
        success: false,
        message: "Enter the PostEx merchant API token.",
        isLive: false,
      };

    try {
      const response = await fetch(
        `${POSTEX_API_ROOT}/order/v2/get-operational-city`,
        {
          method: "GET",
          headers: { token, Accept: "application/json" },
        },
      );
      const payload = await readJson(response);
      const success =
        response.ok &&
        Number(payload?.statusCode) === 200 &&
        String(payload?.statusMessage || "")
          .toUpperCase()
          .includes("SUCCESSFULLY OPERATED") &&
        Array.isArray(payload?.dist);

      return success
        ? {
            success: true,
            message:
              "PostEx token verified against the Operational Cities API.",
            isLive: true,
          }
        : {
            success: false,
            message: apiPayloadMessage(
              payload,
              "PostEx did not verify the token. Check the token and merchant account access.",
            ),
            isLive: false,
          };
    } catch {
      return {
        success: false,
        message: "PostEx could not be reached. Check the connection and retry.",
        isLive: false,
      };
    }
  }
  async createOrder(input, credentials, orderType) {
    const token = credentialValue(credentials, "apiToken");

    if (!token)
      return unconfirmedBooking(
        this.providerName,
        "PostEx merchant API token is missing for this store.",
      );
    const isReturn = orderType === "Reverse" || orderType === "Reversed";
    const address = isReturn ? input.originAddress : input.destinationAddress;
    const customerName = String(input.customerName || "").trim();
    const customerPhoneRaw = String(input.customerPhone || "").trim();
    const customerAddress = String(
      address?.address1 || address?.address || "",
    ).trim();
    const cityName = String(input.cityName || address?.city || "").trim();

    if (!customerName)
      return unconfirmedBooking(
        this.providerName,
        "Customer name is required by PostEx.",
      );
    if (!customerAddress || customerAddress.length < 8)
      return unconfirmedBooking(
        this.providerName,
        "Enter a complete customer address before booking through PostEx.",
      );
    if (!cityName)
      return unconfirmedBooking(
        this.providerName,
        "Enter the customer's city as required by PostEx.",
      );
    let customerPhone;

    try {
      customerPhone = normalizePakistanMobileNumber(customerPhoneRaw);
    } catch (error) {
      return unconfirmedBooking(
        this.providerName,
        error instanceof Error
          ? error.message
          : "Enter a valid Pakistani mobile number.",
      );
    }

    const ref = String(input.orderNumber || input.orderId)
      .trim()
      .slice(0, 80);
    const quantity = Math.max(
      1,
      (input.items || []).reduce(
        (sum, item) => sum + Math.max(0, Number(item.quantity) || 0),
        0,
      ),
    );
    const details = (input.items || [])
      .map((item) => `${item.title} x ${item.quantity}`)
      .join(", ")
      .slice(0, 500);
    const body = {
      orderRefNumber: ref,
      invoicePayment: String(
        isReturn ? 0 : Math.max(0, Number(input.codAmountPKR) || 0),
      ),
      orderDetail:
        details || `BYNDCART ${orderType.toLowerCase()} shipment for ${ref}`,
      customerName,
      customerPhone,
      deliveryAddress: customerAddress,
      transactionNotes: String(
        input.remarks ||
          `BYNDCART ${orderType.toLowerCase()} shipment for ${ref}`,
      ).slice(0, 500),
      cityName,
      invoiceDivision: 1,
      items: quantity,
      // The UI displays "Reversed" as "Reverse"; send the provider's literal type value.
      orderType: orderType === "Reverse" ? "Reversed" : orderType,
    };
    let addressCodes;

    try {
      addressCodes = await resolvePostExAddressCodes(
        input.shopifyStoreId,
        credentials,
        orderType,
      );
    } catch (error) {
      return unconfirmedBooking(
        this.providerName,
        error instanceof Error
          ? error.message
          : "PostEx requires a valid pickup address code or store address code.",
      );
    }

    if (addressCodes.pickupAddressCode)
      body.pickupAddressCode = addressCodes.pickupAddressCode;
    if (addressCodes.storeAddressCode)
      body.storeAddressCode = addressCodes.storeAddressCode;

    if (!body.pickupAddressCode && !body.storeAddressCode) {
      return unconfirmedBooking(
        this.providerName,
        "PostEx requires at least one registered pickup or store address code.",
      );
    }

    try {
      await validatePostExCity(
        input.shopifyStoreId,
        cityName,
        orderType,
        token,
      );
    } catch (error) {
      return unconfirmedBooking(
        this.providerName,
        error instanceof Error
          ? error.message
          : "PostEx could not verify the pickup or delivery city.",
      );
    }

    try {
      const response = await fetch(`${POSTEX_API_ROOT}/order/v3/create-order`, {
        method: "POST",
        headers: {
          token,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });
      const payload = await readJson(response);
      const trackingNumber = String(
        payload?.dist?.trackingNumber || payload?.trackingNumber || "",
      ).trim();
      const accepted =
        response.ok &&
        Number(payload?.statusCode) === 200 &&
        trackingNumber.length > 0;

      if (!accepted) {
        return unconfirmedBooking(
          this.providerName,
          apiPayloadMessage(
            payload,
            "PostEx did not return statusCode 200 and a tracking number. No shipment record was created.",
          ),
        );
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
      return unconfirmedBooking(
        this.providerName,
        "PostEx could not be reached. No API-confirmed shipment was recorded.",
      );
    }
  }
  async createReverseShipment(input, credentials) {
    return this.createOrder(
      { ...input, shipmentType: "RETURN" },
      credentials,
      "Reverse",
    );
  }
  async generateReturnLabel(input, credentials) {
    return this.createReverseShipment(input, credentials);
  }
  async createForwardShipment(input, credentials) {
    const selectedType = String(input.courierServiceType || "").trim();
    const orderType =
      selectedType && selectedType !== "Reverse" && selectedType !== "Reversed"
        ? selectedType
        : input.shipmentType === "EXCHANGE"
          ? "Replacement"
          : "Normal";

    return this.createOrder(input, credentials, orderType);
  }
  async trackShipment(trackingNumber, credentials) {
    const token = credentialValue(credentials, "apiToken");

    if (!token)
      throw new Error("PostEx merchant API token is missing for this store.");
    const safeTracking = String(trackingNumber || "").trim();

    if (!safeTracking) throw new Error("A PostEx tracking number is required.");
    const response = await fetch(
      `${POSTEX_API_ROOT}/order/v1/track-order/${encodeURIComponent(safeTracking)}`,
      {
        method: "GET",
        headers: { token, Accept: "application/json" },
      },
    );
    const payload = await readJson(response);

    if (!response.ok || Number(payload?.statusCode) !== 200 || !payload?.dist) {
      throw new Error(
        apiPayloadMessage(payload, "PostEx tracking lookup failed."),
      );
    }

    const dist = payload.dist;
    const history = Array.isArray(dist.transactionStatusHistory)
      ? dist.transactionStatusHistory
      : [];
    const statusCandidate = String(
      dist.transactionStatus || dist.orderStatus || "",
    ).trim();
    // The API-level statusMessage is usually "SUCCESSFULLY OPERATED"; it is not a parcel
    // status and must never be normalized as DELIVERED. Use carrier tracking history as a fallback.
    const latestHistoryMessage = String(
      history[history.length - 1]?.transactionStatusMessage || "",
    ).trim();
    const rawStatus =
      statusCandidate && normalizeCourierStatus(statusCandidate) !== "UNKNOWN"
        ? statusCandidate
        : latestHistoryMessage || statusCandidate || "UNKNOWN";
    const historyEvents = history
      .map((item) => ({
        timestamp:
          item?.activityDate || item?.createdAt
            ? new Date(item.activityDate || item.createdAt)
            : new Date(NaN),
        status: normalizeCourierStatus(
          String(
            item?.transactionStatusMessage ||
              item?.transactionStatusMessageCode ||
              "UNKNOWN",
          ),
        ),
        description: String(
          item?.transactionStatusMessage ||
            item?.transactionStatusMessageCode ||
            "Status update",
        ),
      }))
      .filter((item) => !Number.isNaN(item.timestamp.getTime()));

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
  async cancelShipment(trackingNumber, credentials) {
    const token = credentialValue(credentials, "apiToken");

    if (!token)
      return {
        success: false,
        message: "PostEx merchant API token is missing for this store.",
      };
    const normalizedTracking = String(trackingNumber || "").trim();

    if (!normalizedTracking)
      return {
        success: false,
        message: "A PostEx tracking number is required.",
      };

    try {
      const response = await fetch(`${POSTEX_API_ROOT}/order/v1/cancel-order`, {
        method: "PUT",
        headers: {
          token,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ trackingNumber: normalizedTracking }),
      });
      const payload = await readJson(response);
      const bodyCodeExists = payload?.statusCode !== undefined;
      const success =
        response.ok &&
        (!bodyCodeExists || Number(payload.statusCode) === 200) &&
        payload?.success !== false;

      return success
        ? {
            success: true,
            message: "PostEx accepted the cancellation request.",
          }
        : {
            success: false,
            message: apiPayloadMessage(
              payload,
              `PostEx cancellation failed (HTTP ${response.status}).`,
            ),
          };
    } catch {
      return {
        success: false,
        message: "PostEx could not be reached. Cancellation was not confirmed.",
      };
    }
  }
}
// -----------------------------------------------------------------------------
// 2. Leopards Courier Merchant API (eCom Merchant APIs V2 PDF)
// Production endpoints use api_key + api_password in JSON request bodies.
// -----------------------------------------------------------------------------
export class LeopardsCourierAdapter {
  providerName = "LEOPARDS";
  displayName = "Leopards Courier";
  description =
    "Leopards Merchant API: booking, CN tracking and cancellation. Configure API key/password plus warehouse details for return pickups.";
  cityHubs = [
    "Karachi",
    "Lahore",
    "Islamabad",
    "Rawalpindi",
    "Faisalabad",
    "Multan",
    "Peshawar",
    "Quetta",
    "Sialkot",
    "Hyderabad",
  ];
  isLive = true;
  async testConnection(input) {
    const apiKey = credentialValue(input.config, "apiKey");
    const apiPassword = credentialValue(input.config, "apiPassword");

    if (!apiKey || !apiPassword)
      return {
        success: false,
        message: "Enter both the Leopards API key and API password.",
        isLive: false,
      };

    try {
      const cities = await loadLeopardsCities(
        apiKey,
        apiPassword,
        leopardsApiRoot(input.config),
      );

      return {
        success: true,
        message: `Leopards API credentials verified. ${cities.length} cities were returned.`,
        isLive: true,
      };
    } catch (error) {
      return {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Leopards API credential verification failed.",
        isLive: false,
      };
    }
  }
  async bookPacket(input, credentials, direction) {
    const apiKey = credentialValue(credentials, "apiKey");
    const apiPassword = credentialValue(credentials, "apiPassword");
    const apiRoot = leopardsApiRoot(credentials);

    if (!apiKey || !apiPassword)
      return unconfirmedBooking(
        this.providerName,
        "Leopards requires both API key and API password for this store.",
      );
    const reverse = direction === "RETURN";
    const merchantProfile = reverse
      ? input.destinationAddress || {}
      : input.originAddress || {};
    const warehouseCity = String(
      merchantProfile.city ||
        merchantProfile.cityName ||
        credentialValue(credentials, "warehouseCity") ||
        "",
    ).trim();
    const warehouseAddress = String(
      merchantProfile.address1 ||
        merchantProfile.address ||
        credentialValue(credentials, "warehouseAddress") ||
        "",
    ).trim();
    const warehouseName = String(
      merchantProfile.name ||
        merchantProfile.fullName ||
        credentialValue(credentials, "warehouseContactName") ||
        "",
    ).trim();
    const warehousePhoneRaw = String(
      merchantProfile.phone ||
        merchantProfile.phoneNumber ||
        credentialValue(credentials, "warehousePhone") ||
        "",
    ).trim();
    const warehouseEmail = String(
      merchantProfile.email ||
        merchantProfile.emailAddress ||
        credentialValue(credentials, "warehouseEmail") ||
        "",
    ).trim();
    const weightGrams = Math.round(
      Number(input.weightKg ? Number(input.weightKg) * 1000 : 1000),
    );

    if (
      !warehouseCity ||
      !warehouseAddress ||
      !warehouseName ||
      !warehousePhoneRaw
    ) {
      return unconfirmedBooking(
        this.providerName,
        "Complete sender name, phone, city, and address under Settings → Shipper profiles before booking with Leopards.",
      );
    }

    if (!Number.isFinite(weightGrams) || weightGrams <= 0) {
      return unconfirmedBooking(
        this.providerName,
        "Enter a valid parcel weight in the Booking table; Leopards requires weight in grams.",
      );
    }

    const customerName = String(input.customerName || "").trim();
    const customerEmail = String(
      input.customerEmail ||
        (reverse
          ? input.originAddress?.email
          : input.destinationAddress?.email) ||
        "",
    ).trim();
    const customerCity = String(
      input.cityName ||
        (direction === "RETURN"
          ? input.originAddress?.city
          : input.destinationAddress?.city) ||
        "",
    ).trim();
    const customerAddress = String(
      (direction === "RETURN" ? input.originAddress : input.destinationAddress)
        ?.address1 ||
        (direction === "RETURN"
          ? input.originAddress
          : input.destinationAddress
        )?.address ||
        "",
    ).trim();
    let customerPhone = "";
    let warehousePhone = "";

    try {
      customerPhone = normalizePakistanMobileNumber(input.customerPhone);
      warehousePhone = normalizePakistanMobileNumber(warehousePhoneRaw);
    } catch (error) {
      return unconfirmedBooking(
        this.providerName,
        error instanceof Error
          ? error.message
          : "Enter valid Pakistani mobile numbers.",
      );
    }

    if (!customerName || customerName.length < 2)
      return unconfirmedBooking(
        this.providerName,
        "A valid customer name is required by Leopards.",
      );
    if (!customerCity)
      return unconfirmedBooking(
        this.providerName,
        "Enter the customer's city before booking through Leopards.",
      );
    if (!customerAddress || customerAddress.length < 8)
      return unconfirmedBooking(
        this.providerName,
        "Enter the full customer address before booking through Leopards.",
      );
    // The supplied Leopards eCom API (v2) documents bookPacket only. It does not publish a
    // separate reverse-pickup endpoint. Returns use that same endpoint with the customer as
    // shipper and the merchant warehouse as consignee. Verify this account-specific return
    // behavior against the merchant's approved Leopards contract before enabling customer returns.
    const senderCityName = reverse ? customerCity : warehouseCity;
    const receiverCityName = reverse ? warehouseCity : customerCity;
    let cities;
    let originCity;
    let destinationCity;

    try {
      cities = await getCachedLeopardsCityRecords(
        input.shopifyStoreId,
        credentials,
      );
      originCity = resolveLeopardsCityId(cities, senderCityName, "origin");
      destinationCity = resolveLeopardsCityId(
        cities,
        receiverCityName,
        "destination",
      );
    } catch (error) {
      return unconfirmedBooking(
        this.providerName,
        error instanceof Error
          ? error.message
          : "Could not resolve Leopards origin/destination cities.",
      );
    }

    const destinationCityRecord = cities.find((city) =>
      sameLeopardsCityName(String(city.name || ""), receiverCityName),
    );
    const cityShipmentTypes = leopardsCityShipmentTypes(destinationCityRecord);

    if (!cityShipmentTypes.length) {
      return unconfirmedBooking(
        this.providerName,
        `Leopards did not return supported shipment types for destination city "${receiverCityName}". Refresh the Leopards city catalog before booking.`,
      );
    }

    const requestedServiceType = String(input.courierServiceType || "").trim();
    const selectedServiceType = requestedServiceType
      ? cityShipmentTypes.find(
          (type) =>
            type.toLocaleLowerCase() ===
            requestedServiceType.toLocaleLowerCase(),
        )
      : cityShipmentTypes[0];

    if (!selectedServiceType) {
      return unconfirmedBooking(
        this.providerName,
        `Leopards does not support shipment type "${requestedServiceType}" for ${receiverCityName}. Available types: ${cityShipmentTypes.join(", ")}.`,
      );
    }

    let shipmentId;

    try {
      shipmentId = extractNumericShopifyId(input.orderId);
    } catch (error) {
      return unconfirmedBooking(
        this.providerName,
        error instanceof Error ? error.message : "Shopify order ID is invalid.",
      );
    }

    const sender = reverse
      ? {
          name: customerName,
          email: customerEmail,
          phone: customerPhone,
          address: customerAddress,
        }
      : {
          name: warehouseName,
          email: warehouseEmail,
          phone: warehousePhone,
          address: warehouseAddress,
        };
    const receiver = reverse
      ? {
          name: warehouseName,
          email: warehouseEmail,
          phone: warehousePhone,
          address: warehouseAddress,
        }
      : {
          name: customerName,
          email: customerEmail,
          phone: customerPhone,
          address: customerAddress,
        };
    const pieces = Math.max(
      1,
      (input.items || []).reduce(
        (sum, item) => sum + Math.max(0, Number(item.quantity) || 0),
        0,
      ),
    );
    const totalCod = reverse
      ? 0
      : Math.max(0, Math.round(Number(input.codAmountPKR) || 0));
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
      shipment_type: selectedServiceType,
      consignment_name_eng: receiver.name,
      consignment_email: receiver.email,
      consignment_phone: receiver.phone,
      consignment_address: receiver.address,
      special_instructions: String(
        input.remarks || `BYNDCART ${direction.toLowerCase()} shipment`,
      ).slice(0, 500),
      ...(reverse
        ? { return_address: customerAddress, return_city: originCity }
        : { return_address: warehouseAddress, return_city: originCity }),
    };

    try {
      const response = await fetch(`${apiRoot}/bookPacket/format/json/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });
      const payload = await readJson(response);
      const trackingNumber = String(
        payload?.track_number || payload?.trackNumber || "",
      ).trim();
      const accepted =
        response.ok &&
        [1, "1", true].includes(payload?.status) &&
        trackingNumber.length > 0;

      if (!accepted) {
        return unconfirmedBooking(
          this.providerName,
          apiPayloadMessage(
            payload,
            "Leopards did not return status 1 and a consignment number. No shipment record was created.",
          ),
        );
      }

      return {
        success: true,
        trackingNumber,
        labelUrl:
          typeof payload?.slip_link === "string"
            ? payload.slip_link
            : undefined,
        courierName: this.providerName,
        rawResponse: payload,
        isLive: true,
      };
    } catch {
      return unconfirmedBooking(
        this.providerName,
        "Leopards could not be reached. No API-confirmed shipment was recorded.",
      );
    }
  }
  async createReverseShipment(input, credentials) {
    return this.bookPacket(
      { ...input, shipmentType: "RETURN" },
      credentials,
      "RETURN",
    );
  }
  async generateReturnLabel(input, credentials) {
    return this.createReverseShipment(input, credentials);
  }
  async createForwardShipment(input, credentials) {
    return this.bookPacket(
      input,
      credentials,
      input.shipmentType === "EXCHANGE" ? "EXCHANGE" : "FORWARD",
    );
  }
  async trackShipment(trackingNumber, credentials) {
    const apiKey = credentialValue(credentials, "apiKey");
    const apiPassword = credentialValue(credentials, "apiPassword");
    const apiRoot = leopardsApiRoot(credentials);
    const safeTracking = String(trackingNumber || "").trim();

    if (!apiKey || !apiPassword)
      throw new Error("Leopards API key/password are missing for this store.");
    if (!safeTracking)
      throw new Error("A Leopards consignment number is required.");
    const response = await fetch(`${apiRoot}/trackBookedPacket/format/json/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        api_key: apiKey,
        api_password: apiPassword,
        track_numbers: safeTracking,
      }),
    });
    const payload = await readJson(response);

    if (
      !response.ok ||
      ![1, "1", true].includes(payload?.status) ||
      !Array.isArray(payload?.packet_list)
    ) {
      throw new Error(
        apiPayloadMessage(payload, "Leopards tracking lookup failed."),
      );
    }

    const packet =
      payload.packet_list.find(
        (item) => String(item?.track_number || "").trim() === safeTracking,
      ) || payload.packet_list[0];

    if (!packet)
      throw new Error(
        "Leopards did not return tracking details for this consignment number.",
      );
    const rawStatus = String(
      packet.booked_packet_status || packet.status || "UNKNOWN",
    );
    const detail =
      packet["Tracking Detail"] ||
      packet.TrackingDetail ||
      packet.tracking_detail ||
      [];
    const eventItems = Array.isArray(detail)
      ? detail
          .map((event) => {
            const statusText = String(
              event.Status ||
                event.Staus ||
                event.Statuss ||
                rawStatus ||
                "Status update",
            );
            const dateText =
              event.Activity_Date ||
              event["Activity Date"] ||
              event.activity_date;
            const date = dateText ? new Date(String(dateText)) : null;

            return {
              timestamp:
                date && !Number.isNaN(date.getTime()) ? date : new Date(NaN),
              status: normalizeCourierStatus(statusText),
              description: [statusText, event.Reason || event.reason]
                .filter(Boolean)
                .join(" — "),
              location: event.Location || event.location,
            };
          })
          .filter((event) => !Number.isNaN(event.timestamp.getTime()))
      : [];

    return {
      trackingNumber: safeTracking,
      courierName: this.providerName,
      status: normalizeCourierStatus(rawStatus),
      rawStatus,
      location:
        String(
          packet.status_remarks ||
            packet.status_reamrks ||
            packet.destination_city_name ||
            "",
        ).trim() || undefined,
      updatedAt: new Date(),
      events: eventItems,
      rawPayload: payload,
    };
  }
  async cancelShipment(trackingNumber, credentials) {
    const apiKey = credentialValue(credentials, "apiKey");
    const apiPassword = credentialValue(credentials, "apiPassword");
    const apiRoot = leopardsApiRoot(credentials);
    const safeTracking = String(trackingNumber || "").trim();

    if (!apiKey || !apiPassword)
      return {
        success: false,
        message: "Leopards API key/password are missing for this store.",
      };
    if (!safeTracking)
      return {
        success: false,
        message: "A Leopards consignment number is required.",
      };

    try {
      const response = await fetch(
        `${apiRoot}/cancelBookedPackets/format/json/`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            api_key: apiKey,
            api_password: apiPassword,
            cn_numbers: safeTracking,
          }),
        },
      );
      const payload = await readJson(response);
      const succeeded = response.ok && [1, "1", true].includes(payload?.status);

      return succeeded
        ? {
            success: true,
            message: "Leopards accepted the cancellation request.",
          }
        : {
            success: false,
            message: apiPayloadMessage(
              payload,
              `Leopards cancellation failed (HTTP ${response.status}).`,
            ),
          };
    } catch {
      return {
        success: false,
        message:
          "Leopards could not be reached. Cancellation was not confirmed.",
      };
    }
  }
}
// -----------------------------------------------------------------------------
// DHL Express MyDHL REST API (3.3.4)
// -----------------------------------------------------------------------------
const DHL_PRODUCTION_API_ROOT = "https://express.api.dhl.com/mydhlapi";

function dhlApiRoot(_credentials) {
  return DHL_PRODUCTION_API_ROOT;
}

function valueFrom(source, ...keys) {
  for (const key of keys) {
    const value = source?.[key];

    if (value !== undefined && value !== null && String(value).trim())
      return String(value).trim();
  }

  return "";
}

function credentialAddress(credentials) {
  return {
    address1: valueFrom(credentials, "shipperAddress", "warehouseAddress"),
    city: valueFrom(credentials, "shipperCity", "warehouseCity"),
    state: valueFrom(credentials, "shipperState", "warehouseState"),
    postalCode: valueFrom(
      credentials,
      "shipperPostalCode",
      "warehousePostalCode",
    ),
    countryCode: valueFrom(
      credentials,
      "shipperCountryCode",
      "warehouseCountryCode",
    ).toUpperCase(),
    name: valueFrom(credentials, "shipperName", "warehouseContactName"),
    phone: valueFrom(credentials, "shipperPhone", "warehousePhone"),
    email: valueFrom(credentials, "shipperEmail", "warehouseEmail"),
    company: valueFrom(
      credentials,
      "shipperCompany",
      "warehouseCompany",
      "shipperName",
      "warehouseContactName",
    ),
  };
}

function normalizeDhlAddress(address, fallback, role) {
  const source = address || {};
  const street =
    valueFrom(
      source,
      "addressLine1",
      "address1",
      "street",
      "address",
      "addressLine",
    ) ||
    fallback?.address1 ||
    "";
  const city =
    valueFrom(source, "cityName", "city", "town") || fallback?.city || "";
  const countryCode =
    valueFrom(source, "countryCode", "country_code", "country") ||
    fallback?.countryCode ||
    "";
  const postalCode =
    valueFrom(source, "postalCode", "zip", "zipCode", "postcode") ||
    fallback?.postalCode ||
    "";
  const fullName =
    valueFrom(source, "fullName", "name", "contactName", "recipientName") ||
    [
      valueFrom(source, "firstName", "first_name"),
      valueFrom(source, "lastName", "last_name"),
    ]
      .filter(Boolean)
      .join(" ") ||
    fallback?.name ||
    "";
  const phone =
    valueFrom(source, "phone", "phoneNumber", "mobilePhone", "telephone") ||
    fallback?.phone ||
    "";
  const email =
    valueFrom(source, "email", "emailAddress") || fallback?.email || "";
  const companyName =
    valueFrom(source, "companyName", "company", "businessName") ||
    fallback?.company ||
    fullName;

  if (
    !street ||
    !city ||
    !countryCode ||
    countryCode.length !== 2 ||
    !fullName ||
    !phone
  ) {
    throw new Error(
      `DHL ${role} details are incomplete. Enter a full street address, city, two-letter country code, contact name, and phone number; add the required merchant address fields in Courier settings.`,
    );
  }

  return {
    postalAddress: {
      postalCode,
      cityName: city,
      countryCode: countryCode.toUpperCase(),
      addressLine1: street,
      ...(valueFrom(source, "addressLine2", "address2")
        ? { addressLine2: valueFrom(source, "addressLine2", "address2") }
        : {}),
      ...(valueFrom(source, "addressLine3", "address3")
        ? { addressLine3: valueFrom(source, "addressLine3", "address3") }
        : {}),
      ...(valueFrom(source, "state", "province", "stateOrProvinceCode")
        ? {
            provinceCode: valueFrom(
              source,
              "state",
              "province",
              "stateOrProvinceCode",
            ),
          }
        : {}),
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

function httpMessage(payload, fallback) {
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    return payload.errors
      .map((entry) => String(entry?.message || entry?.detail || entry))
      .join("; ");
  }

  return String(
    payload?.detail ||
      payload?.title ||
      payload?.message ||
      payload?.error ||
      payload?.statusMessage ||
      fallback,
  );
}

export class DHLCourierAdapter {
  providerName = "DHL";
  displayName = "DHL Express";
  description =
    "DHL Express MyDHL production REST API for account-authenticated shipment labels and tracking. The supplied REST contract does not expose shipment cancellation; it only documents pickup cancellation.";
  isLive = true;
  supportsCancellation = false;
  async testConnection(input) {
    const username = credentialValue(input.config, "username");
    const password = credentialValue(input.config, "password");
    const accountNumber = credentialValue(input.config, "accountNumber");

    if (!username || !password || !accountNumber) {
      return {
        success: false,
        message:
          "DHL API username, password, and shipper account number are required.",
        isLive: false,
      };
    }

    try {
      const response = await fetch(
        `${dhlApiRoot(input.config)}/reference-data?datasetName=country`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
            Accept: "application/json",
          },
        },
      );
      const payload = await readJson(response);

      return response.ok
        ? {
            success: true,
            message:
              "DHL MyDHL API authentication was accepted. Booking still depends on the account, product code, route, and shipment data being valid.",
            isLive: true,
          }
        : {
            success: false,
            message: httpMessage(
              payload,
              `DHL authentication check failed (HTTP ${response.status}).`,
            ),
            isLive: false,
          };
    } catch {
      return {
        success: false,
        message:
          "DHL MyDHL production API could not be reached. Verify production API access and retry.",
        isLive: false,
      };
    }
  }
  async createShipment(input, credentials, direction) {
    const username = credentialValue(credentials, "username");
    const password = credentialValue(credentials, "password");
    const accountNumber = credentialValue(credentials, "accountNumber");

    if (!username || !password || !accountNumber)
      return unconfirmedBooking(
        this.providerName,
        "DHL API username, password, and shipper account number are required for this store.",
      );
    const merchantAddress =
      input.shipmentType === "RETURN"
        ? {
            ...credentialAddress(credentials),
            ...(input.destinationAddress || {}),
          }
        : { ...credentialAddress(credentials), ...(input.originAddress || {}) };
    let shipperDetails;
    let receiverDetails;

    try {
      if (direction === "RETURN") {
        shipperDetails = normalizeDhlAddress(
          input.originAddress,
          null,
          "customer pickup",
        );
        receiverDetails = normalizeDhlAddress(
          input.destinationAddress,
          merchantAddress,
          "merchant delivery",
        );
      } else {
        shipperDetails = normalizeDhlAddress(
          input.originAddress,
          merchantAddress,
          "merchant dispatch",
        );
        receiverDetails = normalizeDhlAddress(
          input.destinationAddress,
          null,
          "customer delivery",
        );
      }
    } catch (error) {
      return unconfirmedBooking(
        this.providerName,
        error instanceof Error
          ? error.message
          : "DHL address details are incomplete.",
      );
    }

    const originCountry = String(
      shipperDetails.postalAddress.countryCode,
    ).toUpperCase();
    const destinationCountry = String(
      receiverDetails.postalAddress.countryCode,
    ).toUpperCase();
    const customsDeclarable =
      credentialValue(credentials, "isCustomsDeclarable").toLowerCase() ===
      "true";

    // The current shipment input does not include per-item customs origin, net weight, HS codes, or tariff line data.
    // Fail closed rather than inventing customs declarations for cross-border shipments.
    if (originCountry !== destinationCountry && !customsDeclarable) {
      return unconfirmedBooking(
        this.providerName,
        "DHL requires customs-declarable shipment data for cross-border routes. Enable customs handling only after line-level customs values and commodity data are supplied; no shipment was booked.",
      );
    }

    if (customsDeclarable) {
      return unconfirmedBooking(
        this.providerName,
        "DHL customs-declarable booking is not enabled because this app's shipment payload does not yet carry validated customs line items. No shipment was booked.",
      );
    }

    const weight = Number(
      input.weightKg || credentialValue(credentials, "defaultWeightKg") || 1,
    );

    if (!Number.isFinite(weight) || weight <= 0)
      return unconfirmedBooking(
        this.providerName,
        "Enter a positive parcel weight in kilograms in the shipment or DHL settings.",
      );
    const now = new Date();

    now.setUTCDate(now.getUTCDate() + 1);
    const plannedShippingDateAndTime = `${now.toISOString().slice(0, 19)} GMT+00:00`;
    const description =
      (input.items || [])
        .map((item) => item.title)
        .filter(Boolean)
        .join(", ")
        .slice(0, 70) || "Merchandise";
    const body = {
      plannedShippingDateAndTime,
      pickup: { isRequested: false },
      productCode: credentialValue(credentials, "productCode") || "P",
      getRateEstimates: false,
      accounts: [{ typeCode: "shipper", number: accountNumber }],
      outputImageProperties: {
        printerDPI: 300,
        encodingFormat: "pdf",
        imageOptions: [
          {
            typeCode: "label",
            templateName: "ECOM26_84_001",
            isRequested: true,
          },
        ],
        splitTransportAndWaybillDocLabels: true,
        allDocumentsInOneImage: false,
      },
      customerDetails: { shipperDetails, receiverDetails },
      content: {
        packages: [
          {
            typeCode: credentialValue(credentials, "packageType") || "2BP",
            weight,
          },
        ],
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
          "Message-Reference":
            `${input.shopifyStoreId.slice(0, 8)}-${Date.now()}`.slice(0, 36),
        },
        body: JSON.stringify(body),
      });
      const payload = await readJson(response);
      const trackingNumber = String(
        payload?.shipmentTrackingNumber ||
          payload?.packages?.[0]?.trackingNumber ||
          "",
      ).trim();

      if (!response.ok || !trackingNumber) {
        return unconfirmedBooking(
          this.providerName,
          httpMessage(
            payload,
            `DHL did not confirm the shipment (HTTP ${response.status}); no shipment was recorded.`,
          ),
        );
      }

      const docs = Array.isArray(payload?.documents) ? payload.documents : [];
      const labelDoc =
        docs.find(
          (doc) => String(doc?.typeCode || "").toLowerCase() === "label",
        ) ||
        docs.find(
          (doc) => String(doc?.imageFormat || "").toUpperCase() === "PDF",
        );
      const labelContentBase64 =
        typeof labelDoc?.content === "string" ? labelDoc.content : undefined;

      return {
        success: true,
        trackingNumber,
        courierName: this.displayName,
        labelUrl: labelContentBase64
          ? `/app/shipments-label?trackingNumber=${encodeURIComponent(trackingNumber)}&documentType=LABEL`
          : "",
        labelContentBase64,
        labelContentType:
          labelDoc?.imageFormat?.toLowerCase() === "png"
            ? "image/png"
            : "application/pdf",
        labelFileName: `DHL-${trackingNumber}.pdf`,
        carrierStatus: "SHIPMENT_CREATED",
        isLive: true,
        rawResponse: {
          shipmentTrackingNumber: trackingNumber,
          trackingUrl: payload?.trackingUrl || null,
          warnings: payload?.warnings || [],
        },
      };
    } catch {
      return unconfirmedBooking(
        this.providerName,
        "DHL MyDHL API could not be reached. No shipment was recorded.",
      );
    }
  }
  async createReverseShipment(input, credentials) {
    return this.createShipment(input, credentials || {}, "RETURN");
  }
  async generateReturnLabel(input, credentials) {
    return this.createShipment(input, credentials || {}, "RETURN");
  }
  async createForwardShipment(input, credentials) {
    return this.createShipment(
      input,
      credentials || {},
      input.shipmentType === "EXCHANGE" ? "EXCHANGE" : "FORWARD",
    );
  }
  async trackShipment(trackingNumber, credentials) {
    const username = credentialValue(credentials, "username");
    const password = credentialValue(credentials, "password");
    const accountNumber = credentialValue(credentials, "accountNumber");
    const safeTracking = String(trackingNumber || "").trim();

    if (!username || !password || !accountNumber)
      throw new Error(
        "DHL username, password, and account number are required for tracking.",
      );
    if (!safeTracking) throw new Error("A DHL tracking number is required.");
    const url = new URL(
      `${dhlApiRoot(credentials)}/shipments/${encodeURIComponent(safeTracking)}/tracking`,
    );

    url.searchParams.set("shipperAccountNumber", accountNumber);
    url.searchParams.set("trackingView", "all-checkpoints");
    url.searchParams.set("levelOfDetail", "all");
    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        Accept: "application/json",
      },
    });
    const payload = await readJson(response);

    if (!response.ok)
      throw new Error(
        httpMessage(payload, `DHL tracking failed (HTTP ${response.status}).`),
      );
    const shipment = Array.isArray(payload?.shipments)
      ? payload.shipments[0]
      : payload?.shipment || payload;
    const events = Array.isArray(shipment?.events) ? shipment.events : [];
    const latest = events.length ? events[events.length - 1] : null;
    const rawStatus =
      valueFrom(latest, "description", "status", "typeCode") ||
      valueFrom(shipment, "status", "description", "statusCode") ||
      "UNKNOWN";
    const status = normalizeCourierStatus(rawStatus);
    const serviceArea =
      latest?.serviceArea || latest?.serviceAreaDescription || {};
    const location =
      typeof serviceArea === "string"
        ? serviceArea
        : valueFrom(serviceArea, "description", "facilityName", "cityName");
    const eventRows = events.map((event) => ({
      timestamp: new Date(valueFrom(event, "date", "timestamp") || Date.now()),
      status: normalizeCourierStatus(
        valueFrom(event, "description", "status", "typeCode"),
      ),
      description:
        valueFrom(event, "description", "status", "typeCode") ||
        "DHL tracking event",
      location:
        valueFrom(
          event?.serviceArea,
          "description",
          "facilityName",
          "cityName",
        ) || undefined,
    }));

    return {
      trackingNumber: safeTracking,
      courierName: this.displayName,
      status,
      rawStatus,
      location: location || undefined,
      updatedAt: new Date(),
      events: eventRows,
      rawPayload: payload,
    };
  }
  async cancelShipment(trackingNumber) {
    return {
      success: false,
      message:
        "The supplied DHL REST contract documents cancellation of a pickup request, not cancellation of a shipment by tracking number. BYNDCART will not claim this shipment was cancelled.",
    };
  }
}
// -----------------------------------------------------------------------------
// FedEx Ship API + Track API
// OAuth endpoint is documented by FedEx; shipment/tracking paths follow the supplied specs.
// -----------------------------------------------------------------------------
const FEDEX_TOKEN_CACHE = new Map();

function fedexApiRoot(_credentials) {
  return "https://apis.fedex.com";
}

function normalizeFedExParty(address, fallback, role) {
  const source = address || {};
  const rawStreet = source.streetLines;
  const streetLines = Array.isArray(rawStreet)
    ? rawStreet.map((line) => String(line).trim()).filter(Boolean)
    : [];
  const street =
    valueFrom(source, "address1", "addressLine1", "address", "street") ||
    fallback?.address1 ||
    "";

  if (!streetLines.length && street) streetLines.push(street);
  const city =
    valueFrom(source, "city", "cityName", "town") || fallback?.city || "";
  const countryCode = (
    valueFrom(source, "countryCode", "country_code", "country") ||
    fallback?.countryCode ||
    ""
  ).toUpperCase();
  const postalCode =
    valueFrom(source, "postalCode", "postcode", "zip", "zipCode") ||
    fallback?.postalCode ||
    "";
  const stateOrProvinceCode =
    valueFrom(source, "stateOrProvinceCode", "state", "province") ||
    fallback?.state ||
    "";
  const personName =
    valueFrom(
      source,
      "personName",
      "fullName",
      "name",
      "contactName",
      "recipientName",
    ) ||
    [
      valueFrom(source, "firstName", "first_name"),
      valueFrom(source, "lastName", "last_name"),
    ]
      .filter(Boolean)
      .join(" ") ||
    fallback?.name ||
    "";
  const companyName =
    valueFrom(source, "companyName", "company", "businessName") ||
    fallback?.company ||
    personName;
  const phoneNumber =
    valueFrom(source, "phoneNumber", "phone", "mobilePhone", "telephone") ||
    fallback?.phone ||
    "";
  const emailAddress =
    valueFrom(source, "emailAddress", "email") || fallback?.email || "";

  if (
    !streetLines.length ||
    !city ||
    countryCode.length !== 2 ||
    !personName ||
    !phoneNumber
  ) {
    throw new Error(
      `FedEx ${role} details are incomplete. A street address, city, two-letter country code, contact name, and phone number are required; check the customer address and merchant shipper fields in Courier settings.`,
    );
  }

  return {
    address: {
      streetLines: streetLines.slice(0, 3),
      city,
      countryCode,
      ...(stateOrProvinceCode ? { stateOrProvinceCode } : {}),
      ...(postalCode ? { postalCode } : {}),
      residential: Boolean(source.residential ?? true),
    },
    contact: {
      personName,
      phoneNumber,
      ...(emailAddress ? { emailAddress } : {}),
      ...(companyName ? { companyName } : {}),
    },
  };
}

function fedexApiError(payload, fallback) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const notifications =
    payload?.output?.alerts ||
    payload?.output?.transactionShipments?.[0]?.alerts ||
    [];

  if (errors.length)
    return errors
      .map((error) => String(error?.message || error?.code || error))
      .join("; ");
  const errorAlerts = Array.isArray(notifications)
    ? notifications.filter(
        (alert) => String(alert?.severity || "").toLowerCase() === "error",
      )
    : [];

  if (errorAlerts.length)
    return errorAlerts
      .map((alert) => String(alert?.message || alert?.code || alert))
      .join("; ");

  return String(payload?.message || payload?.detail || fallback);
}

function recursiveFedExFind(root, keys, visited = new Set()) {
  if (!root || typeof root !== "object" || visited.has(root)) return undefined;
  visited.add(root);

  for (const key of keys) {
    const value = root[key];

    if (
      value !== undefined &&
      value !== null &&
      (typeof value === "string" || typeof value === "number")
    )
      return value;
  }

  const values = Array.isArray(root) ? root : Object.values(root);

  for (const value of values) {
    const result = recursiveFedExFind(value, keys, visited);

    if (result !== undefined) return result;
  }

  return undefined;
}

export class FedExCourierAdapter {
  providerName = "FEDEX";
  displayName = "FedEx";
  description =
    "FedEx production Ship and Track APIs with client-credentials OAuth 2.0, PDF label handling, shipment cancellation, and return shipment labels. Production account and service access must be enabled by FedEx.";
  isLive = true;
  supportsCancellation = true;
  async getAccessToken(credentials) {
    const clientId = credentialValue(credentials, "clientId");
    const clientSecret = credentialValue(credentials, "clientSecret");

    if (!clientId || !clientSecret)
      throw new Error("FedEx API client ID and client secret are required.");
    const root = fedexApiRoot(credentials);
    const secretFingerprint = createHash("sha256")
      .update(clientSecret)
      .digest("hex");
    const cacheKey = `${clientId}:${secretFingerprint}`;
    const cached = FEDEX_TOKEN_CACHE.get(cacheKey);

    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    // BYNDCART uses the production FedEx client-credentials OAuth flow.
    // Environment and grant-type selectors are intentionally not merchant-configurable.
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    });
    const response = await fetch(`${root}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form,
    });
    const payload = await readJson(response);

    if (!response.ok || !payload?.access_token)
      throw new Error(
        httpMessage(payload, `FedEx OAuth failed (HTTP ${response.status}).`),
      );
    const expiresIn = Math.max(120, Number(payload.expires_in) || 3600);

    FEDEX_TOKEN_CACHE.set(cacheKey, {
      token: String(payload.access_token),
      expiresAt: Date.now() + expiresIn * 1000,
    });

    return String(payload.access_token);
  }
  async testConnection(input) {
    const credentials = input.config;

    for (const key of ["clientId", "clientSecret", "accountNumber"]) {
      if (!credentialValue(credentials, key))
        return {
          success: false,
          message: `FedEx ${key === "clientId" ? "API client ID" : key === "clientSecret" ? "API client secret" : "account number"} is required.`,
          isLive: false,
        };
    }

    try {
      await this.getAccessToken(credentials);

      return {
        success: true,
        message:
          "FedEx OAuth credentials were accepted. FedEx account and service availability will be verified when a shipment is validated/booked.",
        isLive: true,
      };
    } catch (error) {
      return {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "FedEx connection test failed.",
        isLive: false,
      };
    }
  }
  async createShipment(input, credentials, isReturn) {
    let token;

    try {
      token = await this.getAccessToken(credentials);
    } catch (error) {
      return unconfirmedBooking(
        this.providerName,
        error instanceof Error ? error.message : "FedEx OAuth failed.",
      );
    }

    const accountNumber = credentialValue(credentials, "accountNumber");
    const merchantAddress =
      input.shipmentType === "RETURN"
        ? {
            ...credentialAddress(credentials),
            ...(input.destinationAddress || {}),
          }
        : { ...credentialAddress(credentials), ...(input.originAddress || {}) };
    let shipper;
    let recipient;

    try {
      if (isReturn) {
        shipper = normalizeFedExParty(
          input.originAddress,
          null,
          "customer pickup/return sender",
        );
        recipient = normalizeFedExParty(
          input.destinationAddress,
          merchantAddress,
          "merchant return destination",
        );
      } else {
        shipper = normalizeFedExParty(
          input.originAddress,
          merchantAddress,
          "merchant shipper",
        );
        recipient = normalizeFedExParty(
          input.destinationAddress,
          null,
          "customer recipient",
        );
      }
    } catch (error) {
      return unconfirmedBooking(
        this.providerName,
        error instanceof Error
          ? error.message
          : "FedEx shipment addresses are incomplete.",
      );
    }

    const weight = Number(
      input.weightKg || credentialValue(credentials, "defaultWeightKg") || 1,
    );

    if (!Number.isFinite(weight) || weight <= 0)
      return unconfirmedBooking(
        this.providerName,
        "Enter a positive parcel weight in kilograms in the shipment or FedEx settings.",
      );
    const requestedShipment = {
      shipDatestamp: new Date().toISOString().slice(0, 10),
      pickupType:
        credentialValue(credentials, "pickupType") ||
        "DROPOFF_AT_FEDEX_LOCATION",
      serviceType:
        credentialValue(credentials, "serviceType") ||
        "FEDEX_INTERNATIONAL_PRIORITY",
      packagingType:
        credentialValue(credentials, "packagingType") || "YOUR_PACKAGING",
      shipper,
      recipients: [recipient],
      shippingChargesPayment: { paymentType: "SENDER" },
      labelSpecification: {
        imageType: "PDF",
        labelStockType: "PAPER_4X6",
        labelFormatType: "COMMON2D",
      },
      requestedPackageLineItems: [
        {
          weight: { units: "KG", value: Number(weight.toFixed(1)) },
          itemDescription:
            (input.items || [])
              .map((item) => item.title)
              .filter(Boolean)
              .join(", ")
              .slice(0, 50) || "Merchandise",
        },
      ],
      totalWeight: Number(weight.toFixed(1)),
    };

    if (isReturn) {
      requestedShipment.shipmentSpecialServices = {
        specialServiceTypes: ["RETURN_SHIPMENT"],
        returnShipmentDetail: { returnType: "PRINT_RETURN_LABEL" },
      };
    }

    const body = {
      labelResponseOptions: "LABEL",
      accountNumber: { value: accountNumber },
      requestedShipment,
    };

    try {
      const response = await fetch(
        `${fedexApiRoot(credentials)}/ship/v1/shipments`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "x-customer-transaction-id":
              `${input.shopifyStoreId.slice(0, 8)}-${Date.now()}`.slice(0, 36),
          },
          body: JSON.stringify(body),
        },
      );
      const payload = await readJson(response);

      if (!response.ok || payload?.errors?.length)
        return unconfirmedBooking(
          this.providerName,
          fedexApiError(
            payload,
            `FedEx shipment creation failed (HTTP ${response.status}).`,
          ),
        );
      const transaction = payload?.output?.transactionShipments?.[0];
      const piece = transaction?.pieceResponses?.[0];
      const trackingNumber = String(
        transaction?.masterTrackingNumber ||
          piece?.trackingNumber ||
          piece?.masterTrackingNumber ||
          "",
      ).trim();

      if (!trackingNumber)
        return unconfirmedBooking(
          this.providerName,
          "FedEx returned no tracking number. No shipment was recorded.",
        );
      const documents = [
        ...(Array.isArray(transaction?.shipmentDocuments)
          ? transaction.shipmentDocuments
          : []),
        ...(Array.isArray(piece?.packageDocuments)
          ? piece.packageDocuments
          : []),
      ];
      const label =
        documents.find(
          (document) =>
            String(document?.contentType || "").toUpperCase() === "LABEL",
        ) ||
        documents.find((document) => document?.encodedLabel || document?.url);
      const encodedLabel =
        typeof label?.encodedLabel === "string"
          ? label.encodedLabel
          : undefined;
      const remoteUrl = typeof label?.url === "string" ? label.url : undefined;

      return {
        success: true,
        trackingNumber,
        courierName: this.displayName,
        labelUrl: encodedLabel
          ? `/app/shipments-label?trackingNumber=${encodeURIComponent(trackingNumber)}&documentType=LABEL`
          : remoteUrl || "",
        labelContentBase64: encodedLabel,
        labelContentType:
          String(label?.docType || "PDF").toUpperCase() === "PDF"
            ? "application/pdf"
            : "application/octet-stream",
        labelFileName: `FedEx-${trackingNumber}.pdf`,
        isLive: true,
        carrierStatus: "SHIPMENT_CREATED",
        rawResponse: {
          trackingNumber,
          serviceType:
            transaction?.serviceType || requestedShipment.serviceType,
          alerts: transaction?.alerts || [],
        },
      };
    } catch {
      return unconfirmedBooking(
        this.providerName,
        "FedEx Ship API could not be reached. No shipment was recorded.",
      );
    }
  }
  async createReverseShipment(input, credentials) {
    return this.createShipment(input, credentials || {}, true);
  }
  async generateReturnLabel(input, credentials) {
    return this.createShipment(input, credentials || {}, true);
  }
  async createForwardShipment(input, credentials) {
    return this.createShipment(input, credentials || {}, false);
  }
  async trackShipment(trackingNumber, credentials) {
    const token = await this.getAccessToken(credentials || {});
    const safeTracking = String(trackingNumber || "").trim();

    if (!safeTracking) throw new Error("A FedEx tracking number is required.");
    const response = await fetch(
      `${fedexApiRoot(credentials)}/track/v1/trackingnumbers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          includeDetailedScans: true,
          trackingInfo: [
            { trackingNumberInfo: { trackingNumber: safeTracking } },
          ],
        }),
      },
    );
    const payload = await readJson(response);

    if (!response.ok || payload?.errors?.length)
      throw new Error(
        fedexApiError(
          payload,
          `FedEx tracking failed (HTTP ${response.status}).`,
        ),
      );
    const statusDescription = recursiveFedExFind(payload, [
      "statusByLocale",
      "statusDescription",
      "eventDescription",
      "description",
      "derivedStatus",
    ]);
    const rawStatus =
      typeof statusDescription === "string" ? statusDescription : "UNKNOWN";
    const location = recursiveFedExFind(payload, [
      "city",
      "cityName",
      "locationDescription",
    ]);
    const updatedTimestamp = recursiveFedExFind(payload, [
      "dateTime",
      "scanDateTime",
      "date",
    ]);
    const timestamp =
      typeof updatedTimestamp === "string" &&
      !Number.isNaN(Date.parse(updatedTimestamp))
        ? new Date(updatedTimestamp)
        : new Date();

    return {
      trackingNumber: safeTracking,
      courierName: this.displayName,
      status: normalizeCourierStatus(rawStatus),
      rawStatus,
      location: typeof location === "string" ? location : undefined,
      updatedAt: timestamp,
      rawPayload: payload,
    };
  }
  async cancelShipment(trackingNumber, credentials) {
    const safeTracking = String(trackingNumber || "").trim();

    if (!safeTracking)
      return {
        success: false,
        message: "A FedEx tracking number is required.",
      };

    try {
      const token = await this.getAccessToken(credentials || {});
      const response = await fetch(
        `${fedexApiRoot(credentials)}/ship/v1/shipments/cancel`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            accountNumber: {
              value: credentialValue(credentials, "accountNumber"),
            },
            trackingNumber: safeTracking,
            emailShipment: false,
            deletionControl: "DELETE_ALL_PACKAGES",
            ...(credentialValue(credentials, "shipperCountryCode")
              ? {
                  senderCountryCode: credentialValue(
                    credentials,
                    "shipperCountryCode",
                  ).toUpperCase(),
                }
              : {}),
            version: { major: 1, minor: 0, patch: 0 },
          }),
        },
      );
      const payload = await readJson(response);
      const errors = Array.isArray(payload?.errors) ? payload.errors : [];

      return response.ok && !errors.length
        ? {
            success: true,
            message: "FedEx accepted the shipment cancellation request.",
          }
        : {
            success: false,
            message: fedexApiError(
              payload,
              `FedEx cancellation failed (HTTP ${response.status}).`,
            ),
          };
    } catch (error) {
      return {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "FedEx cancellation could not be confirmed.",
      };
    }
  }
}
// -----------------------------------------------------------------------------
// 3. Trax Courier Adapter (Smart Returns REST API)
// Official API Docs: https://api.trax.pk/v1
// -----------------------------------------------------------------------------
export class TraxCourierAdapter {
  providerName = "TRAX";
  displayName = "Trax Express Smart Returns";
  description =
    "API setup is pending a current, official Pakistan TRAX merchant API specification.";
  cityHubs = [
    "Karachi",
    "Lahore",
    "Islamabad",
    "Faisalabad",
    "Multan",
    "Peshawar",
  ];
  isLive = false;
  async testConnection(input) {
    if (!input.config.apiToken) {
      return {
        success: false,
        message: "Trax API token is required.",
        isLive: false,
      };
    }

    return credentialsStored("Trax");
  }
  async createReverseShipment(_input, _credentials) {
    return unconfirmedBooking(this.providerName);
  }
  async createForwardShipment(input, credentials) {
    return this.createReverseShipment(input, credentials);
  }
  async generateReturnLabel(input, credentials) {
    return this.createReverseShipment(input, credentials);
  }
  async trackShipment(trackingNumber) {
    return unconfirmedTracking(this.providerName, trackingNumber);
  }
  async cancelShipment(_trackingNumber) {
    return unconfirmedCancel(this.providerName);
  }
}
// -----------------------------------------------------------------------------
// TCS COD API (the supplied separate Transit API is an ETA calculator, not scan tracking)
// -----------------------------------------------------------------------------
const TCS_COD_API_ROOT = "https://api.tcscourier.com/production/v1/cod";

function tcsHeaders(credentials) {
  return {
    "X-IBM-Client-Id": credentialValue(credentials, "clientId"),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function tcsReturnStatusSucceeded(payload) {
  const status = payload?.returnStatus;

  return (
    !status ||
    (String(status.code) === "0200" &&
      String(status.status || "").toUpperCase() === "SUCCESS")
  );
}

function tcsReturnedNumber(payload) {
  return String(
    payload?.CN ||
      payload?.cn ||
      payload?.consignmentNumber ||
      payload?.consignmentNo ||
      payload?.bookingReply?.CN ||
      payload?.data?.CN ||
      payload?.data?.bookingReply?.CN ||
      "",
  ).trim();
}

export class TCSCourierAdapter {
  providerName = "TCS";
  displayName = "TCS Courier";
  description =
    "TCS COD API: standard consignment booking, consignment lookup, cancellation, and reverse logistics when the original order has a TCS consignment number. The supplied API does not return scan-level tracking events or shipping labels.";
  cityHubs = [
    "Karachi",
    "Lahore",
    "Islamabad",
    "Rawalpindi",
    "Faisalabad",
    "Multan",
    "Peshawar",
    "Quetta",
  ];
  isLive = true;
  supportsCancellation = true;
  async testConnection(input) {
    const clientId = credentialValue(input.config, "clientId");
    const userName = credentialValue(input.config, "userName");
    const password = credentialValue(input.config, "password");
    const costCenterCode = credentialValue(input.config, "costCenterCode");

    if (!clientId || !userName || !password || !costCenterCode) {
      return {
        success: false,
        message:
          "TCS Client ID, username, password, and cost center code are required.",
        isLive: false,
      };
    }

    try {
      const response = await fetch(`${TCS_COD_API_ROOT}/cities`, {
        headers: tcsHeaders(input.config),
      });
      const payload = await readJson(response);
      const cities = payload?.city || payload?.cities || payload?.data?.city;

      if (response.ok && Array.isArray(cities) && cities.length > 0) {
        return {
          success: true,
          message:
            "TCS API Client ID/subscription verified through the Cities endpoint. The supplied contract has no non-mutating username/password test; TCS validates booking credentials when a booking is attempted.",
          isLive: true,
        };
      }

      return {
        success: false,
        message: httpMessage(
          payload,
          `TCS connection test failed (HTTP ${response.status}). Check the Client ID and API subscription. `,
        ),
        isLive: false,
      };
    } catch {
      return {
        success: false,
        message:
          "TCS COD API could not be reached. Check the API subscription and retry.",
        isLive: false,
      };
    }
  }
  async bookForward(input, credentials) {
    const userName = credentialValue(credentials, "userName");
    const password = credentialValue(credentials, "password");
    const costCenterCode = credentialValue(credentials, "costCenterCode");
    const warehouseCity =
      valueFrom(input.originAddress, "city", "cityName") ||
      credentialValue(credentials, "warehouseCity");
    const customer = input.destinationAddress || {};
    const customerCity =
      valueFrom(input, "cityName") || valueFrom(customer, "city", "cityName");
    const consigneeName =
      valueFrom(customer, "name", "fullName", "contactName") ||
      input.customerName ||
      "";
    const consigneeAddress = valueFrom(
      customer,
      "address1",
      "address",
      "street",
      "addressLine1",
    );
    let consigneeMobNo =
      valueFrom(customer, "phone", "phoneNumber", "mobilePhone") ||
      input.customerPhone ||
      "";
    const consigneeEmail =
      valueFrom(customer, "email", "emailAddress") || input.customerEmail || "";
    const weight = Number(
      input.weightKg || credentialValue(credentials, "defaultWeightKg"),
    );

    if (!userName || !password || !costCenterCode)
      return unconfirmedBooking(
        this.providerName,
        "Configure TCS username, password, and cost center code first.",
      );
    if (!warehouseCity || !customerCity)
      return unconfirmedBooking(
        this.providerName,
        "TCS requires both the merchant warehouse city and customer destination city.",
      );
    if (!consigneeName || !consigneeAddress || !consigneeEmail)
      return unconfirmedBooking(
        this.providerName,
        "TCS requires the customer's name, full address, and email address before booking.",
      );
    if (!Number.isFinite(weight) || weight <= 0)
      return unconfirmedBooking(
        this.providerName,
        "Enter a positive parcel weight in kilograms in the shipment or TCS settings.",
      );

    try {
      consigneeMobNo = normalizePakistanMobileNumber(consigneeMobNo);
    } catch (error) {
      return unconfirmedBooking(
        this.providerName,
        error instanceof Error
          ? error.message
          : "A valid customer mobile number is required by TCS.",
      );
    }

    const itemsDescription =
      (input.items || [])
        .map((item) => `${item.quantity}x ${item.title}`)
        .filter(Boolean)
        .join(", ")
        .slice(0, 240) || "Merchandise";
    const codAmount = Number.isFinite(Number(input.codAmountPKR))
      ? Math.max(0, Number(input.codAmountPKR))
      : 0;
    const body = {
      userName,
      password,
      costCenterCode,
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
      const response = await fetch(`${TCS_COD_API_ROOT}/create-order`, {
        method: "POST",
        headers: tcsHeaders(credentials),
        body: JSON.stringify(body),
      });
      const payload = await readJson(response);
      const consignmentNumber = tcsReturnedNumber(payload);

      if (
        !response.ok ||
        !tcsReturnStatusSucceeded(payload) ||
        !consignmentNumber
      ) {
        return unconfirmedBooking(
          this.providerName,
          httpMessage(
            payload,
            `TCS did not confirm booking (HTTP ${response.status}); no shipment was recorded.`,
          ),
        );
      }

      return {
        success: true,
        trackingNumber: consignmentNumber,
        courierName: this.displayName,
        isLive: true,
        carrierStatus: "BOOKED",
        rawResponse: {
          CN: consignmentNumber,
          returnStatus: payload?.returnStatus || null,
        },
      };
    } catch {
      return unconfirmedBooking(
        this.providerName,
        "TCS booking endpoint could not be reached. No shipment was recorded.",
      );
    }
  }
  async createReverseShipment(input, credentials) {
    const config = credentials || {};
    const userName = credentialValue(config, "userName");
    const password = credentialValue(config, "password");
    const costCenterCode = credentialValue(config, "costCenterCode");
    let customerPhone =
      input.customerPhone ||
      valueFrom(input.originAddress, "phone", "phoneNumber", "mobilePhone");

    if (!userName || !password || !costCenterCode)
      return unconfirmedBooking(
        this.providerName,
        "Configure TCS username, password, and cost center code first.",
      );
    // reverse-logistics requires a pre-existing TCS consignment number. Never substitute a Shopify order ID.
    const originalTcsShipment = await prisma.shipmentTrack.findFirst({
      where: {
        shopifyStoreId: input.shopifyStoreId,
        shopifyOrderId: input.orderId,
        courier: "TCS",
      },
      orderBy: { createdAt: "desc" },
      select: { trackingNumber: true },
    });

    if (!originalTcsShipment?.trackingNumber) {
      return unconfirmedBooking(
        this.providerName,
        "TCS reverse-logistics requires the original TCS consignment number. This order has no prior TCS shipment in BYNDCART, so no reverse request was sent.",
      );
    }

    try {
      customerPhone = normalizePakistanMobileNumber(customerPhone);
    } catch (error) {
      return unconfirmedBooking(
        this.providerName,
        error instanceof Error
          ? error.message
          : "A valid customer phone is required by TCS.",
      );
    }

    try {
      const response = await fetch(`${TCS_COD_API_ROOT}/reverse-logistics`, {
        method: "POST",
        headers: tcsHeaders(config),
        body: JSON.stringify({
          userName,
          password,
          costCenterCode,
          consignmentNo: originalTcsShipment.trackingNumber,
          consigneeMobNo: customerPhone,
        }),
      });
      const payload = await readJson(response);
      const consignmentNumber = tcsReturnedNumber(payload);

      if (
        !response.ok ||
        !tcsReturnStatusSucceeded(payload) ||
        !consignmentNumber
      ) {
        return unconfirmedBooking(
          this.providerName,
          httpMessage(
            payload,
            `TCS reverse logistics failed (HTTP ${response.status}); no shipment was recorded.`,
          ),
        );
      }

      return {
        success: true,
        trackingNumber: consignmentNumber,
        courierName: this.displayName,
        isLive: true,
        carrierStatus: "REVERSE_REQUESTED",
        rawResponse: {
          CN: consignmentNumber,
          returnStatus: payload?.returnStatus || null,
        },
      };
    } catch {
      return unconfirmedBooking(
        this.providerName,
        "TCS reverse-logistics endpoint could not be reached. No shipment was recorded.",
      );
    }
  }
  async generateReturnLabel(input, credentials) {
    return this.createReverseShipment(input, credentials);
  }
  async createForwardShipment(input, credentials) {
    return this.bookForward(input, credentials || {});
  }
  async trackShipment(trackingNumber, credentials) {
    const config = credentials || {};
    const userName = credentialValue(config, "userName");
    const password = credentialValue(config, "password");
    const clientId = credentialValue(config, "clientId");
    const safeTracking = String(trackingNumber || "").trim();

    if (!userName || !password || !clientId)
      throw new Error(
        "TCS Client ID, username, and password are required for tracking.",
      );
    if (!safeTracking)
      throw new Error("A TCS consignment/reference number is required.");
    const url = new URL(`${TCS_COD_API_ROOT}/track-order`);

    url.searchParams.set("userName", userName);
    url.searchParams.set("password", password);
    url.searchParams.set("referenceNo", safeTracking);
    let response;

    try {
      response = await fetch(url, {
        headers: { "X-IBM-Client-Id": clientId, Accept: "application/json" },
      });
    } catch {
      throw new Error("TCS consignment lookup could not be reached.");
    }

    const payload = await readJson(response);

    if (!response.ok || !tcsReturnStatusSucceeded(payload))
      throw new Error(
        httpMessage(
          payload,
          `TCS consignment lookup failed (HTTP ${response.status}).`,
        ),
      );
    const rows = Array.isArray(payload?.cnDetail) ? payload.cnDetail : [];
    const detail =
      rows.find(
        (row) => String(row?.consignmentNumber || "") === safeTracking,
      ) || rows[0];

    if (!detail)
      throw new Error(
        "TCS returned no consignment details for this reference.",
      );
    const rawStatus =
      valueFrom(
        detail,
        "status",
        "consignmentStatus",
        "shipmentStatus",
        "statusDescription",
      ) ||
      "Consignment details available; scan status not included in the supplied TCS COD contract";
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
  async cancelShipment(trackingNumber, credentials) {
    const config = credentials || {};
    const userName = credentialValue(config, "userName");
    const password = credentialValue(config, "password");
    const safeTracking = String(trackingNumber || "").trim();

    if (!userName || !password || !credentialValue(config, "clientId"))
      return {
        success: false,
        message:
          "TCS Client ID, username, and password are required for cancellation.",
      };
    if (!safeTracking)
      return {
        success: false,
        message: "A TCS consignment number is required for cancellation.",
      };

    try {
      const response = await fetch(`${TCS_COD_API_ROOT}/cancel-order`, {
        method: "PUT",
        headers: tcsHeaders(config),
        body: JSON.stringify({
          userName,
          password,
          consignmentNumber: safeTracking,
        }),
      });
      const payload = await readJson(response);
      const status = payload?.returnStatus;
      const succeeded =
        response.ok &&
        String(status?.code || "") === "0200" &&
        String(status?.status || "").toUpperCase() === "SUCCESS";

      return succeeded
        ? {
            success: true,
            message: String(
              status?.message || "TCS accepted the cancellation request.",
            ),
          }
        : {
            success: false,
            message: httpMessage(
              payload,
              `TCS cancellation failed (HTTP ${response.status}).`,
            ),
          };
    } catch {
      return {
        success: false,
        message:
          "TCS cancellation endpoint could not be reached. Cancellation was not confirmed.",
      };
    }
  }
}
// -----------------------------------------------------------------------------
// 5. M&P Courier Adapter (Muller & Phipps Express API)
// -----------------------------------------------------------------------------
export class MnPCourierAdapter {
  providerName = "MNP";
  displayName = "M&P Courier (Muller & Phipps)";
  description =
    "API setup is pending current official M&P merchant API documentation and account-specific configuration.";
  cityHubs = [
    "Karachi",
    "Lahore",
    "Islamabad",
    "Rawalpindi",
    "Faisalabad",
    "Sargodha",
  ];
  isLive = false;
  async testConnection(input) {
    if (!input.config.apiToken) {
      return {
        success: false,
        message: "M&P Account credentials are required.",
        isLive: false,
      };
    }

    return credentialsStored("M&P");
  }
  async createReverseShipment(_input, _credentials) {
    return unconfirmedBooking(this.providerName);
  }
  async createForwardShipment(input, credentials) {
    return this.createReverseShipment(input, credentials);
  }
  async generateReturnLabel(input, credentials) {
    return this.createReverseShipment(input, credentials);
  }
  async trackShipment(trackingNumber) {
    return unconfirmedTracking(this.providerName, trackingNumber);
  }
  async cancelShipment(_trackingNumber) {
    return unconfirmedCancel(this.providerName);
  }
}
// -----------------------------------------------------------------------------
// 6. CallCourier Adapter (Doorstep Pickup Merchant API)
// -----------------------------------------------------------------------------
export class CallCourierAdapter {
  providerName = "CALLCOURIER";
  displayName = "CallCourier Express Returns";
  description =
    "API setup is pending confirmation of the current Call Courier HTTPS booking and authentication contract.";
  cityHubs = [
    "Lahore",
    "Karachi",
    "Rawalpindi",
    "Peshawar",
    "Quetta",
    "Bahawalpur",
  ];
  isLive = false;
  async testConnection(input) {
    if (!input.config.apiToken) {
      return {
        success: false,
        message: "CallCourier login credentials are required.",
        isLive: false,
      };
    }

    return credentialsStored("CallCourier");
  }
  async createReverseShipment(_input, _credentials) {
    return unconfirmedBooking(this.providerName);
  }
  async createForwardShipment(input, credentials) {
    return this.createReverseShipment(input, credentials);
  }
  async generateReturnLabel(input, credentials) {
    return this.createReverseShipment(input, credentials);
  }
  async trackShipment(trackingNumber) {
    return unconfirmedTracking(this.providerName, trackingNumber);
  }
  async cancelShipment(_trackingNumber) {
    return unconfirmedCancel(this.providerName);
  }
}
const COURIER_SETUP = {
  DHL: {
    apiStatus: "live_booking",
    instructions:
      "Production API only. Enter your DHL API username, password, and shipper account number. Maintain sender name, phone, email, city, and address once in Settings → Shipper profiles.",
    fields: [
      {
        key: "username",
        label: "MyDHL API username",
        placeholder: "DHL API username",
        required: true,
        secret: true,
      },
      {
        key: "password",
        label: "MyDHL API password",
        placeholder: "DHL API password",
        required: true,
        secret: true,
      },
      {
        key: "accountNumber",
        label: "DHL shipper account number",
        placeholder: "DHL Express account number",
        required: true,
        secret: true,
      },
    ],
  },
  FEDEX: {
    apiStatus: "live_booking",
    instructions:
      "Production API only. Enter your FedEx API key/client ID, secret, and account number. Sender/contact details are managed centrally in Settings → Shipper profiles. FedEx must enable production access for these credentials.",
    fields: [
      {
        key: "clientId",
        label: "FedEx API key / client ID",
        placeholder: "FedEx production API key",
        required: true,
        secret: true,
      },
      {
        key: "clientSecret",
        label: "FedEx secret key",
        placeholder: "FedEx production secret key",
        required: true,
        secret: true,
      },
      {
        key: "accountNumber",
        label: "FedEx account number",
        placeholder: "FedEx shipper account number",
        required: true,
        secret: true,
      },
    ],
  },
  TCS: {
    apiStatus: "live_booking",
    instructions:
      "Enter TCS production API credentials only. Sender city, name, phone, email, and address are read from Settings → Shipper profiles. TCS booking also requires its assigned cost center code.",
    fields: [
      {
        key: "clientId",
        label: "TCS API Client ID",
        placeholder: "X-IBM-Client-Id",
        required: true,
        secret: true,
      },
      {
        key: "userName",
        label: "TCS COD username",
        placeholder: "API username",
        required: true,
        secret: true,
      },
      {
        key: "password",
        label: "TCS COD password",
        placeholder: "API password",
        required: true,
        secret: true,
      },
      {
        key: "costCenterCode",
        label: "TCS cost center code",
        placeholder: "Assigned cost center code",
        required: true,
        secret: true,
      },
    ],
  },
  POSTEX: {
    apiStatus: "live_booking",
    instructions:
      "Production API only. Enter your PostEx merchant API token. BYNDCART automatically looks up registered pickup/store address IDs; sender contact and address details are managed in Settings → Shipper profiles.",
    fields: [
      {
        key: "apiToken",
        label: "Merchant API token",
        placeholder: "Paste the PostEx production token",
        required: true,
        secret: true,
      },
    ],
  },
  LEOPARDS: {
    apiStatus: "live_booking",
    instructions:
      "Production API only. Enter the Leopards merchant API key and password. Sender name, phone, email, city, and address are managed centrally in Settings → Shipper profiles.",
    fields: [
      {
        key: "apiKey",
        label: "Merchant API key",
        placeholder: "Leopards production API key",
        required: true,
        secret: true,
      },
      {
        key: "apiPassword",
        label: "Merchant API password",
        placeholder: "Leopards API password",
        required: true,
        secret: true,
      },
    ],
  },
};

export class CourierRegistry {
  static adapters = new Map();
  static defaultAdapter = new PostExCourierAdapter();
  static register(adapter) {
    this.adapters.set(adapter.providerName.toUpperCase(), adapter);
  }
  static get(providerName) {
    if (!providerName) return this.defaultAdapter;
    const normalized = providerName.trim().toUpperCase();
    const adapter = this.adapters.get(normalized);

    if (!adapter)
      throw new Error(`Unsupported courier provider: ${normalized}`);

    return adapter;
  }
  static has(providerName) {
    return this.adapters.has(providerName.trim().toUpperCase());
  }
  static getRegisteredAdapters() {
    return Array.from(this.adapters.values()).map((a) => ({
      providerName: a.providerName,
      displayName: a.displayName,
      description: a.description,
      cityHubs: a.cityHubs,
      isLive: a.isLive,
      supportsCancellation: a.supportsCancellation !== false,
      apiStatus:
        COURIER_SETUP[a.providerName]?.apiStatus || "pending_vendor_docs",
      instructions:
        COURIER_SETUP[a.providerName]?.instructions || a.description,
      fields: COURIER_SETUP[a.providerName]?.fields || [
        {
          key: "apiToken",
          label: "API Token",
          placeholder: "API token",
          required: true,
          secret: true,
        },
      ],
    }));
  }
}
export class RiderCourierAdapter {
  providerName = "RIDER";
  displayName = "Rider";
  description =
    "API setup is pending Rider Logistics' current merchant API documentation and test credentials.";
  cityHubs = ["Karachi", "Lahore", "Islamabad"];
  isLive = false;
  async testConnection(input) {
    if (!input.config.apiToken) {
      return {
        success: false,
        message: "A Rider account reference is required to save this courier.",
        isLive: false,
      };
    }

    return credentialsStored("Rider");
  }
  async createReverseShipment(_input, _credentials) {
    return unconfirmedBooking(this.providerName);
  }
  async createForwardShipment() {
    return unconfirmedBooking(this.providerName);
  }
  async generateReturnLabel() {
    return unconfirmedBooking(this.providerName);
  }
  async trackShipment(trackingNumber) {
    return unconfirmedTracking(this.providerName, trackingNumber);
  }
  async cancelShipment(_trackingNumber) {
    return unconfirmedCancel(this.providerName);
  }
}
// Register only carriers with adapters implemented from the supplied API contracts.
CourierRegistry.register(new PostExCourierAdapter());
CourierRegistry.register(new LeopardsCourierAdapter());
CourierRegistry.register(new DHLCourierAdapter());
CourierRegistry.register(new FedExCourierAdapter());
CourierRegistry.register(new TCSCourierAdapter());

function readCredentialBundle(encryptedValue) {
  if (!encryptedValue) return {};

  try {
    const decrypted = decryptCredential(encryptedValue);

    try {
      const parsed = JSON.parse(decrypted);

      if (
        parsed &&
        parsed.__byndcartCredentialBundle === 1 &&
        parsed.fields &&
        typeof parsed.fields === "object"
      ) {
        return Object.fromEntries(
          Object.entries(parsed.fields).filter(
            (entry) => typeof entry[1] === "string",
          ),
        );
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
  shopifyStoreId,
  providerName,
  data,
) {
  const normalizedProvider = providerName.trim().toUpperCase();

  if (!normalizedProvider || !CourierRegistry.has(normalizedProvider)) {
    throw new Error("Unsupported courier provider.");
  }

  const existing = await prisma.merchantCourierConfig.findUnique({
    where: {
      shopifyStoreId_providerName: {
        shopifyStoreId,
        providerName: normalizedProvider,
      },
    },
    select: { encryptedApiToken: true },
  });
  const currentFields = readCredentialBundle(existing?.encryptedApiToken);
  const incomingFields = Object.fromEntries(
    Object.entries(data.credentials || {})
      .filter(
        (entry) => typeof entry[1] === "string" && entry[1].trim().length > 0,
      )
      .map(([key, value]) => [key, value.trim()]),
  );

  if (data.apiToken?.trim()) incomingFields.apiToken = data.apiToken.trim();
  const mergedFields = { ...currentFields, ...incomingFields };
  const hasCredentialPayload = Object.keys(mergedFields).length > 0;
  const encryptedApiToken = hasCredentialPayload
    ? encryptCredential(
        JSON.stringify({ __byndcartCredentialBundle: 1, fields: mergedFields }),
      )
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
    where: {
      shopifyStoreId_providerName: {
        shopifyStoreId,
        providerName: normalizedProvider,
      },
    },
    update: {
      ...(hasCredentialPayload ? { encryptedApiToken } : {}),
      ...(data.accountNumber !== undefined
        ? { accountNumber: data.accountNumber || null }
        : {}),
      ...(data.additionalConfig !== undefined
        ? { additionalConfig: data.additionalConfig }
        : {}),
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      ...(data.isDefaultReverse !== undefined
        ? { isDefaultReverse: data.isDefaultReverse }
        : {}),
      ...(data.isDefaultForward !== undefined
        ? { isDefaultForward: data.isDefaultForward }
        : {}),
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
      metadata: {
        providerName: normalizedProvider,
        enabled: config.enabled,
        credentialFieldNames: Object.keys(mergedFields),
      },
    },
  });

  return config;
}

/** Loads courier configurations for UI display without exposing decrypted credential values. */
export async function getStoreCourierConfigs(shopifyStoreId) {
  const configs = await prisma.merchantCourierConfig.findMany({
    where: { shopifyStoreId },
  });

  return configs.map((config) => {
    const credentials = readCredentialBundle(config.encryptedApiToken);
    const configuredFieldKeys = Object.keys(credentials);
    const setupFields = COURIER_SETUP[config.providerName]?.fields || [];
    const secretField = setupFields.find(
      (field) => field.secret && credentials[field.key],
    );
    const nonSecretFields = Object.fromEntries(
      setupFields
        .filter(
          (field) =>
            !field.secret && typeof credentials[field.key] === "string",
        )
        .map((field) => [field.key, credentials[field.key]]),
    );
    const tokenForMask = secretField
      ? credentials[secretField.key]
      : credentials.apiToken || "";

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
export async function getDecryptedCourierCredentials(
  shopifyStoreId,
  providerName,
  includeDisabled = false,
) {
  try {
    const config = await prisma.merchantCourierConfig.findUnique({
      where: {
        shopifyStoreId_providerName: {
          shopifyStoreId,
          providerName: providerName.toUpperCase(),
        },
      },
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

function uniqueOptionStrings(values) {
  return Array.from(
    new Set(values.map((value) => String(value || "").trim()).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b));
}

function uniqueOptionStringsInOrder(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const label = String(value || "").trim();

    if (label && !seen.has(label)) {
      seen.add(label);
      result.push(label);
    }
  }

  return result;
}

function normalizePostExOrderType(value) {
  const label = String(value || "").trim();

  if (!label) return null;
  const normalized = label.toLowerCase();

  if (normalized === "normal") return "Normal";
  if (normalized === "reverse") return "Reverse";
  if (normalized === "reversed") return "Reversed";
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
  shopifyStoreId,
  providerName,
) {
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

  const credentials = await getDecryptedCourierCredentials(
    shopifyStoreId,
    provider,
  );

  if (!credentials) {
    throw new Error(
      `${provider} is not configured or enabled. Open Courier Settings, verify the saved API credentials, and retry.`,
    );
  }

  if (provider === "POSTEX") {
    const token = credentialValue(credentials, "apiToken");

    if (!token)
      throw new Error(
        "PostEx merchant API token is missing. Reconfigure PostEx in Courier Settings.",
      );
    // Fetch one complete PostEx city catalog and split it locally by the pickup/delivery flags.
    // The carrier returns HTTP 400 for capitalized operationalCityType values on some accounts,
    // while the no-filter endpoint is also what PostEx's connection check uses.
    const citiesResponse = await fetch(
      `${POSTEX_API_ROOT}/order/v2/get-operational-city`,
      {
        method: "GET",
        headers: { token, Accept: "application/json" },
      },
    );
    const citiesPayload = await readJson(citiesResponse);

    if (
      !citiesResponse.ok ||
      Number(citiesPayload?.statusCode) !== 200 ||
      !Array.isArray(citiesPayload?.dist)
    ) {
      throw new Error(
        apiPayloadMessage(
          citiesPayload,
          `PostEx city lookup failed (HTTP ${citiesResponse.status}). Verify the merchant token and API access.`,
        ),
      );
    }

    const cityRows = citiesPayload.dist.filter(
      (row) => row && typeof row === "object",
    );
    const supportsCityFlag = (value) =>
      value === undefined ||
      value === null ||
      value === true ||
      value === 1 ||
      String(value).trim().toLowerCase() === "true" ||
      String(value).trim() === "1";
    const cityNameFromRow = (row) =>
      row.operationalCityName || row.cityName || row.name;
    const pickupCities = uniqueOptionStrings(
      cityRows
        .filter((row) => supportsCityFlag(row.isPickupCity))
        .map(cityNameFromRow),
    );
    const deliveryCities = uniqueOptionStrings(
      cityRows
        .filter((row) => supportsCityFlag(row.isDeliveryCity))
        .map(cityNameFromRow),
    );

    if (pickupCities.length === 0 && deliveryCities.length === 0) {
      throw new Error(
        "PostEx returned its city endpoint successfully, but no city names or pickup/delivery flags could be read.",
      );
    }

    const typesResponse = await fetch(
      `${POSTEX_API_ROOT}/order/v1/get-order-types`,
      {
        method: "GET",
        headers: { token, Accept: "application/json" },
      },
    );
    const typesPayload = await readJson(typesResponse);

    if (
      !typesResponse.ok ||
      Number(typesPayload?.statusCode) !== 200 ||
      !Array.isArray(typesPayload?.dist)
    ) {
      throw new Error(
        apiPayloadMessage(
          typesPayload,
          `PostEx could not load its supported order types (HTTP ${typesResponse.status}).`,
        ),
      );
    }

    // Keep every value supplied by PostEx and preserve the carrier's order.
    const serviceTypes = uniqueOptionStringsInOrder(
      typesPayload.dist
        .map((item) =>
          normalizePostExOrderType(
            typeof item === "string"
              ? item
              : item?.orderType || item?.type || item?.name,
          ),
        )
        .filter(Boolean),
    );

    if (!serviceTypes.length)
      throw new Error("PostEx returned an empty supported-order-type list.");

    return {
      providerName: provider,
      pickupCities,
      deliveryCities,
      serviceTypes,
      citySource: "carrier_api",
      serviceTypeSource: "carrier_api",
    };
  }

  if (provider === "LEOPARDS") {
    const apiKey = credentialValue(credentials, "apiKey");
    const apiPassword = credentialValue(credentials, "apiPassword");

    if (!apiKey || !apiPassword)
      throw new Error(
        "Leopards API key and password are required. Reconfigure Leopards in Courier Settings.",
      );
    const cities = await loadLeopardsCities(
      apiKey,
      apiPassword,
      leopardsApiRoot(credentials),
    );
    const pickupCities = uniqueOptionStrings(
      cities
        .filter(
          (city) =>
            city.allow_as_origin !== false &&
            String(city.allow_as_origin).toLowerCase() !== "false" &&
            String(city.allow_as_origin) !== "0",
        )
        .map((city) => city.name),
    );
    const deliveryCityRecords = cities.filter(
      (city) =>
        city.allow_as_destination !== false &&
        String(city.allow_as_destination).toLowerCase() !== "false" &&
        String(city.allow_as_destination) !== "0",
    );
    const deliveryCities = uniqueOptionStrings(
      deliveryCityRecords.map((city) => city.name),
    );
    const serviceTypesByCity = Object.fromEntries(
      deliveryCityRecords
        .map((city) => [
          String(city.name || "").trim(),
          leopardsCityShipmentTypes(city),
        ])
        .filter(([cityName, types]) => cityName.length > 0 && types.length > 0),
    );
    const serviceTypes = uniqueOptionStringsInOrder(
      Object.values(serviceTypesByCity).flat(),
    );

    if (!serviceTypes.length) {
      throw new Error(
        "Leopards returned its city list but no shipment_type values. Refresh the courier connection or ask Leopards for the current eCom API city-list contract.",
      );
    }

    return {
      providerName: provider,
      pickupCities,
      deliveryCities,
      serviceTypes,
      serviceTypesByCity,
      citySource: "carrier_api",
      serviceTypeSource: "carrier_api",
      cityRecords: cities,
    };
  }

  if (provider === "TCS") {
    const response = await fetch(`${TCS_COD_API_ROOT}/cities`, {
      headers: tcsHeaders(credentials),
    });
    const payload = await readJson(response);
    const rows = payload?.city || payload?.cities || payload?.data?.city;

    if (!response.ok || !Array.isArray(rows) || !rows.length) {
      throw new Error(
        httpMessage(
          payload,
          `TCS did not return a valid city list (HTTP ${response.status}). Check the Client ID and API subscription.`,
        ),
      );
    }

    const names = uniqueOptionStrings(
      rows.map((row) =>
        typeof row === "string"
          ? row
          : row?.cityName ||
            row?.cityname ||
            row?.name ||
            row?.city ||
            row?.CityName,
      ),
    );

    if (!names.length)
      throw new Error("TCS returned city records without readable city names.");

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

function bookingOptionsObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function bookingOptionsCredentialFingerprint(provider, credentials) {
  const keys =
    provider === "POSTEX"
      ? ["apiToken"]
      : provider === "LEOPARDS"
        ? ["apiKey", "apiPassword"]
        : ["clientId", "userName", "password", "costCenterCode"];
  const identity = Object.fromEntries(
    keys.map((key) => [key, credentialValue(credentials, key)]),
  );

  return createHash("sha256")
    .update(JSON.stringify({ provider, identity }))
    .digest("hex");
}

function isValidPersistedBookingOptions(value, provider, fingerprint) {
  return Boolean(
    value &&
    value.cacheVersion === 3 &&
    value.providerName === provider &&
    value.credentialFingerprint === fingerprint &&
    typeof value.cachedAt === "string" &&
    Array.isArray(value.pickupCities) &&
    Array.isArray(value.deliveryCities) &&
    Array.isArray(value.serviceTypes) &&
    (value.pickupCities.length > 0 || value.deliveryCities.length > 0) &&
    value.serviceTypes.length > 0 &&
    (provider !== "LEOPARDS" ||
      (Array.isArray(value.cityRecords) &&
        value.cityRecords.length > 0 &&
        value.serviceTypesByCity &&
        typeof value.serviceTypesByCity === "object" &&
        !Array.isArray(value.serviceTypesByCity))),
  );
}

/**
 * Uses a store-scoped persistent city/type catalog. Carrier city endpoints are requested only
 * for the first selection (or when the courier credentials change), not on every
 * page render or individual shipment booking.
 */
export async function getMerchantCourierBookingOptions(
  shopifyStoreId,
  providerName,
) {
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

  const credentials = await getDecryptedCourierCredentials(
    shopifyStoreId,
    provider,
  );

  if (!credentials) {
    throw new Error(
      `${provider} is not configured or enabled. Open Courier Settings, verify the saved API credentials, and retry.`,
    );
  }

  const credentialFingerprint = bookingOptionsCredentialFingerprint(
    provider,
    credentials,
  );
  const configKey = {
    shopifyStoreId_providerName: { shopifyStoreId, providerName: provider },
  };
  const existing = await prisma.merchantCourierConfig.findUnique({
    where: configKey,
    select: { additionalConfig: true },
  });
  const currentAdditionalConfig = bookingOptionsObject(
    existing?.additionalConfig,
  );
  const cached = currentAdditionalConfig.byndcartBookingOptionsCache;

  if (isValidPersistedBookingOptions(cached, provider, credentialFingerprint)) {
    return {
      providerName: cached.providerName,
      pickupCities: cached.pickupCities,
      deliveryCities: cached.deliveryCities,
      serviceTypes: cached.serviceTypes,
      ...(cached.serviceTypesByCity
        ? { serviceTypesByCity: cached.serviceTypesByCity }
        : {}),
      citySource: cached.citySource,
      serviceTypeSource: cached.serviceTypeSource,
    };
  }

  const fetched = await fetchMerchantCourierBookingOptionsUncached(
    shopifyStoreId,
    provider,
  );
  const persisted = {
    ...fetched,
    cacheVersion: 3,
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
        byndcartBookingOptionsCache: JSON.parse(JSON.stringify(persisted)),
      },
    },
  });

  return {
    providerName: fetched.providerName,
    pickupCities: fetched.pickupCities,
    deliveryCities: fetched.deliveryCities,
    serviceTypes: fetched.serviceTypes,
    ...(fetched.serviceTypesByCity
      ? { serviceTypesByCity: fetched.serviceTypesByCity }
      : {}),
    citySource: fetched.citySource,
    serviceTypeSource: fetched.serviceTypeSource,
  };
}

async function getCachedLeopardsCityRecords(shopifyStoreId, credentials) {
  // This call fetches once if the catalog is missing or credentials have changed.
  try {
    await getMerchantCourierBookingOptions(shopifyStoreId, "LEOPARDS");
  } catch (error) {
    // Adapter calls without a saved merchant config can still use the supplied credentials.
    const message = error instanceof Error ? error.message : "";

    if (
      !credentials ||
      !message.includes("LEOPARDS is not configured or enabled")
    )
      throw error;

    return loadLeopardsCities(
      credentialValue(credentials, "apiKey"),
      credentialValue(credentials, "apiPassword"),
      leopardsApiRoot(credentials),
    );
  }

  const config = await prisma.merchantCourierConfig.findUnique({
    where: {
      shopifyStoreId_providerName: { shopifyStoreId, providerName: "LEOPARDS" },
    },
    select: { additionalConfig: true },
  });
  const cache = bookingOptionsObject(
    bookingOptionsObject(config?.additionalConfig).byndcartBookingOptionsCache,
  );

  if (Array.isArray(cache.cityRecords) && cache.cityRecords.length > 0) {
    return cache.cityRecords;
  }

  throw new Error(
    "Leopards city catalog is not cached. Reopen the Booking page after verifying the courier connection.",
  );
}

/**
 * Resolves the merchant's default configured courier for reverse or forward shipments.
 */
export async function getDefaultMerchantCourier(
  shopifyStoreId,
  type = "REVERSE",
) {
  const field = type === "REVERSE" ? "isDefaultReverse" : "isDefaultForward";

  try {
    const configs = await prisma.merchantCourierConfig.findMany({
      where: { shopifyStoreId, enabled: true, isLive: true, [field]: true },
      orderBy: { updatedAt: "desc" },
    });

    for (const config of configs) {
      if (!CourierRegistry.has(config.providerName)) continue;
      const adapter = CourierRegistry.get(config.providerName);
      const credentials = await getDecryptedCourierCredentials(
        shopifyStoreId,
        adapter.providerName,
      );
      const requiredFields = (
        COURIER_SETUP[adapter.providerName]?.fields || []
      ).filter((item) => item.required);

      if (
        config.isLive &&
        adapter.isLive &&
        credentials &&
        requiredFields.every((item) => credentialValue(credentials, item.key))
      )
        return adapter;
    }

    const enabledConfigs = await prisma.merchantCourierConfig.findMany({
      where: { shopifyStoreId, enabled: true, isLive: true },
      orderBy: { updatedAt: "desc" },
    });

    for (const config of enabledConfigs) {
      if (!CourierRegistry.has(config.providerName)) continue;
      const adapter = CourierRegistry.get(config.providerName);
      const credentials = await getDecryptedCourierCredentials(
        shopifyStoreId,
        adapter.providerName,
      );
      const requiredFields = (
        COURIER_SETUP[adapter.providerName]?.fields || []
      ).filter((item) => item.required);

      if (
        config.isLive &&
        adapter.isLive &&
        credentials &&
        requiredFields.every((item) => credentialValue(credentials, item.key))
      )
        return adapter;
    }
  } catch {
    // Fall through to PostEx; all callers still validate store-specific credentials before booking.
  }

  return CourierRegistry.get("POSTEX");
}
