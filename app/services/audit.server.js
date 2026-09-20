import prisma from "../db.server";

export async function logAction(input) {
  try {
    return await prisma.auditLog.create({
      data: {
        shopifyStoreId: input.shopifyStoreId,
        userId: input.userId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: input.metadata
          ? JSON.parse(JSON.stringify(input.metadata))
          : undefined,
      },
    });
  } catch (error) {
    // Graceful error handling for audit logging so it never blocks primary user actions
    console.error("[logAction] Failed to write audit log:", error);

    return null;
  }
}

export async function getAuditLogs(shopifyStoreId, limit = 50) {
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
