import { createHash } from "node:crypto";
import prisma from "../db.server";

const REQUIRED_HEADERS = ["courier", "expectedamount", "collectedamount"];

export function settlementNet(input) {
  const net =
    input.collectedAmount -
    input.shippingCharge -
    input.reverseCharge -
    input.fees +
    input.adjustments;

  return Math.round(net * 100) / 100;
}

export function classifySettlement(expectedAmount, collectedAmount) {
  if (collectedAmount === 0 && expectedAmount > 0) return "IMPORTED";
  if (expectedAmount > 0 && collectedAmount === expectedAmount)
    return "MATCHED";
  if (expectedAmount !== collectedAmount) return "DISPUTED";

  return "IMPORTED";
}

export function csvFingerprint(contents) {
  return createHash("sha256")
    .update(contents.replace(/^\uFEFF/, ""), "utf8")
    .digest("hex");
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const source = text.replace(/^\uFEFF/, "");

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }

      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((entry) => entry.some((value) => value.trim().length > 0));
}

function headerIndex(headers) {
  const index = new Map();

  headers.forEach((header, position) => {
    index.set(
      header
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, ""),
      position,
    );
  });

  return index;
}

function cell(row, index, name) {
  const position = index.get(name);

  if (position === undefined) return "";

  return (row[position] || "").trim();
}

function money(value, field, line) {
  if (!value) return 0;
  const amount = Number(value.replace(/,/g, ""));

  if (!Number.isFinite(amount)) {
    throw new Error(`Row ${line} has an invalid ${field}.`);
  }

  return Math.round(amount * 100) / 100;
}

export function parseCodCsv(contents) {
  const table = parseCsv(contents);

  if (table.length < 2) {
    throw new Error(
      "The CSV needs a header row and at least one settlement row.",
    );
  }

  const index = headerIndex(table[0]);

  for (const required of REQUIRED_HEADERS) {
    if (!index.has(required)) {
      throw new Error(
        "CSV headers must include courier, expectedAmount, and collectedAmount.",
      );
    }
  }

  return table.slice(1).map((row, offset) => {
    const line = offset + 2;
    const courier = cell(row, index, "courier");

    if (!courier) throw new Error(`Row ${line} is missing a courier.`);

    return {
      courier: courier.toUpperCase(),
      expectedAmount: money(
        cell(row, index, "expectedamount"),
        "expectedAmount",
        line,
      ),
      collectedAmount: money(
        cell(row, index, "collectedamount"),
        "collectedAmount",
        line,
      ),
      shippingCharge: money(
        cell(row, index, "shippingcharge"),
        "shippingCharge",
        line,
      ),
      reverseCharge: money(
        cell(row, index, "reversecharge"),
        "reverseCharge",
        line,
      ),
      fees: money(cell(row, index, "fees"), "fees", line),
      adjustments: money(cell(row, index, "adjustments"), "adjustments", line),
      trackingNumber: cell(row, index, "trackingnumber") || undefined,
      orderNumber: cell(row, index, "ordernumber") || undefined,
      settlementDate: cell(row, index, "settlementdate") || undefined,
      batchReference: cell(row, index, "batchreference") || undefined,
      courierReference: cell(row, index, "courierreference") || undefined,
      bankReference: cell(row, index, "bankreference") || undefined,
      notes: cell(row, index, "notes") || undefined,
    };
  });
}

function toDecimal(value) {
  return value.toFixed(2);
}

export async function listCodSettlements(shopifyStoreId, options) {
  const where = { shopifyStoreId };

  if (options?.courier && options.courier !== "ALL") {
    where.courier = { equals: options.courier, mode: "insensitive" };
  }

  if (options?.status && options.status !== "ALL") {
    where.status = options.status;
  }

  if (options?.search) {
    const s = options.search.trim();

    if (s) {
      where.OR = [
        { orderNumber: { contains: s, mode: "insensitive" } },
        { trackingNumber: { contains: s, mode: "insensitive" } },
        { courierReference: { contains: s, mode: "insensitive" } },
      ];
    }
  }

  return prisma.codSettlement.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

export async function countUnreconciledCod(shopifyStoreId) {
  return prisma.codSettlement.count({
    where: {
      shopifyStoreId,
      status: { in: ["EXPECTED", "IMPORTED", "DISPUTED"] },
    },
  });
}

export async function createManualSettlement(shopifyStoreId, input) {
  if (input.courierReference) {
    const existing = await prisma.codSettlement.findFirst({
      where: { shopifyStoreId, courierReference: input.courierReference },
    });

    if (existing) {
      throw new Error(
        `Courier reference ${input.courierReference} is already recorded.`,
      );
    }
  }

  const status = input.confirm
    ? "CONFIRMED"
    : classifySettlement(input.expectedAmount, input.collectedAmount);

  return prisma.codSettlement.create({
    data: {
      shopifyStoreId,
      courier: input.courier.toUpperCase(),
      trackingNumber: input.trackingNumber,
      orderNumber: input.orderNumber,
      expectedAmount: toDecimal(input.expectedAmount),
      collectedAmount: toDecimal(input.collectedAmount),
      shippingCharge: toDecimal(input.shippingCharge),
      reverseCharge: toDecimal(input.reverseCharge),
      fees: toDecimal(input.fees),
      adjustments: toDecimal(input.adjustments),
      netAmount: toDecimal(settlementNet(input)),
      settlementDate: input.settlementDate
        ? new Date(input.settlementDate)
        : null,
      batchReference: input.batchReference,
      courierReference: input.courierReference,
      bankReference: input.bankReference,
      notes: input.notes,
      status:
        input.confirm && input.expectedAmount !== input.collectedAmount
          ? "DISPUTED"
          : status,
      source: "MANUAL",
    },
  });
}

export async function confirmCodSettlement(id, shopifyStoreId) {
  const current = await prisma.codSettlement.findFirst({
    where: { id, shopifyStoreId },
  });

  if (!current) throw new Error("Settlement not found.");

  return prisma.codSettlement.update({
    where: { id },
    data: { status: "CONFIRMED" },
  });
}

export async function importCodCsv(shopifyStoreId, fileName, contents) {
  const rows = parseCodCsv(contents);
  const fileHash = csvFingerprint(contents);
  const references = rows.map((row) => row.courierReference).filter(Boolean);
  const uniqueReferences = new Set(references);

  if (uniqueReferences.size !== references.length) {
    throw new Error("The file contains a duplicate courier reference.");
  }

  if (references.length > 0) {
    const existing = await prisma.codSettlement.findFirst({
      where: { shopifyStoreId, courierReference: { in: references } },
    });

    if (existing?.courierReference) {
      throw new Error(
        `Courier reference ${existing.courierReference} was already imported.`,
      );
    }
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const batch = await tx.codImportBatch.create({
        data: { shopifyStoreId, fileName, fileHash, rowCount: rows.length },
      });

      for (const row of rows) {
        await tx.codSettlement.create({
          data: {
            shopifyStoreId,
            importBatchId: batch.id,
            courier: row.courier,
            trackingNumber: row.trackingNumber,
            orderNumber: row.orderNumber,
            expectedAmount: toDecimal(row.expectedAmount),
            collectedAmount: toDecimal(row.collectedAmount),
            shippingCharge: toDecimal(row.shippingCharge),
            reverseCharge: toDecimal(row.reverseCharge),
            fees: toDecimal(row.fees),
            adjustments: toDecimal(row.adjustments),
            netAmount: toDecimal(settlementNet(row)),
            settlementDate: row.settlementDate
              ? new Date(row.settlementDate)
              : null,
            batchReference: row.batchReference,
            courierReference: row.courierReference,
            bankReference: row.bankReference,
            notes: row.notes,
            status: classifySettlement(row.expectedAmount, row.collectedAmount),
            source: "CSV",
          },
        });
      }

      return { batchId: batch.id, rowCount: rows.length };
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    ) {
      throw new Error("This file was already imported.");
    }

    throw error;
  }
}

export async function recordAutoReconciledSettlement(shopifyStoreId, input) {
  try {
    const net = settlementNet({
      expectedAmount: input.expectedAmount,
      collectedAmount: input.collectedAmount,
      shippingCharge: input.shippingCharge || 0,
      reverseCharge: input.reverseCharge || 0,
      fees: input.fees || 0,
      adjustments: input.adjustments || 0,
    });
    const calculatedStatus =
      input.status ||
      (input.expectedAmount > 0 &&
      input.collectedAmount === input.expectedAmount
        ? "CONFIRMED"
        : input.expectedAmount !== input.collectedAmount
          ? "DISPUTED"
          : "MATCHED");
    // Search for existing settlement for this orderNumber or trackingNumber to avoid duplicate rows
    const existing = await prisma.codSettlement.findFirst({
      where: {
        shopifyStoreId,
        OR: [
          ...(input.orderNumber ? [{ orderNumber: input.orderNumber }] : []),
          ...(input.trackingNumber
            ? [{ trackingNumber: input.trackingNumber }]
            : []),
        ],
      },
    });

    if (existing) {
      return await prisma.codSettlement.update({
        where: { id: existing.id },
        data: {
          courier: input.courier.toUpperCase(),
          trackingNumber: input.trackingNumber || existing.trackingNumber,
          expectedAmount: toDecimal(input.expectedAmount),
          collectedAmount: toDecimal(input.collectedAmount),
          shippingCharge: toDecimal(input.shippingCharge || 0),
          fees: toDecimal(input.fees || 0),
          netAmount: toDecimal(net),
          settlementDate: input.settlementDate
            ? new Date(input.settlementDate)
            : existing.settlementDate,
          status: calculatedStatus,
          source: "AUTO_RECONCILE",
          notes:
            input.notes ||
            existing.notes ||
            `Auto-reconciled from ${input.courier}`,
        },
      });
    }

    return await prisma.codSettlement.create({
      data: {
        shopifyStoreId,
        courier: input.courier.toUpperCase(),
        trackingNumber: input.trackingNumber,
        orderNumber: input.orderNumber,
        expectedAmount: toDecimal(input.expectedAmount),
        collectedAmount: toDecimal(input.collectedAmount),
        shippingCharge: toDecimal(input.shippingCharge || 0),
        reverseCharge: toDecimal(input.reverseCharge || 0),
        fees: toDecimal(input.fees || 0),
        adjustments: toDecimal(input.adjustments || 0),
        netAmount: toDecimal(net),
        settlementDate: input.settlementDate
          ? new Date(input.settlementDate)
          : new Date(),
        batchReference: input.batchReference,
        courierReference: input.courierReference,
        bankReference: input.bankReference,
        notes:
          input.notes || `Auto-reconciled from ${input.courier} courier check`,
        status: calculatedStatus,
        source: "AUTO_RECONCILE",
      },
    });
  } catch (error) {
    console.error(
      "[COD Auto-Reconcile] Error persisting settlement record:",
      error,
    );

    return null;
  }
}

export async function exportCodCsv(shopifyStoreId, courierFilter) {
  const rows = await listCodSettlements(shopifyStoreId, {
    courier: courierFilter,
  });
  const header = [
    "courier",
    "orderNumber",
    "trackingNumber",
    "expectedAmount",
    "collectedAmount",
    "shippingCharge",
    "reverseCharge",
    "fees",
    "adjustments",
    "netAmount",
    "status",
    "source",
    "settlementDate",
    "batchReference",
    "courierReference",
    "bankReference",
    "notes",
  ];
  const lines = rows.map((row) =>
    [
      row.courier,
      row.orderNumber,
      row.trackingNumber,
      row.expectedAmount,
      row.collectedAmount,
      row.shippingCharge,
      row.reverseCharge,
      row.fees,
      row.adjustments,
      row.netAmount,
      row.status,
      row.source,
      row.settlementDate ? new Date(row.settlementDate).toISOString() : "",
      row.batchReference,
      row.courierReference,
      row.bankReference,
      row.notes,
    ]
      .map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`)
      .join(","),
  );

  return [header.join(","), ...lines].join("\n");
}
