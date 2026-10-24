process.env.SHOPIFY_API_KEY = "mock_api_key";
process.env.SHOPIFY_API_SECRET = "mock_api_secret";
process.env.SHOPIFY_APP_URL = "https://byndcart-mock.app";
process.env.DATABASE_URL = "postgresql://mock:mock@localhost:5432/mock";
process.env.NODE_ENV = "test";
import test from "node:test";
import assert from "node:assert";
import {
  classifyCourierOrder,
  computeVerifySummary,
  detectCourier,
  isDeliveredStatus,
  isPaidStatus,
  isSafeToMarkPaid,
  parseLeopardResult,
  parsePostExResult,
  resolvePaymentStatus,
} from "../services/codVerification.server";

const order = {
  id: "gid://shopify/Order/1",
  name: "#1001",
  totalPriceSet: { shopMoney: { amount: "3500" } },
};

test("Delivered means the exact courier status, not delivery review", () => {
  assert.strictEqual(isDeliveredStatus("Delivered"), true);
  assert.strictEqual(isDeliveredStatus("Delivered to customer"), true);
  assert.strictEqual(isDeliveredStatus("Delivery Under Review"), false);
  assert.strictEqual(
    classifyCourierOrder("Delivery Under Review").relevant,
    false,
  );
});
test("PostEx settlement is payment received only when the parcel is delivered and settled", () => {
  const settled = parsePostExResult(
    order,
    "CX123",
    {
      dist: {
        transactionStatus: "Delivered",
        invoicePayment: "3500",
        transactionFee: "180",
      },
    },
    { dist: { settle: true, settlementDate: "2026-10-01" } },
  );

  assert.strictEqual(settled.paymentReceived, true);
  assert.strictEqual(settled.matched, true);
  assert.strictEqual(isSafeToMarkPaid(settled), true);
  assert.strictEqual(settled.deliveryCharges, 180);
  const unsettled = parsePostExResult(
    order,
    "CX123",
    { dist: { transactionStatus: "Delivered", invoicePayment: "3500" } },
    { dist: { settle: false } },
  );

  assert.strictEqual(unsettled.paymentStatus, "Payment Not Confirmed");
  assert.strictEqual(isSafeToMarkPaid(unsettled), false);
  const returned = parsePostExResult(
    order,
    "CX123",
    {
      dist: {
        transactionStatus: "Returned to shipper",
        invoicePayment: "3500",
      },
    },
    { dist: { settle: true } },
  );

  assert.strictEqual(returned.paymentReceived, false);
  assert.strictEqual(returned.returned, true);
  assert.strictEqual(isSafeToMarkPaid(returned), false);
});
test("Cancelled and unassigned PostEx orders are ignored and cannot be marked paid", () => {
  const cancelled = parsePostExResult(
    order,
    "CX9",
    { dist: { transactionStatus: "Cancelled" } },
    { dist: { settle: true } },
  );

  assert.strictEqual(cancelled.ignored, true);
  assert.strictEqual(isSafeToMarkPaid(cancelled), false);
  const unassigned = resolvePaymentStatus(
    classifyCourierOrder("Unassigned"),
    true,
  );

  assert.strictEqual(unassigned.paymentStatus, "Unassigned - Ignored");
});
test("Leopards paid words count only when the packet is delivered", () => {
  assert.strictEqual(isPaidStatus("Cheque released"), true);
  assert.strictEqual(isPaidStatus("Not paid"), false);
  const paid = parseLeopardResult(
    order,
    "LEO1",
    {
      packet_list: [
        {
          booked_packet_status: "Delivered",
          booked_packet_collect_amount: "3500",
          delivery_charges: "200",
        },
      ],
    },
    {
      payment_list: [{ status: "Settled", invoice_cheque_date: "2026-10-02" }],
    },
  );

  assert.strictEqual(paid.courier, "Leopard");
  assert.strictEqual(isSafeToMarkPaid(paid), true);
  const summary = computeVerifySummary([paid]);

  assert.strictEqual(summary.deliveredPaymentReceivedAmount, 3500);
  assert.strictEqual(summary.tax, 140);
  assert.strictEqual(summary.totalDeliveryCharges, 200);
  assert.strictEqual(summary.expectedAmount, 3160);
  const custom = computeVerifySummary([paid], 10);

  assert.strictEqual(custom.tax, 350);
  assert.strictEqual(custom.expectedAmount, 2950);
});
test("Courier detection follows the tracking company and PostEx airway bill prefix", () => {
  assert.strictEqual(detectCourier("123", "Leopards Courier"), "Leopard");
  assert.strictEqual(detectCourier("CX9988", ""), "PostEx");
  assert.strictEqual(detectCourier("7788", ""), "PostEx");
});
test("Discrepancy detection flags when courier collected amount differs from Shopify total", () => {
  const differing = parsePostExResult(
    order,
    "CX123",
    {
      dist: {
        transactionStatus: "Delivered",
        invoicePayment: "3200",
        transactionFee: "180",
      },
    },
    { dist: { settle: true } },
  );

  assert.strictEqual(differing.amountMatched, false);
  assert.strictEqual(differing.courierAmount, 3200);
  assert.strictEqual(differing.shopifyAmount, 3500);
  const matched = parsePostExResult(
    order,
    "CX123",
    {
      dist: {
        transactionStatus: "Delivered",
        invoicePayment: "3500",
        transactionFee: "180",
      },
    },
    { dist: { settle: true } },
  );

  assert.strictEqual(matched.amountMatched, true);
});
