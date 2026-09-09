import prisma from "../db.server";

export interface EnqueueJobInput {
  shopifyStoreId?: string;
  type: string;
  payload: Record<string, any>;
  runAt?: Date;
  maxAttempts?: number;
}

/**
 * Enqueues a background job into PostgreSQL via Prisma.
 */
export async function enqueueJob(input: EnqueueJobInput) {
  return await prisma.backgroundJob.create({
    data: {
      shopifyStoreId: input.shopifyStoreId,
      type: input.type,
      payload: input.payload,
      status: "PENDING",
      runAt: input.runAt || new Date(),
      maxAttempts: input.maxAttempts || 3,
    },
  });
}

/**
 * Claims the next available pending job for worker processing.
 * Safely marks job status as PROCESSING within a transaction boundary.
 */
export async function claimNextJob() {
  const now = new Date();

  return await prisma.$transaction(async (tx) => {
    const job = await tx.backgroundJob.findFirst({
      where: {
        status: "PENDING",
        runAt: { lte: now },
      },
      orderBy: { createdAt: "asc" },
    });

    if (!job) return null;

    return await tx.backgroundJob.update({
      where: { id: job.id },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
      },
    });
  });
}

/**
 * Marks a background job as successfully completed.
 */
export async function completeJob(id: string) {
  return await prisma.backgroundJob.update({
    where: { id },
    data: {
      status: "COMPLETED",
      updatedAt: new Date(),
    },
  });
}

/**
 * Handles job failure with retry backoff or terminal failure state.
 */
export async function failJob(id: string, error: Error | string) {
  const errorMessage = typeof error === "string" ? error : error.message || String(error);

  const job = await prisma.backgroundJob.findUnique({
    where: { id },
  });

  if (!job) return null;

  const isFinalAttempt = job.attempts >= job.maxAttempts;

  // Calculate exponential backoff delay for retries (e.g. 5s, 20s, 80s)
  const backoffSeconds = Math.pow(4, job.attempts) * 5;
  const nextRunAt = new Date(Date.now() + backoffSeconds * 1000);

  return await prisma.backgroundJob.update({
    where: { id },
    data: {
      status: isFinalAttempt ? "FAILED" : "PENDING",
      lastError: errorMessage,
      runAt: isFinalAttempt ? job.runAt : nextRunAt,
      updatedAt: new Date(),
    },
  });
}

/**
 * Fetches background jobs for a tenant store.
 */
export async function getStoreJobs(shopifyStoreId: string, limit = 50) {
  return await prisma.backgroundJob.findMany({
    where: { shopifyStoreId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
