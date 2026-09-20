import prisma from "../db.server";

export async function createReturnRequest(input) {
  return await prisma.$transaction(async (tx) => {
    // 1. Create the return request parent
    const returnRequest = await tx.returnRequest.create({
      data: {
        shopifyStoreId: input.shopifyStoreId,
        shopifyOrderId: input.shopifyOrderId,
        orderNumber: input.orderNumber,
        customerEmail: input.customerEmail,
        customerName: input.customerName,
        reason: input.reason,
        customerNote: input.customerNote,
        adminNote: input.adminNote,
        refundAmount:
          input.refundAmount !== undefined ? input.refundAmount : null,
        status: "PENDING",
      },
    });

    // 2. Create individual return items
    if (input.items && input.items.length > 0) {
      await tx.returnItem.createMany({
        data: input.items.map((item) => ({
          returnRequestId: returnRequest.id,
          shopifyLineItemId: item.shopifyLineItemId,
          quantity: item.quantity,
          reason: item.reason,
          reasonNote: item.reasonNote,
          status: "PENDING",
        })),
      });
    }

    // 3. Write audit log
    await tx.auditLog.create({
      data: {
        shopifyStoreId: input.shopifyStoreId,
        action: "RETURN_CREATED",
        entityType: "ReturnRequest",
        entityId: returnRequest.id,
        metadata: {
          orderNumber: input.orderNumber,
          itemCount: input.items.length,
        },
      },
    });

    return await tx.returnRequest.findUnique({
      where: { id: returnRequest.id },
      include: { items: true },
    });
  });
}

export async function getReturnRequests(shopifyStoreId) {
  return await prisma.returnRequest.findMany({
    where: { shopifyStoreId },
    include: { items: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function getReturnRequestById(id, shopifyStoreId) {
  return await prisma.returnRequest.findFirst({
    where: { id, shopifyStoreId },
    include: { items: true },
  });
}

import { transitionReturnStatus } from "./stateMachine.server";

export async function updateReturnRequestStatus(
  id,
  shopifyStoreId,
  status,
  adminNote,
  userId,
) {
  return await transitionReturnStatus({
    id,
    shopifyStoreId,
    targetStatus: status,
    adminNote,
    userId,
  });
}
