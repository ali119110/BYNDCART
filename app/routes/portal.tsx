import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useState } from "react";
import { requireTenantContext } from "../services/tenant.server";
import { lookupShopperOrder, submitShopperReturn, ShopperOrderLookupResult } from "../services/portal.server";
import { requestCustomerOTP, verifyCustomerOTP } from "../services/otp.server";
import { CourierRegistry } from "../services/courier.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopifyStoreId } = await requireTenantContext(request);
  const availableCouriers = CourierRegistry.getRegisteredAdapters();
  return { shopifyStoreId, availableCouriers };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shopifyStoreId } = await requireTenantContext(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "REQUEST_OTP") {
    const orderNumber = (formData.get("orderNumber") as string) || "";
    const customerEmail = (formData.get("customerEmail") as string) || "";

    try {
      const otpReqResult = await requestCustomerOTP(shopifyStoreId, orderNumber, customerEmail);
      return {
        success: true,
        step: "OTP_SENT",
        message: otpReqResult.message,
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
  const { availableCouriers } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<any>();

  // State management
  const [orderNumberInput, setOrderNumberInput] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [otpCodeInput, setOtpCodeInput] = useState("");

  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [selectedItems, setSelectedItems] = useState<Record<string, { quantity: number; reason: string }>>({});
  const [selectedCourier, setSelectedCourier] = useState("TCS");
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
  const estimatedPickupChargePKR = 200;
  const netRefundPKR = Math.max(0, totalSelectedPKR - restockingFeePKR - estimatedPickupChargePKR);

  const selectedItemsCount = Object.keys(selectedItems).length;

  const handleSubmitReturn = () => {
    if (!lookupData || !sessionToken) return;

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
        sessionToken,
        shopifyOrderId: lookupData.order.shopifyOrderId,
        orderNumber: lookupData.order.orderNumber,
        customerEmail: lookupData.order.customerEmail,
        customerName: lookupData.order.customerName,
        courier: selectedCourier,
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
        <div style={{ backgroundColor: "#f1f8f5", border: "1px solid #008060", borderRadius: "8px", padding: "32px", textAlign: "center" }}>
          <h2 style={{ color: "#008060", margin: "0 0 12px 0" }}>Return Booking Confirmed! 🎉</h2>
          <p style={{ fontSize: "16px", margin: "0 0 24px 0" }}>
            Your return request for order <strong>{returnResult.orderNumber}</strong> has been successfully booked.
          </p>

          <div style={{ backgroundColor: "#fff", padding: "20px", borderRadius: "6px", textAlign: "left", marginBottom: "24px" }}>
            <div style={{ marginBottom: "8px" }}>
              <strong>Return Reference ID:</strong> {returnResult.returnRequestId}
            </div>
            <div style={{ marginBottom: "8px" }}>
              <strong>Pickup Courier:</strong> {returnResult.courier}
            </div>
            <div style={{ marginBottom: "8px" }}>
              <strong>Consignment Tracking CN:</strong> <span style={{ fontFamily: "monospace", color: "#2c6ecb" }}>{returnResult.trackingNumber}</span>
            </div>
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
          {currentStep === "REQUEST" && !actionData?.step && (
            <div style={{ backgroundColor: "#fff", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "24px", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
              <h3 style={{ margin: "0 0 8px 0", fontSize: "18px" }}>Step 1: Access Your Order</h3>
              <p style={{ fontSize: "13px", color: "#6d7175", marginBottom: "20px" }}>
                Enter your order number and email/phone to receive a 6-digit verification code.
              </p>
              <fetcher.Form method="post">
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
                We sent a 6-digit verification code to <strong>{actionData?.customerEmail || emailInput}</strong> for order <strong>{actionData?.orderNumber || orderNumberInput}</strong>.
              </p>

              <fetcher.Form method="post">
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
                          {c.displayName} — Doorstep Collection
                        </option>
                      ))}
                    </select>
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

                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px", color: "#d72c0d" }}>
                    <span>Pickup Shipping Charge:</span>
                    <span>- Rs. {estimatedPickupChargePKR.toLocaleString()}</span>
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: "16px", paddingTop: "12px", borderTop: "1px solid #e1e3e5", fontSize: "18px", fontWeight: "bold" }}>
                    <span>Net Estimated Refund:</span>
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
