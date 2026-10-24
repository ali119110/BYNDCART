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
import {
  CourierRegistry,
  getMerchantCourierBookingOptions,
  normalizeCourierStatus,
} from "../services/courier.server";

const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("PostEx booking options cache all four API types and city lists in the database", async () => {
  const delegate = prisma.merchantCourierConfig;
  const originalFindUnique = delegate.findUnique;
  const originalUpdate = delegate.update;
  const originalFetch = globalThis.fetch;
  const config = {
    id: "courier-config-postex-test",
    shopifyStoreId: "store-catalog-test",
    providerName: "POSTEX",
    encryptedApiToken: encryptCredential(
      JSON.stringify({
        __byndcartCredentialBundle: 1,
        fields: { apiToken: "postex-test-token" },
      }),
    ),
    enabled: true,
    isLive: true,
    additionalConfig: null,
  };

  delegate.findUnique = async () => config;

  delegate.update = async ({ data }) => {
    config.additionalConfig = data.additionalConfig;

    return config;
  };

  const requests = [];

  globalThis.fetch = async (input) => {
    const url = String(input);

    requests.push(url);

    if (url.includes("get-operational-city")) {
      return jsonResponse({
        statusCode: "200",
        statusMessage: "SUCCESSFULLY OPERATED",
        dist: [
          {
            operationalCityName: "Karachi",
            isPickupCity: true,
            isDeliveryCity: true,
          },
          {
            operationalCityName: "Lahore",
            isPickupCity: true,
            isDeliveryCity: true,
          },
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

    return jsonResponse(
      { statusCode: "404", message: "Unexpected test endpoint" },
      404,
    );
  };

  try {
    const first = await getMerchantCourierBookingOptions(
      "store-catalog-test",
      "POSTEX",
    );

    assert.deepStrictEqual(first.serviceTypes, [
      "Normal",
      "Reversed",
      "Overland",
      "Replacement",
    ]);
    assert.ok(first.deliveryCities.includes("Karachi"));
    const firstRequestCount = requests.length;

    assert.strictEqual(
      firstRequestCount,
      2,
      "the complete city catalog should be fetched once, plus the order-type list",
    );
    assert.ok(
      requests.some((url) => url.endsWith("/order/v2/get-operational-city")),
      "PostEx city catalog should use the no-filter endpoint to avoid carrier-specific enum casing errors",
    );
    const second = await getMerchantCourierBookingOptions(
      "store-catalog-test",
      "POSTEX",
    );

    assert.deepStrictEqual(second.serviceTypes, [
      "Normal",
      "Reversed",
      "Overland",
      "Replacement",
    ]);
    assert.strictEqual(
      requests.length,
      firstRequestCount,
      "subsequent reads should use the persisted catalog",
    );
    const stored = config.additionalConfig?.byndcartBookingOptionsCache;

    assert.strictEqual(
      stored?.cacheVersion,
      3,
      "the updated courier service-type catalog version should be persisted",
    );
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
test("Leopards booking options extract the merchant's real shipment types from each city", async () => {
  const delegate = prisma.merchantCourierConfig;
  const originalFindUnique = delegate.findUnique;
  const originalUpdate = delegate.update;
  const originalFetch = globalThis.fetch;
  const config = {
    id: "courier-config-leopards-types-test",
    shopifyStoreId: "store-leopards-types-test",
    providerName: "LEOPARDS",
    encryptedApiToken: encryptCredential(
      JSON.stringify({
        __byndcartCredentialBundle: 1,
        fields: {
          apiKey: "leopards-test-key",
          apiPassword: "leopards-test-password",
        },
      }),
    ),
    enabled: true,
    isLive: true,
    additionalConfig: null,
  };

  delegate.findUnique = async () => config;

  delegate.update = async ({ data }) => {
    config.additionalConfig = data.additionalConfig;

    return config;
  };

  const requests = [];

  globalThis.fetch = async (input) => {
    const url = String(input);

    requests.push(url);
    assert.ok(
      url.includes("/getAllCities/format/json/"),
      "Leopards service options must come from its city catalog API",
    );

    return jsonResponse({
      status: 1,
      error: 0,
      city_list: [
        {
          id: 1,
          name: "Karachi",
          allow_as_origin: true,
          allow_as_destination: true,
          shipment_type: ["Overnight", "Flyer"],
        },
        {
          id: 2,
          name: "Lahore",
          allow_as_origin: true,
          allow_as_destination: true,
          shipment_type: ["Overnight", "Economy"],
        },
      ],
    });
  };

  try {
    const options = await getMerchantCourierBookingOptions(
      "store-leopards-types-test",
      "LEOPARDS",
    );

    assert.deepStrictEqual(options.serviceTypes, [
      "Overnight",
      "Flyer",
      "Economy",
    ]);
    assert.strictEqual(options.serviceTypeSource, "carrier_api");
    assert.deepStrictEqual(options.deliveryCities, ["Karachi", "Lahore"]);
    assert.strictEqual(requests.length, 1);
    const cached = await getMerchantCourierBookingOptions(
      "store-leopards-types-test",
      "LEOPARDS",
    );

    assert.deepStrictEqual(cached.serviceTypes, [
      "Overnight",
      "Flyer",
      "Economy",
    ]);
    assert.strictEqual(
      requests.length,
      1,
      "service types should be served from the updated persistent catalog",
    );
  } finally {
    delegate.findUnique = originalFindUnique;
    delegate.update = originalUpdate;
    globalThis.fetch = originalFetch;
  }
});
test("PostEx accepts a return only when statusCode is 200 and a tracking number is present", async () => {
  const calls = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    calls.push({ url, body });

    if (url.includes("get-operational-city")) {
      return jsonResponse({
        statusCode: "200",
        statusMessage: "SUCCESSFULLY OPERATED",
        dist: [
          {
            operationalCityName: "Karachi",
            isPickupCity: true,
            isDeliveryCity: true,
          },
        ],
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
  };

  const result = await CourierRegistry.get("POSTEX").createReverseShipment(
    {
      shopifyStoreId: "store-1",
      orderId: "gid://shopify/Order/1001",
      orderNumber: "#1001",
      customerName: "Ayesha Khan",
      customerPhone: "+92 300 1234567",
      cityName: "Karachi",
      originAddress: { address1: "12 Clifton Block 5", city: "Karachi" },
      items: [{ title: "Kurta", quantity: 1 }],
    },
    { apiToken: "store-token", pickupAddressCode: "PICKUP-001" },
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.isLive, true);
  assert.strictEqual(result.trackingNumber, "PE1001");
  assert.strictEqual(result.carrierStatus, "UnBooked");
  assert.strictEqual(
    normalizeCourierStatus(result.carrierStatus),
    "LABEL_CREATED",
  );
  const booking = calls.find((call) => call.url.includes("create-order"));

  assert.strictEqual(booking?.body.orderType, "Reversed");
  assert.strictEqual(booking?.body.pickupAddressCode, "PICKUP-001");
  assert.ok(
    calls.some((call) => call.url.endsWith("/order/v2/get-operational-city")),
    "PostEx should validate against the no-filter operational-city catalog",
  );
  assert.strictEqual(booking?.body.customerPhone, "03001234567");
  assert.strictEqual(booking?.body.invoicePayment, "0");
  assert.strictEqual(booking?.body.cityName, "Karachi");
});
test("PostEx resolves a missing pickup address code from the registered-address API before booking", async () => {
  const calls = [];
  const delegate = prisma.merchantCourierConfig;
  const originalFindUnique = delegate.findUnique;
  const originalUpdate = delegate.update;

  // This test represents a saved-token adapter call where no address code was supplied.
  // Returning null forces the resolver to query PostEx rather than relying on a persisted cache.
  delegate.findUnique = async () => null;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    calls.push({ url, body });

    if (url.endsWith("/order/v1/get-merchant-address")) {
      return jsonResponse({
        statusCode: "200",
        statusMessage: "SUCCESSFULLY OPERATED",
        dist: [
          {
            addressCode: "PICKUP-001",
            addressType: "Pickup Address",
            cityName: "Karachi",
          },
        ],
      });
    }

    if (url.includes("get-operational-city")) {
      return jsonResponse({
        statusCode: "200",
        statusMessage: "SUCCESSFULLY OPERATED",
        dist: [
          {
            operationalCityName: "Karachi",
            isPickupCity: true,
            isDeliveryCity: true,
          },
        ],
      });
    }

    if (url.includes("create-order")) {
      return jsonResponse({
        statusCode: "200",
        statusMessage: "ORDER HAS BEEN CREATED",
        dist: { trackingNumber: "PE1003", orderStatus: "UnBooked" },
      });
    }

    return jsonResponse(
      { statusCode: "500", statusMessage: "Unexpected test endpoint" },
      500,
    );
  };

  try {
    const result = await CourierRegistry.get("POSTEX").createForwardShipment(
      {
        shopifyStoreId: "store-address-test",
        orderId: "gid://shopify/Order/1003",
        orderNumber: "#1003",
        customerName: "Ayesha Khan",
        customerPhone: "03001234567",
        cityName: "Karachi",
        destinationAddress: { address1: "12 Clifton Block 5", city: "Karachi" },
        items: [{ title: "Kurta", quantity: 1 }],
      },
      { apiToken: "store-token" },
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.trackingNumber, "PE1003");
    const booking = calls.find((call) => call.url.includes("create-order"));

    assert.strictEqual(booking?.body.pickupAddressCode, "PICKUP-001");
    assert.ok(
      calls.some((call) => call.url.endsWith("/order/v1/get-merchant-address")),
      "registered pickup addresses should be queried from PostEx merchant-address API when no code was saved",
    );
    assert.ok(
      calls.every((call) => !call.url.includes("cityName=")),
      "omit empty cityName filters when requesting the complete address list",
    );
  } finally {
    delegate.findUnique = originalFindUnique;
    delegate.update = originalUpdate;
  }
});
test("PostEx does not treat a successful HTTP body without a tracking number as a booking", async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);

    if (url.includes("get-operational-city")) {
      return jsonResponse({
        statusCode: "200",
        statusMessage: "SUCCESSFULLY OPERATED",
        dist: [{ operationalCityName: "Lahore", isPickupCity: true }],
      });
    }

    return jsonResponse({
      statusCode: "200",
      statusMessage: "SUCCESSFULLY OPERATED",
      dist: {},
    });
  };

  const result = await CourierRegistry.get("POSTEX").createReverseShipment(
    {
      shopifyStoreId: "store-1",
      orderId: "gid://shopify/Order/1002",
      orderNumber: "#1002",
      customerName: "Ayesha Khan",
      customerPhone: "03001234567",
      cityName: "Lahore",
      originAddress: { address1: "22 Mall Road Lahore", city: "Lahore" },
    },
    { apiToken: "store-token", pickupAddressCode: "PICKUP-001" },
  );

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.trackingNumber, "");
  assert.strictEqual(result.isLive, false);
});
test("PostEx tracking ignores the API success message and uses the parcel status", async () => {
  globalThis.fetch = async () =>
    jsonResponse({
      statusCode: "200",
      statusMessage: "SUCCESSFULLY OPERATED",
      dist: {
        transactionStatus: "",
        orderStatus: "",
        cityName: "Karachi",
        transactionStatusHistory: [
          {
            transactionStatusMessage: "Delivered",
            activityDate: "2026-10-01T10:00:00Z",
          },
        ],
      },
    });
  const tracked = await CourierRegistry.get("POSTEX").trackShipment("PE1001", {
    apiToken: "store-token",
  });

  assert.strictEqual(tracked.status, "DELIVERED");
  assert.notStrictEqual(
    normalizeCourierStatus("SUCCESSFULLY OPERATED"),
    tracked.rawStatus,
  );
});
test("Leopards return booking uses bookPacket and reverses shipper and consignee", async () => {
  let booked = null;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};

    assert.ok(
      url.startsWith("https://merchantapi.leopardscourier.com/api/"),
      `Leopards must use production API even when legacy credentials contain an environment selector: ${url}`,
    );

    if (url.includes("getAllCities")) {
      return jsonResponse({
        status: 1,
        error: 0,
        city_list: [
          {
            id: 1,
            name: "Karachi",
            allow_as_origin: true,
            allow_as_destination: true,
            shipment_type: ["Overnight", "Flyer"],
          },
          {
            id: 2,
            name: "Lahore",
            allow_as_origin: true,
            allow_as_destination: true,
            shipment_type: ["Overnight", "Economy"],
          },
        ],
      });
    }

    if (url.includes("bookPacket")) {
      booked = body;
      assert.strictEqual(url.includes("reverse"), false);

      return jsonResponse({
        status: 1,
        track_number: "LEO900",
        slip_link: "https://leopard.example/slip/LEO900",
      });
    }

    return jsonResponse({ status: 0 }, 404);
  };

  const result = await CourierRegistry.get("LEOPARDS").createReverseShipment(
    {
      shopifyStoreId: "store-1",
      orderId: "gid://shopify/Order/55",
      orderNumber: "#55",
      customerName: "Ayesha Khan",
      customerEmail: "ayesha@example.com",
      customerPhone: "03001112233",
      cityName: "Karachi",
      courierServiceType: "Overnight",
      originAddress: { address1: "House 4 Block B", city: "Karachi" },
      items: [{ title: "Shirt", quantity: 2 }],
    },
    {
      apiKey: "key",
      apiPassword: "pass",
      environment: "staging",
      warehouseCity: "Lahore",
      warehouseAddress: "Warehouse 9 Industrial Area",
      warehouseContactName: "Store Desk",
      warehousePhone: "03009998877",
      warehouseEmail: "desk@store.com",
      defaultWeightGrams: "750",
    },
  );

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
  assert.strictEqual(
    booked.shipment_type,
    "Overnight",
    "booking must pass the API-advertised shipment service type",
  );
});
test("DHL and FedEx ignore legacy sandbox/test settings and use production APIs only", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];

  globalThis.fetch = async (input) => {
    const url = String(input);

    urls.push(url);

    if (url.endsWith("/oauth/token")) {
      return jsonResponse({
        access_token: "production-oauth-token",
        expires_in: 3600,
      });
    }

    return jsonResponse({ status: "ok" });
  };

  try {
    const dhlResult = await CourierRegistry.get("DHL").testConnection({
      shopifyStoreId: "store-production-only",
      config: {
        environment: "test",
        username: "production-user",
        password: "production-password",
        accountNumber: "production-account",
      },
    });
    const fedexResult = await CourierRegistry.get("FEDEX").testConnection({
      shopifyStoreId: "store-production-only",
      config: {
        environment: "sandbox",
        clientId: `production-client-${Date.now()}`,
        clientSecret: "production-secret",
        accountNumber: "production-account",
      },
    });

    assert.strictEqual(dhlResult.success, true);
    assert.strictEqual(fedexResult.success, true);
    assert.ok(
      urls.includes(
        "https://express.api.dhl.com/mydhlapi/reference-data?datasetName=country",
      ),
    );
    assert.ok(urls.includes("https://apis.fedex.com/oauth/token"));
    assert.ok(
      urls.every((url) => !/sandbox|\/test(?:\/|\?)|staging/i.test(url)),
      "No test, sandbox, or staging API endpoint should be requested.",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("Leopards cancellation succeeds only when status is 1", async () => {
  globalThis.fetch = async () =>
    jsonResponse({ status: 0, error: "CN not found" });
  const failed = await CourierRegistry.get("LEOPARDS").cancelShipment("LEO1", {
    apiKey: "key",
    apiPassword: "pass",
  });

  assert.strictEqual(failed.success, false);
  globalThis.fetch = async () => jsonResponse({ status: 1 });
  const passed = await CourierRegistry.get("LEOPARDS").cancelShipment("LEO1", {
    apiKey: "key",
    apiPassword: "pass",
  });

  assert.strictEqual(passed.success, true);
});
