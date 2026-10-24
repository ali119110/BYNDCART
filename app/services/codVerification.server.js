import { getDecryptedCourierCredentials } from "./courier.server";

const ORDER_BATCH_SIZE = 100;
const POSTEX_API_ROOT = "https://api.postex.pk/services/integration/api";
const LEOPARDS_PRODUCTION_API_ROOT =
  "https://merchantapi.leopardscourier.com/api";

export function normalizeCodText(value) {
  return String(value || "")
    .replace("#", "")
    .trim()
    .toUpperCase();
}

export function moneyWhole(value) {
  const num = Number.parseFloat(String(value || 0));

  if (Number.isNaN(num)) return 0;

  return Number(num.toFixed(0));
}

export function trackingNumberOf(order) {
  for (const fulfillment of order.fulfillments || []) {
    for (const item of fulfillment.trackingInfo || []) {
      if (item.number) return String(item.number).trim();
    }
  }

  return "";
}

export function trackingCompanyOf(order) {
  for (const fulfillment of order.fulfillments || []) {
    for (const item of fulfillment.trackingInfo || []) {
      if (item.company) return String(item.company).trim();
    }
  }

  return "";
}

export function detectCourier(tracking, company = "") {
  const normalizedTracking = normalizeCodText(tracking);
  const normalizedCompany = normalizeCodText(company);

  if (normalizedCompany.includes("LEOPARD")) return "Leopard";
  if (normalizedCompany.includes("POSTEX")) return "PostEx";
  if (normalizedTracking.startsWith("CX")) return "PostEx";

  return "PostEx";
}

export function isDeliveredStatus(status) {
  const value = normalizeCodText(status);

  if (!value) return false;
  if (value === "DELIVERED") return true;

  return value.startsWith("DELIVERED ");
}

export function isCancelledStatus(status) {
  const value = normalizeCodText(status);

  if (!value) return false;

  return (
    value === "CANCELLED" ||
    value === "CANCELED" ||
    value.includes("CANCELLED") ||
    value.includes("CANCELED")
  );
}

export function isUnassignedStatus(status) {
  const value = normalizeCodText(status);

  if (!value) return false;

  return (
    value.includes("UN-ASSIGNED") ||
    value.includes("UNASSIGNED") ||
    value.includes("UN ASSIGNED")
  );
}

export function isReturnedStatus(status) {
  const value = normalizeCodText(status);

  if (!value) return false;

  return (
    value === "RETURN" ||
    value === "RETURNED" ||
    value.includes("RETURN") ||
    value.includes("RTS") ||
    value.includes("RETURNED TO SHIPPER") ||
    value.includes("RETURN IN PROCESS") ||
    value.includes("OUT FOR RETURN")
  );
}

export function classifyCourierOrder(status) {
  const cancelled = isCancelledStatus(status);
  const unassigned = isUnassignedStatus(status);
  const delivered = isDeliveredStatus(status);
  const returned = !cancelled && !unassigned && isReturnedStatus(status);
  const ignored = cancelled || unassigned;
  const relevant = !ignored && (delivered || returned);

  return { cancelled, unassigned, delivered, returned, ignored, relevant };
}

export function resolvePaymentStatus(classification, settledByCourier) {
  if (classification.cancelled) {
    return {
      paymentStatus: "Cancelled - Ignored",
      paymentReceived: false,
      matched: false,
    };
  }

  if (classification.unassigned) {
    return {
      paymentStatus: "Unassigned - Ignored",
      paymentReceived: false,
      matched: false,
    };
  }

  if (classification.returned) {
    return {
      paymentStatus: "Returned - Payment Not Received",
      paymentReceived: false,
      matched: false,
    };
  }

  if (classification.delivered && settledByCourier) {
    return {
      paymentStatus: "Payment Received",
      paymentReceived: true,
      matched: true,
    };
  }

  return {
    paymentStatus: "Payment Not Confirmed",
    paymentReceived: false,
    matched: false,
  };
}

export function isPaidStatus(status) {
  const value = normalizeCodText(status);

  if (!value) return false;

  if (
    value.includes("UNPAID") ||
    value.includes("NOT PAID") ||
    value.includes("PENDING") ||
    value.includes("HOLD") ||
    value.includes("NOT CONFIRMED")
  ) {
    return false;
  }

  return (
    value.includes("PAID") ||
    value.includes("SETTLED") ||
    value.includes("CLEARED") ||
    value.includes("TRANSFERRED") ||
    value.includes("RELEASED") ||
    value.includes("CHEQUE") ||
    value.includes("PAYMENT RECEIVED")
  );
}

export function isDeliveredPaymentReceived(item) {
  return (
    item.delivered === true &&
    item.paymentReceived === true &&
    item.returned !== true &&
    item.ignored !== true &&
    item.cancelled !== true &&
    item.unassigned !== true
  );
}

export function isSafeToMarkPaid(item) {
  return isDeliveredPaymentReceived(item) && item.matched === true;
}

function summaryAmount(item) {
  return item.courierAmount > 0 ? item.courierAmount : item.shopifyAmount;
}

export function computeVerifySummary(results, taxPercent = 4) {
  let deliveredPaymentReceivedCount = 0;
  let deliveredPaymentReceivedAmount = 0;
  let returnedCount = 0;
  let returnedCodAmount = 0;
  let ignoredCount = 0;
  let totalDeliveryCharges = 0;

  for (const item of results) {
    if (item.ignored) ignoredCount += 1;

    if (item.returned) {
      returnedCount += 1;
      returnedCodAmount += summaryAmount(item);
    }

    if (isDeliveredPaymentReceived(item)) {
      deliveredPaymentReceivedCount += 1;
      deliveredPaymentReceivedAmount += summaryAmount(item);
      totalDeliveryCharges += Number(item.deliveryCharges || 0);
    }
  }

  const rate = Math.min(100, Math.max(0, Number(taxPercent) || 0)) / 100;
  const tax = Number((deliveredPaymentReceivedAmount * rate).toFixed(0));

  return {
    deliveredPaymentReceivedCount,
    deliveredPaymentReceivedAmount,
    returnedCount,
    returnedCodAmount,
    ignoredCount,
    totalDeliveryCharges,
    tax,
    expectedAmount: deliveredPaymentReceivedAmount - tax - totalDeliveryCharges,
  };
}

function formatPaymentDate(raw) {
  if (!raw) return "-";
  const parsed = new Date(raw);

  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleDateString("en-PK", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }

  return raw;
}

export function parsePostExResult(order, tracking, trackingData, paymentData) {
  const shopifyAmount = moneyWhole(order.totalPriceSet.shopMoney.amount);
  const dist = trackingData?.dist || trackingData || {};
  const status =
    dist.transactionStatus || dist.orderStatus || dist.shipmentStatus || "";
  const courierAmount = moneyWhole(
    dist.invoicePayment || dist.invoiceAmount || 0,
  );
  const payDist = paymentData?.dist || paymentData || {};
  const settleFlag = payDist.settle;
  const settledByPostEx = settleFlag === true || settleFlag === "true";
  const classification = classifyCourierOrder(status);
  const payment = resolvePaymentStatus(classification, settledByPostEx);
  const paymentStatusRaw = classification.ignored
    ? classification.cancelled
      ? "Cancelled — ignored"
      : "Unassigned — ignored"
    : classification.returned
      ? `Returned — settlement ignored (settle=${settleFlag})`
      : settledByPostEx
        ? "Settled (settle=true)"
        : settleFlag === false || settleFlag === "false"
          ? "Not settled (settle=false)"
          : "No payment data";

  return {
    orderId: order.id,
    orderName: order.name,
    tracking,
    courier: "PostEx",
    shopifyAmount,
    courierAmount,
    deliveryCharges: moneyWhole(dist.transactionFee || 0),
    courierStatus: status || "Unknown",
    paymentStatus: payment.paymentStatus,
    amountMatched: courierAmount === shopifyAmount,
    ...classification,
    settledByCourier: settledByPostEx,
    paymentReceived: payment.paymentReceived,
    matched: payment.matched,
    rawPaymentStatus: paymentStatusRaw,
    paymentDate: formatPaymentDate(
      payment.paymentReceived
        ? String(
            payDist.settlementDate ||
              payDist.upfrontPaymentDate ||
              payDist.reservePaymentDate ||
              "",
          ).trim()
        : "",
    ),
  };
}

export function parseLeopardResult(order, tracking, trackingData, paymentData) {
  const shopifyAmount = moneyWhole(order.totalPriceSet.shopMoney.amount);
  const packet = trackingData?.packet_list?.[0] || {};
  const paymentRow = paymentData?.payment_list?.[0] || {};
  const courierAmount = moneyWhole(packet.booked_packet_collect_amount);
  const status = packet.booked_packet_status || "";
  const paymentStatusRaw =
    paymentRow.status ||
    paymentRow.message ||
    paymentRow.payment_status ||
    JSON.stringify(paymentData || {});
  const settledByCourier = isPaidStatus(paymentStatusRaw);
  const classification = classifyCourierOrder(status);
  const payment = resolvePaymentStatus(classification, settledByCourier);

  return {
    orderId: order.id,
    orderName: order.name,
    tracking,
    courier: "Leopard",
    shopifyAmount,
    courierAmount,
    deliveryCharges: moneyWhole(
      packet.delivery_charges ||
        packet.booked_packet_charges ||
        paymentRow.delivery_charges ||
        paymentRow.service_charges ||
        0,
    ),
    courierStatus: status || "Unknown",
    paymentStatus: payment.paymentStatus,
    amountMatched: courierAmount === shopifyAmount,
    ...classification,
    settledByCourier,
    paymentReceived: payment.paymentReceived,
    matched: payment.matched,
    rawPaymentStatus: paymentStatusRaw || "Not found",
    paymentDate: formatPaymentDate(
      payment.paymentReceived
        ? String(paymentRow.invoice_cheque_date || "").trim()
        : "",
    ),
  };
}

function errorResult(order, message) {
  const tracking = trackingNumberOf(order);

  return {
    orderId: order.id,
    orderName: order.name,
    tracking,
    courier: detectCourier(tracking, trackingCompanyOf(order)),
    shopifyAmount: moneyWhole(order.totalPriceSet?.shopMoney?.amount),
    courierAmount: 0,
    deliveryCharges: 0,
    courierStatus: "Courier API Error",
    paymentStatus: message,
    amountMatched: false,
    cancelled: false,
    unassigned: false,
    returned: false,
    ignored: false,
    relevant: false,
    settledByCourier: false,
    delivered: false,
    paymentReceived: false,
    matched: false,
    rawPaymentStatus: message,
    paymentDate: "-",
  };
}

async function readJson(response) {
  const text = await response.text();

  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

function leopardsRoot(_credentials) {
  // COD reconciliation always uses the production carrier account; ignore legacy UI settings.
  return LEOPARDS_PRODUCTION_API_ROOT;
}

async function postExTracking(tracking, token) {
  const response = await fetch(
    `${POSTEX_API_ROOT}/order/v1/track-order/${encodeURIComponent(tracking)}`,
    {
      headers: { token, Accept: "application/json" },
    },
  );
  const data = await readJson(response);

  if (!response.ok)
    throw new Error(`PostEx tracking error: ${JSON.stringify(data)}`);

  return data;
}

async function postExPayment(tracking, token) {
  const response = await fetch(
    `${POSTEX_API_ROOT}/order/v1/payment-status/${encodeURIComponent(tracking)}`,
    {
      headers: { token, Accept: "application/json" },
    },
  );
  const data = await readJson(response);

  if (!response.ok)
    return {
      statusCode: response.status,
      statusMessage: "PAYMENT STATUS API ERROR",
      raw: data,
    };

  return data;
}

async function leopardTracking(tracking, apiKey, apiPassword, root) {
  const response = await fetch(`${root}/trackBookedPacket/format/json/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      api_password: apiPassword,
      track_numbers: tracking,
    }),
  });
  const data = await readJson(response);

  if (!response.ok)
    throw new Error(`Leopard tracking error: ${JSON.stringify(data)}`);

  return data;
}

async function leopardPayment(tracking, apiKey, apiPassword, root) {
  const params = new URLSearchParams({
    api_key: apiKey,
    api_password: apiPassword,
    cn_numbers: tracking,
  });
  const response = await fetch(
    `${root}/getPaymentDetails/format/json/?${params.toString()}`,
  );
  const data = await readJson(response);

  if (!response.ok)
    return { status: 0, error: "PAYMENT DETAILS API ERROR", raw: data };

  return data;
}

function credentialField(credentials, key) {
  if (!credentials) return "";

  return String(credentials.credentials?.[key] || credentials[key] || "");
}

async function loadCourierSecrets(shopifyStoreId) {
  const [postex, leopards] = await Promise.all([
    getDecryptedCourierCredentials(shopifyStoreId, "POSTEX"),
    getDecryptedCourierCredentials(shopifyStoreId, "LEOPARDS"),
  ]);

  return {
    postex: postex
      ? {
          apiToken:
            credentialField(postex, "apiToken") ||
            String(postex.apiToken || ""),
        }
      : null,
    leopards: leopards
      ? {
          apiKey: credentialField(leopards, "apiKey"),
          apiPassword: credentialField(leopards, "apiPassword"),
        }
      : null,
  };
}

async function verifySingleOrder(order, secrets) {
  const tracking = trackingNumberOf(order);
  const company = trackingCompanyOf(order);
  const courier = detectCourier(tracking, company);

  if (!tracking)
    throw new Error("This fulfilled order has no tracking number.");

  if (courier === "Leopard") {
    const apiKey = secrets.leopards?.apiKey || "";
    const apiPassword = secrets.leopards?.apiPassword || "";

    if (!apiKey || !apiPassword)
      throw new Error("Leopards is not connected for this store.");
    const root = leopardsRoot(secrets.leopards);
    const trackingData = await leopardTracking(
      tracking,
      apiKey,
      apiPassword,
      root,
    );
    const paymentData = await leopardPayment(
      tracking,
      apiKey,
      apiPassword,
      root,
    );

    return parseLeopardResult(order, tracking, trackingData, paymentData);
  }

  const token = secrets.postex?.apiToken || "";

  if (!token) throw new Error("PostEx is not connected for this store.");
  const trackingData = await postExTracking(tracking, token);
  const paymentData = await postExPayment(tracking, token);

  return parsePostExResult(order, tracking, trackingData, paymentData);
}

const PENDING_ORDERS_QUERY = `#graphql
  query CodPendingOrders($first: Int!, $after: String) {
    orders(
      first: $first
      after: $after
      query: "financial_status:pending fulfillment_status:fulfilled"
      sortKey: CREATED_AT
      reverse: false
    ) {
      edges {
        cursor
        node {
          id
          name
          displayFinancialStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          fulfillments(first: 10) { trackingInfo { number company } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const PENDING_COUNT_QUERY = `#graphql
  query CodPendingCount {
    ordersCount(query: "financial_status:pending fulfillment_status:fulfilled") { count }
  }
`;
const ORDER_QUERY = `#graphql
  query CodOrder($id: ID!) {
    order(id: $id) {
      id
      name
      displayFinancialStatus
      displayFulfillmentStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      fulfillments(first: 10) { trackingInfo { number company } }
    }
  }
`;
const MARK_PAID_MUTATION = `#graphql
  mutation CodMarkPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) {
      order { id name displayFinancialStatus }
      userErrors { field message }
    }
  }
`;

async function graphql(admin, query, variables) {
  if (!admin?.graphql)
    throw new Error("Shopify admin is not available for this store.");
  const response = await admin.graphql(
    query,
    variables ? { variables } : undefined,
  );
  const payload = await response.json();

  if (payload.errors?.length) {
    throw new Error(
      payload.errors
        .map((error) => error.message || "Shopify request failed")
        .join(" "),
    );
  }

  return payload.data;
}

export async function verifyCodBatch(
  admin,
  shopifyStoreId,
  cursor,
  taxPercent = 4,
) {
  const data = await graphql(admin, PENDING_ORDERS_QUERY, {
    first: ORDER_BATCH_SIZE,
    after: cursor || null,
  });
  const orders = (data?.orders?.edges || []).map((edge) => edge.node);
  const secrets = await loadCourierSecrets(shopifyStoreId);
  const results = [];

  for (const order of orders) {
    try {
      results.push(await verifySingleOrder(order, secrets));
    } catch (error) {
      results.push(
        errorResult(
          order,
          error instanceof Error ? error.message : "Courier check failed.",
        ),
      );
    }
  }

  const summary = computeVerifySummary(results, taxPercent);

  return {
    batchSize: ORDER_BATCH_SIZE,
    total: results.length,
    relevant: results.filter((item) => item.relevant).length,
    ignored: results.filter((item) => item.ignored).length,
    hidden: results.filter((item) => !item.relevant && !item.ignored).length,
    matched: results.filter((item) => item.matched).length,
    ...summary,
    hasNextPage: Boolean(data?.orders?.pageInfo?.hasNextPage),
    nextCursor: data?.orders?.pageInfo?.endCursor || null,
    results,
  };
}

export async function countPendingCodOrders(admin) {
  try {
    const data = await graphql(admin, PENDING_COUNT_QUERY);
    const count = data?.ordersCount?.count;

    return typeof count === "number" && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

export async function markVerifiedCodPaid(admin, shopifyStoreId, orderId) {
  if (!orderId.startsWith("gid://shopify/Order/")) {
    throw new Error("A Shopify order id is required.");
  }

  const data = await graphql(admin, ORDER_QUERY, { id: orderId });
  const order = data?.order;

  if (!order) throw new Error("That order was not found in this store.");

  if (String(order.displayFinancialStatus || "").toUpperCase() !== "PENDING") {
    throw new Error(
      `${order.name} is not pending payment, so it was not marked paid.`,
    );
  }

  if (
    String(order.displayFulfillmentStatus || "").toUpperCase() !== "FULFILLED"
  ) {
    throw new Error(
      `${order.name} is not fulfilled, so it was not marked paid.`,
    );
  }

  const checked = await verifySingleOrder(
    order,
    await loadCourierSecrets(shopifyStoreId),
  );

  if (!isSafeToMarkPaid(checked)) {
    throw new Error(
      `${order.name} is not a delivered and settled COD order, so it was not marked paid.`,
    );
  }

  const marked = await graphql(admin, MARK_PAID_MUTATION, {
    input: { id: orderId },
  });
  const errors = marked?.orderMarkAsPaid?.userErrors || [];

  if (errors.length) {
    throw new Error(
      errors
        .map(
          (error) => error.message || "Shopify refused to mark the order paid.",
        )
        .join(" "),
    );
  }

  return {
    orderId,
    orderName: marked?.orderMarkAsPaid?.order?.name || order.name,
    courier: checked.courier,
    tracking: checked.tracking,
    shopifyAmount: checked.shopifyAmount,
    courierAmount: checked.courierAmount,
    deliveryCharges: checked.deliveryCharges,
    paymentDate: checked.paymentDate,
    amountMatched: checked.amountMatched,
  };
}
