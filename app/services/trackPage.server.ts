import prisma from "../db.server";
import { syncShipmentTrackingStatus } from "./shipments.server";
import { getCourierOperationsSettings } from "./settings.server";

export interface TrackLookupQuery {
  tracking?: string;
  order?: string;
  phone?: string;
}

/**
 * Looks up shipment tracking record by tracking number or order number
 */
export async function lookupShipmentTracking(shopifyStoreId: string, query: TrackLookupQuery) {
  const cleanTracking = String(query.tracking || "").trim();
  const cleanOrder = String(query.order || "").trim();

  let shipment: any = null;

  if (cleanTracking) {
    shipment = await prisma.shipmentTrack.findFirst({
      where: {
        shopifyStoreId,
        trackingNumber: cleanTracking,
      },
      include: {
        events: {
          orderBy: { timestamp: "desc" },
        },
      },
    });
  } else if (cleanOrder) {
    const formattedOrder = cleanOrder.startsWith("#") ? cleanOrder : `#${cleanOrder}`;
    shipment = await prisma.shipmentTrack.findFirst({
      where: {
        shopifyStoreId,
        OR: [
          { orderNumber: formattedOrder },
          { orderNumber: cleanOrder },
        ],
      },
      include: {
        events: {
          orderBy: { timestamp: "desc" },
        },
      },
    });
  }

  if (shipment && shipment.trackingNumber) {
    // This merchant-level preference applies to all configured courier providers.
    let autoCourierTracking = true;
    try {
      autoCourierTracking = (await getCourierOperationsSettings(shopifyStoreId)).autoCourierTracking;
    } catch (error) {
      console.warn("[TrackPage] Could not read courier tracking preference; preserving existing refresh behavior.", error);
    }
    // Refresh live tracking only when enabled and the saved status is stale.
    const ageMinutes = (Date.now() - new Date(shipment.updatedAt).getTime()) / (1000 * 60);
    if (autoCourierTracking && ageMinutes > 15 && shipment.status !== "DELIVERED" && shipment.status !== "CANCELLED") {
      try {
        await syncShipmentTrackingStatus(shipment.trackingNumber, shopifyStoreId);
        // Reload after sync
        shipment = await prisma.shipmentTrack.findUnique({
          where: { id: shipment.id },
          include: { events: { orderBy: { timestamp: "desc" } } },
        });
      } catch (err) {
        console.warn("[TrackPage] Live tracking refresh error:", err);
      }
    }
  }

  return shipment;
}

/**
 * Returns stepper index (0-4) based on shipment status
 */
export function getTrackingStep(status: string): number {
  const s = String(status || "").toUpperCase();
  if (s === "DELIVERED") return 4;
  if (s === "OUT_FOR_DELIVERY") return 3;
  if (s === "IN_TRANSIT") return 2;
  if (s === "LABEL_CREATED" || s === "BOOKED") return 1;
  return 0; // ORDER_PLACED
}

/**
 * Renders customer-facing branded track order HTML page
 */
export async function renderTrackPageHtml(
  request: Request,
  shopifyStoreId: string,
  brandName: string,
): Promise<Response> {
  const url = new URL(request.url);
  const trackingParam = url.searchParams.get("tracking") || "";
  const orderParam = url.searchParams.get("order") || "";
  const phoneParam = url.searchParams.get("phone") || "";

  const settings = await prisma.storeSettings.findUnique({
    where: { shopifyStoreId },
  }).catch(() => null);

  let shipment: any = null;
  if (trackingParam || orderParam) {
    shipment = await lookupShipmentTracking(shopifyStoreId, {
      tracking: trackingParam,
      order: orderParam,
      phone: phoneParam,
    });
  }

  const step = shipment ? getTrackingStep(shipment.status) : 0;
  const statusLabel = shipment ? shipment.status.replace(/_/g, " ") : "ENTER ORDER";

  const logoHtml = settings?.storeLogoUrl
    ? `<img src="${settings.storeLogoUrl}" alt="${brandName}" style="max-height: 40px; max-width: 180px; object-fit: contain; margin-bottom: 8px;" />`
    : `<h1 style="margin: 0; font-size: 20px; font-weight: 800; color: #111827; letter-spacing: -0.5px;">${brandName}</h1>`;

  const whatsappLink = settings?.whatsappNumber
    ? `<a href="https://wa.me/${settings.whatsappNumber.replace(/[^0-9]/g, "")}" target="_blank" rel="noopener" style="display: inline-flex; align-items: center; gap: 6px; background: #111827; color: #ffffff; padding: 7px 14px; border-radius: 6px; font-size: 12px; font-weight: 600; text-decoration: none;">WhatsApp Support</a>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Track Your Order — ${brandName}</title>
  <style>
    :root {
      --bg: #f9fafb;
      --card-bg: #ffffff;
      --border: #e5e7eb;
      --text: #111827;
      --muted: #6b7280;
      --brand: #111827;
      --success: #166534;
      --success-bg: #dcfce7;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: var(--text);
      display: flex;
      flex-direction: column;
      min-height: 100vh;
      line-height: 1.5;
    }
    .track-shell {
      max-width: 680px;
      margin: 30px auto;
      padding: 0 16px;
      width: 100%;
      flex: 1;
    }
    .track-header {
      text-align: center;
      margin-bottom: 24px;
    }
    .track-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 20px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    .search-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .search-input {
      flex: 1 1 200px;
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 14px;
      color: var(--text);
      outline: none;
    }
    .search-input:focus {
      border-color: var(--brand);
    }
    .search-btn {
      background: var(--brand);
      color: #fff;
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .stepper {
      display: flex;
      justify-content: space-between;
      position: relative;
      margin: 30px 0 20px;
    }
    .stepper::before {
      content: "";
      position: absolute;
      top: 14px;
      left: 10%;
      right: 10%;
      height: 2px;
      background: var(--border);
      z-index: 1;
    }
    .step-node {
      position: relative;
      z-index: 2;
      text-align: center;
      flex: 1;
    }
    .step-circle {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      background: var(--card-bg);
      border: 2px solid var(--border);
      color: var(--muted);
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 8px;
      font-size: 12px;
      font-weight: 700;
    }
    .step-node.active .step-circle {
      border-color: var(--brand);
      background: var(--brand);
      color: #fff;
    }
    .step-node.completed .step-circle {
      border-color: var(--brand);
      background: var(--brand);
      color: #fff;
    }
    .step-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--muted);
    }
    .step-node.active .step-label {
      color: var(--brand);
    }
    .timeline-item {
      display: flex;
      gap: 16px;
      padding: 12px 0;
      border-bottom: 1px solid var(--border);
    }
    .timeline-item:last-child {
      border-bottom: none;
    }
    .timeline-date {
      font-size: 12px;
      color: var(--muted);
      min-width: 80px;
    }
    .timeline-info {
      flex: 1;
      font-size: 13px;
    }
    .track-footer {
      text-align: center;
      font-size: 12px;
      color: var(--muted);
      padding: 20px;
      border-top: 1px solid var(--border);
      margin-top: auto;
    }
  </style>
</head>
<body>
  <div class="track-shell">
    <div class="track-header">
      ${logoHtml}
      <p style="margin: 4px 0 0; color: var(--muted); font-size: 13px;">Live Order & Parcel Tracking</p>
    </div>

    <div class="track-card">
      <form method="get" class="search-row">
        <input class="search-input" name="order" value="${orderParam}" placeholder="Enter Order # (e.g. #1001)" />
        <input class="search-input" name="tracking" value="${trackingParam}" placeholder="Or Courier Tracking (CN) #" />
        <button type="submit" class="search-btn">Track Order</button>
      </form>
    </div>

    ${shipment ? `
    <div class="track-card">
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 14px; margin-bottom: 14px;">
        <div>
          <span style="font-size: 11px; text-transform: uppercase; color: var(--muted); font-weight: 700;">Order ${shipment.orderNumber}</span>
          <h2 style="margin: 2px 0 0; font-size: 18px; font-weight: 800;">Status: ${statusLabel}</h2>
        </div>
        <div style="text-align: right;">
          <span style="font-size: 11px; color: var(--muted);">Courier: <strong>${shipment.courier}</strong></span>
          <div style="font-size: 13px; font-weight: 700; letter-spacing: 0.5px;">CN: ${shipment.trackingNumber}</div>
        </div>
      </div>

      <!-- Stepper -->
      <div class="stepper">
        <div class="step-node ${step >= 0 ? (step === 0 ? "active" : "completed") : ""}">
          <div class="step-circle">1</div>
          <div class="step-label">Placed</div>
        </div>
        <div class="step-node ${step >= 1 ? (step === 1 ? "active" : "completed") : ""}">
          <div class="step-circle">2</div>
          <div class="step-label">Booked</div>
        </div>
        <div class="step-node ${step >= 2 ? (step === 2 ? "active" : "completed") : ""}">
          <div class="step-circle">3</div>
          <div class="step-label">In Transit</div>
        </div>
        <div class="step-node ${step >= 3 ? (step === 3 ? "active" : "completed") : ""}">
          <div class="step-circle">4</div>
          <div class="step-label">Out for Delivery</div>
        </div>
        <div class="step-node ${step >= 4 ? "completed" : ""}">
          <div class="step-circle">5</div>
          <div class="step-label">Delivered</div>
        </div>
      </div>

      ${shipment.destinationCity ? `
      <div style="background: var(--bg); padding: 10px 14px; border-radius: 8px; font-size: 12px; margin: 16px 0; display: flex; justify-content: space-between;">
        <span>Destination: <strong>${shipment.destinationCity}</strong></span>
        <span>COD Amount: <strong>${shipment.codAmount ? `PKR ${Math.round(Number(shipment.codAmount)).toLocaleString("en-PK")}` : "Paid"}</strong></span>
      </div>
      ` : ""}

      <!-- Event Timeline -->
      <h3 style="font-size: 14px; font-weight: 700; margin: 20px 0 10px;">Activity Timeline</h3>
      <div style="border-top: 1px solid var(--border); padding-top: 8px;">
        ${(shipment.events || []).length > 0 ? (shipment.events || []).map((ev: any) => `
          <div class="timeline-item">
            <div class="timeline-date">${new Date(ev.timestamp).toLocaleDateString("en-PK", { month: "short", day: "numeric" })}<br/><span style="font-size: 10px;">${new Date(ev.timestamp).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" })}</span></div>
            <div class="timeline-info">
              <strong>${ev.status.replace(/_/g, " ")}</strong>
              ${ev.description ? `<div style="color: var(--muted); font-size: 12px;">${ev.description}</div>` : ""}
              ${ev.location ? `<div style="font-size: 11px; color: var(--muted);">Location: ${ev.location}</div>` : ""}
            </div>
          </div>
        `).join("") : `
          <div style="padding: 12px 0; color: var(--muted); font-size: 12px;">Shipment label created. Parcel awaiting courier pickup.</div>
        `}
      </div>
    </div>
    ` : (trackingParam || orderParam ? `
    <div class="track-card" style="text-align: center; padding: 30px;">
      <h3 style="margin: 0 0 6px; font-size: 16px;">Order or tracking number not found</h3>
      <p style="margin: 0; color: var(--muted); font-size: 13px;">Please double-check the order number (#1001) or tracking number and try again.</p>
    </div>
    ` : "")}

    <div style="text-align: center; margin-top: 16px;">
      ${whatsappLink}
    </div>
  </div>

  <footer class="track-footer">
    <div>Powered by BYNDCART Logistics</div>
  </footer>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-cache",
    },
  });
}
