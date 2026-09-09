import prisma from "../db.server";
import { getCustomerRiskFlag, CustomerRiskFlag } from "./fraud.server";

export interface CustomerMetrics {
  id: string;
  name: string;
  email: string;
  ordersCount: number;
  returnsCount: number;
  exchangesCount: number;
  refundsCount: number;
  totalRefundedPKR: number;
  returnRate: string;
  riskFlag: CustomerRiskFlag;
  recentOrders: Array<{ id: string; orderNumber: string; totalPrice: number; createdAt: Date }>;
  recentReturns: Array<{ id: string; orderNumber: string; status: string; createdAt: Date }>;
}

/**
 * Queries a list of customers for a store, compiled from Orders, Return Requests, and Exchange Requests.
 */
export async function getStoreCustomers(shopifyStoreId: string, search?: string): Promise<CustomerMetrics[]> {
  const [orders, returns, exchanges] = await Promise.all([
    prisma.order.findMany({
      where: { shopifyStoreId },
      orderBy: { shopifyCreatedAt: "desc" },
    }),
    prisma.returnRequest.findMany({
      where: { shopifyStoreId },
      orderBy: { createdAt: "desc" },
    }),
    prisma.exchangeRequest.findMany({
      where: { shopifyStoreId },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  // Aggregate stats by customer email
  const customerMap = new Map<string, {
    name: string;
    email: string;
    orders: typeof orders;
    returns: typeof returns;
    exchanges: typeof exchanges;
  }>();

  for (const order of orders) {
    if (!order.customerEmail) continue;
    const email = order.customerEmail.toLowerCase().trim();
    if (!customerMap.has(email)) {
      customerMap.set(email, {
        name: order.customerName || email.split("@")[0],
        email,
        orders: [],
        returns: [],
        exchanges: [],
      });
    }
    customerMap.get(email)!.orders.push(order);
  }

  for (const ret of returns) {
    if (!ret.customerEmail) continue;
    const email = ret.customerEmail.toLowerCase().trim();
    if (!customerMap.has(email)) {
      customerMap.set(email, {
        name: ret.customerName || email.split("@")[0],
        email,
        orders: [],
        returns: [],
        exchanges: [],
      });
    }
    customerMap.get(email)!.returns.push(ret);
  }

  for (const ex of exchanges) {
    if (!ex.customerEmail) continue;
    const email = ex.customerEmail.toLowerCase().trim();
    if (!customerMap.has(email)) {
      customerMap.set(email, {
        name: ex.customerName || email.split("@")[0],
        email,
        orders: [],
        returns: [],
        exchanges: [],
      });
    }
    customerMap.get(email)!.exchanges.push(ex);
  }

  const result: CustomerMetrics[] = [];

  for (const [email, data] of customerMap.entries()) {
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      if (!data.name.toLowerCase().includes(q) && !email.toLowerCase().includes(q)) {
        continue;
      }
    }

    const ordersCount = data.orders.length;
    const returnsCount = data.returns.length;
    const exchangesCount = data.exchanges.length;

    let totalRefundedPKR = 0;
    for (const r of data.returns) {
      if (r.refundAmount) {
        totalRefundedPKR += Number(r.refundAmount);
      }
    }

    const totalActivity = ordersCount > 0 ? ordersCount : returnsCount + exchangesCount;
    const returnRatePercent = totalActivity > 0 ? ((returnsCount + exchangesCount) / totalActivity) * 100 : 0;

    const riskFlag = await getCustomerRiskFlag(shopifyStoreId, email);

    result.push({
      id: `cust-${Buffer.from(email).toString("hex").slice(0, 8)}`,
      name: data.name,
      email,
      ordersCount,
      returnsCount,
      exchangesCount,
      refundsCount: returnsCount,
      totalRefundedPKR,
      returnRate: `${returnRatePercent.toFixed(1)}%`,
      riskFlag,
      recentOrders: data.orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        totalPrice: Number(o.totalPrice),
        createdAt: o.shopifyCreatedAt,
      })),
      recentReturns: data.returns.map((r) => ({
        id: r.id,
        orderNumber: r.orderNumber,
        status: r.status,
        createdAt: r.createdAt,
      })),
    });
  }

  return result;
}
