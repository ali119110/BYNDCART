import {
  authenticateShopperOrder,
  lookupShopperOrder,
  submitCustomerTracking,
  submitShopperReturn,
} from "./portal.server";
import { getSettings } from "./settings.server";

/** Render the shared customer portal after the caller resolves the merchant from a trusted source. */
export async function renderCustomerPortalPage(request, options) {
  const form = request.method === "POST" ? await request.formData() : null;
  const intent = String(form?.get("intent") || "");
  let notice = "";
  let error = "";
  const storeId = options.shopifyStoreId;
  let sessionToken = "";
  let lastLookup = null;

  try {
    if (intent === "LOGIN" && form) {
      const orderNumber = String(form.get("orderNumber") || "");
      const identifierType =
        String(form.get("identifierType") || "EMAIL").toUpperCase() === "PHONE"
          ? "PHONE"
          : "EMAIL";
      const identifier = String(form.get("identifier") || "");
      const authenticated = await authenticateShopperOrder(storeId, {
        orderNumber,
        identifierType,
        identifier,
      });

      sessionToken = authenticated.sessionToken;
      lastLookup = await lookupShopperOrder(storeId, sessionToken);
      notice = "You are logged in. Your order history is below.";
    } else if (intent === "OPEN_ORDER" && form) {
      sessionToken = String(form.get("sessionToken") || "");
      const orderNumber = String(form.get("orderNumber") || "");
      const requestType =
        String(form.get("requestType") || "RETURN").toUpperCase() === "EXCHANGE"
          ? "EXCHANGE"
          : "RETURN";

      lastLookup = await lookupShopperOrder(storeId, sessionToken, orderNumber);
      const allowed =
        requestType === "EXCHANGE"
          ? lastLookup.eligibilityByType.EXCHANGE.eligible
          : lastLookup.eligibilityByType.RETURN.eligible;

      if (!allowed) {
        error =
          requestType === "EXCHANGE"
            ? lastLookup.eligibilityByType.EXCHANGE.message
            : lastLookup.eligibilityByType.RETURN.message;
      }
    } else if (intent === "ACCOUNT" && form) {
      sessionToken = String(form.get("sessionToken") || "");
      lastLookup = await lookupShopperOrder(storeId, sessionToken);
    } else if (
      (intent === "SUBMIT_REQUEST" || intent === "SUBMIT_RETURN") &&
      form
    ) {
      sessionToken = String(form.get("sessionToken") || "");
      lastLookup = await lookupShopperOrder(storeId, sessionToken);
      const requestType =
        String(form.get("requestType") || "RETURN").toUpperCase() === "EXCHANGE"
          ? "EXCHANGE"
          : "RETURN";
      const selectedIds = new Set(form.getAll("lineItemId").map(String));
      const items = lastLookup.order.lineItems
        .filter((item) => selectedIds.has(item.lineItemId))
        .map((item) => ({
          shopifyLineItemId: item.lineItemId,
          quantity: Math.max(
            1,
            Number(form.get(`quantity_${item.lineItemId}`) || 1),
          ),
          reason: String(
            form.get(`reason_${item.lineItemId}`) || "Changed Mind",
          ),
          replacementVariantId:
            String(form.get(`replacement_${item.lineItemId}`) || "").trim() ||
            undefined,
          replacementQuantity: Math.max(
            1,
            Number(
              form.get(`replacementQty_${item.lineItemId}`) ||
                form.get(`quantity_${item.lineItemId}`) ||
                1,
            ),
          ),
          price: item.price,
          title: item.title,
        }));

      if (!items.length) {
        error = "Choose at least one item.";
      } else {
        await submitShopperReturn({
          shopifyStoreId: storeId,
          shopifyOrderId: lastLookup.order.shopifyOrderId,
          orderNumber: lastLookup.order.orderNumber,
          customerEmail: lastLookup.order.customerEmail,
          customerName: lastLookup.order.customerName,
          requestType,
          reason: items[0].reason,
          customerNote: String(form.get("customerNote") || "").slice(0, 1000),
          sessionToken,
          items,
        });
        notice = `${requestType === "RETURN" ? "Return" : "Exchange"} request for ${lastLookup.order.orderNumber} was submitted. We will review your request shortly.`;
        lastLookup = await lookupShopperOrder(storeId, sessionToken);
      }
    } else if (intent === "SUBMIT_TRACKING" && form) {
      sessionToken = String(form.get("sessionToken") || "");
      const requestType =
        String(form.get("requestType") || "RETURN").toUpperCase() === "EXCHANGE"
          ? "EXCHANGE"
          : "RETURN";
      const proof = await readProofImage(form.get("proof"));
      const result = await submitCustomerTracking({
        shopifyStoreId: storeId,
        sessionToken,
        requestId: String(form.get("requestId") || ""),
        requestType,
        carrier: String(form.get("carrier") || ""),
        trackingNumber: String(form.get("trackingNumber") || ""),
        proof,
      });

      notice = result.liveStatus
        ? `Tracking number ${result.trackingNumber} recorded. Carrier status: ${result.liveStatus.replaceAll("_", " ")}.`
        : `Tracking number ${result.trackingNumber} recorded. We will monitor the delivery of your parcel.`;
      lastLookup = await lookupShopperOrder(storeId, sessionToken);
    }
  } catch (err) {
    error =
      err instanceof Error
        ? err.message
        : "The request could not be completed.";

    if (form && storeId) {
      sessionToken = String(form.get("sessionToken") || "");

      try {
        if (sessionToken) {
          lastLookup = await lookupShopperOrder(storeId, sessionToken);
        }
      } catch {
        // Fall back to login view
      }
    }
  }

  // Resolve store branding & policies
  let storeBranding = {
    name: options.brandName || "Store",
    logoUrl: null,
    supportEmail: null,
    whatsappNumber: null,
    returnAddress: null,
    policies: null,
  };

  if (lastLookup?.store) {
    storeBranding = {
      name: lastLookup.store.name || options.brandName || "Store",
      logoUrl: lastLookup.store.logoUrl || null,
      supportEmail: lastLookup.store.supportEmail || null,
      whatsappNumber: lastLookup.store.whatsappNumber || null,
      returnAddress: lastLookup.store.returnAddress || null,
      policies: lastLookup.store.policies || null,
    };
  } else {
    try {
      const settings = await getSettings(storeId);

      storeBranding = {
        name: options.brandName || "Store",
        logoUrl: settings.storeLogoUrl || null,
        supportEmail: settings.supportEmail || null,
        whatsappNumber: settings.whatsappNumber || null,
        returnAddress: settings.returnAddress || null,
        policies: settings.policies || null,
      };
    } catch {
      // Keep default branding
    }
  }

  let body = "";

  if (lastLookup && sessionToken) {
    const requestType =
      String(form?.get("requestType") || "RETURN").toUpperCase() === "EXCHANGE"
        ? "EXCHANGE"
        : "RETURN";

    if (intent === "OPEN_ORDER" && !error) {
      body = orderForm(
        lastLookup,
        sessionToken,
        options.actionPath,
        requestType,
      );
    } else {
      body = accountHome(lastLookup, sessionToken, options.actionPath);
    }
  } else {
    const defaultOrderNumber = String(form?.get("orderNumber") || "");
    const defaultIdentifier = String(form?.get("identifier") || "");
    const defaultIdentifierType =
      String(form?.get("identifierType") || "EMAIL").toUpperCase() === "PHONE"
        ? "PHONE"
        : "EMAIL";

    body = requestForm(
      defaultOrderNumber,
      defaultIdentifier,
      options.actionPath,
      defaultIdentifierType,
    );
  }

  return htmlPage(
    storeBranding,
    "Returns & Exchanges",
    `${banner(error, notice)}${body}`,
  );
}

function requestForm(
  orderNumber = "",
  identifier = "",
  actionPath = "/apps/returns",
  identifierType = "EMAIL",
) {
  return `<section class="portal-card portal-login-card">
    <div class="portal-login-header">
      <h2>Check your order</h2>
      <p class="muted">Enter your order number and the contact details used at checkout to access returns, exchanges, and parcel tracking.</p>
    </div>
    <form method="post" action="${escapeHtml(actionPath)}" class="portal-login-form">
      <label>
        <span class="field-title">Order number</span>
        <input name="orderNumber" required value="${escapeHtml(orderNumber)}" placeholder="#1001" autocomplete="off">
      </label>
      <label>
        <span class="field-title">Find order by</span>
        <select name="identifierType">
          <option value="EMAIL" ${identifierType === "EMAIL" ? "selected" : ""}>Email address</option>
          <option value="PHONE" ${identifierType === "PHONE" ? "selected" : ""}>Phone number</option>
        </select>
      </label>
      <label>
        <span class="field-title">Email address or phone number</span>
        <input name="identifier" required value="${escapeHtml(identifier)}" placeholder="you@example.com or 03001234567" autocomplete="off">
      </label>
      <input type="hidden" name="intent" value="LOGIN">
      <button type="submit" class="btn primary full-width">Find your order</button>
    </form>
  </section>`;
}

function accountHome(lookup, sessionToken, actionPath) {
  return `${updatesSection(lookup, sessionToken, actionPath)}${guidelines(lookup)}${historySection(lookup, sessionToken, actionPath)}`;
}

function guidelines(lookup) {
  const returnAddress = lookup?.store?.returnAddress;
  const addressHtml = returnAddress
    ? `
    <div class="return-address-block">
      <div class="return-address-heading">Return Address</div>
      <p class="return-address-content">${escapeHtml(returnAddress).replace(/\n/g, "<br>")}</p>
      <p class="return-address-hint">Please pack the items securely and include your order number inside the parcel.</p>
    </div>
  `
    : "";

  return `<section class="portal-card guidelines-card">
    <h2>How our exchange process works</h2>
    <ol class="guidelines-steps">
      <li>Select the eligible items you would like to exchange and choose your preferred replacements.</li>
      <li>We will review and approve your request.</li>
      <li>Once approved, securely pack the original item in its original packaging.</li>
      <li>Send the parcel to our return address via your preferred courier service.</li>
      <li>Submit your courier name and tracking number on this portal so we can follow the incoming delivery.</li>
      <li>As soon as we receive and inspect your returned parcel at our warehouse, we will dispatch your replacement order.</li>
    </ol>
    ${addressHtml}
  </section>`;
}

function updatesSection(lookup, sessionToken, actionPath) {
  const requests = lookup.accountRequests || [];

  if (!requests.length) return "";
  const cards = requests
    .map((item) => {
      const replacement =
        item.type === "EXCHANGE" && item.newOrderNumber
          ? `<p class="ok-inline">Replacement order ${escapeHtml(item.newOrderNumber)} has been created. Ship the original item and submit your tracking details below.</p>`
          : item.type === "EXCHANGE" &&
              item.status === "APPROVED" &&
              lookup.settings.exchangeReplacementTiming === "AFTER_INSPECTION"
            ? `<p>Your exchange is approved. Please ship the original item to our return address. Your replacement order will be created once we receive and inspect the parcel.</p>`
            : item.status === "APPROVED"
              ? `<p>Your ${item.type === "RETURN" ? "return" : "exchange"} is approved. Please ship the original item and enter your courier tracking details below.</p>`
              : `<p>Status: <strong>${escapeHtml(item.status.replaceAll("_", " "))}</strong></p>`;
      const trackingForm =
        item.status === "APPROVED" && !item.trackingNumber
          ? `<form method="post" action="${escapeHtml(actionPath)}" class="tracking-form" enctype="multipart/form-data">
      <h3>Submit parcel tracking for ${escapeHtml(item.orderNumber)}</h3>
      <input type="hidden" name="intent" value="SUBMIT_TRACKING"><input type="hidden" name="sessionToken" value="${escapeHtml(sessionToken)}">
      <input type="hidden" name="requestId" value="${escapeHtml(item.id)}"><input type="hidden" name="requestType" value="${item.type}">
      <label>Courier name<input name="carrier" required maxlength="80" placeholder="e.g. PostEx, Leopards, TCS, DHL, FedEx"></label>
      <label>Tracking number / Airway Bill<input name="trackingNumber" required maxlength="120" placeholder="e.g. 1234567890"></label>
      <label>Photo of shipping receipt or parcel<input type="file" name="proof" accept="image/jpeg,image/png,image/webp" required></label>
      <button type="submit" class="btn primary">Submit tracking</button>
    </form>`
          : item.trackingNumber
            ? `<div class="tracking-summary-pill"><span class="tracking-carrier">${escapeHtml(item.courier || "Courier")}</span> · Tracking: <strong>${escapeHtml(item.trackingNumber)}</strong>${item.trackingStatus ? ` · <span>${escapeHtml(item.trackingStatus.replaceAll("_", " "))}</span>` : ""}</div>`
            : "";

      return `<article class="history-row">
      <div class="history-row-header">
        <span class="request-type-badge ${item.type.toLowerCase()}">${item.type}</span>
        <strong>${escapeHtml(item.orderNumber)}</strong>
        <span class="history-date">${new Date(item.createdAt).toLocaleDateString()}</span>
      </div>
      ${replacement}
      ${trackingForm}
    </article>`;
    })
    .join("");

  return `<section class="portal-card"><h2>Your request updates</h2><div class="history-cards">${cards}</div></section>`;
}

function historySection(lookup, sessionToken, actionPath) {
  if (!lookup.orderHistory.length) {
    return `<section class="portal-card"><h2>Your order history</h2><p class="muted">No orders were found for this contact.</p></section>`;
  }

  const renderOrderRow = (historyOrder) => {
    const chips = [
      historyOrder.returnEligible
        ? `<span class="eligibility-chip eligible">Return eligible</span>`
        : "",
      historyOrder.exchangeEligible
        ? `<span class="eligibility-chip eligible">Exchange eligible</span>`
        : "",
      historyOrder.fulfillmentStatus
        ? `<span class="fulfillment-chip">${escapeHtml(historyOrder.fulfillmentStatus.replaceAll("_", " "))}</span>`
        : "",
    ]
      .filter(Boolean)
      .join("");
    const actions = [
      historyOrder.returnEligible
        ? `<form method="post" action="${escapeHtml(actionPath)}"><input type="hidden" name="intent" value="OPEN_ORDER"><input type="hidden" name="sessionToken" value="${escapeHtml(sessionToken)}"><input type="hidden" name="orderNumber" value="${escapeHtml(historyOrder.orderNumber)}"><input type="hidden" name="requestType" value="RETURN"><button type="submit" class="btn secondary sm">Start return</button></form>`
        : "",
      historyOrder.exchangeEligible
        ? `<form method="post" action="${escapeHtml(actionPath)}"><input type="hidden" name="intent" value="OPEN_ORDER"><input type="hidden" name="sessionToken" value="${escapeHtml(sessionToken)}"><input type="hidden" name="orderNumber" value="${escapeHtml(historyOrder.orderNumber)}"><input type="hidden" name="requestType" value="EXCHANGE"><button type="submit" class="btn primary sm">Start exchange</button></form>`
        : "",
    ]
      .filter(Boolean)
      .join("");
    const trackingAction =
      historyOrder.trackingUrl || historyOrder.trackingNumber
        ? `
      <a href="${escapeHtml(historyOrder.trackingUrl || `https://www.google.com/search?q=${encodeURIComponent(`${historyOrder.courier || "courier"} tracking ${historyOrder.trackingNumber}`)}`)}" target="_blank" rel="noopener noreferrer" class="btn track-order-btn sm">
        Track My Order
      </a>
    `
        : "";

    return `<article class="order-history-row">
      <div class="order-row-main">
        <div class="order-meta">
          <strong>${escapeHtml(historyOrder.orderNumber)}</strong>
          <span class="order-date">${new Date(historyOrder.createdAt).toLocaleDateString()} · ${historyOrder.itemCount} item(s)</span>
        </div>
        <div class="order-total">${Number(historyOrder.totalPrice).toLocaleString("en-PK")} ${escapeHtml(historyOrder.currency)}</div>
      </div>
      <div class="order-history-eligibility">${chips}</div>
      <div class="order-actions">${trackingAction}${actions}</div>
    </article>`;
  };

  const initialOrders = lookup.orderHistory.slice(0, 5);
  const olderOrders = lookup.orderHistory.slice(5);
  const initialRows = initialOrders.map(renderOrderRow).join("");
  const olderRows = olderOrders.map(renderOrderRow).join("");
  const paginationControl =
    olderOrders.length > 0
      ? `
    <div id="bc-older-orders" class="older-orders-container" style="display:none;">
      ${olderRows}
    </div>
    <div class="see-more-wrap">
      <button type="button" class="btn secondary see-more-btn" id="bc-see-more-btn" onclick="document.getElementById('bc-older-orders').style.display='block'; this.style.display='none';">
        See more orders (${olderOrders.length} older ${olderOrders.length === 1 ? "order" : "orders"})
      </button>
    </div>
  `
      : "";

  return `<section class="portal-card order-history-card">
    <div class="order-history-head">
      <h2>Your order history</h2>
      <p class="muted">Orders matched to your contact details. Submit a return or exchange on eligible orders, or track your delivery.</p>
    </div>
    <div class="order-history-list">
      ${initialRows}
      ${paginationControl}
    </div>
  </section>`;
}

function orderForm(
  lookup,
  sessionToken,
  actionPath = "/apps/returns",
  requestType = "RETURN",
) {
  const catalogue = JSON.stringify(
    lookup.replacementVariants.map((variant) => ({
      id: variant.variantId,
      title: variant.title,
      price: Number(variant.price).toFixed(2),
      currency: lookup.order.currency,
      image: variant.imageUrl || "",
    })),
  ).replace(/</g, "\\u003c");
  const items = lookup.order.lineItems
    .map((item) => {
      const currentVariant =
        item.variantTitle && item.variantTitle !== "Default Title"
          ? item.variantTitle
          : "";
      const image = item.imageUrl
        ? `<img class="item-image" src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.title)}" loading="lazy">`
        : `<div class="item-image item-image-placeholder">No image</div>`;
      const replacement =
        requestType === "EXCHANGE"
          ? `<div class="product-search" data-product-search>
        <label><span class="field-title">Choose replacement item</span><input type="search" data-product-query placeholder="Search for another size or product" autocomplete="off"></label>
        <input type="hidden" name="replacement_${escapeHtml(item.lineItemId)}" data-product-id value="">
        <div class="product-results" hidden></div>
        <span class="replacement-preview" hidden><img alt="" hidden loading="lazy"><span></span></span>
      </div>`
          : "";

      return `<div class="item-card" data-item-card>
      <div class="item-head">
        <label class="item-select">
          <input type="checkbox" name="lineItemId" value="${escapeHtml(item.lineItemId)}">
          <span class="item-info">
            <strong>${escapeHtml(item.title)}</strong>
            <small>${escapeHtml(currentVariant || item.sku || "Variant details")} · ${Number(item.price).toLocaleString("en-PK")} ${escapeHtml(lookup.order.currency)} · Qty ${item.quantity}</small>
          </span>
        </label>
        ${image}
      </div>
      <div class="item-fields">
        <label><span class="field-title">Quantity</span><input type="number" name="quantity_${escapeHtml(item.lineItemId)}" min="1" max="${Math.max(1, item.quantity)}" value="1"></label>
        <label><span class="field-title">Reason</span><select name="reason_${escapeHtml(item.lineItemId)}"><option>Size Mismatch</option><option>Defective / Damaged</option><option>Wrong Item Received</option><option>Changed Mind</option></select></label>
        ${replacement}
        ${requestType === "EXCHANGE" ? `<label><span class="field-title">Replacement quantity</span><input type="number" name="replacementQty_${escapeHtml(item.lineItemId)}" min="1" value="1"></label>` : ""}
      </div>
    </div>`;
    })
    .join("");
  const back = `<form method="post" action="${escapeHtml(actionPath)}" class="back-form"><input type="hidden" name="intent" value="ACCOUNT"><input type="hidden" name="sessionToken" value="${escapeHtml(sessionToken)}"><button type="submit" class="btn secondary sm">← Back to order history</button></form>`;

  return `${updatesSection(lookup, sessionToken, actionPath)}<section class="portal-card order-panel">
    <div class="order-panel-header">
      ${back}
      <h2>${requestType === "EXCHANGE" ? "Exchange" : "Return"} items from ${escapeHtml(lookup.order.orderNumber)}</h2>
      <p class="muted">${requestType === "EXCHANGE" ? "Choose the items you want to exchange and select your preferred replacements." : "Select the items you would like to return."} No courier booking is required at this stage.</p>
    </div>
    <form method="post" action="${escapeHtml(actionPath)}" class="order-request-form">
      <input type="hidden" name="intent" value="SUBMIT_REQUEST"><input type="hidden" name="sessionToken" value="${escapeHtml(sessionToken)}">
      <input type="hidden" name="requestType" value="${requestType}">
      <div class="items-list">${items}</div>
      <label><span class="field-title">Additional details (optional)</span><textarea name="customerNote" maxlength="1000" rows="3" placeholder="Add any details that could help us process your request faster"></textarea></label>
      <p class="eligibility-hint" data-eligibility-hint role="status"></p>
      <button data-submit-request type="submit" class="btn primary full-width">Submit ${requestType === "EXCHANGE" ? "exchange" : "return"} for review</button>
    </form>
    <script type="application/json" id="replacement-catalogue">${catalogue}</script>
  </section>`;
}

async function readProofImage(value) {
  if (!(value instanceof File) || value.size < 1)
    throw new Error("Upload a photo of the shipping receipt or parcel.");
  if (value.size > 900_000)
    throw new Error("The proof image must be smaller than 900 KB.");
  const bytes = Buffer.from(await value.arrayBuffer());
  const mimeType = imageMimeType(bytes);

  if (!mimeType) throw new Error("Upload a JPEG, PNG, or WebP photo.");

  return {
    fileName: value.name || "shipping-proof",
    mimeType,
    contentBase64: bytes.toString("base64"),
  };
}

function imageMimeType(bytes) {
  if (
    bytes.length > 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (
    bytes.length > 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";

  return "";
}

function banner(error, notice) {
  return `${error ? `<div class="portal-banner bad" role="alert">${escapeHtml(error)}</div>` : ""}${notice ? `<div class="portal-banner ok" role="status">${escapeHtml(notice)}</div>` : ""}`;
}

function cleanDigits(value) {
  return value.replace(/\D/g, "");
}

function htmlPage(branding, title, body, status = 200) {
  const brandName = branding.name || "STORE";
  const headerContent = branding.logoUrl
    ? `<img src="${escapeHtml(branding.logoUrl)}" alt="${escapeHtml(brandName)}" class="portal-logo"><small>RETURNS &amp; EXCHANGES</small>`
    : `<span class="portal-brand-text">${escapeHtml(brandName)}</span><small>RETURNS &amp; EXCHANGES</small>`;
  // Footer Left Elements: Support contacts + Shopify Policies (never invent missing policies)
  const supportElements = [];

  if (branding.supportEmail) {
    supportElements.push(
      `<a href="mailto:${escapeHtml(branding.supportEmail)}" class="footer-link">Support: ${escapeHtml(branding.supportEmail)}</a>`,
    );
  }

  if (branding.whatsappNumber) {
    const digits = cleanDigits(branding.whatsappNumber);

    supportElements.push(
      `<a href="https://wa.me/${escapeHtml(digits)}" target="_blank" rel="noopener noreferrer" class="footer-link">WhatsApp: ${escapeHtml(branding.whatsappNumber)}</a>`,
    );
  }

  const policyElements = [];

  if (branding.policies && typeof branding.policies === "object") {
    for (const [, item] of Object.entries(branding.policies)) {
      if (item && typeof item === "object" && item.url) {
        policyElements.push(
          `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="footer-link">${escapeHtml(item.title || "Policy")}</a>`,
        );
      }
    }
  }

  const footerLeftHtml = [...supportElements, ...policyElements].join(
    '<span class="footer-separator">·</span>',
  );
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — ${escapeHtml(brandName)}</title>
  <style>
    :root {
      --bc-p-bg: #f8f9fa;
      --bc-p-surface: #ffffff;
      --bc-p-ink: #111827;
      --bc-p-muted: #6b7280;
      --bc-p-line: #e5e7eb;
      --bc-p-primary: #111827;
      --bc-p-primary-hover: #1f2937;
      --bc-p-accent: #2563eb;
      --bc-p-success: #15803d;
      --bc-p-success-bg: #f0fdf4;
      --bc-p-danger: #b91c1c;
      --bc-p-danger-bg: #fef2f2;
      --bc-p-radius: 10px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bc-p-bg);
      color: var(--bc-p-ink);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .portal-header {
      background: var(--bc-p-surface);
      border-bottom: 1px solid var(--bc-p-line);
      padding: 26px 32px;
      text-align: center;
    }
    .portal-logo {
      max-height: 48px;
      max-width: 220px;
      object-fit: contain;
      display: inline-block;
      vertical-align: middle;
    }
    .portal-brand-text {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: var(--bc-p-ink);
    }
    .portal-header small {
      display: block;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.12em;
      color: var(--bc-p-muted);
      margin-top: 6px;
    }
    main {
      width: min(100%, 1120px);
      max-width: 1120px;
      margin: 0 auto;
      padding: 32px 24px 72px;
    }
    h1 { font-size: 24px; letter-spacing: -0.02em; margin: 0 0 8px; }
    h2 { font-size: 18px; font-weight: 600; margin: 0 0 12px; }
    h3 { font-size: 15px; font-weight: 600; margin: 0 0 8px; }
    p { margin: 0 0 12px; }
    .muted { color: var(--bc-p-muted); font-size: 13px; line-height: 1.45; }
    .portal-card {
      background: var(--bc-p-surface);
      border: 1px solid var(--bc-p-line);
      border-radius: 16px;
      padding: 24px;
      margin: 18px 0;
      box-shadow: 0 8px 28px rgba(15, 23, 42, 0.055);
    }
    .portal-login-card {
      max-width: 560px;
      margin: 38px auto;
    }
    .portal-login-header {
      margin-bottom: 20px;
    }
    .portal-banner {
      padding: 12px 16px;
      border-radius: var(--bc-p-radius);
      font-size: 13px;
      margin: 16px 0;
    }
    .portal-banner.bad { background: var(--bc-p-danger-bg); color: var(--bc-p-danger); border: 1px solid #fecaca; }
    .portal-banner.ok { background: var(--bc-p-success-bg); color: var(--bc-p-success); border: 1px solid #bbf7d0; }
    label { display: block; margin-bottom: 14px; }
    .field-title { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: var(--bc-p-ink); }
    input[type="text"], input[type="email"], input[type="search"], input[type="number"], select, textarea {
      width: 100%;
      min-height: 42px;
      padding: 9px 12px;
      font-size: 14px;
      color: var(--bc-p-ink);
      background: var(--bc-p-surface);
      border: 1px solid var(--bc-p-line);
      border-radius: 8px;
      transition: border-color 0.15s ease;
    }
    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: var(--bc-p-primary);
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 40px;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 600;
      border-radius: 8px;
      border: 1px solid transparent;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .btn.sm { min-height: 34px; padding: 6px 12px; font-size: 12px; }
    .btn.primary { background: var(--bc-p-primary); color: #fff; }
    .btn.primary:hover { background: var(--bc-p-primary-hover); }
    .btn.secondary { background: var(--bc-p-surface); color: var(--bc-p-ink); border-color: var(--bc-p-line); }
    .btn.secondary:hover { background: var(--bc-p-bg); }
    .btn.full-width { width: 100%; }
    .track-order-btn { background: #f3f4f6; color: #111827; border: 1px solid #d1d5db; }
    .track-order-btn:hover { background: #e5e7eb; }
    .guidelines-steps {
      padding-left: 20px;
      margin: 12px 0 16px;
      color: #374151;
      font-size: 13px;
      line-height: 1.6;
    }
    .guidelines-steps li { margin-bottom: 6px; }
    .return-address-block {
      background: var(--bc-p-bg);
      border: 1px dashed var(--bc-p-line);
      border-radius: 8px;
      padding: 14px 16px;
      margin-top: 16px;
    }
    .return-address-heading {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--bc-p-muted);
      margin-bottom: 6px;
    }
    .return-address-content {
      font-size: 13px;
      font-weight: 600;
      color: var(--bc-p-ink);
      line-height: 1.5;
      margin-bottom: 6px;
    }
    .return-address-hint {
      font-size: 12px;
      color: var(--bc-p-muted);
      margin: 0;
    }
    .history-row {
      padding: 12px 0;
      border-bottom: 1px solid var(--bc-p-line);
    }
    .history-row:last-child { border-bottom: 0; }
    .history-row-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      font-size: 13px;
    }
    .request-type-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      background: #e5e7eb;
      color: #374151;
    }
    .request-type-badge.exchange { background: #dbeafe; color: #1e40af; }
    .request-type-badge.return { background: #fee2e2; color: #991b1b; }
    .history-date { margin-left: auto; color: var(--bc-p-muted); font-size: 12px; }
    .tracking-form {
      background: var(--bc-p-bg);
      padding: 14px;
      border-radius: 8px;
      margin-top: 10px;
    }
    .tracking-summary-pill {
      display: inline-block;
      font-size: 12px;
      padding: 6px 12px;
      background: var(--bc-p-bg);
      border: 1px solid var(--bc-p-line);
      border-radius: 6px;
      margin-top: 6px;
    }
    .order-history-row {
      padding: 14px 0;
      border-bottom: 1px solid var(--bc-p-line);
    }
    .order-history-row:last-child { border-bottom: 0; }
    .order-row-main {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 6px;
    }
    .order-date { display: block; font-size: 12px; color: var(--bc-p-muted); margin-top: 2px; }
    .order-total { font-weight: 600; font-size: 14px; }
    .order-history-eligibility {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 10px;
    }
    .eligibility-chip {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--bc-p-success-bg);
      color: var(--bc-p-success);
    }
    .fulfillment-chip {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 999px;
      background: #eff6ff;
      color: #1d4ed8;
      text-transform: capitalize;
    }
    .order-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .order-actions form { margin: 0; padding: 0; }
    .see-more-wrap {
      text-align: center;
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid var(--bc-p-line);
    }
    .item-card {
      border: 1px solid var(--bc-p-line);
      border-radius: 8px;
      padding: 14px;
      margin: 12px 0;
    }
    .item-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 80px;
      gap: 12px;
      align-items: center;
    }
    .item-select {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      margin: 0;
    }
    .item-select input { width: 18px; height: 18px; margin-top: 2px; flex: 0 0 auto; }
    .item-info small { display: block; color: var(--bc-p-muted); margin-top: 4px; }
    .item-image {
      width: 80px;
      height: 80px;
      object-fit: cover;
      border-radius: 6px;
      background: var(--bc-p-bg);
      border: 1px solid var(--bc-p-line);
    }
    .item-image-placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      color: var(--bc-p-muted);
    }
    .item-fields {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--bc-p-line);
    }
    .product-search { grid-column: 1 / -1; position: relative; }
    .product-results {
      position: absolute;
      z-index: 10;
      left: 0;
      right: 0;
      top: 100%;
      background: #fff;
      border: 1px solid var(--bc-p-line);
      border-radius: 8px;
      max-height: 220px;
      overflow-y: auto;
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }
    .product-results button {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border: 0;
      border-bottom: 1px solid var(--bc-p-line);
      background: #fff;
      cursor: pointer;
      text-align: left;
    }
    .product-results button:hover { background: var(--bc-p-bg); }
    .product-results img { width: 36px; height: 36px; object-fit: cover; border-radius: 4px; }
    .replacement-preview {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px;
      border: 1px solid var(--bc-p-line);
      border-radius: 6px;
      margin-top: 8px;
      font-size: 12px;
    }
    .replacement-preview img { width: 36px; height: 36px; object-fit: cover; border-radius: 4px; }
    .portal-footer {
      border-top: 1px solid var(--bc-p-line);
      background: var(--bc-p-surface);
      padding: 24px 16px;
      margin-top: 48px;
    }
    .portal-footer-inner {
      max-width: 760px;
      margin: 0 auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      font-size: 12px;
      color: var(--bc-p-muted);
    }
    .portal-footer-left {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .footer-link {
      color: var(--bc-p-muted);
      text-decoration: none;
      transition: color 0.15s ease;
    }
    .footer-link:hover { color: var(--bc-p-ink); text-decoration: underline; }
    .footer-separator { color: #d1d5db; }
    .portal-footer-right {
      margin-left: auto;
      font-size: 12px;
      color: #9ca3af;
    }
    .portal-footer-right strong { color: #4b5563; }
    /* Improved customer portal hierarchy and tracking/returns layout */
    .portal-header { box-shadow: 0 2px 14px rgba(15, 23, 42, 0.035); }
    .portal-logo { max-height: 54px; max-width: min(240px, 70vw); }
    main { width: min(100%, 1120px); }
    .portal-card { overflow-wrap: anywhere; }
    .portal-card h1, .portal-card h2, .portal-card h3 { letter-spacing: -0.02em; }
    .portal-card h2 { font-size: 20px; line-height: 1.3; }
    .portal-card p { line-height: 1.55; }
    .portal-card + .portal-card { margin-top: 18px; }
    .portal-login-card { border-radius: 20px; padding: 28px; }
    .portal-login-header { padding-bottom: 14px; border-bottom: 1px solid var(--bc-p-line); }
    .field-title { font-size: 12px; letter-spacing: .015em; }
    .btn { min-height: 42px; padding: 9px 17px; border-radius: 10px; }
    .btn:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
      outline: 3px solid rgba(37, 99, 235, .3); outline-offset: 2px;
    }
    .portal-banner { border-radius: 12px; padding: 14px 16px; line-height: 1.55; }
    .order-history-row, .history-row { padding: 16px 0; }
    .order-history-row:hover { background: linear-gradient(90deg, rgba(37,99,235,.035), transparent); }
    .order-row-main { gap: 16px; }
    .order-total { font-size: 16px; font-weight: 750; }
    .history-row-header { flex-wrap: wrap; }
    .tracking-form { border: 1px solid var(--bc-p-line); border-radius: 12px; padding: 16px; }
    .tracking-summary-pill { border-radius: 999px; padding: 6px 11px; }
    .request-type-badge { border-radius: 999px; padding: 4px 10px; letter-spacing: .03em; }
    .guidelines-steps { line-height: 1.7; }
    @media (max-width: 900px) {
      main { width: 100%; padding: 24px 18px 56px; }
      .portal-card { padding: 20px; }
    }

    @media (max-width: 600px) {
      .item-fields { grid-template-columns: 1fr; }
      .portal-footer-inner { flex-direction: column; align-items: flex-start; }
      .portal-footer-right { margin-left: 0; }
    }
  </style>
</head>
<body>
  <header class="portal-header">
    ${headerContent}
  </header>
  <main>
    ${body}
  </main>
  <footer class="portal-footer">
    <div class="portal-footer-inner">
      <div class="portal-footer-left">
        ${footerLeftHtml || `<span>${escapeHtml(brandName)}</span>`}
      </div>
      <div class="portal-footer-right">
        <span>Powered by <strong>BYNDCART</strong></span>
      </div>
    </div>
  </footer>

  <script>
    var catalogueNode = document.getElementById('replacement-catalogue');
    var catalogue = [];
    try { catalogue = catalogueNode ? JSON.parse(catalogueNode.textContent || '[]') : []; } catch (error) { catalogue = []; }
    document.querySelectorAll('[data-product-search]').forEach(function(box) {
      var query = box.querySelector('[data-product-query]');
      var hidden = box.querySelector('[data-product-id]');
      var results = box.querySelector('.product-results');
      var preview = box.querySelector('.replacement-preview');
      function choose(item) {
        hidden.value = item.id;
        query.value = item.title;
        results.hidden = true;
        results.innerHTML = '';
        var image = preview.querySelector('img');
        var title = preview.querySelector('span');
        image.hidden = !item.image;
        if (item.image) image.src = item.image; else image.removeAttribute('src');
        image.alt = item.title;
        title.textContent = item.title + ' · ' + item.currency + ' ' + item.price;
        preview.hidden = false;
      }
      query.addEventListener('input', function() {
        hidden.value = '';
        preview.hidden = true;
        var text = query.value.trim().toLowerCase();
        if (text.length < 1) { results.hidden = true; results.innerHTML = ''; return; }
        var matches = catalogue.filter(function(item) { return item.title.toLowerCase().indexOf(text) !== -1; }).slice(0, 8);
        results.replaceChildren();
        matches.forEach(function(item) {
          var button = document.createElement('button');
          button.type = 'button';
          if (item.image) {
            var image = document.createElement('img');
            image.alt = '';
            image.src = item.image;
            button.appendChild(image);
          }
          var label = document.createElement('span');
          label.textContent = item.title + ' · ' + item.currency + ' ' + item.price;
          button.appendChild(label);
          button.addEventListener('click', function() { choose(item); });
          results.appendChild(button);
        });
        results.hidden = matches.length === 0;
      });
    });
    document.querySelectorAll('.order-request-form').forEach(function(form) {
      var requestType = form.querySelector('[name="requestType"]');
      var hint = form.querySelector('[data-eligibility-hint]');
      form.addEventListener('submit', function(event) {
        var selectedCards = Array.from(form.querySelectorAll('input[name="lineItemId"]:checked')).map(function(input) { return input.closest('[data-item-card]'); });
        if (!selectedCards.length) { event.preventDefault(); hint.textContent = 'Select at least one product to continue.'; return; }
        if (requestType && requestType.value === 'EXCHANGE') {
          var missingReplacement = selectedCards.some(function(card) { var selected = card.querySelector('[data-product-id]'); return !selected || !selected.value; });
          if (missingReplacement) { event.preventDefault(); hint.textContent = 'Search and choose a replacement product for every selected item.'; }
        }
      });
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] || char,
  );
}
