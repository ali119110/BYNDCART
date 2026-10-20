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
      notice = "You are logged in. Your order history is below.";
      body = accountHome(lastLookup, sessionToken, options.actionPath);
    } else if (intent === "OPEN_ORDER" && form) {
      sessionToken = String(form.get("sessionToken") || "");
      const orderNumber = String(form.get("orderNumber") || "");
      const requestType = String(form.get("requestType") || "RETURN").toUpperCase() === "EXCHANGE" ? "EXCHANGE" : "RETURN";
      lastLookup = await lookupShopperOrder(storeId, sessionToken, orderNumber);
      const allowed = requestType === "EXCHANGE" ? lastLookup.eligibilityByType.EXCHANGE.eligible : lastLookup.eligibilityByType.RETURN.eligible;
      if (!allowed) {
        error = requestType === "EXCHANGE" ? lastLookup.eligibilityByType.EXCHANGE.message : lastLookup.eligibilityByType.RETURN.message;
        body = accountHome(lastLookup, sessionToken, options.actionPath);
      } else {
        body = orderForm(lastLookup, sessionToken, options.actionPath, requestType);
      }
    } else if (intent === "ACCOUNT" && form) {
      sessionToken = String(form.get("sessionToken") || "");
      lastLookup = await lookupShopperOrder(storeId, sessionToken);
      body = accountHome(lastLookup, sessionToken, options.actionPath);
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
        body = orderForm(lastLookup, sessionToken, options.actionPath, requestType);
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
        body = accountHome(lastLookup, sessionToken, options.actionPath);
      }
    } else if (intent === "SUBMIT_TRACKING" && form) {
      sessionToken = String(form.get("sessionToken") || "");
      const requestType = String(form.get("requestType") || "RETURN").toUpperCase() === "EXCHANGE" ? "EXCHANGE" : "RETURN";
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
        ? `Tracking ${result.trackingNumber} was saved. Latest carrier status: ${result.liveStatus.replaceAll("_", " ")}.`
        : `Tracking ${result.trackingNumber} was saved. The store can follow this number, and live status appears when the connected courier responds.`;
      lastLookup = await lookupShopperOrder(storeId, sessionToken);
      body = accountHome(lastLookup, sessionToken, options.actionPath);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "The request could not be completed.";
    if (form && storeId) {
      sessionToken = String(form.get("sessionToken") || "");
      try {
        if (sessionToken) {
          lastLookup = await lookupShopperOrder(storeId, sessionToken);
          body = orderForm(lastLookup, sessionToken, options.actionPath, String(form.get("requestType") || "RETURN").toUpperCase() === "EXCHANGE" ? "EXCHANGE" : "RETURN");
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
    <h2>Login</h2>
    <p class="muted">Enter the order number and the contact detail used at checkout. No verification code is required.</p>
    <label>Order number<input name="orderNumber" required value="${escapeHtml(orderNumber)}" placeholder="#1001" autocomplete="off"></label>
    <label>Login using<select name="identifierType">
      <option value="EMAIL" ${identifierType === "EMAIL" ? "selected" : ""}>Email address</option>
      <option value="PHONE" ${identifierType === "PHONE" ? "selected" : ""}>Phone number</option>
    </select></label>
    <label>Email address or phone number<input name="identifier" required value="${escapeHtml(identifier)}" placeholder="you@example.com or +92 300 1234567" autocomplete="off"></label>
    <input type="hidden" name="intent" value="LOGIN">
    <button type="submit">Login</button>
  </form>`;
}

function accountHome(lookup: ShopperOrderLookupResult, sessionToken: string, actionPath: string) {
  return `${updatesSection(lookup, sessionToken, actionPath)}${guidelines()}${historySection(lookup, sessionToken, actionPath)}`;
}

function guidelines() {
  return `<section class="guidelines"><h2>How to process an exchange</h2><ol>
    <li>Choose an eligible order and submit the return or exchange. The store reviews it before anything is shipped.</li>
    <li>After approval, pack the original item securely.</li>
    <li>Send it with your own courier. BYNDCART does not book the shipment for you.</li>
    <li>Submit the courier name, tracking number, and a photo of the receipt on this page.</li>
    <li>The store uses that tracking number to follow the parcel. A replacement order is created either right after approval or after the store receives and inspects the item, depending on the store setting.</li>
  </ol></section>`;
}

function updatesSection(lookup: ShopperOrderLookupResult, sessionToken: string, actionPath: string) {
  const requests = lookup.accountRequests || [];
  if (!requests.length) return "";
  const cards = requests.map((item) => {
    const replacement = item.type === "EXCHANGE" && item.newOrderNumber
      ? `<p class="ok-inline">Replacement order ${escapeHtml(item.newOrderNumber)} has been created. Ship the original item and submit the tracking details below.</p>`
      : item.type === "EXCHANGE" && item.status === "APPROVED" && lookup.settings.exchangeReplacementTiming === "AFTER_INSPECTION"
        ? `<p>Your exchange is approved. Ship the original item to the store. The replacement order is created after the store receives and inspects it.</p>`
        : item.status === "APPROVED"
          ? `<p>Your ${item.type === "RETURN" ? "return" : "exchange"} is approved. Ship the original item and submit tracking below.</p>`
          : `<p>Status: <strong>${escapeHtml(item.status.replaceAll("_", " "))}</strong></p>`;
    const trackingForm = item.status === "APPROVED" && !item.trackingNumber ? `<form method="post" action="${escapeHtml(actionPath)}" class="tracking-form" enctype="multipart/form-data">
      <h3>Submit tracking for ${escapeHtml(item.orderNumber)}</h3>
      <input type="hidden" name="intent" value="SUBMIT_TRACKING"><input type="hidden" name="sessionToken" value="${escapeHtml(sessionToken)}">
      <input type="hidden" name="requestId" value="${escapeHtml(item.id)}"><input type="hidden" name="requestType" value="${item.type}">
      <label>Carrier/courier name<input name="carrier" required maxlength="80" placeholder="PostEx, Leopards, TCS, DHL, or FedEx"></label>
      <label>Tracking number / airway bill<input name="trackingNumber" required maxlength="120"></label>
      <label>Photo of the receipt or parcel<input type="file" name="proof" accept="image/jpeg,image/png,image/webp" required></label>
      <button type="submit">Submit tracking</button>
    </form>` : item.trackingNumber ? `<p class="muted">Carrier: ${escapeHtml(item.courier || "Not provided")} · Tracking: <strong>${escapeHtml(item.trackingNumber)}</strong>${item.trackingStatus ? ` · Status: ${escapeHtml(item.trackingStatus.replaceAll("_", " "))}` : ""}</p>` : "";
    return `<article class="history-row"><p><strong>${item.type}</strong> · ${escapeHtml(item.orderNumber)}</p>${replacement}${trackingForm}</article>`;
  }).join("");
  return `<section><h2>Your request updates</h2>${cards}</section>`;
}

function historySection(lookup: ShopperOrderLookupResult, sessionToken: string, actionPath: string) {
  if (!lookup.orderHistory.length) return `<section><h2>Your order history</h2><p class="muted">No other orders were found for this contact.</p></section>`;
  const rows = lookup.orderHistory.map((historyOrder) => {
    const chips = [
      historyOrder.returnEligible ? `<span class="eligibility-chip eligible">Return eligible</span>` : "",
      historyOrder.exchangeEligible ? `<span class="eligibility-chip eligible">Exchange eligible</span>` : "",
    ].filter(Boolean).join("");
    const actions = [
      historyOrder.returnEligible ? `<form method="post" action="${escapeHtml(actionPath)}"><input type="hidden" name="intent" value="OPEN_ORDER"><input type="hidden" name="sessionToken" value="${escapeHtml(sessionToken)}"><input type="hidden" name="orderNumber" value="${escapeHtml(historyOrder.orderNumber)}"><input type="hidden" name="requestType" value="RETURN"><button type="submit">Create return</button></form>` : "",
      historyOrder.exchangeEligible ? `<form method="post" action="${escapeHtml(actionPath)}"><input type="hidden" name="intent" value="OPEN_ORDER"><input type="hidden" name="sessionToken" value="${escapeHtml(sessionToken)}"><input type="hidden" name="orderNumber" value="${escapeHtml(historyOrder.orderNumber)}"><input type="hidden" name="requestType" value="EXCHANGE"><button type="submit">Create exchange</button></form>` : "",
    ].filter(Boolean).join("");
    return `<article class="order-history-row"><div><strong>${escapeHtml(historyOrder.orderNumber)}</strong><small>${new Date(historyOrder.createdAt).toLocaleDateString()} · ${historyOrder.itemCount} item(s)</small></div><strong>${Number(historyOrder.totalPrice).toLocaleString("en-PK")} ${escapeHtml(historyOrder.currency)}</strong><div class="order-history-eligibility">${chips}</div><div class="order-actions">${actions}</div></article>`;
  }).join("");
  return `<section class="order-history"><h2>Your order history</h2><p class="muted">Orders matched to the contact you used to log in. Eligible orders show an action. Orders that are outside the store policy are listed without an action.</p>${rows}</section>`;
}

function orderForm(lookup: ShopperOrderLookupResult, sessionToken: string, actionPath = "/apps/returns", requestType: "RETURN" | "EXCHANGE" = "RETURN") {
  const catalogue = JSON.stringify(lookup.replacementVariants.map((variant) => ({
    id: variant.variantId,
    title: variant.title,
    price: Number(variant.price).toFixed(2),
    currency: lookup.order.currency,
    image: variant.imageUrl || "",
  }))).replace(/</g, "\\u003c");
  const items = lookup.order.lineItems.map((item) => {
    const currentVariant = item.variantTitle && item.variantTitle !== "Default Title" ? item.variantTitle : "";
    const image = item.imageUrl
      ? `<img class="item-image" src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.title)}" loading="lazy">`
      : `<div class="item-image item-image-placeholder" aria-label="Product image unavailable">No image</div>`;
    const replacement = requestType === "EXCHANGE" ? `<div class="product-search" data-product-search>
        <label>Replacement product<input type="search" data-product-query placeholder="Type a product name" autocomplete="off"></label>
        <input type="hidden" name="replacement_${escapeHtml(item.lineItemId)}" data-product-id value="">
        <div class="product-results" hidden></div>
        <span class="replacement-preview" hidden><img alt="" hidden loading="lazy"><span></span></span>
      </div>` : "";
    return `<div class="item-card" data-item-card>
      <div class="item-head">
        <label class="item-select"><input type="checkbox" name="lineItemId" value="${escapeHtml(item.lineItemId)}"><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(currentVariant || item.sku || "Variant details unavailable")} · ${Number(item.price).toLocaleString("en-PK")} ${escapeHtml(lookup.order.currency)} · Qty ${item.quantity}</small></span></label>
        ${image}
      </div>
      <div class="item-fields">
        <label>Quantity<input type="number" name="quantity_${escapeHtml(item.lineItemId)}" min="1" max="${Math.max(1, item.quantity)}" value="1"></label>
        <label>Reason<select name="reason_${escapeHtml(item.lineItemId)}"><option>Size Mismatch</option><option>Defective / Damaged</option><option>Wrong Item Received</option><option>Changed Mind</option></select></label>
        ${replacement}
        ${requestType === "EXCHANGE" ? `<label>Replacement quantity<input type="number" name="replacementQty_${escapeHtml(item.lineItemId)}" min="1" value="1"></label>` : ""}
      </div>
    </div>`;
  }).join("");
  const back = `<form method="post" action="${escapeHtml(actionPath)}" class="back-form"><input type="hidden" name="intent" value="ACCOUNT"><input type="hidden" name="sessionToken" value="${escapeHtml(sessionToken)}"><button type="submit" class="secondary">Back to order history</button></form>`;
  return `${updatesSection(lookup, sessionToken, actionPath)}<section class="order-panel">
    <h2>Order ${escapeHtml(lookup.order.orderNumber)}</h2>
    <p class="muted">${requestType === "EXCHANGE" ? "Select the items to exchange, search for the replacement, then send the request for review." : "Select the items to return, then send the request for review."} No shipment is booked at this step.</p>
    ${back}
    <form method="post" action="${escapeHtml(actionPath)}" class="order-request-form">
      <input type="hidden" name="intent" value="SUBMIT_REQUEST"><input type="hidden" name="sessionToken" value="${escapeHtml(sessionToken)}">
      <input type="hidden" name="requestType" value="${requestType}">
      <p class="policy"><strong>${requestType === "EXCHANGE" ? "Exchange" : "Return"}:</strong> Eligible to request</p>
      ${items}
      <label>Additional note (optional)<textarea name="customerNote" maxlength="1000" rows="3" placeholder="Add any helpful details"></textarea></label>
      <p class="eligibility-hint" data-eligibility-hint role="status"></p>
      <button data-submit-request type="submit">Submit ${requestType === "EXCHANGE" ? "exchange" : "return"} for review</button>
    </form>
    <script type="application/json" id="replacement-catalogue">${catalogue}</script>
  </section>`;
}

async function readProofImage(value: FormDataEntryValue | null) {
  if (!(value instanceof File) || value.size < 1) throw new Error("Upload a photo of the shipping receipt or parcel.");
  if (value.size > 900_000) throw new Error("The proof image must be smaller than 900 KB.");
  const bytes = Buffer.from(await value.arrayBuffer());
  const mimeType = imageMimeType(bytes);
  if (!mimeType) throw new Error("Upload a JPEG, PNG, or WebP photo.");
  return { fileName: value.name || "shipping-proof", mimeType, contentBase64: bytes.toString("base64") };
}

function imageMimeType(bytes: Buffer) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "";
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
    .item-card{border:1px solid #e2e5e9;border-radius:14px;padding:14px;margin:12px 0;background:#fff}.item-head{display:grid;grid-template-columns:minmax(0,1fr) 92px;gap:12px;align-items:center}.item-select{display:flex;grid-template-columns:auto 1fr;align-items:flex-start;gap:10px;margin:0}.item-select input{width:18px;min-height:18px;flex:0 0 auto;margin-top:2px;accent-color:#111827}.item-select small{display:block;color:#667085;font-weight:400;margin-top:5px;line-height:1.45}.item-image{display:block;width:92px;height:100px;object-fit:cover;border-radius:10px;background:#f0f1f2}.item-image-placeholder{display:flex;align-items:center;justify-content:center;color:#858b91;font-size:11px}.item-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}.item-fields label{margin:8px 0}.item-fields label:nth-child(3){grid-column:span 2}.replacement-preview{display:flex;align-items:center;gap:9px;margin-top:8px;padding:8px;border:1px solid #e6e8eb;border-radius:9px;font-size:12px;color:#42474c}.replacement-preview img{width:44px;height:44px;object-fit:cover;border-radius:6px;background:#f2f3f4}.replacement-preview[hidden]{display:none}.ok{background:#e7f6ee;color:#0f7b4c}.bad,.warn{background:#fff0ef;color:#b42318}.history-row{padding:10px 0;border-bottom:1px solid #eef0f3}.tracking-form{background:#f8fafc}.portal-login-form button,.order-request-form>button{width:100%;min-height:48px;background:#111827;color:#fff;border-radius:10px}.order-request-form>button:disabled{background:#d2d5da;color:#686e75;cursor:not-allowed}.eligibility-hint{font-size:13px;color:#5c6779;margin:8px 0}.order-history-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:14px 0;border-bottom:1px solid #eceef0}.order-history-row small{display:block;margin-top:4px;color:#667085;font-weight:400}.order-history-eligibility{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px}.eligibility-chip{font-size:11px;padding:5px 8px;border-radius:999px;font-weight:700}.eligibility-chip.eligible{background:#eaf6ee;color:#17643b}.eligibility-chip.ineligible{background:#f1f2f3;color:#525960}.order-actions{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px}.order-actions form{margin:0;padding:0;border:0;background:transparent}.order-actions button,.secondary{min-height:38px;padding:0 12px;border-radius:8px}.secondary{background:#fff;color:#111827;border:1px solid #c9d0d9}.guidelines ol{margin:8px 0 0;padding-left:18px}.guidelines li{margin:6px 0}.ok-inline{background:#e7f6ee;color:#0f7b4c;border-radius:8px;padding:8px 10px}.product-search{grid-column:1/-1;position:relative}.product-results{position:absolute;z-index:5;left:0;right:0;top:100%;background:#fff;border:1px solid #c9d0d9;border-radius:8px;max-height:220px;overflow:auto;box-shadow:0 8px 24px rgba(15,23,42,.08)}.product-results button{width:100%;display:flex;gap:8px;align-items:center;text-align:left;background:#fff;color:#142033;border:0;border-bottom:1px solid #eef0f3;min-height:52px;padding:8px}.product-results img{width:36px;height:36px;object-fit:cover;border-radius:6px}.back-form{margin:0 0 12px;padding:0;border:0;background:transparent}.order-history-row details{grid-column:1/-1;color:#667085;font-size:12px}.order-history-row summary{cursor:pointer;font-weight:600}.order-history-row p{margin:8px 0 0}
    @media(max-width:520px){.item-fields{grid-template-columns:1fr}.item-fields label:nth-child(3){grid-column:auto}.item-head{grid-template-columns:minmax(0,1fr) 72px}.item-image{width:72px;height:80px}main{padding:20px 12px 40px}.order-history-row{grid-template-columns:minmax(0,1fr) auto}}
  </style></head><body><header>${escapeHtml(brandName || "STORE")}<small>RETURNS &amp; EXCHANGES</small></header><main><h1>Returns and exchanges</h1><p class="muted">Log in, review your orders, and arrange shipping only after approval.</p>${body}</main>
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
  </script></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] || char));
}
