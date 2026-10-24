import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import prisma from "../db.server";
import { requireTenantContext } from "../services/tenant.server";
import { generateCode128Svg } from "../utils/barcode";
import { normalizeCourierOperationsSettings } from "../services/settings.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { shopifyStoreId } = await requireTenantContext(request);
  const url = new URL(request.url);

  const idsParam = url.searchParams.get("ids");
  const trackingParam = url.searchParams.get("trackingNumber");

  let shipments: any[] = [];
  if (idsParam) {
    const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
    shipments = await prisma.shipmentTrack.findMany({
      where: {
        shopifyStoreId,
        id: { in: ids },
      },
      include: {
        shopifyStore: {
          select: {
            shop: true,
            storeSettings: true,
          },
        },
      },
    });
  } else if (trackingParam) {
    shipments = await prisma.shipmentTrack.findMany({
      where: {
        shopifyStoreId,
        trackingNumber: trackingParam.trim(),
      },
      include: {
        shopifyStore: {
          select: {
            shop: true,
            storeSettings: true,
          },
        },
      },
    });
  }

  // Read one merchant-level label/profile configuration, shared by every courier.
  const labels = shipments.map((s) => {
    const barcodeSvg = generateCode128Svg(s.trackingNumber, 55, 2);
    const storeSettings = s.shopifyStore?.storeSettings || {};
    const operations = normalizeCourierOperationsSettings(storeSettings.courierOperationsSettings);
    const selectedProfileIndex = Number.isInteger(s.shipperProfileIndex)
      && Number(s.shipperProfileIndex) >= 0
      && Number(s.shipperProfileIndex) < operations.shipperProfiles.length
      ? Number(s.shipperProfileIndex)
      : operations.defaultShipperProfileIndex;
    const shipper = operations.shipperProfiles[selectedProfileIndex] || operations.shipperProfiles[0];
    const storeDomain = s.shopifyStore?.shop?.replace(".myshopify.com", "") || "";
    const storeName = shipper?.name || (storeSettings.storeLogoUrl ? "Store" : storeDomain.toUpperCase() || "STORE");
    return {
      id: s.id,
      orderNumber: s.orderNumber,
      trackingNumber: s.trackingNumber,
      courier: s.courier,
      destinationCity: s.destinationCity || "—",
      codAmount: Number(s.codAmount || 0),
      createdAt: new Date(s.createdAt).toLocaleDateString("en-PK", {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
      storeName,
      storeLogoUrl: operations.labelLogoUrl || storeSettings.storeLogoUrl || null,
      supportPhone: shipper?.phone || storeSettings.whatsappNumber || storeSettings.supportEmail || "Support",
      returnAddress: shipper?.address || storeSettings.returnAddress || "Merchant Warehouse",
      shipperCity: shipper?.city || "",
      labelWebsite: operations.labelWebsite || storeDomain,
      labelSize: operations.labelSize,
      barcodeSvg,
    };
  });

  return { labels };
}

export default function AwbPrintPage() {
  const { labels } = useLoaderData<typeof loader>();

  return (
    <div style={{ background: "#f3f4f6", minHeight: "100vh", padding: "20px" }}>
      {/* Print Controls (Hidden when printing) */}
      <div className="no-print" style={{ maxWidth: "800px", margin: "0 auto 20px", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#fff", padding: "14px 20px", borderRadius: "8px", border: "1px solid #e5e7eb" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 700 }}>Airway Bills ({labels.length} Label{labels.length === 1 ? "" : "s"})</h2>
          <p style={{ margin: 0, fontSize: "12px", color: "#6b7280" }}>Print format: {labels[0]?.labelSize === "A4_3" ? "A4 — 3 labels per page" : labels[0]?.labelSize === "A4_4" ? "A4 — 4 labels per page" : "Thermal — 4 × 6 inches"}. Change this in Settings → Label settings.</p>
        </div>
        <div style={{ display: "flex", gap: "10px" }}>
          <button
            type="button"
            onClick={() => window.print()}
            style={{ background: "#111827", color: "#fff", border: "none", padding: "8px 18px", borderRadius: "6px", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}
          >
            Print Labels
          </button>
          <button
            type="button"
            onClick={() => window.close()}
            style={{ background: "#fff", color: "#374151", border: "1px solid #d1d5db", padding: "8px 14px", borderRadius: "6px", fontSize: "13px", cursor: "pointer" }}
          >
            Close
          </button>
        </div>
      </div>

      {labels.length === 0 && (
        <div className="no-print" style={{ maxWidth: "600px", margin: "40px auto", textAlign: "center", background: "#fff", padding: "30px", borderRadius: "8px" }}>
          <p style={{ color: "#6b7280" }}>No shipments found to print. Select booked shipments from the Bookings panel first.</p>
        </div>
      )}

      {/* Printable Labels Container */}
      <div className={`awb-container awb-container--${(labels[0]?.labelSize || "THERMAL_4X6").toLowerCase()}`} style={{ maxWidth: labels[0]?.labelSize === "A4_3" ? "8.1in" : "4in", margin: "0 auto" }}>
        {labels.map((item) => (
          <div key={item.id} className={`awb-card awb-card--${item.labelSize.toLowerCase()}`} style={{ width: item.labelSize === "A4_3" ? "7.8in" : "3.85in", minHeight: item.labelSize === "A4_3" ? "3.55in" : "5.8in", margin: "0 auto 12px", background: "#fff", border: "2px solid #000", padding: item.labelSize === "A4_3" ? "7px" : "12px", boxSizing: "border-box", fontFamily: "sans-serif", fontSize: item.labelSize === "A4_3" ? "9px" : "11px", color: "#000", position: "relative", pageBreakInside: "avoid" }}>
            
            {/* Header: Courier & Store */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "2px solid #000", paddingBottom: "8px" }}>
              <div>
                <span style={{ fontSize: "18px", fontWeight: 900, letterSpacing: "1px" }}>{item.courier}</span>
                <span style={{ display: "block", fontSize: "9px", fontWeight: 600, textTransform: "uppercase" }}>Overnight COD Express</span>
              </div>
              <div style={{ textAlign: "right" }}>
                {item.storeLogoUrl ? (
                  <img src={item.storeLogoUrl} alt="Store Logo" style={{ maxHeight: "30px", maxWidth: "120px", objectFit: "contain" }} />
                ) : (
                  <strong style={{ fontSize: "14px" }}>{item.storeName}</strong>
                )}
                <div style={{ fontSize: "9px", color: "#444" }}>Date: {item.createdAt}</div>
                {item.labelWebsite && <div style={{ fontSize: "8px", color: "#444", maxWidth: "150px", overflowWrap: "anywhere" }}>{item.labelWebsite}</div>}
              </div>
            </div>

            {/* Tracking Barcode */}
            <div style={{ textAlign: "center", padding: "10px 0 6px", borderBottom: "1.5px solid #000" }}>
              <div style={{ display: "inline-block", maxWidth: "100%", overflow: "hidden" }} dangerouslySetInnerHTML={{ __html: item.barcodeSvg }} />
              <div style={{ fontSize: "14px", fontWeight: 900, letterSpacing: "2px", marginTop: "4px" }}>
                {item.trackingNumber}
              </div>
            </div>

            {/* Destination & Order Number Strip */}
            <div style={{ display: "flex", borderBottom: "1.5px solid #000", background: "#fafafa" }}>
              <div style={{ flex: 1, padding: "8px", borderRight: "1.5px solid #000" }}>
                <span style={{ fontSize: "9px", textTransform: "uppercase", color: "#555", display: "block" }}>Order Number</span>
                <strong style={{ fontSize: "15px" }}>{item.orderNumber}</strong>
              </div>
              <div style={{ flex: 1, padding: "8px", textAlign: "right" }}>
                <span style={{ fontSize: "9px", textTransform: "uppercase", color: "#555", display: "block" }}>Destination City</span>
                <strong style={{ fontSize: "16px", textTransform: "uppercase" }}>{item.destinationCity}</strong>
              </div>
            </div>

            {/* Prominent COD Amount Box */}
            <div style={{ border: "2px solid #000", margin: "10px 0", padding: "8px", textAlign: "center", background: "#f8f8f8" }}>
              <span style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase" }}>Cash On Delivery (C.O.D) Amount</span>
              <div style={{ fontSize: "22px", fontWeight: 900 }}>
                {item.codAmount > 0 ? `PKR ${item.codAmount.toLocaleString("en-PK")}` : "PAID (NO CASH)"}
              </div>
            </div>

            {/* Shipper & Consignee Addresses */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", borderBottom: "1.5px solid #000", paddingBottom: "8px", fontSize: "10px" }}>
              <div>
                <strong style={{ textTransform: "uppercase", fontSize: "9px", borderBottom: "1px solid #ccc", display: "block", marginBottom: "3px" }}>Shipper / Return To:</strong>
                <div>{item.storeName}</div>
                <div style={{ color: "#333", fontSize: "9px" }}>{item.returnAddress}</div>
                {item.shipperCity && <div>{item.shipperCity}</div>}
                <div style={{ marginTop: "3px" }}>Contact: {item.supportPhone}</div>
              </div>
              <div>
                <strong style={{ textTransform: "uppercase", fontSize: "9px", borderBottom: "1px solid #ccc", display: "block", marginBottom: "3px" }}>Consignee / Deliver To:</strong>
                <div style={{ fontWeight: 700 }}>Customer Order: {item.orderNumber}</div>
                <div style={{ textTransform: "uppercase", fontWeight: 600 }}>{item.destinationCity}</div>
                <div style={{ fontSize: "9px", color: "#444", marginTop: "3px" }}>Please verify flyer seal before delivery.</div>
              </div>
            </div>

            {/* Footer / Instructions */}
            <div style={{ paddingTop: "8px", fontSize: "8px", color: "#555", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Do not deliver if flyer seal is tampered.</span>
              <span>{item.labelWebsite || "BYNDCART Logistics"}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Print CSS Rules */}
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          body {
            background: #fff !important;
            margin: 0 !important;
            padding: 0 !important;
          }
          .no-print {
            display: none !important;
          }
          .awb-container {
            max-width: 100% !important;
            margin: 0 !important;
          }
          .awb-card {
            margin: 0 auto !important;
            page-break-after: auto !important;
            page-break-inside: avoid !important;
            border: 2px solid #000 !important;
          }
          .awb-card--a4_3 {
            width: 7.8in !important;
            height: 3.55in !important;
            min-height: 3.55in !important;
            max-height: 3.55in !important;
            margin-bottom: 0.08in !important;
          }
          .awb-card--a4_4 {
            width: 3.85in !important;
            height: 5.55in !important;
            min-height: 5.55in !important;
            max-height: 5.55in !important;
            margin-bottom: 0 !important;
          }
          .awb-container--a4_3 {
            display: flex !important;
            flex-direction: column !important;
            gap: 0.08in !important;
            max-width: 8.1in !important;
          }
          .awb-container--a4_4 {
            display: grid !important;
            grid-template-columns: repeat(2, 3.85in) !important;
            grid-auto-rows: 5.55in !important;
            gap: 0.1in !important;
            max-width: 8.1in !important;
          }
          .awb-card--thermal_4x6 {
            page-break-after: always !important;
            width: 3.85in !important;
            min-height: 5.8in !important;
          }
          @page {
            size: ${labels[0]?.labelSize === "THERMAL_4X6" ? "4in 6in" : "A4 portrait"};
            margin: 0.1in;
          }
        }
      ` }} />
    </div>
  );
}
