import crypto from "crypto";

const ENCRYPTION_KEY = process.env.ENCRYPTION_SECRET || process.env.CREDENTIAL_ENCRYPTION_KEY || "byndcart_courier_encryption_key_32b!"; // 32 bytes
const ALGORITHM = "aes-256-cbc";

/**
 * Encrypts a plaintext credential string using AES-256-CBC.
 */
export function encryptCredential(text: string): string {
  if (!text) return "";
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync(ENCRYPTION_KEY, "salt", 32);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return `${iv.toString("hex")}:${encrypted}`;
}

/**
 * Decrypts an encrypted credential string.
 */
export function decryptCredential(encryptedText: string): string {
  if (!encryptedText) return "";
  if (!encryptedText.includes(":")) return encryptedText; // Fallback for unencrypted legacy keys in dev

  try {
    const [ivHex, encryptedHex] = encryptedText.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const key = crypto.scryptSync(ENCRYPTION_KEY, "salt", 32);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encryptedHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (error) {
    console.error("[Encryption] Failed to decrypt credential:", error);
    return "";
  }
}

/**
 * Masks a credential for secure UI display (e.g. "••••••••1234").
 * Never exposes raw secret tokens to the client browser.
 */
export function maskCredential(text: string): string {
  if (!text) return "";
  const decrypted = decryptCredential(text);
  if (!decrypted) return "";
  if (decrypted.length <= 4) return "••••";
  return `••••••••${decrypted.slice(-4)}`;
}
