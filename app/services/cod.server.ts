import { createHash } from "node:crypto";
import prisma from "../db.server";

export type CodStatus = "EXPECTED" | "IMPORTED" | "MATCHED" | "DISPUTED" | "CONFIRMED";

export interface CodAmounts {
  expectedAmount: number;
  collectedAmount: number;
  shippingCharge: number;
  reverseCharge: number;
  fees: number;
  adjustments: number;
}

export interface ParsedCodRow extends CodAmounts {
  courier: string;
  trackingNumber?: string;
  orderNumber?: string;
  settlementDate?: string;
  batchReference?: string;
  courierReference?: string;
  bankReference?: string;
  notes?: string;
}

const REQUIRED_HEADERS = ["courier", "expectedamount", "collectedamount"];

export function settlementNet(input: CodAmounts) {
  const net =
    input.collectedAmount -
    input.shippingCharge -
    input.reverseCharge -
    input.fees +
    input.adjustments;
  return Math.round(net * 100) / 100;
}

export function classifySettlement(expectedAmount: number, collectedAmount: number): CodStatus {
  if (collectedAmount === 0 && expectedAmount > 0) return "IMPORTED";
  if (expectedAmount > 0 && collectedAmount === expectedAmount) return "MATCHED";
  if (expectedAmount !== collectedAmount) return "DISPUTED";
  return "IMPORTED";
}

export function csvFingerprint(contents: string) {
  return createHash("sha256").update(contents.replace(/^\uFEFF/, ""), "utf8").digest("hex");
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
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

function headerIndex(headers: string[]) {
  const index = new Map<string, number>();
  headers.forEach((header, position) => {
    index.set(header.trim().toLowerCase().replace(/[\s_-]+/g, ""), position);
  });
  return index;
}

function cell(row: string[], index: Map<string, number>, name: string) {
  const position = index.get(name);
  if (position === undefined) return "";
  return (row[position] || "").trim();
}

function money(value: string, field: string, line: number) {
  if (!value) return 0;
  const amount = Number(value.replace(/,/g, ""));
  if (!Number.isFinite(amount)) {
    throw new Error(`Row ${line} has an invalid ${field}.`);
  }
  return Math.round(amount * 100) / 100;
}

export function parseCodCsv(contents: string): ParsedCodRow[] {
  const table = parseCsv(contents);
  if (table.length < 2) {
    throw new Error("The CSV needs a header row and at least one settlement row.");
  }

  const index = headerIndex(table[0]);
  for (const required of REQUIRED_HEADERS) {
    if (!index.has(required)) {
      throw new Error("CSV headers must include courier, expectedAmount, and collectedAmount.");
    }
  }

  return table.slice(1).map((row, offset) => {
    const line = offset + 2;
    const courier = cell(row, index, "courier");
    if (!courier) throw new Error(`Row ${line} is missing a courier.`);
    return {
      courier: courier.toUpperCase(),
      expectedAmount: money(cell(row, index, "expectedamount"), "expectedAmount", line),
      collectedAmount: money(cell(row, index, "collectedamount"), "collectedAmount", line),
      shippingCharge: money(cell(row, index, "shippingcharge"), "shippingCharge", line),
      reverseCharge: money(cell(row, index, "reversecharge"), "reverseCharge", line),
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

function toDecimal(value: number) {
  return value.toFixed(2);
}

export async function listCodSettlements(shopifyStoreId: string) {
  return prisma.codSettlement.findMany({
    where: { shopifyStoreId },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

export async function countUnreconciledCod(shopifyStoreId: string) {
  return prisma.codSettlement.count({
    where: { shopifyStoreId, status: { in: ["EXPECTED", "IMPORTED", "DISPUTED"] } },
  });
}

export async function createManualSettlement(
  shopifyStoreId: string,
  input: ParsedCodRow & { confirm?: boolean }
) {
  if (input.courierReference) {
    const existing = await prisma.codSettlement.findFirst({
      where: { shopifyStoreId, courierReference: input.courierReference },
    });
    if (existing) {
      throw new Error(`Courier reference ${input.courierReference} is already recorded.`);
    }
  }

  const status: CodStatus = input.confirm ? "CONFIRMED" : classifySettlement(input.expectedAmount, input.collectedAmount);
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
      settlementDate: input.settlementDate ? new Date(input.settlementDate) : null,
      batchReference: input.batchReference,
      courierReference: input.courierReference,
      bankReference: input.bankReference,
      notes: input.notes,
      status: input.confirm && input.expectedAmount !== input.collectedAmount ? "DISPUTED" : status,
      source: "MANUAL",
    },
  });
}

export async function confirmCodSettlement(id: string, shopifyStoreId: string) {
  const current = await prisma.codSettlement.findFirst({ where: { id, shopifyStoreId } });
  if (!current) throw new Error("Settlement not found.");
  return prisma.codSettlement.update({
    where: { id },
    data: { status: "CONFIRMED" },
  });
}

export async function importCodCsv(shopifyStoreId: string, fileName: string, contents: string) {
  const rows = parseCodCsv(contents);
  const fileHash = csvFingerprint(contents);
  const references = rows.map((row) => row.courierReference).filter(Boolean) as string[];
  const uniqueReferences = new Set(references);
  if (uniqueReferences.size !== references.length) {
    throw new Error("The file contains a duplicate courier reference.");
  }

  if (references.length > 0) {
    const existing = await prisma.codSettlement.findFirst({
      where: { shopifyStoreId, courierReference: { in: references } },
    });
    if (existing?.courierReference) {
      throw new Error(`Courier reference ${existing.courierReference} was already imported.`);
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
            settlementDate: row.settlementDate ? new Date(row.settlementDate) : null,
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
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002") {
      throw new Error("This file was already imported.");
    }
    throw error;
  }
}

export async function exportCodCsv(shopifyStoreId: string) {
  const rows = await listCodSettlements(shopifyStoreId);
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
      .join(",")
  );
  return [header.join(","), ...lines].join("\n");
}
