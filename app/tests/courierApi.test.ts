process.env.SHOPIFY_API_KEY = "mock_api_key";
process.env.SHOPIFY_API_SECRET = "mock_api_secret";
process.env.SHOPIFY_APP_URL = "https://byndcart-mock.app";
process.env.SCOPES = "read_orders,write_returns";
process.env.DATABASE_URL = "postgresql://mock:mock@localhost:5432/mock";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert";
import prisma from "../db.server";
import { encryptCredential } from "../utils/encryption.server";
import { CourierRegistry, getMerchantCourierBookingOptions, normalizeCourierStatus } from "../services/courier.server";

const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("PostEx booking options cache all four API types and city lists in the database", async () => {
  const delegate = (prisma as any).merchantCourierConfig;
  const originalFindUnique = delegate.findUnique;
  const originalUpdate = delegate.update;
  const originalFetch = globalThis.fetch;
  const config: any = {
    id: "courier-config-postex-test",
    shopifyStoreId: "store-catalog-test",
    providerName: "POSTEX",
    encryptedApiToken: encryptCredential(JSON.stringify({
      __byndcartCredentialBundle: 1,
      fields: { apiToken: "postex-test-token" },
    })),
    enabled: true,
    isLive: true,
    additionalConfig: null,
  };
  delegate.findUnique = async () => config;
  delegate.update = async ({ data }: any) => {
    config.additionalConfig = data.additionalConfig;
    return config;
  };

  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("get-operational-city")) {
      return jsonResponse({
        statusCode: "200",
        statusMessage: "SUCCESSFULLY OPERATED",
        dist: [
          { operationalCityName: "Karachi", isPickupCity: true, isDeliveryCity: true },
          { operationalCityName: "Lahore", isPickupCity: true, isDeliveryCity: true },
        ],
      });
    }
    if (url.includes("get-order-types")) {
      return jsonResponse({
        statusCode: "200",
        statusMessage: "SUCCESSFULLY OPERATED",
        dist: ["Normal", "Reversed", "Overland", "Replacement"],
      });
    }
    return jsonResponse({ statusCode: "404", message: "Unexpected test endpoint" }, 404);
  }) as typeof fetch;

  try {
    const first = await getMerchantCourierBookingOptions("store-catalog-test", "POSTEX");
    assert.deepStrictEqual(first.serviceTypes, ["Normal", "Reverse", "Overland", "Replacement"]);
    assert.ok(first.deliveryCities.includes("Karachi"));
    const firstRequestCount = requests.length;
    assert.strictEqual(firstRequestCount, 3, "one pickup list, one delivery list, and one type list should be fetched");

    const second = await getMerchantCourierBookingOptions("store-catalog-test", "POSTEX");
    assert.deepStrictEqual(second.serviceTypes, ["Normal", "Reverse", "Overland", "Replacement"]);
    assert.strictEqual(requests.length, firstRequestCount, "subsequent reads should use the persisted catalog");
    const stored = (config.additionalConfig as any)?.byndcartBookingOptionsCache;
    assert.ok(stored?.credentialFingerprint);
    assert.ok(stored?.cachedAt);
    assert.ok(stored?.pickupCities?.includes("Karachi"));
    assert.ok(stored?.deliveryCities?.includes("Lahore"));
  } finally {
    delegate.findUnique = originalFindUnique;
    delegate.update = originalUpdate;
    globalThis.fetch = originalFetch;
  }
});

test("PostEx accepts a return only when statusCode is 200 and a tracking number is present", async () => {
  const calls: Array<{ url: string; body?: any }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.includes("get-operational-city")) {
      return jsonResponse({
        statusCode: "200",
        statusMessage: "SUCCESSFULLY OPERATED",
        dist: [{ operationalCityName: "Karachi", isPickupCity: true, isDeliveryCity: true }],
      });
    }
    if (url.includes("create-order")) {
      return jsonResponse({
        statusCode: "200",
        statusMessage: "ORDER HAS BEEN CREATED",
        dist: { trackingNumber: "PE1001", orderStatus: "UnBooked" },
      });
    }
    return jsonResponse({ statusCode: "500" }, 500);
  }) as typeof fetch;

  const result = await CourierRegistry.get("POSTEX").createReverseShipment({
    shopifyStoreId: "store-1",
    orderId: "gid://shopify/Order/1001",
    orderNumber: "#1001",
    customerName: "Ayesha Khan",
    customerPhone: "+92 300 1234567",
    cityName: "Karachi",
    originAddress: { address1: "12 Clifton Block 5", city: "Karachi" },
    items: [{ title: "Kurta", quantity: 1 }],
  }, { apiToken: "store-token" });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.isLive, true);
  assert.strictEqual(result.trackingNumber, "PE1001");
  assert.strictEqual(result.carrierStatus, "UnBooked");
  assert.strictEqual(normalizeCourierStatus(result.carrierStatus), "LABEL_CREATED");
  const booking = calls.find((call) => call.url.includes("create-order"));
  assert.strictEqual(booking?.body.orderType, "Reversed");
  assert.ok(calls.some((call) => call.url.includes("operationalCityType=Pickup")), "PostEx city lookup should use the carrier's lowercase pickup value");
  assert.strictEqual(booking?.body.customerPhone, "03001234567");
  assert.strictEqual(booking?.body.invoicePayment, "0");
  assert.strictEqual(booking?.body.cityName, "Karachi");
});

test("PostEx does not treat a successful HTTP body without a tracking number as a booking", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("get-operational-city")) {
      return jsonResponse({ statusCode: "200", statusMessage: "SUCCESSFULLY OPERATED", dist: [{ operationalCityName: "Lahore", isPickupCity: true }] });
    }
    return jsonResponse({ statusCode: "200", statusMessage: "SUCCESSFULLY OPERATED", dist: {} });
  }) as typeof fetch;

  const result = await CourierRegistry.get("POSTEX").createReverseShipment({
    shopifyStoreId: "store-1",
    orderId: "gid://shopify/Order/1002",
    orderNumber: "#1002",
    customerName: "Ayesha Khan",
    customerPhone: "03001234567",
    cityName: "Lahore",
    originAddress: { address1: "22 Mall Road Lahore", city: "Lahore" },
  }, { apiToken: "store-token" });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.trackingNumber, "");
  assert.strictEqual(result.isLive, false);
});

test("PostEx tracking ignores the API success message and uses the parcel status", async () => {
  globalThis.fetch = (async () => jsonResponse({
    statusCode: "200",
    statusMessage: "SUCCESSFULLY OPERATED",
    dist: {
      transactionStatus: "",
      orderStatus: "",
      cityName: "Karachi",
      transactionStatusHistory: [{ transactionStatusMessage: "Delivered", activityDate: "2026-10-01T10:00:00Z" }],
    },
  })) as typeof fetch;

  const tracked = await CourierRegistry.get("POSTEX").trackShipment("PE1001", { apiToken: "store-token" });
  assert.strictEqual(tracked.status, "DELIVERED");
  assert.notStrictEqual(normalizeCourierStatus("SUCCESSFULLY OPERATED"), tracked.rawStatus);
});

test("Leopards return booking uses bookPacket and reverses shipper and consignee", async () => {
  let booked: any = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.includes("getAllCities")) {
      return jsonResponse({
        status: 1,
        error: 0,
        city_list: [
          { id: 1, name: "Karachi", allow_as_origin: true, allow_as_destination: true },
          { id: 2, name: "Lahore", allow_as_origin: true, allow_as_destination: true },
        ],
      });
    }
    if (url.includes("bookPacket")) {
      booked = body;
      assert.strictEqual(url.includes("reverse"), false);
      return jsonResponse({ status: 1, track_number: "LEO900", slip_link: "https://leopard.example/slip/LEO900" });
    }
    return jsonResponse({ status: 0 }, 404);
  }) as typeof fetch;

  const result = await CourierRegistry.get("LEOPARDS").createReverseShipment({
    shopifyStoreId: "store-1",
    orderId: "gid://shopify/Order/55",
    orderNumber: "#55",
    customerName: "Ayesha Khan",
    customerEmail: "ayesha@example.com",
    customerPhone: "03001112233",
    cityName: "Karachi",
    originAddress: { address1: "House 4 Block B", city: "Karachi" },
    items: [{ title: "Shirt", quantity: 2 }],
  }, {
    apiKey: "key",
    apiPassword: "pass",
    environment: "staging",
    warehouseCity: "Lahore",
    warehouseAddress: "Warehouse 9 Industrial Area",
    warehouseContactName: "Store Desk",
    warehousePhone: "03009998877",
    warehouseEmail: "desk@store.com",
    defaultWeightGrams: "750",
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.trackingNumber, "LEO900");
  assert.strictEqual(result.labelUrl, "https://leopard.example/slip/LEO900");
  assert.strictEqual(booked.api_key, "key");
  assert.strictEqual(booked.origin_city, 1);
  assert.strictEqual(booked.destination_city, 2);
  assert.strictEqual(booked.shipment_name_eng, "Ayesha Khan");
  assert.strictEqual(booked.consignment_name_eng, "Store Desk");
  assert.strictEqual(booked.booked_packet_weight, 750);
  assert.strictEqual(booked.booked_packet_collect_amount, 0);
  assert.strictEqual(booked.booked_packet_no_piece, 2);
});

test("Leopards cancellation succeeds only when status is 1", async () => {
  globalThis.fetch = (async () => jsonResponse({ status: 0, error: "CN not found" })) as typeof fetch;
  const failed = await CourierRegistry.get("LEOPARDS").cancelShipment("LEO1", { apiKey: "key", apiPassword: "pass" });
  assert.strictEqual(failed.success, false);

  globalThis.fetch = (async () => jsonResponse({ status: 1 })) as typeof fetch;
  const passed = await CourierRegistry.get("LEOPARDS").cancelShipment("LEO1", { apiKey: "key", apiPassword: "pass" });
  assert.strictEqual(passed.success, true);
});
