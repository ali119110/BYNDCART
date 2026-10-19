import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useState } from "react";
import { resolvePortalStore } from "../services/portalAccess.server";
import { lookupShopperOrder, submitShopperReturn, ShopperOrderLookupResult } from "../services/portal.server";
import { requestCustomerOTP, verifyCustomerOTP } from "../services/otp.server";
import { CourierRegistry, getDefaultMerchantCourier, getStoreCourierConfigs } from "../services/courier.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const { shop, shopifyStoreId } = await resolvePortalStore(url.searchParams.get("shop"));
  const adapters = CourierRegistry.getRegisteredAdapters();
  const storeCourierConfigs = await getStoreCourierConfigs(shopifyStoreId);
  const configuredByProvider = new Map(storeCourierConfigs.map((config) => [config.providerName, config]));
  const availableCouriers = adapters.map((adapter) => {
    const config = configuredByProvider.get(adapter.providerName);
    return {
      ...adapter,
      liveBookingConfigured: Boolean(adapter.isLive && config?.enabled && config?.hasToken),
    };
  });
  const defaultReturnCourier = await getDefaultMerchantCourier(shopifyStoreId, "REVERSE");
  return {
    shop,
    shopifyStoreId,
    availableCouriers,
    defaultReturnCourier: defaultReturnCourier.providerName,
    embedded: url.searchParams.get("embedded") === "1",
    storefrontUrl: `https://${shop}/apps/returns`,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const { shopifyStoreId } = await resolvePortalStore(String(formData.get("shop") || new URL(request.url).searchParams.get("shop") || ""));
  const intent = formData.get("intent") as string;

  if (intent === "REQUEST_OTP") {
    const orderNumber = (formData.get("orderNumber") as string) || "";
    const customerEmail = (formData.get("customerEmail") as string) || "";

    try {
      const otpReqResult = await requestCustomerOTP(shopifyStoreId, orderNumber, customerEmail);
      return {
        success: true,
        step: otpReqResult.emailSent ? "OTP_SENT" : "REQUEST",
        message: otpReqResult.message,
        emailSent: Boolean(otpReqResult.emailSent),
        orderNumber,
        customerEmail,
      };
    } catch (err: any) {
      return { success: false, error: err.message || "Failed to request verification code" };
    }
  }

  if (intent === "VERIFY_OTP") {
    const orderNumber = (formData.get("orderNumber") as string) || "";
    const customerEmail = (formData.get("customerEmail") as string) || "";
    const otpCode = (formData.get("otpCode") as string) || "";

    try {
      const verifyResult = await verifyCustomerOTP(shopifyStoreId, orderNumber, customerEmail, otpCode);
      if (!verifyResult.success || !verifyResult.sessionToken) {
        return { success: false, error: verifyResult.error || "OTP verification failed" };
      }

      // Fetch order details now that user is verified
      const lookupResult = await lookupShopperOrder(shopifyStoreId, verifyResult.sessionToken);

      return {
        success: true,
        step: "AUTHENTICATED",
        sessionToken: verifyResult.sessionToken,
        lookupResult,
      };
    } catch (err: any) {
      return { success: false, error: err.message || "OTP verification failed" };
    }
  }

  if (intent === "SUBMIT_RETURN") {
    const sessionToken = (formData.get("sessionToken") as string) || "";
    const shopifyOrderId = formData.get("shopifyOrderId") as string;
    const orderNumber = formData.get("orderNumber") as string;
    const customerEmail = formData.get("customerEmail") as string;
    const customerName = formData.get("customerName") as string;
    const courier = formData.get("courier") as string;
    const customerPhone = String(formData.get("customerPhone") || "");
    const pickupAddress = String(formData.get("pickupAddress") || "");
    const reason = formData.get("reason") as string;
    const itemsJson = formData.get("items") as string;

    try {
      const items = itemsJson ? JSON.parse(itemsJson) : [];
      const returnResult = await submitShopperReturn({
        shopifyStoreId,
        shopifyOrderId,
        orderNumber,
        customerEmail,
        customerName,
        courier,
        customerPhone,
        pickupAddress,
        reason,
        sessionToken,
        items,
      });

      return { success: true, returnResult };
    } catch (err: any) {
      return { success: false, error: err.message || "Return submission failed" };
    }
  }

  return { success: false, error: "Invalid action intent" };
};

export default function ShopperPortal() {
  const { shop, availableCouriers, defaultReturnCourier, embedded, storefrontUrl } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<any>();

  // State management
  const [orderNumberInput, setOrderNumberInput] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [otpCodeInput, setOtpCodeInput] = useState("");

  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [selectedItems, setSelectedItems] = useState<Record<string, { quantity: number; reason: string }>>({});
  const [selectedCourier, setSelectedCourier] = useState(defaultReturnCourier || "TCS");
  const [pickupPhoneInput, setPickupPhoneInput] = useState("");
  const [pickupAddressInput, setPickupAddressInput] = useState("");
  const [pickupDetailsError, setPickupDetailsError] = useState("");
  const [generalReason, setGeneralReason] = useState("Size Mismatch");

  const isSubmitting = fetcher.state !== "idle";
  const actionData = fetcher.data;

  // Sync state from server responses
  const currentStep = actionData?.step || (sessionToken ? "AUTHENTICATED" : "REQUEST");
  const lookupData: ShopperOrderLookupResult | undefined = actionData?.lookupResult;
  const returnResult = actionData?.returnResult;
  const errorMsg = actionData?.error;
  const infoMsg = actionData?.message;

  if (actionData?.sessionToken && actionData.sessionToken !== sessionToken) {
    setSessionToken(actionData.sessionToken);
  }

  const toggleItemSelection = (lineItemId: string) => {
    setSelectedItems((prev) => {
      const copy = { ...prev };
      if (copy[lineItemId]) {
        delete copy[lineItemId];
      } else {
        copy[lineItemId] = { quantity: 1, reason: "Size Mismatch" };
      }
      return copy;
    });
  };

  const handleItemQuantityChange = (lineItemId: string, qty: number) => {
    setSelectedItems((prev) => {
      if (!prev[lineItemId]) return prev;
      return { ...prev, [lineItemId]: { ...prev[lineItemId], quantity: qty } };
    });
  };

  const handleItemReasonChange = (lineItemId: string, reason: string) => {
    setSelectedItems((prev) => {
      if (!prev[lineItemId]) return prev;
      return { ...prev, [lineItemId]: { ...prev[lineItemId], reason } };
    });
  };

  // Compute live PKR totals for authenticated view
  let totalSelectedPKR = 0;
  if (lookupData?.order?.lineItems) {
    for (const item of lookupData.order.lineItems) {
      if (selectedItems[item.lineItemId]) {
        totalSelectedPKR += item.price * selectedItems[item.lineItemId].quantity;
      }
    }
  }

  const restockingFeePercent = lookupData?.settings?.restockingFeePercent || 0;
  const restockingFeePKR = Math.round((totalSelectedPKR * restockingFeePercent) / 100);
  const selectedCourierHasLiveBooking = Boolean(
    availableCouriers.find((courier) => courier.providerName === selectedCourier)?.liveBookingConfigured
  );
  const netRefundPKR = Math.max(0, totalSelectedPKR - restockingFeePKR);

  const selectedItemsCount = Object.keys(selectedItems).length;

  const handleSubmitReturn = () => {
    if (!lookupData || !sessionToken) return;
    if (selectedCourierHasLiveBooking && (!pickupPhoneInput.trim() || !pickupAddressInput.trim())) {
      setPickupDetailsError("PostEx needs a pickup phone number and a full pickup address before it can book the return.");
      return;
    }
    setPickupDetailsError("");

    const payloadItems = Object.entries(selectedItems).map(([lineItemId, data]) => {
      const original = lookupData.order.lineItems.find((li) => li.lineItemId === lineItemId);
      return {
        shopifyLineItemId: lineItemId,
        quantity: data.quantity,
        reason: data.reason,
        price: original?.price || 0,
      };
    });

    fetcher.submit(
      {
        intent: "SUBMIT_RETURN",
        shop,
        sessionToken,
        shopifyOrderId: lookupData.order.shopifyOrderId,
        orderNumber: lookupData.order.orderNumber,
        customerEmail: lookupData.order.customerEmail,
        customerName: lookupData.order.customerName,
        courier: selectedCourier,
        customerPhone: pickupPhoneInput,
        pickupAddress: pickupAddressInput,
        reason: generalReason,
        items: JSON.stringify(payloadItems),
      },
      { method: "post" }
    );
  };

  const handleResetSession = () => {
    setSessionToken(null);
    setOrderNumberInput("");
    setEmailInput("");
    setOtpCodeInput("");
    setSelectedItems({});
    window.location.reload();
  };

  if (embedded) {
    return (
      <div style={{ maxWidth: "640px", margin: "40px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ background: "#fff", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "24px" }}>
          <h1 style={{ fontSize: "22px", margin: "0 0 8px" }}>Customer returns stay on your store</h1>
          <p style={{ color: "#5c5f62", marginTop: 0 }}>
            Shoppers should not use this admin screen. Add the store link to the footer. It opens on the store website.
          </p>
          <p style={{ fontFamily: "monospace", wordBreak: "break-all" }}>{storefrontUrl}</p>
          <a href={storefrontUrl} target="_top">Open the store page</a>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: "760px", margin: "40px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ textAlign: "center", marginBottom: "32px" }}>
        <h1 style={{ fontSize: "28px", fontWeight: "bold", margin: "0 0 8px 0" }}>Pakistani Shopper Return Portal 🇵🇰</h1>
        <p style={{ color: "#5c5f62", margin: 0 }}>
          Secure 2-Factor verified self-service return & exchange booking across Pakistan
        </p>
      </div>

      {/* SUCCESS CONFIRMATION SCREEN */}
      {returnResult ? (
        <div style={{ backgroundColor: returnResult.bookingConfirmed ? "#f1f8f5" : "#fff8eb", border: `1px solid ${returnResult.bookingConfirmed ? "#008060" : "#e08c00"}`, borderRadius: "8px", padding: "32px", textAlign: "center" }}>
          <h2 style={{ color: returnResult.bookingConfirmed ? "#008060" : "#8a6116", margin: "0 0 12px 0" }}>
            {returnResult.bookingConfirmed ? "Return booking confirmed" : "Return request recorded"}
          </h2>
          <p style={{ fontSize: "16px", margin: "0 0 24px 0" }}>
            {returnResult.bookingConfirmed
              ? <>The courier confirmed the pickup for order <strong>{returnResult.orderNumber}</strong>.</>
              : <>Your return request for order <strong>{returnResult.orderNumber}</strong> was recorded. The airway bill is still pending. {returnResult.bookingMessage}</>}
          </p>

          <div style={{ backgroundColor: "#fff", padding: "20px", borderRadius: "6px", textAlign: "left", marginBottom: "24px" }}>
            <div style={{ marginBottom: "8px" }}>
              <strong>Return Reference ID:</strong> {returnResult.returnRequestId}
            </div>
            <div style={{ marginBottom: "8px" }}>
              <strong>Pickup Courier:</strong> {returnResult.courier}
            </div>
            {returnResult.bookingConfirmed && returnResult.trackingNumber && (
              <div style={{ marginBottom: "8px" }}>
                <strong>Consignment Tracking CN:</strong> <span style={{ fontFamily: "monospace", color: "#2c6ecb" }}>{returnResult.trackingNumber}</span>
              </div>
            )}
            <div style={{ margin: "16px 0 0 0", paddingTop: "12px", borderTop: "1px solid #e1e3e5" }}>
              <strong>Estimated Net Refund (PKR):</strong> <span style={{ fontSize: "18px", color: "#008060", fontWeight: "bold" }}>Rs. {returnResult.summaryPKR?.netRefundAmount?.toLocaleString()}</span>
            </div>
          </div>

          {returnResult.labelUrl && (
            <a
              href={returnResult.labelUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                display: "inline-block",
                padding: "10px 20px",
                backgroundColor: "#008060",
                color: "#fff",
                borderRadius: "4px",
                textDecoration: "none",
                fontWeight: "bold",
              }}
            >
              Download Pickup Label / CN
            </a>
          )}
        </div>
      ) : (
        <>
          {/* ERROR & INFO ALERTS */}
          {errorMsg && (
            <div style={{ backgroundColor: "#fdf2f2", border: "1px solid #d72c0d", borderRadius: "6px", padding: "16px", color: "#d72c0d", marginBottom: "20px" }}>
              {errorMsg}
            </div>
          )}

          {infoMsg && (
            <div style={{ backgroundColor: "#f4f9f7", border: "1px solid #008060", borderRadius: "6px", padding: "16px", color: "#008060", marginBottom: "20px" }}>
              {infoMsg}
            </div>
          )}

          {/* STEP 1: ORDER NUMBER & EMAIL INPUT (REQUEST OTP) */}
          {currentStep === "REQUEST" && (
            <div style={{ backgroundColor: "#fff", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "24px", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
              <h3 style={{ margin: "0 0 8px 0", fontSize: "18px" }}>Step 1: Access Your Order</h3>
              <p style={{ fontSize: "13px", color: "#6d7175", marginBottom: "20px" }}>
                Enter your order number and email/phone to receive a 6-digit verification code.
              </p>
              <fetcher.Form method="post">
                <input type="hidden" name="shop" value={shop} />
                <input type="hidden" name="intent" value="REQUEST_OTP" />
                <div style={{ marginBottom: "16px" }}>
                  <label style={{ display: "block", marginBottom: "6px", fontSize: "14px", fontWeight: 500 }}>
                    Order Number (e.g. #1001)
                  </label>
                  <input
                    type="text"
                    name="orderNumber"
                    required
                    placeholder="#1001"
                    value={orderNumberInput}
                    onChange={(e) => setOrderNumberInput(e.target.value)}
                    style={{ width: "100%", padding: "10px", border: "1px solid #c9cccf", borderRadius: "4px", fontSize: "14px" }}
                  />
                </div>

                <div style={{ marginBottom: "20px" }}>
                  <label style={{ display: "block", marginBottom: "6px", fontSize: "14px", fontWeight: 500 }}>
                    Email Address or Phone
                  </label>
                  <input
                    type="email"
                    name="customerEmail"
                    required
                    placeholder="customer@example.com"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    style={{ width: "100%", padding: "10px", border: "1px solid #c9cccf", borderRadius: "4px", fontSize: "14px" }}
                  />
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting}
                  style={{
                    width: "100%",
                    padding: "12px",
                    backgroundColor: "#008060",
                    color: "#fff",
                    border: "none",
                    borderRadius: "4px",
                    fontSize: "15px",
                    fontWeight: "bold",
                    cursor: "pointer",
                  }}
                >
                  {isSubmitting ? "Sending Code..." : "Request 6-Digit Verification Code"}
                </button>
              </fetcher.Form>
            </div>
          )}

          {/* STEP 2: VERIFY OTP CODE */}
          {currentStep === "OTP_SENT" && (
            <div style={{ backgroundColor: "#fff", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "24px", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
              <h3 style={{ margin: "0 0 8px 0", fontSize: "18px" }}>Step 2: Enter Verification Code</h3>
              <p style={{ fontSize: "13px", color: "#6d7175", marginBottom: "20px" }}>
                {actionData?.emailSent
                  ? <>We sent a 6-digit verification code to <strong>{actionData?.customerEmail || emailInput}</strong> for order <strong>{actionData?.orderNumber || orderNumberInput}</strong>.</>
                  : actionData?.message || "If an order with those details exists, a verification code has been sent to your email."}
              </p>

              <fetcher.Form method="post">
                <input type="hidden" name="shop" value={shop} />
                <input type="hidden" name="intent" value="VERIFY_OTP" />
                <input type="hidden" name="orderNumber" value={actionData?.orderNumber || orderNumberInput} />
                <input type="hidden" name="customerEmail" value={actionData?.customerEmail || emailInput} />

                <div style={{ marginBottom: "20px" }}>
                  <label style={{ display: "block", marginBottom: "6px", fontSize: "14px", fontWeight: 500 }}>
                    6-Digit Verification Code
                  </label>
                  <input
                    type="text"
                    name="otpCode"
                    required
                    maxLength={6}
                    placeholder="123456"
                    value={otpCodeInput}
                    onChange={(e) => setOtpCodeInput(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "12px",
                      border: "2px solid #008060",
                      borderRadius: "4px",
                      fontSize: "22px",
                      letterSpacing: "8px",
                      textAlign: "center",
                    }}
                  />
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting}
                  style={{
                    width: "100%",
                    padding: "12px",
                    backgroundColor: "#008060",
                    color: "#fff",
                    border: "none",
                    borderRadius: "4px",
                    fontSize: "15px",
                    fontWeight: "bold",
                    cursor: "pointer",
                    marginBottom: "12px",
                  }}
                >
                  {isSubmitting ? "Verifying Code..." : "Verify & View Order Items"}
                </button>

                <div style={{ textAlign: "center", fontSize: "13px" }}>
                  <button
                    type="button"
                    onClick={handleResetSession}
                    style={{ background: "none", border: "none", color: "#005bd3", cursor: "pointer" }}
                  >
                    Change Order or Email
                  </button>
                </div>
              </fetcher.Form>
            </div>
          )}

          {/* STEP 3: AUTHENTICATED ORDER & RETURN SELECTION */}
          {currentStep === "AUTHENTICATED" && lookupData && (
            <div>
              {/* Eligibility Warning */}
              {!lookupData.eligible && (
                <div style={{ backgroundColor: "#fef6e7", border: "1px solid #e08c00", borderRadius: "6px", padding: "16px", marginBottom: "20px" }}>
                  <strong>Ineligible for Standard Online Return:</strong> {lookupData.ineligibilityReason}
                </div>
              )}

              <div style={{ backgroundColor: "#fff", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "24px", marginBottom: "20px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                  <div>
                    <h3 style={{ margin: 0 }}>Order {lookupData.order.orderNumber}</h3>
                    <div style={{ fontSize: "13px", color: "#6d7175" }}>Placed on {new Date(lookupData.order.createdAt).toLocaleDateString()}</div>
                  </div>
                  <button
                    onClick={handleResetSession}
                    style={{ background: "none", border: "none", color: "#005bd3", cursor: "pointer", fontSize: "13px" }}
                  >
                    Log Out / Switch Order
                  </button>
                </div>

                <h4 style={{ margin: "16px 0 12px 0", fontSize: "15px" }}>Select Items to Return:</h4>

                {lookupData.order.lineItems.map((item) => {
                  const isSelected = !!selectedItems[item.lineItemId];
                  return (
                    <div
                      key={item.lineItemId}
                      style={{
                        display: "flex",
                        gap: "16px",
                        alignItems: "center",
                        padding: "12px",
                        border: isSelected ? "2px solid #008060" : "1px solid #e1e3e5",
                        borderRadius: "6px",
                        marginBottom: "10px",
                        backgroundColor: isSelected ? "#f4f9f7" : "#fff",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleItemSelection(item.lineItemId)}
                        style={{ width: "18px", height: "18px", cursor: "pointer" }}
                      />

                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: "bold" }}>{item.title}</div>
                        <div style={{ fontSize: "13px", color: "#6d7175" }}>Rs. {item.price.toLocaleString()}</div>
                      </div>

                      {isSelected && (
                        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                          <select
                            value={selectedItems[item.lineItemId]?.reason || "Size Mismatch"}
                            onChange={(e) => handleItemReasonChange(item.lineItemId, e.target.value)}
                            style={{ padding: "6px", fontSize: "13px", border: "1px solid #c9cccf", borderRadius: "4px" }}
                          >
                            <option value="Size Mismatch">Size Mismatch</option>
                            <option value="Fabric / Color Difference">Fabric / Color Difference</option>
                            <option value="Defective / Damaged">Defective / Damaged</option>
                            <option value="Wrong Item Received">Wrong Item Received</option>
                            <option value="Changed Mind">Changed Mind</option>
                          </select>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Pakistani Pickup Courier Selection */}
                {selectedItemsCount > 0 && (
                  <div style={{ marginTop: "24px", paddingTop: "20px", borderTop: "1px solid #e1e3e5" }}>
                    <h4 style={{ margin: "0 0 12px 0", fontSize: "15px" }}>Select Doorstep Pickup Courier (Pakistan):</h4>
                    <select
                      value={selectedCourier}
                      onChange={(e) => setSelectedCourier(e.target.value)}
                      style={{ width: "100%", padding: "10px", border: "1px solid #c9cccf", borderRadius: "4px", fontSize: "14px" }}
                    >
                      {availableCouriers.map((c) => (
                        <option key={c.providerName} value={c.providerName}>
                          {c.displayName} — {c.liveBookingConfigured ? "PostEx return API; pickup details required" : "Manual airway bill required"}
                        </option>
                      ))}
                    </select>
                    {selectedCourierHasLiveBooking && (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: "12px", marginTop: "14px" }}>
                        <div>
                          <label htmlFor="pickup-phone" style={{ display: "block", marginBottom: "5px", fontSize: "13px", fontWeight: 600 }}>
                            Pickup phone number
                          </label>
                          <input
                            id="pickup-phone"
                            type="tel"
                            autoComplete="tel"
                            value={pickupPhoneInput}
                            onChange={(e) => { setPickupPhoneInput(e.target.value); setPickupDetailsError(""); }}
                            placeholder="03XX XXXXXXX"
                            required
                            style={{ width: "100%", padding: "10px", border: "1px solid #c9cccf", borderRadius: "4px", fontSize: "14px", boxSizing: "border-box" }}
                          />
                        </div>
                        <div>
                          <label htmlFor="pickup-address" style={{ display: "block", marginBottom: "5px", fontSize: "13px", fontWeight: 600 }}>
                            Pickup address
                          </label>
                          <input
                            id="pickup-address"
                            type="text"
                            autoComplete="street-address"
                            value={pickupAddressInput}
                            onChange={(e) => { setPickupAddressInput(e.target.value); setPickupDetailsError(""); }}
                            placeholder="Full address where the parcel will be collected"
                            required
                            style={{ width: "100%", padding: "10px", border: "1px solid #c9cccf", borderRadius: "4px", fontSize: "14px", boxSizing: "border-box" }}
                          />
                        </div>
                      </div>
                    )}
                    {!selectedCourierHasLiveBooking && (
                      <p style={{ fontSize: "12px", color: "#6d7175", margin: "10px 0 0" }}>
                        BYNDCART will not create a live shipment for this selection. The store will book it with the carrier and add the airway bill manually.
                      </p>
                    )}
                    {pickupDetailsError && (
                      <p role="alert" style={{ fontSize: "12px", color: "#b42318", margin: "10px 0 0" }}>{pickupDetailsError}</p>
                    )}
                  </div>
                )}
              </div>

              {/* STEP 4: PKR REFUND SUMMARY & SUBMIT */}
              {selectedItemsCount > 0 && (
                <div style={{ backgroundColor: "#fff", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "24px" }}>
                  <h3 style={{ margin: "0 0 16px 0", fontSize: "18px" }}>Refund Estimate (PKR)</h3>

                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                    <span>Selected Items Value:</span>
                    <strong>Rs. {totalSelectedPKR.toLocaleString()}</strong>
                  </div>

                  {restockingFeePercent > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px", color: "#d72c0d" }}>
                      <span>Restocking Fee ({restockingFeePercent}%):</span>
                      <span>- Rs. {restockingFeePKR.toLocaleString()}</span>
                    </div>
                  )}

                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px", color: "#6d7175", fontSize: "13px" }}>
                    <span>Courier pickup charge:</span>
                    <span>{selectedCourierHasLiveBooking ? "Not quoted by the current integration" : "Not quoted; airway bill entered manually"}</span>
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: "16px", paddingTop: "12px", borderTop: "1px solid #e1e3e5", fontSize: "18px", fontWeight: "bold" }}>
                    <span>Estimated refund before any unquoted courier fee:</span>
                    <span style={{ color: "#008060" }}>Rs. {netRefundPKR.toLocaleString()}</span>
                  </div>

                  <button
                    onClick={handleSubmitReturn}
                    disabled={isSubmitting || !lookupData.eligible}
                    style={{
                      width: "100%",
                      marginTop: "20px",
                      padding: "14px",
                      backgroundColor: lookupData.eligible ? "#008060" : "#8c9196",
                      color: "#fff",
                      border: "none",
                      borderRadius: "4px",
                      fontSize: "16px",
                      fontWeight: "bold",
                      cursor: lookupData.eligible ? "pointer" : "not-allowed",
                    }}
                  >
                    {isSubmitting ? "Submitting Return Request..." : `Confirm Return Request (Rs. ${netRefundPKR.toLocaleString()})`}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
