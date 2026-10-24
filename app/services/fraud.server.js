import prisma from "../db.server";
import { getSettings } from "./settings.server";

/**
 * Checks a customer's return + exchange history against the store's
 * configured fraud thresholds and returns a flag with human-readable reasons.
 */
export async function getCustomerRiskFlag(shopifyStoreId, customerEmail) {
  const settings = await getSettings(shopifyStoreId);
  const windowStart = new Date();

  windowStart.setDate(windowStart.getDate() - settings.fraudFlagWindowDays);
  const [lifetimeReturns, lifetimeExchanges, windowReturns, windowExchanges] =
    await Promise.all([
      prisma.returnRequest.count({ where: { shopifyStoreId, customerEmail } }),
      prisma.exchangeRequest.count({
        where: { shopifyStoreId, customerEmail },
      }),
      prisma.returnRequest.count({
        where: {
          shopifyStoreId,
          customerEmail,
          createdAt: { gte: windowStart },
        },
      }),
      prisma.exchangeRequest.count({
        where: {
          shopifyStoreId,
          customerEmail,
          createdAt: { gte: windowStart },
        },
      }),
    ]);
  const lifetimeCount = lifetimeReturns + lifetimeExchanges;
  const windowCount = windowReturns + windowExchanges;
  const reasons = [];

  if (lifetimeCount >= settings.fraudFlagReturnCount) {
    reasons.push(
      `${lifetimeCount} lifetime returns/exchanges (threshold: ${settings.fraudFlagReturnCount})`,
    );
  }

  if (windowCount >= settings.fraudFlagWindowCount) {
    reasons.push(
      `${windowCount} returns/exchanges in the last ${settings.fraudFlagWindowDays} days (threshold: ${settings.fraudFlagWindowCount})`,
    );
  }

  return {
    flagged: reasons.length > 0,
    reasons,
    lifetimeCount,
    windowCount,
  };
}

/**
 * Batch version: given a list of customer emails (e.g. all emails on the
 * current page of a Returns/Exchanges table), returns a Map of email -> flag.
 * Avoids N+1 queries when rendering a table.
 */
export async function getCustomerRiskFlagsForEmails(shopifyStoreId, emails) {
  const uniqueEmails = [...new Set(emails)];
  const settings = await getSettings(shopifyStoreId);
  const windowStart = new Date();

  windowStart.setDate(windowStart.getDate() - settings.fraudFlagWindowDays);
  const [returnsByEmail, exchangesByEmail, returnsInWindow, exchangesInWindow] =
    await Promise.all([
      prisma.returnRequest.groupBy({
        by: ["customerEmail"],
        where: { shopifyStoreId, customerEmail: { in: uniqueEmails } },
        _count: { _all: true },
      }),
      prisma.exchangeRequest.groupBy({
        by: ["customerEmail"],
        where: { shopifyStoreId, customerEmail: { in: uniqueEmails } },
        _count: { _all: true },
      }),
      prisma.returnRequest.groupBy({
        by: ["customerEmail"],
        where: {
          shopifyStoreId,
          customerEmail: { in: uniqueEmails },
          createdAt: { gte: windowStart },
        },
        _count: { _all: true },
      }),
      prisma.exchangeRequest.groupBy({
        by: ["customerEmail"],
        where: {
          shopifyStoreId,
          customerEmail: { in: uniqueEmails },
          createdAt: { gte: windowStart },
        },
        _count: { _all: true },
      }),
    ]);
  const lifetimeMap = new Map();

  for (const r of returnsByEmail) {
    lifetimeMap.set(
      r.customerEmail,
      (lifetimeMap.get(r.customerEmail) ?? 0) + r._count._all,
    );
  }

  for (const e of exchangesByEmail) {
    lifetimeMap.set(
      e.customerEmail,
      (lifetimeMap.get(e.customerEmail) ?? 0) + e._count._all,
    );
  }

  const windowMap = new Map();

  for (const r of returnsInWindow) {
    windowMap.set(
      r.customerEmail,
      (windowMap.get(r.customerEmail) ?? 0) + r._count._all,
    );
  }

  for (const e of exchangesInWindow) {
    windowMap.set(
      e.customerEmail,
      (windowMap.get(e.customerEmail) ?? 0) + e._count._all,
    );
  }

  const result = new Map();

  for (const email of uniqueEmails) {
    const lifetimeCount = lifetimeMap.get(email) ?? 0;
    const windowCount = windowMap.get(email) ?? 0;
    const reasons = [];

    if (lifetimeCount >= settings.fraudFlagReturnCount) {
      reasons.push(
        `${lifetimeCount} lifetime returns/exchanges (threshold: ${settings.fraudFlagReturnCount})`,
      );
    }

    if (windowCount >= settings.fraudFlagWindowCount) {
      reasons.push(
        `${windowCount} in the last ${settings.fraudFlagWindowDays} days (threshold: ${settings.fraudFlagWindowCount})`,
      );
    }

    result.set(email, {
      flagged: reasons.length > 0,
      reasons,
      lifetimeCount,
      windowCount,
    });
  }

  return result;
}
