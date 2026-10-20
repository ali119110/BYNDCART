function readableStatus(value: unknown) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.toLowerCase().replaceAll("_", " ");
}

function sentence(value: unknown) {
  const text = String(value || "").trim();
  if (!text || text.startsWith("{") || text.startsWith("[")) return "";
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function titleFromAction(action: string) {
  const words = String(action || "Update recorded").replaceAll("_", " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function describeAuditEvent(action: string, metadata?: unknown) {
  const meta = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  const key = String(action || "");
  const orderNumber = sentence(meta.orderNumber);
  const previousStatus = readableStatus(meta.previousStatus);
  const newStatus = readableStatus(meta.newStatus);
  const error = sentence(meta.error || meta.reason);
  const trackingNumber = sentence(meta.trackingNumber);
  const carrier = sentence(meta.carrier);
  const replacementOrder = sentence(meta.replacementOrderNumber || meta.newOrderNumber || meta.draftOrderName);

  if (key === "EXCHANGE_CREATED") {
    return {
      title: "Exchange created",
      description: orderNumber ? `Customer requested an exchange for order ${orderNumber}.` : "Customer requested an exchange.",
    };
  }
  if (key === "RETURN_CREATED") {
    return {
      title: "Return created",
      description: orderNumber ? `Customer requested a return for order ${orderNumber}.` : "Customer requested a return.",
    };
  }
  if (key.startsWith("EXCHANGE_STATUS_TRANSITION_") || key.startsWith("RETURN_STATUS_TRANSITION_")) {
    const kind = key.startsWith("EXCHANGE") ? "Exchange" : "Return";
    const status = readableStatus(key.split("TRANSITION_")[1]) || newStatus || "updated";
    const description = previousStatus && (newStatus || status)
      ? `Status changed from ${previousStatus} to ${newStatus || status}.`
      : `The ${kind.toLowerCase()} is now ${status}.`;
    return { title: `${kind} ${status}`, description };
  }
  if (key === "CUSTOMER_TRACKING_SUBMITTED") {
    const detail = trackingNumber
      ? `Customer submitted tracking ${trackingNumber}${carrier ? ` with ${carrier}` : ""}.`
      : "Customer submitted a tracking number.";
    return { title: "Tracking submitted", description: detail };
  }
  if (key === "SHOPIFY_REPLACEMENT_ORDER_CREATED") {
    return {
      title: "Replacement order created",
      description: replacementOrder ? `Shopify created replacement order ${replacementOrder}.` : "Shopify created the replacement order.",
    };
  }
  if (key === "SHOPIFY_REPLACEMENT_DRAFT_CREATED") {
    return {
      title: "Replacement draft created",
      description: replacementOrder ? `Shopify created replacement draft ${replacementOrder}.` : "Shopify created the replacement draft.",
    };
  }
  if (key === "SHOPIFY_REPLACEMENT_ORDER_FAILED" || key === "SHOPIFY_DRAFT_ORDER_CREATE_FAILED") {
    return {
      title: "Replacement order not created",
      description: error || "Shopify did not create the replacement order.",
    };
  }
  if (key === "SHOPIFY_RETURN_CREATED") {
    return { title: "Return opened", description: "Shopify opened a return on the original order. It shows as return in progress." };
  }
  if (key === "SHOPIFY_RETURN_CREATE_FAILED") {
    return { title: "Return not opened", description: error || "Shopify did not open the return on the original order." };
  }
  if (key === "SHOPIFY_ORDER_TAGS_ADDED") {
    return { title: "Order tagged", description: "The Shopify order tag was added." };
  }
  if (key === "SHOPIFY_ORDER_TAG_ADD_FAILED" || key === "SHOPIFY_ORDER_TAG_ADD_SKIPPED") {
    return { title: "Order tag not added", description: error || "Shopify did not add the order tag." };
  }
  if (key.endsWith("WAREHOUSE_RECEIVED")) {
    return { title: "Received at warehouse", description: trackingNumber ? `Warehouse received tracking ${trackingNumber}.` : "Warehouse received the original item." };
  }
  if (key.endsWith("WAREHOUSE_INSPECTION_COMPLETED")) {
    return { title: "Inspection completed", description: "Warehouse finished inspecting the original item." };
  }
  if (key === "EXCHANGE_POLICY_OVERRIDE" || key === "RETURN_POLICY_OVERRIDE") {
    return { title: "Policy override", description: error || "A merchant policy override was recorded." };
  }
  if (key === "RETURN_SHOPIFY_REFUND_COMPLETED" || key === "SHOPIFY_REFUND_CREATED") {
    return { title: "Refund created", description: "Shopify created the refund." };
  }
  if (key === "RETURN_REFUND_FALLBACK_TO_MANUAL" || key === "SHOPIFY_REFUND_CREATE_FAILED") {
    return { title: "Refund needs attention", description: error || "Shopify did not create the refund, so it is waiting for manual confirmation." };
  }
  if (key === "RETURN_MANUAL_REFUND_PENDING") {
    return { title: "Refund pending", description: "The refund is waiting for manual confirmation." };
  }
  if (key === "EXCHANGE_STORE_CREDIT_ISSUED") {
    return { title: "Store credit issued", description: "Shopify issued store credit for the cheaper replacement." };
  }
  if (key === "EXCHANGE_PAYMENT_INVOICE_SENT") {
    return { title: "Payment invoice sent", description: "Shopify sent the invoice for the additional replacement amount." };
  }

  return {
    title: titleFromAction(key),
    description: error || "Recorded in the request history.",
  };
}
