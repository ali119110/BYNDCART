import prisma from "../db.server";

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
]);
const MAX_BYTES = 1_500_000;

export function validateEvidence(input) {
  if (!ALLOWED_MIME.has(input.mimeType)) {
    throw new Error("Evidence must be a JPEG, PNG, WebP, or MP4 file.");
  }

  if (
    !Number.isFinite(input.sizeBytes) ||
    input.sizeBytes <= 0 ||
    input.sizeBytes > MAX_BYTES
  ) {
    throw new Error("Evidence files must be between 1 byte and 1.5 MB.");
  }

  if (!input.sourceUrl && !input.contentBase64) {
    throw new Error("Provide an evidence file or a URL.");
  }

  if (input.sourceUrl && !/^https:\/\//i.test(input.sourceUrl)) {
    throw new Error("Evidence URLs must use HTTPS.");
  }

  return true;
}

export async function saveEvidence(input) {
  if (!input.returnRequestId && !input.exchangeRequestId) {
    throw new Error("Evidence must be linked to a return or an exchange.");
  }

  validateEvidence(input);
  const kind = input.mimeType.startsWith("video/") ? "VIDEO" : "PHOTO";

  return prisma.evidenceAttachment.create({
    data: {
      shopifyStoreId: input.shopifyStoreId,
      returnRequestId: input.returnRequestId,
      exchangeRequestId: input.exchangeRequestId,
      kind,
      fileName: input.fileName.slice(0, 180),
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      sourceUrl: input.sourceUrl,
      contentBase64: input.contentBase64,
      uploadedBy: input.uploadedBy || "MERCHANT",
    },
  });
}

export async function listEvidence(shopifyStoreId, returnRequestId) {
  return prisma.evidenceAttachment.findMany({
    where: {
      shopifyStoreId,
      ...(returnRequestId ? { returnRequestId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      returnRequestId: true,
      exchangeRequestId: true,
      kind: true,
      fileName: true,
      mimeType: true,
      sizeBytes: true,
      sourceUrl: true,
      uploadedBy: true,
      createdAt: true,
    },
  });
}
