import React from "react";
import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requireTenantContext } from "../utils/tenant.server";
import prisma from "../db.server";
import { executeInitialShopifySync } from "../services/shopifySync.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { shopifyStoreId, admin } = await requireTenantContext(request);
    
    let store = await prisma.shopifyStore.findUnique({
      where: { id: shopifyStoreId },
      select: {
        shop: true,
        syncStatus: true,
        lastSyncAt: true,
      },
    });

    // Auto-trigger sync if syncStatus is PENDING or lastSyncAt is missing
    if (store && (store.syncStatus === "PENDING" || !store.lastSyncAt) && admin) {
      try {
        await executeInitialShopifySync({ shopifyStoreId, admin });
        store = await prisma.shopifyStore.findUnique({
          where: { id: shopifyStoreId },
          select: {
            shop: true,
            syncStatus: true,
            lastSyncAt: true,
          },
        });
      } catch (syncErr) {
        console.error("[Dashboard Loader] Auto-sync attempt failed:", syncErr);
      }
    }

    // Query real counts from Database
    const [ordersCount, returnsCount, exchangesCount, customerCacheCount, exchangeItems, recentReturnsDb, recentExchangesDb] = await Promise.all([
      prisma.order.count({ where: { shopifyStoreId } }),
      prisma.returnRequest.count({ where: { shopifyStoreId } }),
      prisma.exchangeRequest.count({ where: { shopifyStoreId } }),
      prisma.customerCache.count({ where: { shopifyStoreId } }),
      prisma.exchangeItem.findMany({
        where: { exchangeRequest: { shopifyStoreId } },
        select: { priceDifference: true },
      }),
      prisma.returnRequest.findMany({
        where: { shopifyStoreId },
        take: 5,
        orderBy: { createdAt: "desc" },
      }),
      prisma.exchangeRequest.findMany({
        where: { shopifyStoreId },
        take: 5,
        orderBy: { createdAt: "desc" },
        include: { items: true },
      }),
    ]);

    // Calculate revenue retained from exchanges
    const revenueRetained = exchangeItems.reduce((acc, item) => {
      const val = item.priceDifference ? parseFloat(item.priceDifference.toString()) : 0;
      return acc + (isNaN(val) ? 0 : val);
    }, 0);

    // If customerCacheCount is 0, count unique customer emails from Orders
    let customersCount = customerCacheCount;
    if (customersCount === 0) {
      const distinctCustomers = await prisma.order.findMany({
        where: { shopifyStoreId, customerEmail: { not: null } },
        select: { customerEmail: true },
        distinct: ["customerEmail"],
      });
      customersCount = distinctCustomers.length;
    }

    return {
      shop: store?.shop ?? "Connected Store",
      metrics: {
        ordersCount,
        returnsCount,
        exchangesCount,
        customersCount,
        revenueRetained,
      },
      recentReturns: recentReturnsDb.map((r) => ({
        id: r.id,
        orderNumber: r.orderNumber,
        customerName: r.customerName || r.customerEmail,
        status: r.status,
        date: new Date(r.createdAt).toLocaleDateString(),
      })),
      recentExchanges: recentExchangesDb.map((e) => ({
        id: e.id,
        orderNumber: e.orderNumber,
        customerName: e.customerName || e.customerEmail,
        replacementTitle: e.items?.[0]?.replacementTitle || "Replacement Item",
        status: e.status,
        date: new Date(e.createdAt).toLocaleDateString(),
      })),
    };
  } catch (error) {
    console.error("[Dashboard Loader] Error:", error);
    return {
      shop: "Connected Store",
      metrics: {
        ordersCount: 0,
        returnsCount: 0,
        exchangesCount: 0,
        customersCount: 0,
        revenueRetained: 0,
      },
      recentReturns: [],
      recentExchanges: [],
    };
  }
}

export default function Dashboard() {
  const loaderData = useLoaderData<typeof loader>();

  const shop = loaderData?.shop ?? "Connected Store";
  const metrics = loaderData?.metrics ?? {
    ordersCount: 0,
    returnsCount: 0,
    exchangesCount: 0,
    customersCount: 0,
    revenueRetained: 0,
  };

  const recentReturns = loaderData?.recentReturns ?? [];
  const recentExchanges = loaderData?.recentExchanges ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px", maxWidth: "1240px", margin: "0 auto", padding: "8px 0" }}>
      {/* Header Banner */}
      <div style={{ borderBottom: "1px solid #e2e8f0", paddingBottom: "16px" }}>
        <h1 style={{ fontSize: "24px", fontWeight: "700", color: "#0f172a", margin: 0, fontFamily: "Outfit, sans-serif" }}>
          BYNDCART Dashboard
        </h1>
        <p style={{ margin: "4px 0 0 0", color: "#64748b", fontSize: "14px" }}>
          Real-time metrics for {shop}
        </p>
      </div>

      {/* Business KPI Metric Cards */}
      <div>
        <h2 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a", marginBottom: "14px", fontFamily: "Outfit, sans-serif" }}>
          Store Performance Metrics
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "16px" }}>
          <div style={{ background: "#ffffff", padding: "20px", borderRadius: "16px", border: "1px solid #e2e8f0", boxShadow: "0 4px 6px -1px rgba(0,0,0,0.02)" }}>
            <div style={{ fontSize: "13px", color: "#64748b", fontWeight: 600 }}>Total Store Orders</div>
            <div style={{ fontSize: "28px", fontWeight: 800, color: "#0f172a", margin: "8px 0", fontFamily: "Outfit, sans-serif" }}>
              {metrics.ordersCount}
            </div>
            <div style={{ fontSize: "12px", color: "#10b981", fontWeight: 600 }}>Synced from Shopify</div>
          </div>

          <div style={{ background: "#ffffff", padding: "20px", borderRadius: "16px", border: "1px solid #e2e8f0", boxShadow: "0 4px 6px -1px rgba(0,0,0,0.02)" }}>
            <div style={{ fontSize: "13px", color: "#64748b", fontWeight: 600 }}>Return Requests</div>
            <div style={{ fontSize: "28px", fontWeight: 800, color: "#6366f1", margin: "8px 0", fontFamily: "Outfit, sans-serif" }}>
              {metrics.returnsCount}
            </div>
            <div style={{ fontSize: "12px", color: "#6366f1", fontWeight: 600 }}>Total returns created</div>
          </div>

          <div style={{ background: "#ffffff", padding: "20px", borderRadius: "16px", border: "1px solid #e2e8f0", boxShadow: "0 4px 6px -1px rgba(0,0,0,0.02)" }}>
            <div style={{ fontSize: "13px", color: "#64748b", fontWeight: 600 }}>Exchange Requests</div>
            <div style={{ fontSize: "28px", fontWeight: 800, color: "#10b981", margin: "8px 0", fontFamily: "Outfit, sans-serif" }}>
              {metrics.exchangesCount}
            </div>
            <div style={{ fontSize: "12px", color: "#10b981", fontWeight: 600 }}>Product replacements</div>
          </div>

          <div style={{ background: "#ffffff", padding: "20px", borderRadius: "16px", border: "1px solid #e2e8f0", boxShadow: "0 4px 6px -1px rgba(0,0,0,0.02)" }}>
            <div style={{ fontSize: "13px", color: "#64748b", fontWeight: 600 }}>Registered Customers</div>
            <div style={{ fontSize: "28px", fontWeight: 800, color: "#0f172a", margin: "8px 0", fontFamily: "Outfit, sans-serif" }}>
              {metrics.customersCount}
            </div>
            <div style={{ fontSize: "12px", color: "#64748b", fontWeight: 600 }}>Active store profiles</div>
          </div>

          <div style={{ background: "#ffffff", padding: "20px", borderRadius: "16px", border: "1px solid #e2e8f0", boxShadow: "0 4px 6px -1px rgba(0,0,0,0.02)" }}>
            <div style={{ fontSize: "13px", color: "#64748b", fontWeight: 600 }}>Revenue Retained</div>
            <div style={{ fontSize: "28px", fontWeight: 800, color: "#059669", margin: "8px 0", fontFamily: "Outfit, sans-serif" }}>
              ${metrics.revenueRetained.toFixed(2)}
            </div>
            <div style={{ fontSize: "12px", color: "#059669", fontWeight: 600 }}>Saved via exchanges</div>
          </div>
        </div>
      </div>

      {/* Recent Activity Tables */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(450px, 1fr))", gap: "20px" }}>
        
        {/* Recent Returns Table */}
        <div style={{ background: "#ffffff", padding: "20px", borderRadius: "16px", border: "1px solid #e2e8f0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
            <h3 style={{ fontSize: "16px", fontWeight: 700, margin: 0, fontFamily: "Outfit, sans-serif" }}>Recent Returns</h3>
            <a href="/app/returns" style={{ color: "#6366f1", fontSize: "13px", fontWeight: 600, textDecoration: "none" }}>View All →</a>
          </div>
          {recentReturns.length === 0 ? (
            <p style={{ color: "#64748b", fontSize: "13px", margin: "20px 0", textAlign: "center" }}>No returns recorded yet.</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #e2e8f0", textAlign: "left" }}>
                  <th style={{ padding: "8px 0", fontSize: "11px", color: "#64748b", textTransform: "uppercase" }}>Order</th>
                  <th style={{ padding: "8px 0", fontSize: "11px", color: "#64748b", textTransform: "uppercase" }}>Customer</th>
                  <th style={{ padding: "8px 0", fontSize: "11px", color: "#64748b", textTransform: "uppercase" }}>Status</th>
                  <th style={{ padding: "8px 0", fontSize: "11px", color: "#64748b", textTransform: "uppercase", textAlign: "right" }}>Date</th>
                </tr>
              </thead>
              <tbody>
                {recentReturns.map((r: any) => (
                  <tr key={r.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "10px 0", fontWeight: 600 }}>{r.orderNumber}</td>
                    <td style={{ padding: "10px 0", color: "#475569" }}>{r.customerName}</td>
                    <td style={{ padding: "10px 0" }}>
                      <span style={{
                        fontSize: "11px",
                        fontWeight: "bold",
                        padding: "2px 8px",
                        borderRadius: "12px",
                        backgroundColor: r.status === "PENDING" ? "#fef3c7" : "#dcfce7",
                        color: r.status === "PENDING" ? "#d97706" : "#15803d",
                      }}>
                        {r.status}
                      </span>
                    </td>
                    <td style={{ padding: "10px 0", textAlign: "right", color: "#64748b", fontSize: "12px" }}>{r.date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Recent Exchanges Table */}
        <div style={{ background: "#ffffff", padding: "20px", borderRadius: "16px", border: "1px solid #e2e8f0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
            <h3 style={{ fontSize: "16px", fontWeight: 700, margin: 0, fontFamily: "Outfit, sans-serif" }}>Recent Exchanges</h3>
            <a href="/app/exchanges" style={{ color: "#6366f1", fontSize: "13px", fontWeight: 600, textDecoration: "none" }}>View All →</a>
          </div>
          {recentExchanges.length === 0 ? (
            <p style={{ color: "#64748b", fontSize: "13px", margin: "20px 0", textAlign: "center" }}>No exchanges recorded yet.</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #e2e8f0", textAlign: "left" }}>
                  <th style={{ padding: "8px 0", fontSize: "11px", color: "#64748b", textTransform: "uppercase" }}>Order</th>
                  <th style={{ padding: "8px 0", fontSize: "11px", color: "#64748b", textTransform: "uppercase" }}>Replacement</th>
                  <th style={{ padding: "8px 0", fontSize: "11px", color: "#64748b", textTransform: "uppercase" }}>Status</th>
                  <th style={{ padding: "8px 0", fontSize: "11px", color: "#64748b", textTransform: "uppercase", textAlign: "right" }}>Date</th>
                </tr>
              </thead>
              <tbody>
                {recentExchanges.map((e: any) => (
                  <tr key={e.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "10px 0", fontWeight: 600 }}>{e.orderNumber}</td>
                    <td style={{ padding: "10px 0", color: "#475569" }}>{e.replacementTitle}</td>
                    <td style={{ padding: "10px 0" }}>
                      <span style={{
                        fontSize: "11px",
                        fontWeight: "bold",
                        padding: "2px 8px",
                        borderRadius: "12px",
                        backgroundColor: e.status === "PENDING" ? "#fef3c7" : "#dcfce7",
                        color: e.status === "PENDING" ? "#d97706" : "#15803d",
                      }}>
                        {e.status}
                      </span>
                    </td>
                    <td style={{ padding: "10px 0", textAlign: "right", color: "#64748b", fontSize: "12px" }}>{e.date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

      </div>
    </div>
  );
}


