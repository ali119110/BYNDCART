import prisma from "../db.server";

export interface CachedCustomer {
  shopifyCustomerId: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  ordersCount?: number;
  totalSpent?: number;
}

export async function upsertCustomerCache(shopifyStoreId: string, customer: CachedCustomer) {
  const ordersCount = customer.ordersCount ?? 0;
  const totalSpent = customer.totalSpent ?? 0;

  return await prisma.customerCache.upsert({
    where: { shopifyCustomerId: customer.shopifyCustomerId },
    update: {
      firstName: customer.firstName ?? null,
      lastName: customer.lastName ?? null,
      email: customer.email ?? null,
      phone: customer.phone ?? null,
      ordersCount,
      totalSpent,
      fetchedAt: new Date(),
    },
    create: {
      shopifyStoreId,
      shopifyCustomerId: customer.shopifyCustomerId,
      firstName: customer.firstName ?? null,
      lastName: customer.lastName ?? null,
      email: customer.email ?? null,
      phone: customer.phone ?? null,
      ordersCount,
      totalSpent,
    },
  });
}

export async function deleteCustomerFromWebhook(shopifyStoreId: string, payload: any) {
  const shopifyCustomerId = payload.id
    ? String(payload.id).startsWith("gid://")
      ? payload.id
      : `gid://shopify/Customer/${payload.id}`
    : null;

  if (!shopifyCustomerId) return;

  try {
    await prisma.customerCache.delete({
      where: { shopifyCustomerId },
    });
  } catch (e) {
    // Record might not exist in cache
  }
}

export async function upsertCustomerFromWebhook(shopifyStoreId: string, payload: any) {
  const rawId = payload.id;
  if (!rawId) return;

  const shopifyCustomerId = String(rawId).startsWith("gid://")
    ? String(rawId)
    : `gid://shopify/Customer/${rawId}`;

  const firstName = payload.first_name ?? payload.firstName ?? null;
  const lastName = payload.last_name ?? payload.lastName ?? null;
  const email = payload.email ?? null;
  const phone = payload.phone ?? null;
  const ordersCount = payload.orders_count ?? payload.ordersCount ?? 0;
  const totalSpent = parseFloat(payload.total_spent ?? payload.totalSpent ?? "0");

  return await upsertCustomerCache(shopifyStoreId, {
    shopifyCustomerId,
    firstName,
    lastName,
    email,
    phone,
    ordersCount,
    totalSpent,
  });
}

export async function syncShopifyCustomers(shopifyStoreId: string, admin: any) {
  if (!admin) return { success: true, count: 0 };

  let synchronizedCount = 0;
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response: any = await admin.graphql(
      `#graphql
      query getCustomers($cursor: String) {
        customers(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              firstName
              lastName
              email
              phone
              numberOfOrders
              amountSpent { amount }
            }
          }
        }
      }`,
      { variables: { cursor } }
    );

    const { data }: any = await response.json();
    const edges = data?.customers?.edges ?? [];

    for (const edge of edges) {
      const node = edge.node;
      await upsertCustomerCache(shopifyStoreId, {
        shopifyCustomerId: node.id,
        firstName: node.firstName,
        lastName: node.lastName,
        email: node.email,
        phone: node.phone,
        ordersCount: parseInt(node.numberOfOrders ?? "0", 10),
        totalSpent: parseFloat(node.amountSpent?.amount ?? "0"),
      });
      synchronizedCount++;
    }

    hasNextPage = data?.customers?.pageInfo?.hasNextPage ?? false;
    cursor = data?.customers?.pageInfo?.endCursor ?? null;

    if (synchronizedCount >= 500) break;
  }

  return { success: true, count: synchronizedCount };
}

export interface CustomerMetrics {
  id: string;
  name: string;
  email: string;
  ordersCount: number;
  returnsCount: number;
  exchangesCount: number;
  totalRefundedPKR: number;
  returnRate: string;
  riskFlag: {
    flagged: boolean;
    reasons: string[];
  };
  recentReturns: Array<{
    id: string;
    orderNumber: string;
    status: string;
  }>;
}

export async function getStoreCustomers(shopifyStoreId: string, search = ""): Promise<CustomerMetrics[]> {
  const cached = await prisma.customerCache.findMany({
    where: { shopifyStoreId },
    orderBy: { fetchedAt: "desc" },
  });

  const returns = await prisma.returnRequest.findMany({
    where: { shopifyStoreId },
    select: { id: true, customerEmail: true, orderNumber: true, status: true, refundAmount: true },
  });

  const exchanges = await prisma.exchangeRequest.findMany({
    where: { shopifyStoreId },
    select: { id: true, customerEmail: true, orderNumber: true, status: true },
  });

  const customerMap = new Map<string, CustomerMetrics>();

  if (cached.length > 0) {
    for (const c of cached) {
      const email = c.email || "";
      const name = `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || email || "Unknown Customer";

      const customerReturns = returns.filter((r) => r.customerEmail === email);
      const customerExchanges = exchanges.filter((e) => e.customerEmail === email);
      const totalRefunded = customerReturns.reduce((acc, r) => {
        const val = r.refundAmount ? parseFloat(r.refundAmount.toString()) : 0;
        return acc + (isNaN(val) ? 0 : val);
      }, 0);

      const retCount = customerReturns.length;
      const ordersCount = c.ordersCount || 1;
      const rateVal = ((retCount / Math.max(ordersCount, 1)) * 100).toFixed(1);

      const reasons: string[] = [];
      if (retCount >= 3) reasons.push(`High return count: ${retCount} returns on file`);
      if (parseFloat(rateVal) > 30) reasons.push(`Excessive return rate: ${rateVal}%`);

      customerMap.set(c.id, {
        id: c.id,
        name,
        email,
        ordersCount: c.ordersCount,
        returnsCount: retCount,
        exchangesCount: customerExchanges.length,
        totalRefundedPKR: totalRefunded,
        returnRate: `${rateVal}%`,
        riskFlag: {
          flagged: reasons.length > 0,
          reasons,
        },
        recentReturns: customerReturns.slice(0, 5).map((r) => ({
          id: r.id,
          orderNumber: r.orderNumber,
          status: r.status,
        })),
      });
    }
  } else {
    // Fallback: Aggregate customer profiles directly from Order records if CustomerCache has not synced yet
    const orders = await prisma.order.findMany({
      where: { shopifyStoreId },
      select: { customerEmail: true, customerName: true },
    });

    const emailOrderCounts = new Map<string, { name: string; count: number }>();
    for (const o of orders) {
      if (!o.customerEmail) continue;
      const existing = emailOrderCounts.get(o.customerEmail);
      if (existing) {
        existing.count += 1;
      } else {
        emailOrderCounts.set(o.customerEmail, {
          name: o.customerName || o.customerEmail,
          count: 1,
        });
      }
    }

    for (const [email, info] of emailOrderCounts.entries()) {
      const customerReturns = returns.filter((r) => r.customerEmail === email);
      const customerExchanges = exchanges.filter((e) => e.customerEmail === email);
      const totalRefunded = customerReturns.reduce((acc, r) => {
        const val = r.refundAmount ? parseFloat(r.refundAmount.toString()) : 0;
        return acc + (isNaN(val) ? 0 : val);
      }, 0);

      const retCount = customerReturns.length;
      const rateVal = ((retCount / Math.max(info.count, 1)) * 100).toFixed(1);

      const reasons: string[] = [];
      if (retCount >= 3) reasons.push(`High return count: ${retCount} returns on file`);
      if (parseFloat(rateVal) > 30) reasons.push(`Excessive return rate: ${rateVal}%`);

      customerMap.set(email, {
        id: email,
        name: info.name,
        email,
        ordersCount: info.count,
        returnsCount: retCount,
        exchangesCount: customerExchanges.length,
        totalRefundedPKR: totalRefunded,
        returnRate: `${rateVal}%`,
        riskFlag: {
          flagged: reasons.length > 0,
          reasons,
        },
        recentReturns: customerReturns.slice(0, 5).map((r) => ({
          id: r.id,
          orderNumber: r.orderNumber,
          status: r.status,
        })),
      });
    }
  }

  const result = Array.from(customerMap.values());
  if (!search) return result;

  const q = search.toLowerCase();
  return result.filter((c) => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q));
}
