process.env.SHOPIFY_API_KEY = "mock_api_key";
process.env.SHOPIFY_API_SECRET = "mock_api_secret";
process.env.SHOPIFY_APP_URL = "https://byndcart-mock.app";
process.env.SCOPES = "read_orders,write_returns";
process.env.DATABASE_URL = "postgresql://mock:mock@localhost:5432/mock";
process.env.NODE_ENV = "test";
import test from "node:test";
import assert from "node:assert";
import prisma from "../db.server";
// Mock prisma.shipmentTrack and auditLog for unit tests
prisma.shipmentTrack.upsert = async (args) => ({
  id: "ship-uuid-100",
  shopifyStoreId: args.create.shopifyStoreId,
  shopifyOrderId: args.create.shopifyOrderId,
  orderNumber: args.create.orderNumber,
  type: args.create.type,
  courier: args.create.courier,
  trackingNumber: args.create.trackingNumber,
  labelUrl: args.create.labelUrl,
  status: args.create.status,
  createdAt: new Date(),
  updatedAt: new Date(),
});
prisma.shipmentTrack.findMany = async () => [
  {
    id: "ship-uuid-100",
    shopifyStoreId: "store-1",
    shopifyOrderId: "gid://shopify/Order/1001",
    orderNumber: "#1001",
    type: "RETURN",
    courier: "TCS",
    trackingNumber: "771234567890",
    labelUrl: "https://tcs.local/123.pdf",
    status: "IN_TRANSIT",
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];
prisma.shipmentTrack.findFirst = async () => null;
prisma.shipmentEvent.create = async () => ({});
prisma.auditLog.create = async () => ({});
test("Pakistani Logistics - Carrier Provider Adapters (TCS, Leopards, Trax, M&P, PostEx, CallCourier)", async () => {
  const { CourierRegistry } = await import("../services/courier.server");
  const registered = CourierRegistry.getRegisteredAdapters();

  assert.ok(registered.length >= 6);
  // Test TCS Express Adapter
  const tcs = CourierRegistry.get("TCS");
  const tcsLabel = await tcs.generateReturnLabel({
    shopifyStoreId: "store-1",
    orderId: "gid://shopify/Order/1001",
    orderNumber: "#1001",
  });

  assert.strictEqual(tcsLabel.success, true);
  assert.ok(tcsLabel.trackingNumber.startsWith("77"));
  assert.strictEqual(tcsLabel.costPKR, 250);
  // Test Leopards Adapter
  const leopards = CourierRegistry.get("LEOPARDS");
  const leopardsLabel = await leopards.generateReturnLabel({
    shopifyStoreId: "store-1",
    orderId: "gid://shopify/Order/1002",
    orderNumber: "#1002",
  });

  assert.strictEqual(leopardsLabel.success, true);
  assert.ok(leopardsLabel.trackingNumber.startsWith("LEO-"));
  assert.strictEqual(leopardsLabel.costPKR, 220);
  // Test Trax Adapter
  const trax = CourierRegistry.get("TRAX");
  const traxLabel = await trax.generateReturnLabel({
    shopifyStoreId: "store-1",
    orderId: "gid://shopify/Order/1003",
    orderNumber: "#1003",
  });

  assert.strictEqual(traxLabel.success, true);
  assert.ok(traxLabel.trackingNumber.startsWith("TRX-"));
  assert.strictEqual(traxLabel.costPKR, 200);
  // Test PostEx Adapter
  const postex = CourierRegistry.get("POSTEX");
  const postexLabel = await postex.generateReturnLabel({
    shopifyStoreId: "store-1",
    orderId: "gid://shopify/Order/1004",
    orderNumber: "#1004",
  });

  assert.strictEqual(postexLabel.success, true);
  assert.ok(postexLabel.trackingNumber.startsWith("PEX-"));
});
test("Pakistani Logistics Service - Register & Query Tenant Shipments", async () => {
  const { registerShipmentTrack, getStoreShipments } =
    await import("../services/shipments.server");
  const shipment = await registerShipmentTrack({
    shopifyStoreId: "store-1",
    orderId: "gid://shopify/Order/1001",
    orderNumber: "#1001",
    courier: "TCS",
    type: "RETURN",
  });

  assert.strictEqual(shipment.success, true);
  assert.strictEqual(shipment.courier, "TCS");
  const list = await getStoreShipments("store-1");

  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].orderNumber, "#1001");
  assert.strictEqual(list[0].courier, "TCS");
});
