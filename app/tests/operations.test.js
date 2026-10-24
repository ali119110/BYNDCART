process.env.SHOPIFY_API_KEY = "mock_api_key";
process.env.SHOPIFY_API_SECRET = "mock_api_secret";
process.env.SHOPIFY_APP_URL = "https://byndcart-mock.app";
process.env.DATABASE_URL = "postgresql://mock:mock@localhost:5432/mock";
process.env.NODE_ENV = "test";
import test from "node:test";
import assert from "node:assert";
import {
  classifySettlement,
  parseCodCsv,
  settlementNet,
} from "../services/cod.server";
import { validateEvidence } from "../services/evidence.server";
import { isRefundMethod } from "../services/refunds.server";
import { roleAllows } from "../services/permissions.server";
import { unconfirmedBooking } from "../services/courier.server";

test("COD net settlement subtracts charges and keeps adjustments", () => {
  assert.strictEqual(
    settlementNet({
      expectedAmount: 5000,
      collectedAmount: 4800,
      shippingCharge: 200,
      reverseCharge: 150,
      fees: 50,
      adjustments: 25,
    }),
    4425,
  );
});
test("COD classification distinguishes imported, matched, and disputed rows", () => {
  assert.strictEqual(classifySettlement(1000, 0), "IMPORTED");
  assert.strictEqual(classifySettlement(1000, 1000), "MATCHED");
  assert.strictEqual(classifySettlement(1000, 900), "DISPUTED");
});
test("COD CSV parser honors quotes and rejects a bad amount", () => {
  const rows = parseCodCsv(
    'courier,expectedAmount,collectedAmount,notes\nTCS,1500,1500,"paid, batch A"\n',
  );

  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].courier, "TCS");
  assert.strictEqual(rows[0].notes, "paid, batch A");
  assert.throws(
    () => parseCodCsv("courier,expectedAmount,collectedAmount\nTCS,nope,1\n"),
    /invalid expectedAmount/,
  );
  assert.throws(
    () => parseCodCsv("courier,notes\nTCS,missing\n"),
    /headers must include/,
  );
});
test("Evidence rules reject unsupported files and non-HTTPS URLs", () => {
  assert.throws(
    () =>
      validateEvidence({
        fileName: "proof.gif",
        mimeType: "image/gif",
        sizeBytes: 100,
        sourceUrl: "https://example.com/proof.gif",
      }),
    /JPEG, PNG, WebP, or MP4/,
  );
  assert.throws(
    () =>
      validateEvidence({
        fileName: "proof.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 100,
        sourceUrl: "http://example.com/proof.jpg",
      }),
    /HTTPS/,
  );
  assert.strictEqual(
    validateEvidence({
      fileName: "proof.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 100,
      sourceUrl: "https://example.com/proof.jpg",
    }),
    true,
  );
});
test("Refund methods and staff roles stay explicit", () => {
  assert.strictEqual(isRefundMethod("JAZZCASH"), true);
  assert.strictEqual(isRefundMethod("CASH"), false);
  assert.strictEqual(roleAllows("WAREHOUSE", "warehouse"), true);
  assert.strictEqual(roleAllows("WAREHOUSE", "refunds"), false);
  assert.strictEqual(roleAllows("ADMIN", "billing"), true);
});
test("Courier booking without confirmation does not invent a tracking number", () => {
  const result = unconfirmedBooking("TCS");

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.isLive, false);
  assert.strictEqual(result.trackingNumber, "");
});
