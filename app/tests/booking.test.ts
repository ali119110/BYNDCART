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
  assert.strictEqual(matchPakistaniCity(""), "Karachi");

  // Verify major cities list contains expected entries
  assert.ok(MAJOR_PAKISTANI_CITIES.includes("Karachi"));
  assert.ok(MAJOR_PAKISTANI_CITIES.includes("Lahore"));
  assert.ok(MAJOR_PAKISTANI_CITIES.includes("Islamabad"));
  assert.ok(MAJOR_PAKISTANI_CITIES.length > 50);
});

test("Pakistani Logistics - Package weight estimation", () => {
  // Empty or missing weight defaults to 0.5 kg
  assert.strictEqual(estimatePackageWeight([]), 0.5);
  assert.strictEqual(estimatePackageWeight(null), 0.5);
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

test("Loadsheet Service - Loadsheet creation and parcel assignment", async () => {
  const mockShipments = [
    {
      id: "ship-101",
      shopifyStoreId: "store-test",
      shopifyOrderId: "gid://shopify/Order/1001",
      orderNumber: "#1001",
      courier: "POSTEX",
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
      trackingNumber: "POSTEX-1002",
      destinationCity: "Karachi",
      codAmount: 3400,
      loadsheetId: null,
      status: "LABEL_CREATED",
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
  (prisma as any).shipmentTrack.findMany = async () => mockShipments;
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
});
