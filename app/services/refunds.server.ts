import prisma from "../db.server";
import { transitionExchangeStatus } from "./stateMachine.server";

export const REFUND_METHODS = [
  "SHOPIFY",
  "STORE_CREDIT",
  "BANK_TRANSFER",
  "EASYPAISA",
  "JAZZCASH",
  "MANUAL",
] as const;

export type RefundMethod = (typeof REFUND_METHODS)[number];

export function isRefundMethod(value: string): value is RefundMethod {
  return (REFUND_METHODS as readonly string[]).includes(value);
}

export async function listRefundRecords(shopifyStoreId: string) {
  return prisma.refundRecord.findMany({
    where: { shopifyStoreId },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

export async function countPendingRefunds(shopifyStoreId: string) {
  return prisma.refundRecord.count({
    where: { shopifyStoreId, status: "PENDING" },
  });
}

export async function createRefundRecord(input: {
  shopifyStoreId: string;
  returnRequestId?: string;
  exchangeRequestId?: string;
  method: RefundMethod;
  amount: number;
  currency?: string;
  reference?: string;
  reason?: string;
  notes?: string;
  confirmed?: boolean;
}) {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error("Refund amount must be greater than zero.");
  }
  if (!input.returnRequestId && !input.exchangeRequestId) {
    throw new Error("A refund must be linked to a return or an exchange.");
  }

  if (input.returnRequestId) {
    const existing = await prisma.refundRecord.findFirst({
      where: {
        shopifyStoreId: input.shopifyStoreId,
        returnRequestId: input.returnRequestId,
        method: input.method,
        status: { not: "CANCELLED" },
      },
    });
    if (existing) throw new Error("An open refund already exists for this return and method.");
  }

  if (input.exchangeRequestId) {
    const existing = await prisma.refundRecord.findFirst({
      where: {
        shopifyStoreId: input.shopifyStoreId,
        exchangeRequestId: input.exchangeRequestId,
        method: input.method,
        status: { not: "CANCELLED" },
      },
    });
    if (existing) throw new Error("An open refund already exists for this exchange and method.");
  }

  const confirmed = Boolean(input.confirmed);
  return prisma.refundRecord.create({
    data: {
      shopifyStoreId: input.shopifyStoreId,
      returnRequestId: input.returnRequestId,
      exchangeRequestId: input.exchangeRequestId,
      method: input.method,
      amount: input.amount.toFixed(2),
      currency: input.currency || "PKR",
      reference: input.reference,
      reason: input.reason,
      notes: input.notes,
      status: confirmed ? "CONFIRMED" : "PENDING",
      confirmedAt: confirmed ? new Date() : null,
    },
  });
}

export async function confirmRefundRecord(id: string, shopifyStoreId: string, reference?: string) {
  const current = await prisma.refundRecord.findFirst({ where: { id, shopifyStoreId } });
  if (!current) throw new Error("Refund record not found.");
  if (current.status === "CONFIRMED") return current;
  return prisma.refundRecord.update({
    where: { id },
    data: {
      status: "CONFIRMED",
      confirmedAt: new Date(),
      ...(reference !== undefined ? { reference: reference.trim() || current.reference } : {}),
    },
  });
}

/**
 * Cancels a pending or approved exchange and opens a manual refund.
 * This does not create a Shopify refund and does not mark the money as paid.
 */
export async function convertExchangeToManualRefund(input: {
  shopifyStoreId: string;
  exchangeRequestId: string;
  method: RefundMethod;
  amount: number;
  reference?: string;
  reason?: string;
}) {
  const exchange = await prisma.exchangeRequest.findFirst({
    where: { id: input.exchangeRequestId, shopifyStoreId: input.shopifyStoreId },
  });
  if (!exchange) throw new Error("Exchange not found.");
  if (exchange.status !== "PENDING" && exchange.status !== "APPROVED") {
    throw new Error("Only a pending or approved exchange can be converted to a refund.");
  }

  const existing = await prisma.refundRecord.findFirst({
    where: {
      shopifyStoreId: input.shopifyStoreId,
      exchangeRequestId: input.exchangeRequestId,
      status: { not: "CANCELLED" },
    },
  });
  if (existing) throw new Error("This exchange already has a refund record.");

  const refund = await createRefundRecord({
    shopifyStoreId: input.shopifyStoreId,
    exchangeRequestId: input.exchangeRequestId,
    method: input.method,
    amount: input.amount,
    reference: input.reference,
    reason: input.reason || "Exchange converted to refund",
    notes: "Internal refund record. Payment is pending until a merchant confirms it.",
    confirmed: false,
  });

  await transitionExchangeStatus({
    id: input.exchangeRequestId,
    shopifyStoreId: input.shopifyStoreId,
    targetStatus: "CANCELLED",
  });

  return refund;
}
