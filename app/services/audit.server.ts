import prisma from "../db.server";

export interface LogActionInput {
  shopifyStoreId: string;
  userId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: any;
}

export async function logAction(input: LogActionInput) {
  try {
    return await prisma.auditLog.create({
      data: {
        shopifyStoreId: input.shopifyStoreId,
        userId: input.userId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: input.metadata ? JSON.parse(JSON.stringify(input.metadata)) : undefined,
      },
    });
  } catch (error) {
    // Graceful error handling for audit logging so it never blocks primary user actions
    console.error("[logAction] Failed to write audit log:", error);
    return null;
  }
}

export async function getAuditLogs(shopifyStoreId: string, limit = 50) {
  return await prisma.auditLog.findMany({
    where: { shopifyStoreId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      user: {
        select: {
          name: true,
          email: true,
        },
      },
    },
  });
}
