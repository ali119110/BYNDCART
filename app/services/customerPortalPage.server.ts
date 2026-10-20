import { authenticateShopperOrder, lookupShopperOrder, submitCustomerTracking, submitShopperReturn } from "./portal.server";
import type { ShopperOrderLookupResult } from "./portal.server";

export interface CustomerPortalPageOptions {
  shopifyStoreId: string;
  brandName: string;
  actionPath: string;
}

/** Render the shared customer portal after the caller resolves the merchant from a trusted source. */
export async function renderCustomerPortalPage(request: Request, options: CustomerPortalPageOptions) {
  const form = request.method === "POST" ? await request.formData() : null;
  const intent = String(form?.get("intent") || "");
  let notice = "";
  let error = "";
  const storeId = options.shopifyStoreId;
  let body = requestForm("", "", options.actionPath, "EMAIL");
  let sessionToken = "";
  let lastLookup: ShopperOrderLookupResult | null = null;

  try {

    if (intent === "LOGIN" && form) {
      const orderNumber = String(form.get("orderNumber") || "");
      const identifierType = String(form.get("identifierType") || "EMAIL").toUpperCase() === "PHONE" ? "PHONE" : "EMAIL";
      const identifier = String(form.get("identifier") || "");
      const authenticated = await authenticateShopperOrder(storeId, { orderNumber, identifierType, identifier });
      sessionToken = authenticated.sessionToken;
      lastLookup = await lookupShopperOrder(storeId, sessionToken);
      notice = "Order " + lastLookup.order.orderNumber + " found. You can now submit a return or exchange request.";
      body = orderForm(lastLookup, sessionToken, options.actionPath);
    } else if ((intent === "SUBMIT_REQUEST" || intent === "SUBMIT_RETURN") && form) {
      sessionToken = String(form.get("sessionToken") || "");
      lastLookup = await lookupShopperOrder(storeId, sessionToken);
      const requestType = String(form.get("requestType") || "RETURN").toUpperCase() === "EXCHANGE" ? "EXCHANGE" : "RETURN";
      const selectedIds = new Set(form.getAll("lineItemId").map(String));
      const items = lastLookup.order.lineItems.filter((item) => selectedIds.has(item.lineItemId)).map((item) => ({
        shopifyLineItemId: item.lineItemId,
        quantity: Math.max(1, Number(form.get(`quantity_${item.lineItemId}`) || 1)),
        reason: String(form.get(`reason_${item.lineItemId}`) || "Changed Mind"),
        replacementVariantId: String(form.get(`replacement_${item.lineItemId}`) || "").trim() || undefined,
        replacementQuantity: Math.max(1, Number(form.get(`replacementQty_${item.lineItemId}`) || form.get(`quantity_${item.lineItemId}`) || 1)),
        price: item.price,
        title: item.title,
      }));
      if (!items.length) {
        error = "Choose at least one item.";
        body = orderForm(lastLookup, sessionToken, options.actionPath);
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
        notice = `${requestType === "RETURN" ? "Return" : "Exchange"} request for ${lastLookup.order.orderNumber} was submitted. Status: Pending merchant review. No courier was booked.`;
        lastLookup = await lookupShopperOrder(storeId, sessionToken);
        body = orderForm(lastLookup, sessionToken, options.actionPath);
      }
    } else if (intent === "SUBMIT_TRACKING" && form) {
      sessionToken = String(form.get("sessionToken") || "");
      const requestType = String(form.get("requestType") || "RETURN").toUpperCase() === "EXCHANGE" ? "EXCHANGE" : "RETURN";
      const result = await submitCustomerTracking({
        shopifyStoreId: storeId,
        sessionToken,
        requestId: String(form.get("requestId") || ""),
        requestType,
        carrier: String(form.get("carrier") || ""),
        trackingNumber: String(form.get("trackingNumber") || ""),
      });
      notice = `Tracking details ${result.idempotent ? "were already recorded" : "were saved"}. BYNDCART did not book or verify the shipment.`;
      lastLookup = await lookupShopperOrder(storeId, sessionToken);
      body = orderForm(lastLookup, sessionToken, options.actionPath);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "The request could not be completed.";
    if (form && storeId) {
      sessionToken = String(form.get("sessionToken") || "");
      try {
        if (sessionToken) {
          lastLookup = await lookupShopperOrder(storeId, sessionToken);
          body = orderForm(lastLookup, sessionToken, options.actionPath);
        } else {
          body = requestForm(String(form.get("orderNumber") || ""), String(form.get("identifier") || ""), options.actionPath, String(form.get("identifierType") || "EMAIL") === "PHONE" ? "PHONE" : "EMAIL");
        }
      } catch {
        body = requestForm(String(form.get("orderNumber") || ""), String(form.get("identifier") || ""), options.actionPath, String(form.get("identifierType") || "EMAIL") === "PHONE" ? "PHONE" : "EMAIL");
      }
    }
  }
  return htmlPage(options.brandName, "Returns and exchanges", `${banner(error, notice)}${body}`);
}

function requestForm(orderNumber = "", identifier = "", actionPath = "/apps/returns", identifierType: "EMAIL" | "PHONE" = "EMAIL") {
  return `<form method="post" action="${escapeHtml(actionPath)}" class="portal-login-form">
    <h2>Find your order</h2>
    <p class="muted">Enter the order number and the contact detail used at checkout. No verification code is required.</p>
    <label>Order number<input name="orderNumber" required value="${escapeHtml(orderNumber)}" placeholder="#1001" autocomplete="off"></label>
    <label>Find order using<select name="identifierType">
      <option value="EMAIL" ${identifierType === "EMAIL" ? "selected" : ""}>Email address</option>
      <option value="PHONE" ${identifierType === "PHONE" ? "selected" : ""}>Phone number</option>
    </select></label>
    <label>Email address or phone number<input name="identifier" required value="${escapeHtml(identifier)}" placeholder="you@example.com or +92 300 1234567" autocomplete="off"></label>
    <input type="hidden" name="intent" value="LOGIN">
    <button type="submit">Find my order</button>
  </form>`;
}

function orderForm(lookup: ShopperOrderLookupResult, sessionToken: string, actionPath = "/apps/returns") {
  const variantOptions = lookup.replacementVariants.slice(0, 200).map((variant) =>
    `<option value="${escapeHtml(variant.variantId)}">${escapeHtml(variant.title)} · ${escapeHtml(lookup.order.currency)} ${Number(variant.price).toFixed(2)}</option>`
  ).join("");
  const items = lookup.order.lineItems.map((item) => `<div class="item-card">
    <label class="item-select"><input type="checkbox" name="lineItemId" value="${escapeHtml(item.lineItemId)}"><span><strong>${escapeHtml(item.title)}</strong><small>${Number(item.price).toLocaleString("en-PK")} ${escapeHtml(lookup.order.currency)} · Qty ${item.quantity}</small></span></label>
    <div class="item-fields">
      <label>Quantity<input type="number" name="quantity_${escapeHtml(item.lineItemId)}" min="1" max="${Math.max(1, item.quantity)}" value="1"></label>
      <label>Reason<select name="reason_${escapeHtml(item.lineItemId)}"><option>Size Mismatch</option><option>Defective / Damaged</option><option>Wrong Item Received</option><option>Changed Mind</option></select></label>
      <label>Replacement variant for exchange<select name="replacement_${escapeHtml(item.lineItemId)}"><option value="">Select replacement (exchange only)</option>${variantOptions}</select></label>
      <label>Replacement quantity<input type="number" name="replacementQty_${escapeHtml(item.lineItemId)}" min="1" value="1"></label>
    </div>
  </div>`).join("");
  const history = lookup.requestHistory.length ? `<section><h2>Request history for this order</h2>${lookup.requestHistory.map((item) => {
    const trackingForm = item.status === "APPROVED" && !item.trackingNumber ? `<form method="post" action="${escapeHtml(actionPath)}" class="tracking-form">
      <h3>Submit your shipping details</h3>
      <input type="hidden" name="intent" value="SUBMIT_TRACKING"><input type="hidden" name="sessionToken" value="${escapeHtml(sessionToken)}">
      <input type="hidden" name="requestId" value="${escapeHtml(item.id)}"><input type="hidden" name="requestType" value="${item.type}">
      <label>Carrier/courier name<input name="carrier" required maxlength="80" placeholder="Carrier you arranged"></label>
      <label>Tracking number / airway bill<input name="trackingNumber" required maxlength="120"></label>
      <button type="submit">Save tracking details</button>
    </form>` : item.trackingNumber ? `<p class="muted">Carrier: ${escapeHtml(item.courier || "Not provided")} · Tracking: <strong>${escapeHtml(item.trackingNumber)}</strong></p>` : "";
    return `<article class="history-row"><p><strong>${item.type}</strong> · ${escapeHtml(item.orderNumber)} · <b>${escapeHtml(item.status.replaceAll("_", " "))}</b></p>${trackingForm}</article>`;
  }).join("")}</section>` : "";

  return `<section class="order-panel">
    <h2>Order ${escapeHtml(lookup.order.orderNumber)}</h2>
    <p class="muted">Choose the specific items and quantities. The store reviews your request before shipping begins.</p>
    <p class="policy">Returns: ${lookup.eligibilityByType.RETURN.eligible ? "Eligible to request" : escapeHtml(lookup.eligibilityByType.RETURN.message)}<br>Exchanges: ${lookup.eligibilityByType.EXCHANGE.eligible ? "Eligible to request" : escapeHtml(lookup.eligibilityByType.EXCHANGE.message)}</p>
    <form method="post" action="${escapeHtml(actionPath)}">
      <input type="hidden" name="intent" value="SUBMIT_REQUEST"><input type="hidden" name="sessionToken" value="${escapeHtml(sessionToken)}">
      <label>Request type<select name="requestType"><option value="RETURN">Return for refund</option><option value="EXCHANGE">Exchange for another product</option></select></label>
      ${items}
      <label>Additional note (optional)<textarea name="customerNote" maxlength="1000" rows="3" placeholder="Add any helpful details"></textarea></label>
      <button type="submit" ${lookup.eligible ? "" : "disabled"}>Submit request</button>
      <p class="muted">BYNDCART never books courier shipments. After approval, arrange shipping with a carrier of your choice and enter its tracking details above.</p>
    </form>
  </section>${history}`;
}

function banner(error: string, notice: string) {
  return `${error ? `<p class="bad">${escapeHtml(error)}</p>` : ""}${notice ? `<p class="ok">${escapeHtml(notice)}</p>` : ""}`;
}

function htmlPage(brandName: string, title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
  <style>
    *{box-sizing:border-box} body{margin:0;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f9;color:#142033}
    header{background:#fff;border-bottom:1px solid #e4e8ee;padding:20px 16px;text-align:center;font-weight:800;letter-spacing:.03em;color:#111827}header small{display:block;font-size:11px;font-weight:600;color:#667085;letter-spacing:.12em;margin-top:5px}main{max-width:760px;margin:0 auto;padding:28px 16px 64px} h1{font-size:26px;letter-spacing:-.03em;margin:0 0 8px} h2{font-size:18px;margin:0 0 12px} h3{font-size:15px;margin:0 0 10px}
    form,.ok,.bad,.warn,.order-panel,section{background:#fff;border:1px solid #e4e8ee;border-radius:14px;padding:16px;margin:14px 0} p{line-height:1.5}.muted{color:#5c6779;font-size:13px}.policy{background:#f8fafc;padding:10px;border-radius:9px;font-size:13px}
    label{display:grid;gap:6px;margin:12px 0;font-size:13px;font-weight:650} input,select,textarea,button{font:inherit;min-height:42px;border-radius:8px} input,select,textarea{width:100%;border:1px solid #c9d0d9;padding:9px 11px;background:#fff;color:#142033} button{background:#1f4b99;color:#fff;border:0;padding:0 15px;cursor:pointer;font-weight:650}button:disabled{opacity:.45;cursor:not-allowed}
    .item-card{border:1px solid #e6eaf0;border-radius:12px;padding:12px;margin:12px 0}.item-select{display:flex;grid-template-columns:auto 1fr;align-items:center;gap:10px}.item-select input{width:18px;min-height:18px}.item-select small{display:block;color:#667085;font-weight:400;margin-top:3px}.item-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px}.item-fields label{margin:8px 0}.item-fields label:nth-child(3){grid-column:span 2}.ok{background:#e7f6ee;color:#0f7b4c}.bad,.warn{background:#fff0ef;color:#b42318}.history-row{padding:10px 0;border-bottom:1px solid #eef0f3}.tracking-form{background:#f8fafc}.tracking-form button{width:100%}.portal-login-form button{width:100%;min-height:46px}
    @media(max-width:520px){.item-fields{grid-template-columns:1fr}.item-fields label:nth-child(3){grid-column:auto}main{padding:20px 12px 40px}}
  </style></head><body><header>${escapeHtml(brandName || "STORE")}<small>RETURNS &amp; EXCHANGES</small></header><main><h1>Returns and exchanges</h1><p class="muted">Find your order, submit a request, and arrange shipping only after approval.</p>${body}</main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] || char));
}
