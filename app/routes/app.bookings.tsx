import { useState, useMemo } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { requireTenantContext } from "../services/tenant.server";
import { assertPermission } from "../services/permissions.server";
import {
  fetchUnfulfilledOrders,
  bookCourierShipment,
  bulkBookCourierShipments,
  type UnfulfilledOrder,
} from "../services/booking.server";
import {
  createLoadsheet,
  getUnassignedBookedShipments,
  listLoadsheets,
} from "../services/loadsheet.server";
import { getDecryptedCourierCredentials } from "../services/courier.server";
import { MAJOR_PAKISTANI_CITIES } from "../services/pakistanLogistics";

export async function loader({ request }: LoaderFunctionArgs) {
  const { shopifyStoreId, admin } = await requireTenantContext(request);

  // Load unfulfilled orders from Shopify
  const unfulfilledOrders = admin ? await fetchUnfulfilledOrders(admin, shopifyStoreId, 50) : [];

  // Check which couriers have active credentials
  const [postexCreds, leopardsCreds, tcsCreds] = await Promise.all([
    getDecryptedCourierCredentials(shopifyStoreId, "POSTEX"),
    getDecryptedCourierCredentials(shopifyStoreId, "LEOPARDS"),
    getDecryptedCourierCredentials(shopifyStoreId, "TCS"),
  ]);

  const courierStatus = {
    POSTEX: Boolean(postexCreds?.apiToken || postexCreds?.credentials?.apiToken),
    LEOPARDS: Boolean(leopardsCreds?.apiKey || leopardsCreds?.credentials?.apiKey),
    TCS: Boolean(tcsCreds?.clientId || tcsCreds?.credentials?.clientId),
    RIDER: true, // In-house rider is always available
  };

  // Load unassigned booked shipments waiting for rider loadsheet
  const unassignedShipments = await getUnassignedBookedShipments(shopifyStoreId);

  // Load past loadsheets
  const pastLoadsheets = await listLoadsheets(shopifyStoreId);

  return {
    unfulfilledOrders,
    courierStatus,
    unassignedShipments,
    pastLoadsheets,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { shopifyStoreId, session, admin } = await requireTenantContext(request);
  await assertPermission(shopifyStoreId, session, "settings");

  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "BOOK_SINGLE") {
      const orderId = String(form.get("orderId") || "");
      const orderNumber = String(form.get("orderNumber") || "");
      const courier = String(form.get("courier") || "POSTEX");
      const customerName = String(form.get("customerName") || "");
      const customerPhone = String(form.get("customerPhone") || "");
      const customerAddress = String(form.get("customerAddress") || "");
      const cityName = String(form.get("cityName") || "Karachi");
      const codAmountPKR = Number(form.get("codAmountPKR") || 0);
      const weightKg = Number(form.get("weightKg") || 0.5);
      const remarks = String(form.get("remarks") || "");

      const result = await bookCourierShipment(admin, shopifyStoreId, session, {
        orderId,
        orderNumber,
        courier,
        customerName,
        customerPhone,
        customerAddress,
        cityName,
        codAmountPKR,
        weightKg,
        remarks,
      });

      if (!result.success) {
        return { ok: false, message: result.error || "Booking failed." };
      }

      return {
        ok: true,
        message: `Order ${orderNumber} successfully booked with ${courier}! Tracking: ${result.trackingNumber}`,
        booking: result,
      };
    }

    if (intent === "BOOK_BULK") {
      const rawPayload = String(form.get("bulkPayload") || "[]");
      let items: any[] = [];
      try {
        items = JSON.parse(rawPayload);
      } catch {
        return { ok: false, message: "Invalid bulk booking payload." };
      }

      if (!items.length) {
        return { ok: false, message: "No orders selected for booking." };
      }

      const { booked, failed } = await bulkBookCourierShipments(admin, shopifyStoreId, session, items);

      const failedMsg = failed.length ? ` (${failed.length} failed: ${failed.map((f) => `${f.orderNumber}: ${f.error}`).join("; ")})` : "";
      return {
        ok: booked.length > 0,
        message: `Bulk booked ${booked.length} of ${items.length} orders successfully.${failedMsg}`,
        booked,
        failed,
      };
    }

    if (intent === "CREATE_LOADSHEET") {
      const courier = String(form.get("courier") || "POSTEX");
      const riderName = String(form.get("riderName") || "");
      const riderPhone = String(form.get("riderPhone") || "");
      const notes = String(form.get("notes") || "");
      const shipmentIds = String(form.get("shipmentIds") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const loadsheet = await createLoadsheet(shopifyStoreId, session?.id, {
        courier,
        shipmentIds,
        riderName,
        riderPhone,
        notes,
      });

      return {
        ok: true,
        message: `Loadsheet ${loadsheet.loadsheetNumber} created for ${loadsheet.parcelCount} parcels! Total COD: PKR ${Number(loadsheet.totalCodAmount).toLocaleString("en-PK")}`,
        loadsheet,
      };
    }

    return { ok: false, message: "Unknown booking intent." };
  } catch (error) {
    if (error instanceof Response) throw error;
    return { ok: false, message: error instanceof Error ? error.message : "Booking operation failed." };
  }
}

export default function BookingsPage() {
  const { unfulfilledOrders, courierStatus, unassignedShipments, pastLoadsheets } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  const [activeTab, setActiveTab] = useState<"BOOK" | "LOADSHEET">("BOOK");
  const [selectedCourier, setSelectedCourier] = useState<"POSTEX" | "LEOPARDS" | "TCS" | "RIDER">("POSTEX");

  // Selection & Editing state for orders
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);
  const [orderEdits, setOrderEdits] = useState<Record<string, { city?: string; weight?: number; cod?: number; remarks?: string }>>({});
  const [searchQuery, setSearchQuery] = useState("");

  // Loadsheet selection
  const [selectedShipmentIds, setSelectedShipmentIds] = useState<string[]>([]);
  const [barcodeScanInput, setBarcodeScanInput] = useState("");

  const filteredOrders = useMemo(() => {
    return unfulfilledOrders.filter((order) => {
      const q = searchQuery.trim().toLowerCase();
      if (!q) return true;
      return (
        order.name.toLowerCase().includes(q) ||
        order.customerName.toLowerCase().includes(q) ||
        order.customerPhone.includes(q) ||
        order.matchedCity.toLowerCase().includes(q)
      );
    });
  }, [unfulfilledOrders, searchQuery]);

  const toggleSelectOrder = (id: string) => {
    setSelectedOrderIds((curr) =>
      curr.includes(id) ? curr.filter((item) => item !== id) : [...curr, id],
    );
  };

  const toggleSelectAllOrders = () => {
    const unbookedIds = filteredOrders.filter((o) => !o.alreadyBooked).map((o) => o.id);
    if (selectedOrderIds.length === unbookedIds.length && unbookedIds.length > 0) {
      setSelectedOrderIds([]);
    } else {
      setSelectedOrderIds(unbookedIds);
    }
  };

  const handleEditOrder = (id: string, field: "city" | "weight" | "cod" | "remarks", value: any) => {
    setOrderEdits((curr) => ({
      ...curr,
      [id]: {
        ...curr[id],
        [field]: value,
      },
    }));
  };

  // Build bulk payload
  const bulkBookingPayload = useMemo(() => {
    return selectedOrderIds.map((id) => {
      const order = unfulfilledOrders.find((o) => o.id === id);
      const edit = orderEdits[id] || {};
      return {
        orderId: order?.id,
        orderNumber: order?.name,
        courier: selectedCourier,
        customerName: order?.customerName,
        customerPhone: order?.customerPhone,
        customerAddress: `${order?.address1 || ""} ${order?.address2 || ""}`.trim(),
        cityName: edit.city || order?.matchedCity || "Karachi",
        codAmountPKR: edit.cod !== undefined ? edit.cod : (order?.suggestedCod || 0),
        weightKg: edit.weight !== undefined ? edit.weight : (order?.suggestedWeight || 0.5),
        remarks: edit.remarks || "Allow customer to check flyer before payment",
      };
    });
  }, [selectedOrderIds, unfulfilledOrders, orderEdits, selectedCourier]);

  // Handle barcode scanner submission for loadsheet
  const handleBarcodeScan = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const code = barcodeScanInput.trim().toUpperCase();
      if (!code) return;

      const found = unassignedShipments.find(
        (s) => s.trackingNumber.toUpperCase() === code || s.orderNumber.toUpperCase() === code,
      );

      if (found && !selectedShipmentIds.includes(found.id)) {
        setSelectedShipmentIds((curr) => [...curr, found.id]);
        setBarcodeScanInput("");
      } else if (!found) {
        alert(`No unassigned shipment found matching CN or Order #: ${code}`);
      }
    }
  };

  return (
    <div className="bc-page">
      <header className="bc-header">
        <div className="bc-header-copy">
          <p className="bc-eyebrow">LOGISTICS & DISPATCH</p>
          <h1>Courier Booking & Handover</h1>
          <p>
            Book unfulfilled orders with PostEx, Leopards, TCS, or In-House Rider. Automatically updates Shopify fulfillments with tracking numbers and generates courier manifests.
          </p>
        </div>
      </header>

      {actionData?.message && (
        <div className={actionData.ok ? "bc-note ok" : "bc-note bad"}>
          {actionData.message}
        </div>
      )}

      {/* Main Tabs */}
      <div style={{ display: "flex", gap: "8px", borderBottom: "1px solid var(--bc-line)", paddingBottom: "10px" }}>
        <button
          type="button"
          className={`bc-btn ${activeTab === "BOOK" ? "primary" : ""}`}
          onClick={() => setActiveTab("BOOK")}
        >
          Book Orders ({unfulfilledOrders.length} Unfulfilled)
        </button>
        <button
          type="button"
          className={`bc-btn ${activeTab === "LOADSHEET" ? "primary" : ""}`}
          onClick={() => setActiveTab("LOADSHEET")}
        >
          Rider Loadsheet & Scanner ({unassignedShipments.length} Ready)
        </button>
      </div>

      {activeTab === "BOOK" && (
        <div className="bc-stack">
          {/* Courier Selection Bar */}
          <section className="bc-card" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
              <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--bc-muted)" }}>Select Courier:</span>
              {(["POSTEX", "LEOPARDS", "TCS", "RIDER"] as const).map((c) => {
                const isConfigured = courierStatus[c];
                return (
                  <button
                    key={c}
                    type="button"
                    className={`bc-btn ${selectedCourier === c ? "primary" : ""}`}
                    onClick={() => setSelectedCourier(c)}
                  >
                    {c === "POSTEX" ? "PostEx" : c === "LEOPARDS" ? "Leopards" : c === "TCS" ? "TCS" : "In-House Rider"}
                    {!isConfigured && c !== "RIDER" ? " (Needs Setup)" : ""}
                  </button>
                );
              })}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <a href="/app/couriers" className="bc-btn" style={{ fontSize: "11px" }}>
                Courier Settings
              </a>
            </div>
          </section>

          {/* Action Toolbar */}
          <section className="bc-card bc-toolbar" style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", gap: "10px", alignItems: "center", flex: "1 1 260px" }}>
              <input
                type="search"
                placeholder="Search by order #, customer, phone, or city"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ width: "100%", maxWidth: "320px" }}
              />
            </div>

            <div className="bc-actions" style={{ marginLeft: "auto" }}>
              {selectedOrderIds.length > 0 && (
                <Form method="post" style={{ display: "inline" }}>
                  <input type="hidden" name="intent" value="BOOK_BULK" />
                  <input type="hidden" name="bulkPayload" value={JSON.stringify(bulkBookingPayload)} />
                  <button type="submit" className="bc-btn primary" disabled={isSubmitting}>
                    {isSubmitting ? "Booking..." : `Book ${selectedOrderIds.length} with ${selectedCourier}`}
                  </button>
                </Form>
              )}

              {/* Print AWB Button */}
              <button
                type="button"
                className="bc-btn"
                onClick={() => {
                  window.open(`/app/awb`, "_blank");
                }}
              >
                Print Airway Bills
              </button>
            </div>
          </section>

          {/* Orders Booking Table */}
          <div className="bc-table-wrap">
            <table className="bc-table">
              <thead>
                <tr>
                  <th style={{ width: "36px" }}>
                    <input
                      type="checkbox"
                      checked={selectedOrderIds.length > 0 && selectedOrderIds.length === filteredOrders.filter((o) => !o.alreadyBooked).length}
                      onChange={toggleSelectAllOrders}
                      aria-label="Select all"
                    />
                  </th>
                  <th>Order</th>
                  <th>Customer & Address</th>
                  <th>City</th>
                  <th>Weight (kg)</th>
                  <th>COD (PKR)</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredOrders.length === 0 && (
                  <tr>
                    <td colSpan={8}>No unfulfilled orders found in Shopify.</td>
                  </tr>
                )}
                {filteredOrders.map((order) => {
                  const edit = orderEdits[order.id] || {};
                  const currentCity = edit.city || order.matchedCity;
                  const currentWeight = edit.weight !== undefined ? edit.weight : order.suggestedWeight;
                  const currentCod = edit.cod !== undefined ? edit.cod : order.suggestedCod;
                  const isSelected = selectedOrderIds.includes(order.id);

                  return (
                    <tr key={order.id} style={{ background: order.alreadyBooked ? "#fafafa" : undefined }}>
                      <td>
                        {!order.alreadyBooked ? (
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelectOrder(order.id)}
                            aria-label={`Select ${order.name}`}
                          />
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <strong>{order.name}</strong>
                        <div style={{ fontSize: "11px", color: "var(--bc-muted)" }}>
                          {new Date(order.createdAt).toLocaleDateString("en-PK", { month: "short", day: "numeric" })}
                        </div>
                        <span className={`bc-badge ${order.isCod ? "warn" : "ok"}`}>
                          {order.isCod ? "COD" : "Prepaid"}
                        </span>
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{order.customerName}</div>
                        <div style={{ fontSize: "11px", color: "var(--bc-muted)" }}>{order.customerPhone || "No phone"}</div>
                        <div style={{ fontSize: "11px", color: "#444", maxWidth: "220px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {order.address1}
                        </div>
                      </td>
                      <td>
                        <select
                          value={currentCity}
                          disabled={order.alreadyBooked}
                          onChange={(e) => handleEditOrder(order.id, "city", e.target.value)}
                          style={{ fontSize: "12px", padding: "4px 8px", maxWidth: "130px" }}
                        >
                          {MAJOR_PAKISTANI_CITIES.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          type="number"
                          step="0.1"
                          min="0.1"
                          max="50"
                          value={currentWeight}
                          disabled={order.alreadyBooked}
                          onChange={(e) => handleEditOrder(order.id, "weight", Number(e.target.value))}
                          style={{ width: "65px", fontSize: "12px", padding: "4px" }}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={currentCod}
                          disabled={order.alreadyBooked}
                          onChange={(e) => handleEditOrder(order.id, "cod", Number(e.target.value))}
                          style={{ width: "90px", fontSize: "12px", padding: "4px" }}
                        />
                      </td>
                      <td>
                        {order.alreadyBooked ? (
                          <div>
                            <span className="bc-badge ok">Booked</span>
                            {order.existingTracking && (
                              <div style={{ fontSize: "10px", marginTop: "2px", fontWeight: 600 }}>
                                {order.existingCourier}: {order.existingTracking}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="bc-badge warn">Ready</span>
                        )}
                      </td>
                      <td>
                        {order.alreadyBooked ? (
                          <a
                            href={`/app/awb?trackingNumber=${encodeURIComponent(order.existingTracking || "")}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="bc-btn"
                            style={{ fontSize: "11px", padding: "4px 8px" }}
                          >
                            Print AWB
                          </a>
                        ) : (
                          <Form method="post">
                            <input type="hidden" name="intent" value="BOOK_SINGLE" />
                            <input type="hidden" name="orderId" value={order.id} />
                            <input type="hidden" name="orderNumber" value={order.name} />
                            <input type="hidden" name="courier" value={selectedCourier} />
                            <input type="hidden" name="customerName" value={order.customerName} />
                            <input type="hidden" name="customerPhone" value={order.customerPhone} />
                            <input type="hidden" name="customerAddress" value={`${order.address1} ${order.address2}`.trim()} />
                            <input type="hidden" name="cityName" value={currentCity} />
                            <input type="hidden" name="codAmountPKR" value={currentCod} />
                            <input type="hidden" name="weightKg" value={currentWeight} />
                            <input type="hidden" name="remarks" value="Fragile - Handle with care" />
                            <button
                              type="submit"
                              className="bc-btn primary"
                              disabled={isSubmitting}
                              style={{ fontSize: "11px", padding: "4px 10px" }}
                            >
                              Book {selectedCourier}
                            </button>
                          </Form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === "LOADSHEET" && (
        <div className="bc-stack">
          {/* Loadsheet & Barcode Scanner Card */}
          <section className="bc-card">
            <h2 className="bc-title" style={{ margin: "0 0 6px" }}>Rider Pickup Loadsheet Manifest</h2>
            <p className="bc-muted" style={{ margin: "0 0 16px" }}>
              Scan or select today's booked parcels to generate a signed manifest for the courier pickup rider.
            </p>

            <div style={{ display: "flex", gap: "12px", alignItems: "center", marginBottom: "16px", flexWrap: "wrap" }}>
              <label style={{ flex: "1 1 280px" }}>
                <span className="bc-field-label">Barcode Scanner Input</span>
                <input
                  type="text"
                  placeholder="Scan Tracking Barcode (CN) or Order # and press Enter"
                  value={barcodeScanInput}
                  onChange={(e) => setBarcodeScanInput(e.target.value)}
                  onKeyDown={handleBarcodeScan}
                  style={{ width: "100%" }}
                />
              </label>

              <div style={{ paddingTop: "18px" }}>
                <button
                  type="button"
                  className="bc-btn"
                  onClick={() => setSelectedShipmentIds(unassignedShipments.map((s) => s.id))}
                >
                  Select All Unassigned ({unassignedShipments.length})
                </button>
              </div>
            </div>

            {/* Create Loadsheet Form */}
            {selectedShipmentIds.length > 0 && (
              <Form method="post" className="bc-card" style={{ background: "#fafafa", border: "1px solid var(--bc-line)", marginTop: "12px" }}>
                <input type="hidden" name="intent" value="CREATE_LOADSHEET" />
                <input type="hidden" name="courier" value={selectedCourier} />
                <input type="hidden" name="shipmentIds" value={selectedShipmentIds.join(",")} />

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px", marginBottom: "12px" }}>
                  <label>
                    <span className="bc-field-label">Rider Name</span>
                    <input name="riderName" placeholder="e.g. Muhammad Ali" />
                  </label>
                  <label>
                    <span className="bc-field-label">Rider Mobile Number</span>
                    <input name="riderPhone" placeholder="03XXXXXXXXX" />
                  </label>
                  <label>
                    <span className="bc-field-label">Handover Notes</span>
                    <input name="notes" placeholder="e.g. Evening pickup batch" />
                  </label>
                </div>

                <button type="submit" className="bc-btn primary" disabled={isSubmitting}>
                  Generate Loadsheet for {selectedShipmentIds.length} Parcels
                </button>
              </Form>
            )}
          </section>

          {/* Unassigned Shipments Ready For Handover */}
          <div className="bc-table-wrap">
            <h3 style={{ fontSize: "14px", fontWeight: 700, margin: "14px 0 8px" }}>
              Parcels Awaiting Loadsheet Handover ({unassignedShipments.length})
            </h3>
            <table className="bc-table">
              <thead>
                <tr>
                  <th style={{ width: "36px" }}>Select</th>
                  <th>Order</th>
                  <th>Courier</th>
                  <th>Consignment #</th>
                  <th>Destination</th>
                  <th>COD Amount</th>
                  <th>Booked Date</th>
                </tr>
              </thead>
              <tbody>
                {unassignedShipments.length === 0 && (
                  <tr>
                    <td colSpan={7}>All booked shipments have already been assigned to loadsheets.</td>
                  </tr>
                )}
                {unassignedShipments.map((shipment) => (
                  <tr key={shipment.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedShipmentIds.includes(shipment.id)}
                        onChange={() =>
                          setSelectedShipmentIds((curr) =>
                            curr.includes(shipment.id)
                              ? curr.filter((id) => id !== shipment.id)
                              : [...curr, shipment.id],
                          )
                        }
                      />
                    </td>
                    <td><strong>{shipment.orderNumber}</strong></td>
                    <td><span className="bc-badge">{shipment.courier}</span></td>
                    <td>{shipment.trackingNumber}</td>
                    <td>{shipment.destinationCity || "Karachi"}</td>
                    <td><strong>PKR {Number(shipment.codAmount || 0).toLocaleString("en-PK")}</strong></td>
                    <td>{new Date(shipment.createdAt).toLocaleDateString("en-PK", { month: "short", day: "numeric" })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Past Loadsheets History */}
          <div className="bc-table-wrap" style={{ marginTop: "24px" }}>
            <h3 style={{ fontSize: "14px", fontWeight: 700, margin: "14px 0 8px" }}>
              Generated Loadsheet History
            </h3>
            <table className="bc-table">
              <thead>
                <tr>
                  <th>Loadsheet #</th>
                  <th>Courier</th>
                  <th>Date</th>
                  <th>Parcels</th>
                  <th>Total COD</th>
                  <th>Rider</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pastLoadsheets.length === 0 && (
                  <tr>
                    <td colSpan={7}>No loadsheets generated yet.</td>
                  </tr>
                )}
                {pastLoadsheets.map((ls) => (
                  <tr key={ls.id}>
                    <td><strong>{ls.loadsheetNumber}</strong></td>
                    <td><span className="bc-badge">{ls.courier}</span></td>
                    <td>{new Date(ls.createdAt).toLocaleDateString("en-PK", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                    <td>{ls.parcelCount}</td>
                    <td><strong>PKR {Number(ls.totalCodAmount).toLocaleString("en-PK")}</strong></td>
                    <td>{ls.riderName ? `${ls.riderName} (${ls.riderPhone || ""})` : "—"}</td>
                    <td><span className="bc-badge ok">{ls.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
