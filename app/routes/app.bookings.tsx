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

  // Load unfulfilled orders from Shopify (with automatic DB fallback for all synced orders)
  const unfulfilledOrders = await fetchUnfulfilledOrders(admin, shopifyStoreId, 250);

  // Check which couriers have active credentials
  const [postexCreds, leopardsCreds, tcsCreds] = await Promise.all([
    getDecryptedCourierCredentials(shopifyStoreId, "POSTEX"),
    getDecryptedCourierCredentials(shopifyStoreId, "LEOPARDS"),
    getDecryptedCourierCredentials(shopifyStoreId, "TCS"),
  ]);

  const courierStatus = {
    POSTEX: Boolean(postexCreds?.apiToken || postexCreds?.credentials?.apiToken),
    LEOPARDS: Boolean(leopardsCreds?.credentials?.apiKey || leopardsCreds?.apiToken),
    TCS: Boolean(tcsCreds?.credentials?.clientId || tcsCreds?.credentials?.apiKey || tcsCreds?.apiToken),
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
  const [orderEdits, setOrderEdits] = useState<Record<string, {
    name?: string;
    phone?: string;
    address?: string;
    city?: string;
    weight?: number;
    cod?: number;
    type?: string;
    remarks?: string;
  }>>({});

  // Search & Filter state (matches Universal Courier UI)
  const [searchOrder, setSearchOrder] = useState("");
  const [searchTag, setSearchTag] = useState("");
  const [selectDate, setSelectDate] = useState("");
  const [financialFilter, setFinancialFilter] = useState("ALL");
  const [fulfillmentFilter, setFulfillmentFilter] = useState("ALL");

  // Shipper Profile & Pickup location state
  const [selectedShipperProfile, setSelectedShipperProfile] = useState("DEFAULT");
  const [selectedPickupLocation, setSelectedPickupLocation] = useState("DEFAULT");

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 20;

  // Viewing line items modal
  const [viewingOrder, setViewingOrder] = useState<UnfulfilledOrder | null>(null);

  // Loadsheet selection
  const [selectedShipmentIds, setSelectedShipmentIds] = useState<string[]>([]);
  const [barcodeScanInput, setBarcodeScanInput] = useState("");

  // Filtering orders
  const filteredOrders = useMemo(() => {
    return unfulfilledOrders.filter((order) => {
      // Order search
      if (searchOrder.trim()) {
        const q = searchOrder.trim().toLowerCase();
        const matches =
          order.name.toLowerCase().includes(q) ||
          order.customerName.toLowerCase().includes(q) ||
          order.customerPhone.includes(q) ||
          order.matchedCity.toLowerCase().includes(q);
        if (!matches) return false;
      }

      // Tag search
      if (searchTag.trim()) {
        const t = searchTag.trim().toLowerCase();
        const matchesTag = order.tags.some((tag) => tag.toLowerCase().includes(t));
        if (!matchesTag) return false;
      }

      // Date filter
      if (selectDate) {
        const orderDateStr = order.createdAt.slice(0, 10);
        if (orderDateStr !== selectDate) return false;
      }

      // Financial status filter
      if (financialFilter !== "ALL") {
        const finStatus = (order.displayFinancialStatus || "").toUpperCase();
        if (financialFilter === "PENDING" && finStatus !== "PENDING") return false;
        if (financialFilter === "PAID" && finStatus !== "PAID") return false;
        if (financialFilter === "PARTIALLY_PAID" && finStatus !== "PARTIALLY_PAID") return false;
        if (financialFilter === "VOIDED" && finStatus !== "VOIDED") return false;
      }

      // Fulfillment filter
      if (fulfillmentFilter !== "ALL") {
        if (fulfillmentFilter === "UNFULFILLED" && order.alreadyBooked) return false;
      }

      return true;
    });
  }, [unfulfilledOrders, searchOrder, searchTag, selectDate, financialFilter, fulfillmentFilter]);

  // Paginated slice
  const paginatedOrders = useMemo(() => {
    const startIndex = (currentPage - 1) * pageSize;
    return filteredOrders.slice(startIndex, startIndex + pageSize);
  }, [filteredOrders, currentPage, pageSize]);

  const toggleSelectOrder = (id: string) => {
    setSelectedOrderIds((curr) =>
      curr.includes(id) ? curr.filter((item) => item !== id) : [...curr, id],
    );
  };

  const toggleSelectAll = () => {
    const pageUnbooked = paginatedOrders.filter((o) => !o.alreadyBooked).map((o) => o.id);
    const allSelected = pageUnbooked.length > 0 && pageUnbooked.every((id) => selectedOrderIds.includes(id));
    if (allSelected) {
      setSelectedOrderIds((curr) => curr.filter((id) => !pageUnbooked.includes(id)));
    } else {
      setSelectedOrderIds((curr) => Array.from(new Set([...curr, ...pageUnbooked])));
    }
  };

  const handleEditOrder = (id: string, field: string, value: any) => {
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
        customerName: edit.name || order?.customerName,
        customerPhone: edit.phone || order?.customerPhone,
        customerAddress: edit.address || `${order?.address1 || ""} ${order?.address2 || ""}`.trim(),
        cityName: edit.city || order?.matchedCity || "Karachi",
        codAmountPKR: edit.cod !== undefined ? edit.cod : (order?.suggestedCod || 0),
        weightKg: edit.weight !== undefined ? edit.weight : (order?.suggestedWeight || 0.5),
        remarks: edit.remarks || "Allow customer to check flyer before payment",
      };
    });
  }, [selectedOrderIds, unfulfilledOrders, orderEdits, selectedCourier]);

  // Barcode scanner submission for loadsheet
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
    <div className="bc-page" style={{ maxWidth: "1400px", padding: "16px 20px" }}>
      {/* Universal Courier Announcement Banner */}
      <div
        style={{
          background: "#e6f4ea",
          border: "1px solid #bbf7d0",
          borderRadius: "6px",
          padding: "9px 18px",
          fontSize: "13px",
          color: "#166534",
          fontWeight: 500,
          textAlign: "center",
          marginBottom: "16px",
          boxShadow: "0 1px 2px rgba(22, 101, 52, 0.05)",
        }}
      >
        Note: You have 997,579 courier credits remaining. Active logistics integration connected.
      </div>

      {actionData?.message && (
        <div
          className={`bc-note ${actionData.ok ? "ok" : "bad"}`}
          style={{ marginBottom: "16px" }}
        >
          {actionData.message}
        </div>
      )}

      {/* Main Tabs (Book Orders vs Loadsheet) */}
      <div style={{ display: "flex", gap: "8px", borderBottom: "1px solid #e2e8f0", paddingBottom: "10px", marginBottom: "16px" }}>
        <button
          type="button"
          className={`bc-btn ${activeTab === "BOOK" ? "primary" : ""}`}
          onClick={() => setActiveTab("BOOK")}
          style={{ fontWeight: 700 }}
        >
          Create Booking ({filteredOrders.length} Available)
        </button>
        <button
          type="button"
          className={`bc-btn ${activeTab === "LOADSHEET" ? "primary" : ""}`}
          onClick={() => setActiveTab("LOADSHEET")}
        >
          Rider Loadsheet & Scanner ({unassignedShipments.length} Ready)
        </button>
        <button
          type="button"
          className="bc-btn"
          style={{ marginLeft: "auto" }}
          onClick={() => window.open("/app/awb", "_blank")}
        >
          Print Airway Bills
        </button>
      </div>

      {activeTab === "BOOK" && (
        <div>
          {/* Centered Large Courier Branding */}
          <div style={{ textAlign: "center", margin: "16px 0 20px" }}>
            {selectedCourier === "POSTEX" && (
              <div style={{ display: "inline-flex", alignItems: "baseline", gap: "2px" }}>
                <span style={{ fontSize: "36px", fontWeight: 900, color: "#0f172a", letterSpacing: "-0.04em" }}>PostEx</span>
                <span style={{ fontSize: "38px", fontWeight: 900, color: "#16a34a" }}>.</span>
              </div>
            )}
            {selectedCourier === "LEOPARDS" && (
              <div style={{ display: "inline-flex", alignItems: "baseline", gap: "6px" }}>
                <span style={{ fontSize: "34px", fontWeight: 900, color: "#ca8a04", letterSpacing: "-0.03em" }}>LEOPARDS</span>
                <span style={{ fontSize: "34px", fontWeight: 900, color: "#0f172a" }}>COURIER</span>
              </div>
            )}
            {selectedCourier === "TCS" && (
              <div style={{ display: "inline-flex", alignItems: "baseline", gap: "6px" }}>
                <span style={{ fontSize: "34px", fontWeight: 900, color: "#dc2626", letterSpacing: "-0.03em" }}>TCS</span>
                <span style={{ fontSize: "34px", fontWeight: 900, color: "#0f172a" }}>EXPRESS</span>
              </div>
            )}
            {selectedCourier === "RIDER" && (
              <div style={{ display: "inline-flex", alignItems: "baseline", gap: "6px" }}>
                <span style={{ fontSize: "34px", fontWeight: 900, color: "#2563eb", letterSpacing: "-0.03em" }}>IN-HOUSE</span>
                <span style={{ fontSize: "34px", fontWeight: 900, color: "#0f172a" }}>RIDER</span>
              </div>
            )}
            <p style={{ margin: "4px 0 14px", fontSize: "14px", fontWeight: 500, color: "#64748b" }}>
              Create Booking with {selectedCourier === "POSTEX" ? "PostEx" : selectedCourier === "LEOPARDS" ? "Leopards" : selectedCourier === "TCS" ? "TCS" : "In-House Rider"}
            </p>

            {/* Courier Selection Pill Buttons */}
            <div style={{ display: "inline-flex", gap: "6px", background: "#f1f5f9", padding: "4px", borderRadius: "10px", border: "1px solid #e2e8f0" }}>
              {(["POSTEX", "LEOPARDS", "TCS", "RIDER"] as const).map((c) => {
                const active = selectedCourier === c;
                const isConfigured = courierStatus[c];
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setSelectedCourier(c)}
                    style={{
                      padding: "6px 14px",
                      borderRadius: "7px",
                      fontSize: "12px",
                      fontWeight: active ? 700 : 500,
                      background: active ? "#0f172a" : "transparent",
                      color: active ? "#ffffff" : "#475569",
                      border: "none",
                      cursor: "pointer",
                      transition: "all 140ms ease",
                    }}
                  >
                    {c === "POSTEX" ? "PostEx" : c === "LEOPARDS" ? "Leopards" : c === "TCS" ? "TCS" : "In-House Rider"}
                    {!isConfigured && c !== "RIDER" ? " (Needs Setup)" : ""}
                  </button>
                );
              })}
              <a
                href="/app/couriers"
                style={{
                  padding: "6px 12px",
                  borderRadius: "7px",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "#2563eb",
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                }}
              >
                ⚙ Settings
              </a>
            </div>
          </div>

          {/* 5-Field Search and Filter Grid (Matches Universal Courier UI) */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr)) auto",
              gap: "10px",
              alignItems: "center",
              background: "#ffffff",
              padding: "14px 16px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
              marginBottom: "16px",
            }}
          >
            <input
              type="text"
              placeholder="Search Order"
              value={searchOrder}
              onChange={(e) => {
                setSearchOrder(e.target.value);
                setCurrentPage(1);
              }}
              style={{
                height: "38px",
                padding: "0 12px",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                fontSize: "13px",
                background: "#ffffff",
                color: "#0f172a",
              }}
            />
            <input
              type="text"
              placeholder="Search Tag"
              value={searchTag}
              onChange={(e) => {
                setSearchTag(e.target.value);
                setCurrentPage(1);
              }}
              style={{
                height: "38px",
                padding: "0 12px",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                fontSize: "13px",
                background: "#ffffff",
                color: "#0f172a",
              }}
            />
            <input
              type="date"
              value={selectDate}
              onChange={(e) => {
                setSelectDate(e.target.value);
                setCurrentPage(1);
              }}
              style={{
                height: "38px",
                padding: "0 10px",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                fontSize: "13px",
                background: "#ffffff",
                color: "#0f172a",
              }}
            />
            <select
              value={financialFilter}
              onChange={(e) => {
                setFinancialFilter(e.target.value);
                setCurrentPage(1);
              }}
              style={{
                height: "38px",
                padding: "0 10px",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                fontSize: "13px",
                background: "#ffffff",
                color: "#0f172a",
              }}
            >
              <option value="ALL">Financial Status</option>
              <option value="PENDING">Pending (COD)</option>
              <option value="PAID">Paid</option>
              <option value="PARTIALLY_PAID">Partially Paid</option>
              <option value="VOIDED">Voided</option>
            </select>
            <select
              value={fulfillmentFilter}
              onChange={(e) => {
                setFulfillmentFilter(e.target.value);
                setCurrentPage(1);
              }}
              style={{
                height: "38px",
                padding: "0 10px",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                fontSize: "13px",
                background: "#ffffff",
                color: "#0f172a",
              }}
            >
              <option value="ALL">Fulfillment Status</option>
              <option value="UNFULFILLED">Unfulfilled</option>
              <option value="PARTIALLY_FULFILLED">Partially Fulfilled</option>
            </select>
            <button
              type="button"
              className="bc-btn"
              style={{
                height: "38px",
                padding: "0 24px",
                background: "#16a34a",
                color: "#ffffff",
                border: "1px solid #15803d",
                borderRadius: "6px",
                fontWeight: 700,
                fontSize: "14px",
                cursor: "pointer",
              }}
            >
              Search
            </button>
          </div>

          {/* Shipper Profile & Pickup Location row with Pagination Controls */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-end",
              flexWrap: "wrap",
              gap: "16px",
              marginBottom: "14px",
            }}
          >
            <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", flex: "1 1 540px" }}>
              <div style={{ flex: "1 1 260px" }}>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 700, color: "#0f172a", marginBottom: "5px" }}>
                  Shipper Profile
                </label>
                <select
                  value={selectedShipperProfile}
                  onChange={(e) => setSelectedShipperProfile(e.target.value)}
                  style={{
                    width: "100%",
                    height: "38px",
                    padding: "0 10px",
                    border: "1px solid #cbd5e1",
                    borderRadius: "6px",
                    fontSize: "12px",
                    background: "#ffffff",
                    color: "#0f172a",
                  }}
                >
                  <option value="DEFAULT">FEAR | Row E, Block 04, Sindhi Jamat Cooperative Housing Society, Karachi</option>
                  <option value="LAHORE">CENTRAL HUB | Gulberg III, MM Alam Road, Lahore</option>
                  <option value="ISLAMABAD">NORTH DISPATCH | Blue Area, Islamabad</option>
                </select>
              </div>

              <div style={{ flex: "1 1 260px" }}>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 700, color: "#0f172a", marginBottom: "5px" }}>
                  Pickup Location
                </label>
                <select
                  value={selectedPickupLocation}
                  onChange={(e) => setSelectedPickupLocation(e.target.value)}
                  style={{
                    width: "100%",
                    height: "38px",
                    padding: "0 10px",
                    border: "1px solid #cbd5e1",
                    borderRadius: "6px",
                    fontSize: "12px",
                    background: "#ffffff",
                    color: "#0f172a",
                  }}
                >
                  <option value="DEFAULT">Row E , Block 4 ,Sindhi Jamat Co-operative Housing Society , Karachi</option>
                  <option value="LAHORE">Plot 18, Commercial Zone, MM Alam Road, Lahore</option>
                </select>
              </div>
            </div>

            {/* Back / Next Pagination */}
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginLeft: "auto" }}>
              <button
                type="button"
                className="bc-btn"
                disabled={currentPage === 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                style={{
                  minWidth: "64px",
                  height: "36px",
                  color: currentPage === 1 ? "#94a3b8" : "#0f172a",
                  fontWeight: 600,
                }}
              >
                Back
              </button>
              <span style={{ fontSize: "12px", fontWeight: 600, color: "#475569" }}>
                {filteredOrders.length > 0 ? (
                  <>
                    Page {currentPage} of {Math.max(1, Math.ceil(filteredOrders.length / pageSize))} ({filteredOrders.length} orders)
                  </>
                ) : (
                  "0 orders"
                )}
              </span>
              <button
                type="button"
                className="bc-btn"
                disabled={currentPage >= Math.ceil(filteredOrders.length / pageSize)}
                onClick={() => setCurrentPage((p) => p + 1)}
                style={{
                  minWidth: "64px",
                  height: "36px",
                  color: currentPage >= Math.ceil(filteredOrders.length / pageSize) ? "#94a3b8" : "#0f172a",
                  fontWeight: 600,
                }}
              >
                Next
              </button>
            </div>
          </div>

          {/* Universal Courier Orders Table */}
          <div
            style={{
              overflowX: "auto",
              background: "#ffffff",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            }}
          >
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "13px" }}>
              <thead>
                <tr style={{ background: "#0f172a", color: "#ffffff", fontSize: "12px", fontWeight: 700, letterSpacing: "0.02em" }}>
                  <th style={{ width: "36px", padding: "10px", textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={
                        paginatedOrders.length > 0 &&
                        paginatedOrders.filter((o) => !o.alreadyBooked).every((o) => selectedOrderIds.includes(o.id))
                      }
                      onChange={toggleSelectAll}
                      style={{ accentColor: "#16a34a", cursor: "pointer", width: "16px", height: "16px" }}
                    />
                  </th>
                  <th style={{ width: "36px", padding: "10px 6px", textAlign: "center" }}>#</th>
                  <th style={{ padding: "10px 8px", minWidth: "90px" }}>Order</th>
                  <th style={{ padding: "10px 8px", minWidth: "120px" }}>Name</th>
                  <th style={{ padding: "10px 8px", minWidth: "115px" }}>Phone</th>
                  <th style={{ padding: "10px 8px", minWidth: "220px" }}>Address</th>
                  <th style={{ padding: "10px 8px", minWidth: "90px" }}>City</th>
                  <th style={{ padding: "10px 8px", minWidth: "135px" }}>City</th>
                  <th style={{ padding: "10px 8px", width: "85px" }}>COD</th>
                  <th style={{ padding: "10px 8px", width: "70px" }}>KG</th>
                  <th style={{ padding: "10px 8px", width: "105px" }}>Type</th>
                  <th style={{ width: "36px", padding: "10px 4px", textAlign: "center" }}></th>
                  <th style={{ width: "36px", padding: "10px 4px", textAlign: "center" }}></th>
                </tr>
              </thead>
              <tbody>
                {paginatedOrders.length === 0 ? (
                  <tr>
                    <td colSpan={13} style={{ padding: "36px 16px", textAlign: "center", color: "#64748b" }}>
                      No unfulfilled orders found matching your search criteria.
                    </td>
                  </tr>
                ) : (
                  paginatedOrders.map((order, idx) => {
                    const rowNumber = (currentPage - 1) * pageSize + idx + 1;
                    const edit = orderEdits[order.id] || {};
                    const currentName = edit.name !== undefined ? edit.name : order.customerName;
                    const currentPhone = edit.phone !== undefined ? edit.phone : order.customerPhone;
                    const currentAddress = edit.address !== undefined ? edit.address : `${order.address1 || ""} ${order.address2 || ""}`.trim();
                    const currentCity = edit.city || order.matchedCity || "Lahore";
                    const currentCod = edit.cod !== undefined ? edit.cod : order.suggestedCod;
                    const currentWeight = edit.weight !== undefined ? edit.weight : order.suggestedWeight;
                    const currentType = edit.type || "Normal";

                    const isSelected = selectedOrderIds.includes(order.id);

                    // Validation status: phone has digits, address has content, city is chosen
                    const isValid = Boolean(currentPhone && currentPhone.length >= 10 && currentAddress.length >= 5 && currentCity);

                    return (
                      <tr
                        key={order.id}
                        style={{
                          borderBottom: "1px solid #e2e8f0",
                          background: order.alreadyBooked ? "#f8fafc" : isSelected ? "#f0fdf4" : idx % 2 === 0 ? "#ffffff" : "#fcfcfd",
                        }}
                      >
                        {/* Checkbox */}
                        <td style={{ textAlign: "center", padding: "8px 10px" }}>
                          {!order.alreadyBooked ? (
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleSelectOrder(order.id)}
                              style={{ accentColor: "#16a34a", cursor: "pointer", width: "16px", height: "16px" }}
                            />
                          ) : (
                            <span style={{ color: "#94a3b8" }}>—</span>
                          )}
                        </td>

                        {/* # Row Index */}
                        <td style={{ textAlign: "center", padding: "8px 6px", fontSize: "12px", color: "#64748b", fontWeight: 600 }}>
                          {rowNumber}
                        </td>

                        {/* Order Number Link */}
                        <td style={{ padding: "8px 8px" }}>
                          <span
                            className="bc-order-link"
                            style={{
                              color: "#0d9488",
                              fontWeight: 700,
                              fontSize: "13px",
                              cursor: "pointer",
                            }}
                            onClick={() => setViewingOrder(order)}
                          >
                            {order.name}
                          </span>
                          {order.alreadyBooked && (
                            <div style={{ fontSize: "11px", color: "#166534", fontWeight: 600, marginTop: "2px" }}>
                              Booked ({order.existingCourier})
                            </div>
                          )}
                        </td>

                        {/* Name (Inline editable input) */}
                        <td style={{ padding: "8px 8px" }}>
                          <input
                            type="text"
                            value={currentName}
                            disabled={order.alreadyBooked}
                            onChange={(e) => handleEditOrder(order.id, "name", e.target.value)}
                            style={{
                              width: "100%",
                              height: "32px",
                              padding: "4px 8px",
                              border: "1px solid #cbd5e1",
                              borderRadius: "4px",
                              fontSize: "12px",
                              background: order.alreadyBooked ? "#f1f5f9" : "#ffffff",
                              color: "#0f172a",
                            }}
                          />
                        </td>

                        {/* Phone (Inline editable input) */}
                        <td style={{ padding: "8px 8px" }}>
                          <input
                            type="text"
                            value={currentPhone}
                            placeholder="03001234567"
                            disabled={order.alreadyBooked}
                            onChange={(e) => handleEditOrder(order.id, "phone", e.target.value)}
                            style={{
                              width: "100%",
                              height: "32px",
                              padding: "4px 8px",
                              border: "1px solid #cbd5e1",
                              borderRadius: "4px",
                              fontSize: "12px",
                              background: order.alreadyBooked ? "#f1f5f9" : "#ffffff",
                              color: "#0f172a",
                            }}
                          />
                        </td>

                        {/* Address (Inline editable input) */}
                        <td style={{ padding: "8px 8px" }}>
                          <input
                            type="text"
                            value={currentAddress}
                            placeholder="Street, Area, Building"
                            disabled={order.alreadyBooked}
                            onChange={(e) => handleEditOrder(order.id, "address", e.target.value)}
                            style={{
                              width: "100%",
                              height: "32px",
                              padding: "4px 8px",
                              border: "1px solid #cbd5e1",
                              borderRadius: "4px",
                              fontSize: "12px",
                              background: order.alreadyBooked ? "#f1f5f9" : "#ffffff",
                              color: "#0f172a",
                            }}
                          />
                        </td>

                        {/* Shopify Original City */}
                        <td style={{ padding: "8px 8px", color: "#475569", fontSize: "12px", fontWeight: 500 }}>
                          {order.city || "—"}
                        </td>

                        {/* Matched City Dropdown */}
                        <td style={{ padding: "8px 8px" }}>
                          <select
                            value={currentCity}
                            disabled={order.alreadyBooked}
                            onChange={(e) => handleEditOrder(order.id, "city", e.target.value)}
                            style={{
                              width: "100%",
                              height: "32px",
                              padding: "2px 6px",
                              border: "1px solid #cbd5e1",
                              borderRadius: "4px",
                              fontSize: "12px",
                              background: order.alreadyBooked ? "#f1f5f9" : "#ffffff",
                              color: "#0f172a",
                            }}
                          >
                            <option value="">Select City</option>
                            {MAJOR_PAKISTANI_CITIES.map((city) => (
                              <option key={city} value={city}>
                                {city}
                              </option>
                            ))}
                          </select>
                        </td>

                        {/* COD Amount */}
                        <td style={{ padding: "8px 8px" }}>
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={currentCod}
                            disabled={order.alreadyBooked}
                            onChange={(e) => handleEditOrder(order.id, "cod", Number(e.target.value))}
                            style={{
                              width: "100%",
                              height: "32px",
                              padding: "4px 6px",
                              border: "1px solid #cbd5e1",
                              borderRadius: "4px",
                              fontSize: "12px",
                              textAlign: "right",
                              background: order.alreadyBooked ? "#f1f5f9" : "#ffffff",
                              color: "#0f172a",
                            }}
                          />
                        </td>

                        {/* KG Weight */}
                        <td style={{ padding: "8px 8px" }}>
                          <input
                            type="number"
                            step="0.1"
                            min="0.1"
                            max="50"
                            value={currentWeight}
                            disabled={order.alreadyBooked}
                            onChange={(e) => handleEditOrder(order.id, "weight", Number(e.target.value))}
                            style={{
                              width: "100%",
                              height: "32px",
                              padding: "4px 6px",
                              border: "1px solid #cbd5e1",
                              borderRadius: "4px",
                              fontSize: "12px",
                              textAlign: "center",
                              background: order.alreadyBooked ? "#f1f5f9" : "#ffffff",
                              color: "#0f172a",
                            }}
                          />
                        </td>

                        {/* Service Type */}
                        <td style={{ padding: "8px 8px" }}>
                          <select
                            value={currentType}
                            disabled={order.alreadyBooked}
                            onChange={(e) => handleEditOrder(order.id, "type", e.target.value)}
                            style={{
                              width: "100%",
                              height: "32px",
                              padding: "2px 6px",
                              border: "1px solid #cbd5e1",
                              borderRadius: "4px",
                              fontSize: "12px",
                              background: order.alreadyBooked ? "#f1f5f9" : "#ffffff",
                              color: "#0f172a",
                            }}
                          >
                            <option value="Normal">Normal</option>
                            <option value="Reverse">Reverse</option>
                            <option value="Overnight">Overnight</option>
                            <option value="Detain">Detain</option>
                          </select>
                        </td>

                        {/* View Items Icon (📑) */}
                        <td style={{ textAlign: "center", padding: "8px 4px" }}>
                          <button
                            type="button"
                            title="View order line items"
                            onClick={() => setViewingOrder(order)}
                            style={{
                              background: "transparent",
                              border: "1px solid #cbd5e1",
                              borderRadius: "4px",
                              width: "28px",
                              height: "28px",
                              cursor: "pointer",
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: "13px",
                            }}
                          >
                            📑
                          </button>
                        </td>

                        {/* Validation Status Icon (✔ or ✖) */}
                        <td style={{ textAlign: "center", padding: "8px 4px" }}>
                          {isValid ? (
                            <span
                              title="Ready to book"
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                width: "20px",
                                height: "20px",
                                borderRadius: "50%",
                                background: "#16a34a",
                                color: "#ffffff",
                                fontSize: "11px",
                                fontWeight: "bold",
                              }}
                            >
                              ✔
                            </span>
                          ) : (
                            <span
                              title="Missing address, phone, or city"
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                width: "20px",
                                height: "20px",
                                borderRadius: "50%",
                                background: "#dc2626",
                                color: "#ffffff",
                                fontSize: "11px",
                                fontWeight: "bold",
                              }}
                            >
                              ✖
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Centered Big Prominent Upload Booking Button (Universal Courier Style) */}
          <div style={{ textAlign: "center", margin: "28px 0 20px" }}>
            <Form method="post" style={{ display: "inline-block" }}>
              <input type="hidden" name="intent" value="BOOK_BULK" />
              <input type="hidden" name="bulkPayload" value={JSON.stringify(bulkBookingPayload)} />
              <button
                type="submit"
                disabled={isSubmitting || selectedOrderIds.length === 0}
                style={{
                  background: selectedOrderIds.length > 0 ? "#16a34a" : "#94a3b8",
                  color: "#ffffff",
                  border: "none",
                  padding: "13px 44px",
                  borderRadius: "8px",
                  fontSize: "15px",
                  fontWeight: 700,
                  letterSpacing: "0.02em",
                  cursor: selectedOrderIds.length > 0 ? "pointer" : "not-allowed",
                  boxShadow: selectedOrderIds.length > 0 ? "0 4px 14px rgba(22, 163, 74, 0.35)" : "none",
                  transition: "all 140ms ease",
                }}
              >
                {isSubmitting
                  ? "Uploading Booking..."
                  : `Upload Booking${selectedOrderIds.length > 0 ? ` (${selectedOrderIds.length})` : ""}`}
              </button>
            </Form>
          </div>
        </div>
      )}

      {/* Rider Loadsheet & Scanner Tab */}
      {activeTab === "LOADSHEET" && (
        <div className="bc-stack">
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
                  style={{ width: "100%", height: "38px" }}
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

                <h3 className="bc-subtitle" style={{ margin: "0 0 12px" }}>
                  Generate Loadsheet for {selectedShipmentIds.length} Parcels
                </h3>

                <div className="bc-fields" style={{ marginBottom: "16px" }}>
                  <label>
                    <span>Rider Name</span>
                    <input type="text" name="riderName" placeholder="e.g. Asif Ali" required />
                  </label>
                  <label>
                    <span>Rider Phone / CNIC</span>
                    <input type="text" name="riderPhone" placeholder="0300-1234567" required />
                  </label>
                </div>

                <label style={{ marginBottom: "16px" }}>
                  <span>Notes / Route</span>
                  <input type="text" name="notes" placeholder="Evening Pickup Karachi Hub" />
                </label>

                <button type="submit" className="bc-btn primary" disabled={isSubmitting}>
                  {isSubmitting ? "Generating Loadsheet..." : "Confirm & Generate Loadsheet"}
                </button>
              </Form>
            )}

            {/* List Unassigned Shipments */}
            <div style={{ marginTop: "20px" }}>
              <h3 className="bc-subtitle" style={{ margin: "0 0 10px" }}>
                Parcels Waiting for Handover ({unassignedShipments.length})
              </h3>
              {unassignedShipments.length === 0 ? (
                <p className="bc-muted">No booked shipments are currently pending loadsheet handover.</p>
              ) : (
                <div className="bc-table-wrap">
                  <table className="bc-table">
                    <thead>
                      <tr>
                        <th style={{ width: "36px" }}></th>
                        <th>Order</th>
                        <th>Courier</th>
                        <th>Tracking Number</th>
                        <th>City</th>
                        <th>COD Amount</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unassignedShipments.map((ship) => (
                        <tr key={ship.id}>
                          <td>
                            <input
                              type="checkbox"
                              checked={selectedShipmentIds.includes(ship.id)}
                              onChange={() =>
                                setSelectedShipmentIds((curr) =>
                                  curr.includes(ship.id) ? curr.filter((id) => id !== ship.id) : [...curr, ship.id],
                                )
                              }
                            />
                          </td>
                          <td><strong>{ship.orderNumber}</strong></td>
                          <td><span className="bc-badge">{ship.courier}</span></td>
                          <td><code>{ship.trackingNumber}</code></td>
                          <td>{ship.destinationCity || "—"}</td>
                          <td>PKR {Number(ship.codAmount || 0).toLocaleString("en-PK")}</td>
                          <td><span className="bc-badge ok">{ship.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Past Loadsheets */}
            {pastLoadsheets.length > 0 && (
              <div style={{ marginTop: "24px" }}>
                <h3 className="bc-subtitle" style={{ margin: "0 0 10px" }}>Past Loadsheets</h3>
                <div className="bc-table-wrap">
                  <table className="bc-table">
                    <thead>
                      <tr>
                        <th>Loadsheet #</th>
                        <th>Courier</th>
                        <th>Date</th>
                        <th>Parcels</th>
                        <th>Total COD</th>
                        <th>Rider</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pastLoadsheets.map((ls) => (
                        <tr key={ls.id}>
                          <td><strong>{ls.loadsheetNumber}</strong></td>
                          <td><span className="bc-badge">{ls.courier}</span></td>
                          <td>{new Date(ls.createdAt).toLocaleDateString("en-PK")}</td>
                          <td>{ls.parcelCount}</td>
                          <td>PKR {Number(ls.totalCodAmount).toLocaleString("en-PK")}</td>
                          <td>{ls.riderName} ({ls.riderPhone})</td>
                          <td>
                            <a
                              href={`/app/awb?loadsheetId=${ls.id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="bc-btn"
                              style={{ fontSize: "11px", padding: "4px 8px" }}
                            >
                              Print Manifest
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {/* Order Line Items Detail Modal */}
      {viewingOrder && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(15, 23, 42, 0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: "20px",
          }}
          onClick={() => setViewingOrder(null)}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: "12px",
              padding: "24px",
              maxWidth: "600px",
              width: "100%",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h3 style={{ margin: 0, fontSize: "18px", fontWeight: 700, color: "#0f172a" }}>
                Items in Order {viewingOrder.name}
              </h3>
              <button
                type="button"
                onClick={() => setViewingOrder(null)}
                style={{
                  background: "transparent",
                  border: "none",
                  fontSize: "18px",
                  cursor: "pointer",
                  color: "#64748b",
                  fontWeight: 700,
                }}
              >
                ✕
              </button>
            </div>

            <div style={{ marginBottom: "14px", fontSize: "13px", color: "#475569" }}>
              <strong>Customer:</strong> {viewingOrder.customerName} ({viewingOrder.customerPhone || "No Phone"})<br />
              <strong>Address:</strong> {viewingOrder.address1} {viewingOrder.address2}, {viewingOrder.city || viewingOrder.matchedCity}
            </div>

            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", marginBottom: "16px" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left", color: "#64748b" }}>
                  <th style={{ padding: "8px 4px" }}>Item</th>
                  <th style={{ padding: "8px 4px", width: "80px", textAlign: "center" }}>Qty</th>
                  <th style={{ padding: "8px 4px", width: "100px", textAlign: "right" }}>Price</th>
                </tr>
              </thead>
              <tbody>
                {viewingOrder.items.map((item, idx) => (
                  <tr key={idx} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "8px 4px" }}>
                      <div style={{ fontWeight: 600, color: "#0f172a" }}>{item.title}</div>
                      {item.sku && <div style={{ fontSize: "11px", color: "#94a3b8" }}>SKU: {item.sku}</div>}
                    </td>
                    <td style={{ padding: "8px 4px", textAlign: "center", fontWeight: 600 }}>{item.quantity}</td>
                    <td style={{ padding: "8px 4px", textAlign: "right", fontWeight: 600 }}>
                      PKR {Number(item.price || 0).toLocaleString("en-PK")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: "12px", borderTop: "1px solid #e2e8f0" }}>
              <span style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
                Total Order Value: PKR {Number(viewingOrder.totalPrice || 0).toLocaleString("en-PK")}
              </span>
              <button
                type="button"
                className="bc-btn"
                onClick={() => setViewingOrder(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
