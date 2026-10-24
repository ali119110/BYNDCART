process.env.SHOPIFY_API_KEY = "mock_api_key";
process.env.SHOPIFY_API_SECRET = "mock_api_secret";
process.env.SHOPIFY_APP_URL = "https://byndcart-mock.app";
process.env.SCOPES = "read_orders,write_orders,write_fulfillments";
process.env.DATABASE_URL = "postgresql://mock:mock@localhost:5432/mock";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert";

import {
  normalizePakistaniMobile,
  isValidPakistaniMobile,
  matchPakistaniCity,
  estimatePackageWeight,
  MAJOR_PAKISTANI_CITIES,
} from "../services/pakistanLogistics.server";
import { generateCode128Svg } from "../utils/barcode";
import prisma from "../db.server";

test("Pakistani Logistics - Mobile number normalization and validation", () => {
  // Standard format
  assert.strictEqual(normalizePakistaniMobile("03001234567"), "03001234567");
  assert.strictEqual(isValidPakistaniMobile("03001234567"), true);

  // +92 prefix
  assert.strictEqual(normalizePakistaniMobile("+923001234567"), "03001234567");
  assert.strictEqual(isValidPakistaniMobile("+923001234567"), true);

  // 0092 prefix
  assert.strictEqual(normalizePakistaniMobile("00923001234567"), "03001234567");

  // Spaces and hyphens
  assert.strictEqual(normalizePakistaniMobile("+92 321-7654321"), "03217654321");
  assert.strictEqual(normalizePakistaniMobile("0345 111 2233"), "03451112233");

  // Invalid numbers
  assert.strictEqual(isValidPakistaniMobile("04212345678"), false); // PTCL landline
  assert.strictEqual(isValidPakistaniMobile("12345"), false);
  assert.strictEqual(isValidPakistaniMobile(""), false);
});

test("Pakistani Logistics - City matching and abbreviation aliases", () => {
  // Canonical matches
  assert.strictEqual(matchPakistaniCity("Karachi"), "Karachi");
  assert.strictEqual(matchPakistaniCity("Lahore"), "Lahore");
  assert.strictEqual(matchPakistaniCity("Islamabad"), "Islamabad");

  // Common Pakistani courier shortcodes
  assert.strictEqual(matchPakistaniCity("KHI"), "Karachi");
  assert.strictEqual(matchPakistaniCity("LHR"), "Lahore");
  assert.strictEqual(matchPakistaniCity("ISB"), "Islamabad");
  assert.strictEqual(matchPakistaniCity("RWP"), "Rawalpindi");
  assert.strictEqual(matchPakistaniCity("FSD"), "Faisalabad");
  assert.strictEqual(matchPakistaniCity("PEW"), "Peshawar");
  assert.strictEqual(matchPakistaniCity("MUX"), "Multan");
  assert.strictEqual(matchPakistaniCity("SKT"), "Sialkot");
  assert.strictEqual(matchPakistaniCity("UET"), "Quetta");

  // Case insensitivity & trimming
  assert.strictEqual(matchPakistaniCity("  rawalpindi  "), "Rawalpindi");
  assert.strictEqual(matchPakistaniCity("KARACHI"), "Karachi");

  // Unknown city fallback
  assert.strictEqual(matchPakistaniCity("NonExistentCity123"), "NonExistentCity123");
  assert.strictEqual(matchPakistaniCity(""), "", "missing city/address must not default to Karachi");
  assert.strictEqual(matchPakistaniCity("", ""), "", "missing city and address must require an explicit selection");

  // Verify major cities list contains expected entries
  assert.ok(MAJOR_PAKISTANI_CITIES.includes("Karachi"));
  assert.ok(MAJOR_PAKISTANI_CITIES.includes("Lahore"));
  assert.ok(MAJOR_PAKISTANI_CITIES.includes("Islamabad"));
  assert.ok(MAJOR_PAKISTANI_CITIES.length > 50);
});

test("Pakistani Logistics - Package weight estimation", () => {
  // Empty or missing weight defaults to 0.5 kg
  assert.strictEqual(estimatePackageWeight([]), 0.5);
  assert.strictEqual(estimatePackageWeight(null as any), 0.5);
  assert.strictEqual(estimatePackageWeight([{ quantity: 1, grams: 0 }]), 0.5);

  // Computed weight from grams
  assert.strictEqual(estimatePackageWeight([{ quantity: 2, grams: 500 }]), 1);
  assert.strictEqual(estimatePackageWeight([{ quantity: 3, grams: 400 }]), 1.2);
});

test("Barcode Generator - Code-128 SVG creation", () => {
  const svg = generateCode128Svg("PK-POSTEX-99881122");
  assert.ok(svg.startsWith("<svg"), "Should output valid SVG tag");
  assert.ok(svg.includes("PK-POSTEX-99881122"), "Should include text value in data attribute");
  assert.ok(svg.includes("<rect"), "Should render barcode bar rectangles");
  assert.ok(svg.endsWith("</svg>"), "Should close SVG tag");

  // Numerical CN
  const numSvg = generateCode128Svg("771234567890");
  assert.ok(numSvg.includes("771234567890"));
  assert.ok(numSvg.includes("<rect"));
});

test("Booking service extracts COD from Shopify gateway and outstanding balance", async () => {
  const orderNode = (input: {
    name: string;
    financialStatus: string;
    gateways: string[];
    total: string;
    outstanding: string;
  }) => ({
    id: `gid://shopify/Order/${input.name.replace(/\D/g, "") || "1"}`,
    name: input.name,
    createdAt: "2026-10-23T10:00:00.000Z",
    displayFinancialStatus: input.financialStatus,
    displayFulfillmentStatus: "UNFULFILLED",
    paymentGatewayNames: input.gateways,
    tags: [],
    currentTotalPriceSet: { shopMoney: { amount: input.total } },
    totalPriceSet: { shopMoney: { amount: input.total } },
    totalOutstandingSet: { shopMoney: { amount: input.outstanding } },
    customer: { firstName: "Test", lastName: "Customer", email: "test@example.com", phone: "03001234567" },
    shippingAddress: {
      name: "Test Customer",
      phone: "03001234567",
      address1: "10 Test Road",
      address2: "",
      city: "Karachi",
      province: "Sindh",
      zip: "74000",
      country: "Pakistan",
    },
    lineItems: { edges: [] },
  });

  const nodes = [
    orderNode({
      name: "#COD-100",
      financialStatus: "PENDING",
      gateways: ["Cash on Delivery (COD)"],
      total: "12500.00",
      outstanding: "12500.00",
    }),
    orderNode({
      name: "#COD-PAID-101",
      financialStatus: "PAID",
      gateways: ["Cash on Delivery (COD)"],
      total: "7990.00",
      outstanding: "0.00",
    }),
    orderNode({
      name: "#ONLINE-102",
      financialStatus: "PENDING",
      gateways: ["Shopify Payments"],
      total: "3000.00",
      outstanding: "3000.00",
    }),
  ];

  const shipmentTrack = (prisma as any).shipmentTrack;
  const originalFindMany = shipmentTrack.findMany;
  shipmentTrack.findMany = async () => [];
  try {
    const { fetchUnfulfilledOrders } = await import("../services/booking.server");
    const orders = await fetchUnfulfilledOrders({
      graphql: async () => new Response(JSON.stringify({
        data: { orders: { edges: nodes.map((node) => ({ node })) } },
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    }, "store-cod-test", 100);

    const codOrder = orders.find((order) => order.name === "#COD-100");
    const paidCodOrder = orders.find((order) => order.name === "#COD-PAID-101");
    const onlineOrder = orders.find((order) => order.name === "#ONLINE-102");

    assert.strictEqual(codOrder?.suggestedCod, 12500);
    assert.strictEqual(paidCodOrder?.suggestedCod, 7990, "COD gateway should retain the order total if a COD app marks it paid");
    assert.strictEqual(onlineOrder?.suggestedCod, 0, "a pending online payment must not be mistaken for COD");
  } finally {
    shipmentTrack.findMany = originalFindMany;
  }
});

test("Loadsheet Service - Loadsheet creation and parcel assignment", async () => {
  const mockShipments = [
    {
      id: "ship-101",
      shopifyStoreId: "store-test",
      shopifyOrderId: "gid://shopify/Order/1001",
      orderNumber: "#1001",
      courier: "POSTEX",
      type: "FORWARD",
      trackingNumber: "POSTEX-1001",
      destinationCity: "Lahore",
      codAmount: 2500,
      loadsheetId: null,
      status: "LABEL_CREATED",
      createdAt: new Date(),
    },
    {
      id: "ship-102",
      shopifyStoreId: "store-test",
      shopifyOrderId: "gid://shopify/Order/1002",
      orderNumber: "#1002",
      courier: "POSTEX",
      type: "FORWARD",
      trackingNumber: "POSTEX-1002",
      destinationCity: "Karachi",
      codAmount: 3400,
      loadsheetId: null,
      status: "LABEL_CREATED",
      createdAt: new Date(),
    },
    {
      id: "ship-exchange",
      shopifyStoreId: "store-test",
      shopifyOrderId: "gid://shopify/Order/1003",
      orderNumber: "#1003",
      courier: "POSTEX",
      type: "EXCHANGE",
      trackingNumber: "POSTEX-EXCHANGE-1003",
      destinationCity: "Karachi",
      codAmount: 0,
      loadsheetId: null,
      status: "LABEL_CREATED",
      createdAt: new Date(),
    },
    {
      id: "ship-return",
      shopifyStoreId: "store-test",
      shopifyOrderId: "gid://shopify/Order/1004",
      orderNumber: "#1004",
      courier: "POSTEX",
      type: "RETURN",
      trackingNumber: "POSTEX-RETURN-1004",
      destinationCity: "Lahore",
      codAmount: 0,
      loadsheetId: null,
      status: "LABEL_CREATED",
      createdAt: new Date(),
    },
    {
      id: "ship-delivered",
      shopifyStoreId: "store-test",
      shopifyOrderId: "gid://shopify/Order/1005",
      orderNumber: "#1005",
      courier: "POSTEX",
      type: "FORWARD",
      trackingNumber: "POSTEX-DELIVERED-1005",
      destinationCity: "Islamabad",
      codAmount: 0,
      loadsheetId: null,
      status: "DELIVERED",
      createdAt: new Date(),
    },
  ];

  let createdLoadsheetRecord: any = null;
  let updatedShipmentIds: string[] = [];

  // Mock prisma.loadsheet
  (prisma as any).loadsheet = {
    create: async ({ data }: any) => {
      createdLoadsheetRecord = {
        id: "ls-uuid-1",
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return createdLoadsheetRecord;
    },
    findFirst: async () => createdLoadsheetRecord,
    findMany: async () => [createdLoadsheetRecord],
  };

  // Mock prisma.shipmentTrack
  (prisma as any).shipmentTrack.findMany = async ({ where = {} }: any = {}) => mockShipments.filter((shipment: any) => {
    if (where.shopifyStoreId && shipment.shopifyStoreId !== where.shopifyStoreId) return false;
    if (where.id?.in && !where.id.in.includes(shipment.id)) return false;
    if (where.courier && shipment.courier !== where.courier) return false;
    if (where.type && shipment.type !== where.type) return false;
    if (where.loadsheetId === null && shipment.loadsheetId !== null) return false;
    if (where.status?.notIn?.includes(shipment.status)) return false;
    return true;
  });
  (prisma as any).shipmentTrack.updateMany = async ({ where, data }: any) => {
    updatedShipmentIds = where.id.in;
    return { count: where.id.in.length };
  };

  (prisma as any).$transaction = async (callback: any) => callback(prisma);
  (prisma as any).auditLog = { create: async () => ({}) };

  const { createLoadsheet, getUnassignedBookedShipments } = await import("../services/loadsheet.server");

  // 1. Fetch unassigned booked shipments
  const unassigned = await getUnassignedBookedShipments("store-test", "POSTEX");
  assert.strictEqual(unassigned.length, 2);

  // 2. Create loadsheet
  const result = await createLoadsheet("store-test", "user-test", {
    courier: "POSTEX",
    shipmentIds: ["ship-101", "ship-102"],
    riderName: "Ahmed Khan",
    riderPhone: "03001234567",
    notes: "Evening courier pickup",
  });

  assert.strictEqual(result.parcelCount, 2);
  assert.strictEqual(result.totalCodAmount, "5900.00");
  assert.strictEqual(result.riderName, "Ahmed Khan");
  assert.strictEqual(result.riderPhone, "03001234567");
  assert.ok(result.loadsheetNumber.startsWith("LS-POSTEX-"));
  assert.deepStrictEqual(updatedShipmentIds, ["ship-101", "ship-102"]);

  // Returns, exchanges, and delivered parcels must never appear in handover loadsheets.
  await assert.rejects(
    createLoadsheet("store-test", "user-test", {
      courier: "POSTEX",
      shipmentIds: ["ship-exchange"],
      riderName: "Ahmed Khan",
      riderPhone: "03001234567",
    }),
    /No eligible forward shipments found/,
  );
  await assert.rejects(
    createLoadsheet("store-test", "user-test", {
      courier: "POSTEX",
      shipmentIds: ["ship-return"],
      riderName: "Ahmed Khan",
      riderPhone: "03001234567",
    }),
    /No eligible forward shipments found/,
  );
  await assert.rejects(
    createLoadsheet("store-test", "user-test", {
      courier: "POSTEX",
      shipmentIds: ["ship-delivered"],
      riderName: "Ahmed Khan",
      riderPhone: "03001234567",
    }),
    /No eligible forward shipments found/,
  );
});

test("Shopify fulfillment sync creates fulfillment using the current mutation and confirmed tracking", async () => {
  const orderId = "gid://shopify/Order/2001";
  let createCalls = 0;
  const admin = {
    graphql: async (query: string) => {
      if (query.includes("GetOrderFulfillmentOrders")) {
        return new Response(JSON.stringify({
          data: {
            order: {
              id: orderId,
              displayFulfillmentStatus: "UNFULFILLED",
              fulfillments: { nodes: [] },
              fulfillmentOrders: {
                nodes: [{
                  id: "gid://shopify/FulfillmentOrder/3001",
                  status: "OPEN",
                  supportedActions: [{ action: "CREATE_FULFILLMENT" }],
                  assignedLocation: { location: { id: "gid://shopify/Location/1" } },
                }],
              },
            },
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (query.includes("mutation CreateFulfillment")) {
        createCalls += 1;
        assert.ok(query.includes("fulfillmentCreate("), "Should use the current fulfillmentCreate mutation");
        assert.ok(!query.includes("fulfillmentCreateV2("), "Should not use deprecated fulfillmentCreateV2");
        return new Response(JSON.stringify({
          data: {
            fulfillmentCreate: {
              fulfillment: {
                id: "gid://shopify/Fulfillment/4001",
                status: "SUCCESS",
                trackingInfo: [{ number: "PX-2001", company: "PostEx", url: "https://postex.pk/tracking?cn=PX-2001" }],
              },
              userErrors: [],
            },
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error("Unexpected Shopify GraphQL query in test.");
    },
  };

  const { fulfillOrderInShopify } = await import("../services/booking.server");
  const result = await fulfillOrderInShopify(admin, orderId, "POSTEX", "PX-2001");
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.fulfillmentId, "gid://shopify/Fulfillment/4001");
  assert.strictEqual(createCalls, 1);
});

test("Shopify fulfillment sync reports top-level GraphQL errors instead of false success", async () => {
  const orderId = "gid://shopify/Order/2002";
  const admin = {
    graphql: async (query: string) => {
      if (query.includes("GetOrderFulfillmentOrders")) {
        return new Response(JSON.stringify({
          data: {
            order: {
              id: orderId,
              displayFulfillmentStatus: "UNFULFILLED",
              fulfillments: { nodes: [] },
              fulfillmentOrders: {
                nodes: [{
                  id: "gid://shopify/FulfillmentOrder/3002",
                  status: "OPEN",
                  supportedActions: [{ action: "CREATE_FULFILLMENT" }],
                  assignedLocation: { location: { id: "gid://shopify/Location/1" } },
                }],
              },
            },
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        errors: [{ message: "Access denied for fulfillmentCreate. Missing write_merchant_managed_fulfillment_orders scope." }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  };

  const { fulfillOrderInShopify } = await import("../services/booking.server");
  const result = await fulfillOrderInShopify(admin, orderId, "POSTEX", "PX-2002");
  assert.strictEqual(result.success, false);
  assert.match(result.error || "", /write_merchant_managed_fulfillment_orders/);
});

test("Shopify fulfillment sync is idempotent when the same tracking number is already fulfilled", async () => {
  const orderId = "gid://shopify/Order/2003";
  let createCalls = 0;
  const admin = {
    graphql: async (query: string) => {
      if (query.includes("GetOrderFulfillmentOrders")) {
        return new Response(JSON.stringify({
          data: {
            order: {
              id: orderId,
              displayFulfillmentStatus: "FULFILLED",
              fulfillments: {
                nodes: [{
                  id: "gid://shopify/Fulfillment/4003",
                  trackingInfo: [{ number: "PX-2003" }],
                  fulfillmentOrders: { nodes: [{ id: "gid://shopify/FulfillmentOrder/3003" }] },
                }],
              },
              fulfillmentOrders: {
                nodes: [{
                  id: "gid://shopify/FulfillmentOrder/3003",
                  status: "CLOSED",
                  supportedActions: [],
                  assignedLocation: { location: { id: "gid://shopify/Location/1" } },
                }],
              },
            },
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (query.includes("mutation CreateFulfillment")) {
        createCalls += 1;
      }
      throw new Error("A duplicate fulfillment mutation must not run.");
    },
  };

  const { fulfillOrderInShopify } = await import("../services/booking.server");
  const result = await fulfillOrderInShopify(admin, orderId, "POSTEX", "PX-2003");
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.fulfillmentId, "gid://shopify/Fulfillment/4003");
  assert.strictEqual(createCalls, 0);
});

