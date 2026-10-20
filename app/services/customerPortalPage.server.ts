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
    `<option value="${escapeHtml(variant.variantId)}" data-image="${escapeHtml(variant.imageUrl || "")}" data-title="${escapeHtml(variant.title)}">${escapeHtml(variant.title)} · ${escapeHtml(lookup.order.currency)} ${Number(variant.price).toFixed(2)}</option>`
  ).join("");
  const items = lookup.order.lineItems.map((item) => {
    const currentVariant = item.variantTitle && item.variantTitle !== "Default Title" ? item.variantTitle : "";
    const image = item.imageUrl
      ? `<img class="item-image" src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.title)}" loading="lazy">`
      : `<div class="item-image item-image-placeholder" aria-label="Product image unavailable">No image</div>`;
    return `<div class="item-card" data-item-card>
      <div class="item-head">
        <label class="item-select"><input type="checkbox" name="lineItemId" value="${escapeHtml(item.lineItemId)}"><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(currentVariant || item.sku || "Variant details unavailable")} · ${Number(item.price).toLocaleString("en-PK")} ${escapeHtml(lookup.order.currency)} · Qty ${item.quantity}</small></span></label>
        ${image}
      </div>
      <div class="item-fields">
        <label>Quantity to return<input type="number" name="quantity_${escapeHtml(item.lineItemId)}" min="1" max="${Math.max(1, item.quantity)}" value="1"></label>
        <label>Reason<select name="reason_${escapeHtml(item.lineItemId)}"><option>Size Mismatch</option><option>Defective / Damaged</option><option>Wrong Item Received</option><option>Changed Mind</option></select></label>
        <label>Replacement product for exchange<select data-replacement-select name="replacement_${escapeHtml(item.lineItemId)}"><option value="" data-title="">Select a replacement (exchange only)</option>${variantOptions}</select><span class="replacement-preview" hidden><img alt="" hidden loading="lazy"><span></span></span></label>
        <label>Replacement quantity<input type="number" name="replacementQty_${escapeHtml(item.lineItemId)}" min="1" value="1"></label>
      </div>
    </div>`;
  }).join("");
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

  const orderHistory = lookup.orderHistory.length ? `<section class="order-history"><h2>Your order history</h2><p class="muted">Recent orders matched to the verified contact you used to find this order.</p>${lookup.orderHistory.map((historyOrder) => `<article class="order-history-row"><div><strong>${escapeHtml(historyOrder.orderNumber)}</strong><small>${new Date(historyOrder.createdAt).toLocaleDateString()} · ${historyOrder.itemCount} item(s)</small></div><strong>${Number(historyOrder.totalPrice).toLocaleString("en-PK")} ${escapeHtml(historyOrder.currency)}</strong><div class="order-history-eligibility"><span class="eligibility-chip ${historyOrder.returnEligible ? "eligible" : "ineligible"}">Return: ${historyOrder.returnEligible ? "Eligible" : "Not eligible"}</span><span class="eligibility-chip ${historyOrder.exchangeEligible ? "eligible" : "ineligible"}">Exchange: ${historyOrder.exchangeEligible ? "Eligible" : "Not eligible"}</span></div><details><summary>Policy details</summary><p>Return: ${escapeHtml(historyOrder.returnMessage)}<br>Exchange: ${escapeHtml(historyOrder.exchangeMessage)}</p></details></article>`).join("")}</section>` : "";
  const defaultRequestType = lookup.eligibilityByType.RETURN.eligible ? "RETURN" : "EXCHANGE";

  return `<section class="order-panel">
    <h2>Order ${escapeHtml(lookup.order.orderNumber)}</h2>
    <p class="muted">Select one or more items, choose the exact quantity, then send your request to the store for review. No shipment is booked at this step.</p>
    <p class="policy"><strong>Return policy:</strong> ${lookup.eligibilityByType.RETURN.eligible ? "Eligible to request" : escapeHtml(lookup.eligibilityByType.RETURN.message)}<br><strong>Exchange policy:</strong> ${lookup.eligibilityByType.EXCHANGE.eligible ? "Eligible to request" : escapeHtml(lookup.eligibilityByType.EXCHANGE.message)}</p>
    <form method="post" action="${escapeHtml(actionPath)}" class="order-request-form">
      <input type="hidden" name="intent" value="SUBMIT_REQUEST"><input type="hidden" name="sessionToken" value="${escapeHtml(sessionToken)}">
      <label>What would you like to do?<select name="requestType" data-return-eligible="${lookup.eligibilityByType.RETURN.eligible ? "true" : "false"}" data-return-message="${escapeHtml(lookup.eligibilityByType.RETURN.message)}" data-exchange-eligible="${lookup.eligibilityByType.EXCHANGE.eligible ? "true" : "false"}" data-exchange-message="${escapeHtml(lookup.eligibilityByType.EXCHANGE.message)}"><option value="RETURN" ${defaultRequestType === "RETURN" ? "selected" : ""}>Return for refund</option><option value="EXCHANGE" ${defaultRequestType === "EXCHANGE" ? "selected" : ""}>Exchange for another product</option></select></label>
      ${items}
      <label>Additional note (optional)<textarea name="customerNote" maxlength="1000" rows="3" placeholder="Add any helpful details"></textarea></label>
      <p class="eligibility-hint" data-eligibility-hint role="status"></p>
      <button data-submit-request type="submit" ${lookup.eligibilityByType[defaultRequestType].eligible ? "" : "disabled"}>Submit request for review</button>
      <p class="muted">The store must review and approve your request. BYNDCART does not book a courier at submission time.</p>
    </form>
  </section>${orderHistory}${history}`;
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
    .item-card{border:1px solid #e2e5e9;border-radius:14px;padding:14px;margin:12px 0;background:#fff}.item-head{display:grid;grid-template-columns:minmax(0,1fr) 92px;gap:12px;align-items:center}.item-select{display:flex;grid-template-columns:auto 1fr;align-items:flex-start;gap:10px;margin:0}.item-select input{width:18px;min-height:18px;flex:0 0 auto;margin-top:2px;accent-color:#111827}.item-select small{display:block;color:#667085;font-weight:400;margin-top:5px;line-height:1.45}.item-image{display:block;width:92px;height:100px;object-fit:cover;border-radius:10px;background:#f0f1f2}.item-image-placeholder{display:flex;align-items:center;justify-content:center;color:#858b91;font-size:11px}.item-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}.item-fields label{margin:8px 0}.item-fields label:nth-child(3){grid-column:span 2}.replacement-preview{display:flex;align-items:center;gap:9px;margin-top:8px;padding:8px;border:1px solid #e6e8eb;border-radius:9px;font-size:12px;color:#42474c}.replacement-preview img{width:44px;height:44px;object-fit:cover;border-radius:6px;background:#f2f3f4}.replacement-preview[hidden]{display:none}.ok{background:#e7f6ee;color:#0f7b4c}.bad,.warn{background:#fff0ef;color:#b42318}.history-row{padding:10px 0;border-bottom:1px solid #eef0f3}.tracking-form{background:#f8fafc}.portal-login-form button,.order-request-form>button{width:100%;min-height:48px;background:#111827;color:#fff;border-radius:10px}.order-request-form>button:disabled{background:#d2d5da;color:#686e75;cursor:not-allowed}.eligibility-hint{font-size:13px;color:#5c6779;margin:8px 0}.order-history-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:14px 0;border-bottom:1px solid #eceef0}.order-history-row small{display:block;margin-top:4px;color:#667085;font-weight:400}.order-history-eligibility{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px}.eligibility-chip{font-size:11px;padding:5px 8px;border-radius:999px;font-weight:700}.eligibility-chip.eligible{background:#eaf6ee;color:#17643b}.eligibility-chip.ineligible{background:#f1f2f3;color:#525960}.order-history-row details{grid-column:1/-1;color:#667085;font-size:12px}.order-history-row summary{cursor:pointer;font-weight:600}.order-history-row p{margin:8px 0 0}
    @media(max-width:520px){.item-fields{grid-template-columns:1fr}.item-fields label:nth-child(3){grid-column:auto}.item-head{grid-template-columns:minmax(0,1fr) 72px}.item-image{width:72px;height:80px}main{padding:20px 12px 40px}.order-history-row{grid-template-columns:minmax(0,1fr) auto}}
  </style></head><body><header>${escapeHtml(brandName || "STORE")}<small>RETURNS &amp; EXCHANGES</small></header><main><h1>Returns and exchanges</h1><p class="muted">Find your order, submit a request, and arrange shipping only after approval.</p>${body}</main>
  <script>
    document.querySelectorAll('[data-replacement-select]').forEach(function(select) {
      function refreshPreview() {
        var card = select.closest('[data-item-card]');
        var preview = card && card.querySelector('.replacement-preview');
        if (!preview) return;
        var option = select.options[select.selectedIndex];
        var image = preview.querySelector('img');
        var title = preview.querySelector('span');
        if (!select.value) { preview.hidden = true; image.hidden = true; image.removeAttribute('src'); title.textContent = ''; return; }
        var imageUrl = option ? option.getAttribute('data-image') || '' : '';
        image.hidden = !imageUrl;
        if (imageUrl) image.src = imageUrl; else image.removeAttribute('src');
        image.alt = option ? option.getAttribute('data-title') || 'Replacement product' : 'Replacement product';
        title.textContent = option ? option.getAttribute('data-title') || option.textContent : '';
        preview.hidden = false;
      }
      select.addEventListener('change', refreshPreview);
      refreshPreview();
    });
    document.querySelectorAll('.order-request-form').forEach(function(form) {
      var requestType = form.querySelector('[name="requestType"]');
      var submit = form.querySelector('[data-submit-request]');
      var hint = form.querySelector('[data-eligibility-hint]');
      function refreshEligibility() {
        var key = requestType.value === 'EXCHANGE' ? 'exchange' : 'return';
        var eligible = requestType.getAttribute('data-' + key + '-eligible') === 'true';
        submit.disabled = !eligible;
        hint.textContent = eligible ? 'Your request will be sent to the store for review.' : requestType.getAttribute('data-' + key + '-message') || 'This request type is not eligible under the store policy.';
      }
      requestType.addEventListener('change', refreshEligibility);
      refreshEligibility();
      form.addEventListener('submit', function(event) {
        var selectedCards = Array.from(form.querySelectorAll('input[name="lineItemId"]:checked')).map(function(input) { return input.closest('[data-item-card]'); });
        if (!selectedCards.length) { event.preventDefault(); hint.textContent = 'Select at least one product to continue.'; return; }
        if (requestType.value === 'EXCHANGE') {
          var missingReplacement = selectedCards.some(function(card) { var select = card.querySelector('[data-replacement-select]'); return !select || !select.value; });
          if (missingReplacement) { event.preventDefault(); hint.textContent = 'Choose a replacement product for every selected item before submitting the exchange.'; return; }
        }
      });
    });
  </script></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] || char));
}
