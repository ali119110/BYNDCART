import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { normalizeShopDomain, resolvePortalStore } from "../services/portalAccess.server";
import { lookupShopperOrder, submitShopperReturn } from "../services/portal.server";
import { requestCustomerOTP, verifyCustomerOTP } from "../services/otp.server";
import { CourierRegistry, getDefaultMerchantCourier, getStoreCourierConfigs } from "../services/courier.server";

/**
 * Shopify app proxy for https://{store}/apps/returns.
 * The response is the customer page, so the browser stays on the store website.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return renderStorePage(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return renderStorePage(request);
}

async function renderStorePage(request: Request) {
  await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = normalizeShopDomain(url.searchParams.get("shop"));
  if (!shop) {
    return htmlPage("Returns", `<p>Shopify did not include a store domain.</p>`, 400);
  }

  const form = request.method === "POST" ? await request.formData() : null;
  const intent = String(form?.get("intent") || "");
  let notice = "";
  let error = "";
  let body = requestForm();

  try {
    const { shopifyStoreId } = await resolvePortalStore(shop);
    const courierChoices = await loadCourierChoices(shopifyStoreId);

    if (intent === "REQUEST_OTP" && form) {
      const orderNumber = String(form.get("orderNumber") || "");
      const customerEmail = String(form.get("customerEmail") || "");
      const result = await requestCustomerOTP(shopifyStoreId, orderNumber, customerEmail);
      notice = result.message;
      body = result.emailSent ? codeForm(orderNumber, customerEmail) : requestForm(orderNumber, customerEmail);
    } else if (intent === "VERIFY_OTP" && form) {
      const orderNumber = String(form.get("orderNumber") || "");
      const customerEmail = String(form.get("customerEmail") || "");
      const otpCode = String(form.get("otpCode") || "");
      const verified = await verifyCustomerOTP(shopifyStoreId, orderNumber, customerEmail, otpCode);
      if (!verified.success || !verified.sessionToken) {
        error = verified.error || "The verification code was not accepted.";
        body = codeForm(orderNumber, customerEmail);
      } else {
        const lookup = await lookupShopperOrder(shopifyStoreId, verified.sessionToken);
        body = orderForm(lookup, verified.sessionToken, courierChoices);
      }
    } else if (intent === "SUBMIT_RETURN" && form) {
      const sessionToken = String(form.get("sessionToken") || "");
      const lookup = await lookupShopperOrder(shopifyStoreId, sessionToken);
      const selected = new Set(form.getAll("lineItemId").map(String));
      const items = lookup.order.lineItems
        .filter((item) => selected.has(item.lineItemId))
        .map((item) => ({
          shopifyLineItemId: item.lineItemId,
          quantity: 1,
          reason: String(form.get(`reason_${item.lineItemId}`) || "Changed Mind"),
          price: item.price,
        }));
      if (!items.length) {
        error = "Choose at least one item.";
        body = orderForm(lookup, sessionToken, courierChoices);
      } else {
        const result = await submitShopperReturn({
          shopifyStoreId,
          shopifyOrderId: lookup.order.shopifyOrderId,
          orderNumber: lookup.order.orderNumber,
          customerEmail: lookup.order.customerEmail,
          customerName: lookup.order.customerName,
          courier: String(form.get("courier") || courierChoices.defaultCourier),
          customerPhone: String(form.get("customerPhone") || ""),
          pickupAddress: String(form.get("pickupAddress") || ""),
          reason: items[0].reason,
          sessionToken,
          items,
        });
        notice = result.bookingConfirmed
          ? `Return ${result.returnRequestId} was booked with ${result.courier}. Tracking ${result.trackingNumber}.`
          : `Return request ${result.returnRequestId} was recorded. ${result.bookingMessage}`;
        body = `<p>You can close this page.</p>`;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "The request could not be completed.";
    if (form) {
      body = requestForm(String(form.get("orderNumber") || ""), String(form.get("customerEmail") || ""));
    }
  }

  return htmlPage("Returns and exchanges", `${banner(error, notice)}${body}`);
}

function requestForm(orderNumber = "", email = "") {
  return `<form method="post" action="/apps/returns">
    <h2>Start a return or exchange</h2>
    <label>Order number<input name="orderNumber" required value="${escapeHtml(orderNumber)}" placeholder="#1001"></label>
    <label>Email on the order<input type="email" name="customerEmail" required value="${escapeHtml(email)}"></label>
    <input type="hidden" name="intent" value="REQUEST_OTP">
    <button type="submit">Email me a verification code</button>
  </form>`;
}

function codeForm(orderNumber: string, email: string) {
  return `<form method="post" action="/apps/returns">
    <h2>Enter the verification code</h2>
    <input type="hidden" name="intent" value="VERIFY_OTP">
    <input type="hidden" name="orderNumber" value="${escapeHtml(orderNumber)}">
    <input type="hidden" name="customerEmail" value="${escapeHtml(email)}">
    <label>6-digit code<input name="otpCode" required inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label>
    <button type="submit">Verify and view items</button>
  </form>`;
}

async function loadCourierChoices(shopifyStoreId: string) {
  const adapters = CourierRegistry.getRegisteredAdapters();
  const configs = await getStoreCourierConfigs(shopifyStoreId);
  const configured = new Map(configs.map((config) => [config.providerName, config]));
  const defaultCourier = (await getDefaultMerchantCourier(shopifyStoreId, "REVERSE")).providerName;
  return {
    defaultCourier,
    couriers: adapters.map((adapter) => {
      const config = configured.get(adapter.providerName);
      return {
        providerName: adapter.providerName,
        displayName: adapter.displayName,
        liveBookingConfigured: Boolean(adapter.isLive && config?.enabled && config?.hasToken),
      };
    }),
  };
}

function orderForm(
  lookup: Awaited<ReturnType<typeof lookupShopperOrder>>,
  sessionToken: string,
  courierChoices: Awaited<ReturnType<typeof loadCourierChoices>>,
) {
  const items = lookup.order.lineItems.map((item) => `<label class="item">
      <input type="checkbox" name="lineItemId" value="${escapeHtml(item.lineItemId)}">
      <span>${escapeHtml(item.title)} · Rs. ${Number(item.price).toLocaleString("en-PK")}</span>
      <select name="reason_${escapeHtml(item.lineItemId)}">
        <option>Size Mismatch</option>
        <option>Defective / Damaged</option>
        <option>Wrong Item Received</option>
        <option>Changed Mind</option>
      </select>
    </label>`).join("");
  const courierOptions = courierChoices.couriers.map((courier) => {
    const note = courier.liveBookingConfigured ? "PostEx return API; pickup details required" : "Manual airway bill required";
    const selected = courier.providerName === courierChoices.defaultCourier ? " selected" : "";
    return `<option value="${escapeHtml(courier.providerName)}"${selected}>${escapeHtml(courier.displayName)} — ${escapeHtml(note)}</option>`;
  }).join("");
  const liveCourier = courierChoices.couriers.some((courier) => courier.liveBookingConfigured);
  return `<form method="post" action="/apps/returns">
    <h2>Order ${escapeHtml(lookup.order.orderNumber)}</h2>
    ${lookup.eligible ? "" : `<p class="warn">${escapeHtml(lookup.ineligibilityReason || "This order cannot be requested online.")}</p>`}
    <input type="hidden" name="intent" value="SUBMIT_RETURN">
    <input type="hidden" name="sessionToken" value="${escapeHtml(sessionToken)}">
    ${items}
    <label>Pickup courier<select name="courier">${courierOptions}</select></label>
    ${liveCourier ? `<label>Pickup phone<input name="customerPhone" type="tel" autocomplete="tel" placeholder="03XX XXXXXXX"></label>
    <label>Pickup address<input name="pickupAddress" autocomplete="street-address" placeholder="Full address where the parcel will be collected"></label>
    <p>PostEx booking needs both the phone number and the pickup address. Other couriers are recorded without a live shipment.</p>` : `<p>This store has no live courier booking. The request is recorded and the store adds the airway bill after booking with the carrier.</p>`}
    <button type="submit" ${lookup.eligible ? "" : "disabled"}>Submit request</button>
  </form>`;
}

function banner(error: string, notice: string) {
  return `${error ? `<p class="bad">${escapeHtml(error)}</p>` : ""}${notice ? `<p class="ok">${escapeHtml(notice)}</p>` : ""}`;
}

function htmlPage(title: string, body: string, status = 200) {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; font-family: "Plus Jakarta Sans", sans-serif; background: #f6f7f9; color: #142033; }
    main { max-width: 640px; margin: 0 auto; padding: 32px 16px 64px; }
    form, .ok, .bad, .warn { background: #fff; border: 1px solid #e4e8ee; border-radius: 12px; padding: 16px; }
    h1, h2 { font-family: Outfit, sans-serif; margin: 0 0 8px; }
    p { line-height: 1.5; }
    label { display: grid; gap: 6px; margin: 12px 0; font-size: 14px; font-weight: 650; }
    input, select, button { font: inherit; min-height: 42px; border-radius: 8px; }
    input, select { border: 1px solid #c9cccf; padding: 8px 12px; }
    button { background: #1f4b99; color: #fff; border: 0; padding: 0 14px; cursor: pointer; }
    button:disabled { opacity: 0.5; }
    .item { grid-template-columns: auto 1fr; align-items: center; }
    .ok { background: #e7f6ee; color: #0f7b4c; }
    .bad, .warn { background: #fdecea; color: #b42318; }
  </style>
</head>
<body>
  <main>
    <h1>Returns and exchanges</h1>
    <p>Use the order number and the email on that order. The code arrives by email.</p>
    ${body}
  </main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] || char
  ));
}
