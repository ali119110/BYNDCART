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
prisma.shipmentTrack.upsert = (async (args: any) => ({
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
})) as any;

prisma.shipmentTrack.findMany = (async () => [
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
]) as any;

prisma.shipmentTrack.findFirst = (async () => null) as any;
prisma.shipmentTrack.findUnique = (async () => null) as any;
prisma.shipmentEvent.create = (async () => ({})) as any;
prisma.auditLog.create = (async () => ({})) as any;


test("Registered couriers include PostEx, Leopards, DHL, FedEx, and TCS, and incomplete bookings stay unconfirmed", async () => {
  const { CourierRegistry } = await import("../services/courier.server");

  const registered = CourierRegistry.getRegisteredAdapters().map((adapter) => adapter.providerName).sort();
  assert.deepStrictEqual(registered, ["DHL", "FEDEX", "LEOPARDS", "POSTEX", "TCS"]);
  assert.throws(() => CourierRegistry.get("TRAX"), /Unsupported courier provider/);

  const leopards = CourierRegistry.get("LEOPARDS");
  const leopardsLabel = await leopards.generateReturnLabel({
    shopifyStoreId: "store-1",
    orderId: "gid://shopify/Order/1002",
    orderNumber: "#1002",
  });
  assert.strictEqual(leopardsLabel.success, false);
  assert.strictEqual(leopardsLabel.isLive, false);

  const postex = CourierRegistry.get("POSTEX");
  const postexLabel = await postex.generateReturnLabel({
    shopifyStoreId: "store-1",
    orderId: "gid://shopify/Order/1004",
    orderNumber: "#1004",
  });
  assert.strictEqual(postexLabel.success, false);
  assert.strictEqual(postexLabel.isLive, false);
});

test("Pakistani Logistics Service - Register & Query Tenant Shipments", async () => {
  const { registerShipmentTrack, getStoreShipments } = await import("../services/shipments.server");

  await assert.rejects(
    () => registerShipmentTrack({
      shopifyStoreId: "store-1",
      orderId: "gid://shopify/Order/1001",
      orderNumber: "#1001",
      courier: "POSTEX",
      trackingNumber: "771234567890",
      type: "RETURN",
    }),
    /carrier API confirms the booking/,
  );

  const list = await getStoreShipments("store-1");
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].orderNumber, "#1001");
  assert.strictEqual(list[0].courier, "TCS"); // fixture row, not a live booking
});
