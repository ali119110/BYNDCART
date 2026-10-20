import crypto from "crypto";
import prisma from "../db.server";
import { sendCustomerOTPNotification } from "./notifications.server";

const SESSION_SECRET = process.env.CUSTOMER_SESSION_SECRET || "byndcart_customer_session_secret_key_32bytes!";
const OTP_EXPIRY_MINUTES = 10;
const MAX_VERIFICATION_ATTEMPTS = 3;

// In-memory rate limiting counters (resets on server restart or window expiry)
interface RateLimitEntry {
  count: number;
  resetAt: number;
}
const rateLimitMap = new Map<string, RateLimitEntry>();

/**
 * Checks and increments rate limit counter for a key within a window (ms).
 * Returns true if allowed, false if limit exceeded.
 */
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(key);

  if (!record || record.resetAt <= now) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (record.count >= limit) {
    return false;
  }

  record.count += 1;
  return true;
}

/**
 * Resets rate limit for testing purposes.
 */
export function clearRateLimits() {
  rateLimitMap.clear();
}

/**
 * Generates a cryptographically secure 6-digit numeric OTP.
 */
export function generateSecureOTP(length = 6): string {
  const min = Math.pow(10, length - 1);
  const max = Math.pow(10, length) - 1;
  const num = crypto.randomInt(min, max + 1);
  return num.toString();
}

/**
 * Computes SHA-256 hash of an OTP code with app salt.
 */
export function hashOTP(otp: string): string {
  return crypto
    .createHash("sha256")
    .update(`${otp}:${SESSION_SECRET}`)
    .digest("hex");
}

/**
 * Requests an OTP code for order lookup and sends it to the customer.
 * Prevents order enumeration by returning generic response even if order does not match.
 */
export async function requestCustomerOTP(
  shopifyStoreId: string,
  orderNumberInput: string,
  destinationInput: string
) {
  const normalizedEmail = destinationInput.trim().toLowerCase();
  const normalizedOrderNumber = orderNumberInput.trim().startsWith("#")
    ? orderNumberInput.trim()
    : `#${orderNumberInput.trim()}`;

  // Rate Limit: Max 3 OTP requests per 10 minutes per destination/order
  const rateLimitKey = `otp_req:${shopifyStoreId}:${normalizedOrderNumber}:${normalizedEmail}`;
  if (!checkRateLimit(rateLimitKey, 3, 10 * 60 * 1000)) {
    throw new Error("Too many OTP requests. Please wait a few minutes before trying again.");
  }

  const order = await findCustomerOrder(shopifyStoreId, normalizedOrderNumber, normalizedEmail);

  // Generic anti-enumeration response if order does not exist or store mismatch
  const genericSuccessResponse = {
    success: true,
    emailSent: false,
    message: "If an order with those details exists in our system, a verification code has been sent to your email.",
  };

  if (!order) {
    // Audit Log attempt on non-existent order
    await prisma.auditLog.create({
      data: {
        shopifyStoreId,
        action: "OTP_REQUEST_ORDER_NOT_FOUND",
        entityType: "CustomerOTP",
        metadata: { orderNumber: normalizedOrderNumber, maskedDestination: maskDestination(normalizedEmail) },
      },
    });
    return genericSuccessResponse;
  }

  // Generate 6-digit OTP code & compute hash
  const otpCode = generateSecureOTP(6);
  const otpHash = hashOTP(otpCode);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  // Invalidate any active, unverified OTPs for this order & destination
  await prisma.customerOTP.updateMany({
    where: {
      shopifyStoreId,
      orderNumber: normalizedOrderNumber,
      destination: normalizedEmail,
      verified: false,
    },
    data: {
      expiresAt: new Date(0), // expire immediately
    },
  });

  // Create new CustomerOTP database record
  await prisma.customerOTP.create({
    data: {
      shopifyStoreId,
      orderNumber: normalizedOrderNumber,
      destination: normalizedEmail,
      otpHash,
      expiresAt,
      attempts: 0,
      maxAttempts: MAX_VERIFICATION_ATTEMPTS,
      verified: false,
    },
  });

  // Audit Log security event (NEVER store plaintext OTP)
  await prisma.auditLog.create({
    data: {
      shopifyStoreId,
      action: "OTP_REQUESTED",
      entityType: "CustomerOTP",
      metadata: { orderNumber: normalizedOrderNumber, maskedDestination: maskDestination(normalizedEmail) },
    },
  });

  const sent = await sendCustomerOTPNotification({
    shopifyStoreId,
    orderNumber: order.orderNumber,
    destination: normalizedEmail,
    otpCode,
  });

  if (!sent.success) {
    console.error("[OTP] Verification email was not sent:", sent.error);
    if (process.env.NODE_ENV !== "test") {
      throw new Error(
        sent.error === "RESEND_API_KEY not configured"
          ? "Verification email is not set up for this store yet."
          : "The verification email could not be sent. Please try again shortly."
      );
    }
  }

  return {
    success: true,
    emailSent: sent.success,
    message: genericSuccessResponse.message,
  };
}

async function findCustomerOrder(shopifyStoreId: string, normalizedOrderNumber: string, normalizedEmail: string) {
  const local = await findLocalCustomerOrder(shopifyStoreId, normalizedOrderNumber, normalizedEmail);
  if (local || process.env.NODE_ENV === "test") return local;

  try {
    const { syncCustomerOrder } = await import("./orders.server");
    await syncCustomerOrder(shopifyStoreId, normalizedOrderNumber);
  } catch (error) {
    console.error("[OTP] Could not load this order from Shopify:", error);
  }

  return findLocalCustomerOrder(shopifyStoreId, normalizedOrderNumber, normalizedEmail);
}

async function findLocalCustomerOrder(shopifyStoreId: string, normalizedOrderNumber: string, normalizedEmail: string) {
  const candidates = getCustomerOrderNumberCandidates(normalizedOrderNumber);
  for (const orderNumber of candidates) {
    const order = await prisma.order.findFirst({
      where: {
        shopifyStoreId,
        orderNumber: { equals: orderNumber, mode: "insensitive" },
        customerEmail: { equals: normalizedEmail, mode: "insensitive" },
      },
    });
    if (order) return order;
  }
  return null;
}

/**
 * Verifies a customer-submitted 6-digit OTP code.
 */
export async function verifyCustomerOTP(
  shopifyStoreId: string,
  orderNumberInput: string,
  destinationInput: string,
  userEnteredOtp: string
) {
  const normalizedEmail = destinationInput.trim().toLowerCase();
  const normalizedOrderNumber = orderNumberInput.trim().startsWith("#")
    ? orderNumberInput.trim()
    : `#${orderNumberInput.trim()}`;

  // Rate Limit: Max 5 verification attempts per 15 minutes per order/destination
  const rateLimitKey = `otp_verify:${shopifyStoreId}:${normalizedOrderNumber}:${normalizedEmail}`;
  if (!checkRateLimit(rateLimitKey, 5, 15 * 60 * 1000)) {
    throw new Error("Too many failed verification attempts. Please wait before trying again.");
  }

  // Find active, unverified OTP record
  const otpRecord = await prisma.customerOTP.findFirst({
    where: {
      shopifyStoreId,
      orderNumber: normalizedOrderNumber,
      destination: normalizedEmail,
      verified: false,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!otpRecord) {
    await prisma.auditLog.create({
      data: {
        shopifyStoreId,
        action: "OTP_VERIFY_EXPIRED_OR_NOT_FOUND",
        entityType: "CustomerOTP",
        metadata: { orderNumber: normalizedOrderNumber },
      },
    });
    return { success: false, error: "Verification code is invalid or has expired. Please request a new code." };
  }

  // Check maximum verification attempts
  if (otpRecord.attempts >= otpRecord.maxAttempts) {
    await prisma.auditLog.create({
      data: {
        shopifyStoreId,
        action: "OTP_MAX_ATTEMPTS_EXCEEDED",
        entityType: "CustomerOTP",
        metadata: { orderNumber: normalizedOrderNumber, otpId: otpRecord.id },
      },
    });
    return { success: false, error: "Maximum verification attempts exceeded. Please request a new verification code." };
  }

  const computedHash = hashOTP(userEnteredOtp.trim());

  if (computedHash !== otpRecord.otpHash) {
    // Increment failed attempts
    const updatedRecord = await prisma.customerOTP.update({
      where: { id: otpRecord.id },
      data: { attempts: { increment: 1 } },
    });

    const currentAttempts = updatedRecord ? updatedRecord.attempts : otpRecord.attempts + 1;
    const remainingAttempts = Math.max(0, otpRecord.maxAttempts - currentAttempts);

    await prisma.auditLog.create({
      data: {
        shopifyStoreId,
        action: "OTP_VERIFY_FAILED",
        entityType: "CustomerOTP",
        metadata: { orderNumber: normalizedOrderNumber, remainingAttempts },
      },
    });

    return {
      success: false,
      error: `Invalid verification code. ${remainingAttempts} attempts remaining.`,
    };
  }


  // Successful verification -> Mark as verified & invalidate code from reuse
  await prisma.customerOTP.update({
    where: { id: otpRecord.id },
    data: { verified: true },
  });

  await prisma.auditLog.create({
    data: {
      shopifyStoreId,
      action: "OTP_VERIFIED_SUCCESS",
      entityType: "CustomerOTP",
      metadata: { orderNumber: normalizedOrderNumber, otpId: otpRecord.id },
    },
  });

  // Create short-lived customer session payload (15-minute validity)
  const sessionToken = createCustomerSessionToken({
    shopifyStoreId,
    orderNumber: normalizedOrderNumber,
    customerEmail: normalizedEmail,
    durationMinutes: 15,
  });

  return {
    success: true,
    sessionToken,
    orderNumber: normalizedOrderNumber,
    customerEmail: normalizedEmail,
  };
}

export interface CustomerSessionPayload {
  shopifyStoreId: string;
  orderNumber: string;
  customerEmail: string;
  customerPhone?: string;
  exp: number;
}

/** Canonical comparison form. Letter prefixes such as FR-/FR are equivalent to the trailing Shopify number. */
export function normalizeCustomerOrderNumber(value: string): string {
  const trimmed = String(value || "").trim().replace(/\s+/g, "");
  if (!trimmed) return "";
  const compact = trimmed.replace(/^#+/, "").replace(/-/g, "");
  const numericTail = compact.match(/^(?:[A-Z]+)?(\d+)$/i);
  return numericTail ? `#${numericTail[1]}` : compact.toUpperCase();
}

/** Candidate spellings let FR4609, FR-4609, #4609 and 4609 identify the same order. */
export function getCustomerOrderNumberCandidates(value: string): string[] {
  const rawInput = String(value || "").trim().replace(/\s+/g, "");
  if (!rawInput) return [];
  const raw = rawInput.replace(/^#+/, "");
  const compact = raw.replace(/-/g, "");
  const candidates = [rawInput, raw, compact, `#${raw}`, `#${compact}`];
  const prefixAndNumber = compact.match(/^([A-Z]+)(\d+)$/i);
  if (prefixAndNumber) {
    const digits = prefixAndNumber[2];
    const prefix = prefixAndNumber[1];
    candidates.push(digits, `#${digits}`, `${prefix}-${digits}`, `#${prefix}-${digits}`);
  }
  if (/^\d+$/.test(compact)) candidates.push(compact, `#${compact}`);
  return [...new Set(candidates.filter(Boolean))];
}

function normalizeSessionPhone(value: string | null | undefined): string | undefined {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("0092")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = "92" + digits.slice(1);
  return digits || undefined;
}

/**
 * Creates an HMAC-SHA256 signed session token for verified shoppers.
 */
export function createCustomerSessionToken(params: {
  shopifyStoreId: string;
  orderNumber: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  durationMinutes?: number;
}): string {
  const duration = params.durationMinutes || 15;
  const exp = Math.floor(Date.now() / 1000) + duration * 60;
  const payload: CustomerSessionPayload = {
    shopifyStoreId: params.shopifyStoreId,
    // Preserve the stored Shopify name for lookups; verification compares canonical forms.
    orderNumber: String(params.orderNumber || "").trim(),
    customerEmail: String(params.customerEmail || "").trim().toLowerCase(),
    customerPhone: normalizeSessionPhone(params.customerPhone),
    exp,
  };

  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payloadBase64)
    .digest("base64url");

  return `${payloadBase64}.${signature}`;
}

/**
 * Verifies and decodes a customer session token. Enforces tenant, order, and expiration rules.
 */
export function verifyCustomerSessionToken(
  token: string,
  expectedStoreId: string,
  expectedOrderNumber?: string
): CustomerSessionPayload | null {
  if (!token || !token.includes(".")) return null;

  const [payloadBase64, signature] = token.split(".");
  if (!payloadBase64 || !signature) return null;

  const expectedSignature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payloadBase64)
    .digest("base64url");

  if (signature !== expectedSignature) {
    return null; // Invalid signature
  }

  try {
    const payload: CustomerSessionPayload = JSON.parse(
      Buffer.from(payloadBase64, "base64url").toString("utf8")
    );

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (payload.exp < nowSeconds) {
      return null; // Expired session
    }

    if (payload.shopifyStoreId !== expectedStoreId) {
      return null; // Cross-merchant access attempt
    }

    if (expectedOrderNumber) {
      const normExpected = normalizeCustomerOrderNumber(expectedOrderNumber);
      if (normalizeCustomerOrderNumber(payload.orderNumber).toLowerCase() !== normExpected.toLowerCase()) {
        return null; // Order tampering attempt
      }
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Helper to mask emails/phone numbers in logs (e.g. c***r@example.com).
 */
function maskDestination(dest: string): string {
  if (dest.includes("@")) {
    const [name, domain] = dest.split("@");
    const maskedName = name.length > 2 ? `${name[0]}***${name[name.length - 1]}` : `${name[0]}***`;
    return `${maskedName}@${domain}`;
  }
  return dest.length > 4 ? `${dest.slice(0, 3)}***${dest.slice(-2)}` : "***";
}
