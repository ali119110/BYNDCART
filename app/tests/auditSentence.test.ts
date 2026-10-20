import test from "node:test";
import assert from "node:assert/strict";
import { describeAuditEvent } from "../utils/auditSentence";

test("audit history is a sentence instead of stored JSON", () => {
  const created = describeAuditEvent("EXCHANGE_CREATED", { itemCount: 1, orderNumber: "FR4609", requestSource: "CUSTOMER", policyEligible: true });
  assert.equal(created.title, "Exchange created");
  assert.equal(created.description, "Customer requested an exchange for order FR4609.");
  assert.equal(created.description.includes("{"), false);

  const approved = describeAuditEvent("EXCHANGE_STATUS_TRANSITION_APPROVED", { newStatus: "APPROVED", previousStatus: "PENDING" });
  assert.equal(approved.description, "Status changed from pending to approved.");
  assert.equal(approved.description.includes("{"), false);
});
