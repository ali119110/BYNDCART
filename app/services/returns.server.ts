import prisma from "../db.server";
import { notifyStatusChange } from "./notifications.server";

export interface CreateReturnRequestInput {
  shopifyStoreId: string;
  shopifyOrderId: string;
  orderNumber: string;
  customerEmail: string;
  customerName?: string;
  reason?: string;
  customerNote?: string;
  items: Array<{
    shopifyLineItemId: string;
    quantity: number;
    reason: string;
    reasonNote?: string;
  }>;
}

export async function createReturnRequest(input: CreateReturnRequestInput) {
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
        metadata: { orderNumber: input.orderNumber, itemCount: input.items.length },
      },
    });

    return await tx.returnRequest.findUnique({
      where: { id: returnRequest.id },
      include: { items: true },
    });
  });
}

export async function getReturnRequests(shopifyStoreId: string) {
  return await prisma.returnRequest.findMany({
    where: { shopifyStoreId },
    include: { items: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function getReturnRequestById(id: string, shopifyStoreId: string) {
  return await prisma.returnRequest.findFirst({
    where: { id, shopifyStoreId },
    include: { items: true },
  });
}

import { transitionReturnStatus, ReturnStatus } from "./stateMachine.server";

export async function updateReturnRequestStatus(
  id: string,
  shopifyStoreId: string,
  status: "PENDING" | "APPROVED" | "REJECTED" | "COMPLETED" | "CANCELLED",
  adminNote?: string,
  userId?: string
) {
  return await transitionReturnStatus({
    id,
    shopifyStoreId,
    targetStatus: status as ReturnStatus,
    adminNote,
    userId,
  });
}

