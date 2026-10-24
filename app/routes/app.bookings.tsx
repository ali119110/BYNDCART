import { useState, useMemo, useEffect, useRef } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useFetcher, useLoaderData, useNavigation } from "react-router";
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
import { getDecryptedCourierCredentials, getMerchantCourierBookingOptions } from "../services/courier.server";
import { isValidPakistaniMobile, MAJOR_PAKISTANI_CITIES } from "../services/pakistanLogistics";
import { getCourierOperationsSettings } from "../services/settings.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { shopifyStoreId, admin } = await requireTenantContext(request);

  // Booking must reflect the current Shopify state, never stale database snapshots.
  let unfulfilledOrders: UnfulfilledOrder[] = [];
  let bookingLoadError: string | null = null;
  try {
    unfulfilledOrders = await fetchUnfulfilledOrders(admin, shopifyStoreId, 100);
  } catch (error) {
    bookingLoadError = error instanceof Error
      ? error.message
      : "Unable to load current unfulfilled orders from Shopify. Reload the page and try again.";
  }

  // Check which couriers have active credentials - pass credentials details for pickup address
  const [postexCreds, leopardsCreds, tcsCreds, courierOperationsSettings] = await Promise.all([
    getDecryptedCourierCredentials(shopifyStoreId, "POSTEX"),
    getDecryptedCourierCredentials(shopifyStoreId, "LEOPARDS"),
    getDecryptedCourierCredentials(shopifyStoreId, "TCS"),
    getCourierOperationsSettings(shopifyStoreId),
  ]);

  // Build configured couriers list with pickup addresses from their credentials
  const configuredCouriers: Array<{
    key: string;
    label: string;
    pickupAddress: string;
    pickupCity: string;
  }> = [];

  if (postexCreds?.apiToken || postexCreds?.credentials?.apiToken) {
    configuredCouriers.push({
      key: "POSTEX",
      label: "PostEx",
      pickupAddress: (postexCreds.credentials as any)?.warehouseAddress || (postexCreds as any)?.warehouseAddress || "",
      pickupCity: (postexCreds.credentials as any)?.warehouseCity || (postexCreds as any)?.warehouseCity || "Karachi",
    });
  }
  if (leopardsCreds?.credentials?.apiKey || (leopardsCreds as any)?.apiKey) {
    configuredCouriers.push({
      key: "LEOPARDS",
      label: "Leopards Courier",
      pickupAddress: (leopardsCreds?.credentials as any)?.warehouseAddress || (leopardsCreds as any)?.warehouseAddress || "",
      pickupCity: (leopardsCreds?.credentials as any)?.warehouseCity || (leopardsCreds as any)?.warehouseCity || "Karachi",
    });
  }
  if (tcsCreds?.credentials?.clientId || (tcsCreds as any)?.clientId) {
    configuredCouriers.push({
      key: "TCS",
      label: "TCS Express",
      pickupAddress: (tcsCreds?.credentials as any)?.warehouseAddress || (tcsCreds as any)?.warehouseAddress || "",
      pickupCity: (tcsCreds?.credentials as any)?.warehouseCity || (tcsCreds as any)?.warehouseCity || "Karachi",
    });
  }
  // In-house rider is always available
  configuredCouriers.push({
    key: "RIDER",
    label: "In-House Rider",
    pickupAddress: "",
    pickupCity: "",
  });

  // Load unassigned booked shipments waiting for rider loadsheet
  const unassignedShipments = await getUnassignedBookedShipments(shopifyStoreId);

  // Load past loadsheets
  const pastLoadsheets = await listLoadsheets(shopifyStoreId);

  return {
    unfulfilledOrders,
    bookingLoadError,
    configuredCouriers,
    courierOperationsSettings,
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
    if (intent === "LOAD_COURIER_OPTIONS") {
      const providerName = String(form.get("providerName") || "").trim().toUpperCase();
      try {
        const options = await getMerchantCourierBookingOptions(shopifyStoreId, providerName);
        return { ...options, intent, error: null };
      } catch (error) {
        return {
          intent,
          providerName,
          pickupCities: [],
          deliveryCities: [],
          serviceTypes: [],
          error: error instanceof Error ? error.message : `Could not load ${providerName} booking options from its API.`,
        };
      }
    }

    if (intent === "BOOK_SINGLE") {
      const orderId = String(form.get("orderId") || "");
      const orderNumber = String(form.get("orderNumber") || "");
      const courier = String(form.get("courier") || "POSTEX");
      const customerName = String(form.get("customerName") || "");
      const customerPhone = String(form.get("customerPhone") || "");
      const customerAddress = String(form.get("customerAddress") || "");
      const cityName = String(form.get("cityName") || "");
      const codAmountPKR = Number(form.get("codAmountPKR") || 0);
      const weightKg = Number(form.get("weightKg") || 0.5);
      const remarks = String(form.get("remarks") || "");
      const serviceType = String(form.get("serviceType") || "Normal");
      let items: Array<{ title: string; quantity: number; price?: number; sku?: string }> = [];
      try {
        const rawItems = String(form.get("items") || "[]");
        const parsedItems = JSON.parse(rawItems);
        if (Array.isArray(parsedItems)) items = parsedItems;
      } catch {
        return { intent, ok: false, message: "Invalid order line-item payload." };
      }

      const result = await bookCourierShipment(admin, shopifyStoreId, session, {
        orderId,
        orderNumber,
        courier,
        serviceType,
        customerName,
        customerPhone,
        customerAddress,
        cityName,
        codAmountPKR,
        weightKg,
        remarks,
        items,
      });

      if (!result.success) {
        return { intent, ok: false, message: result.error || "Booking failed.", booking: result };
      }

      return {
        intent,
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
    return {
      intent,
      ok: false,
      message: error instanceof Error ? error.message : "Booking operation failed.",
    };
  }
}

type BookingUploadStep = {
  orderNumber: string;
  status: "pending" | "uploading" | "success" | "failed";
  message?: string;
};

type BookingUploadProgress = {
  total: number;
  completed: number;
  currentIndex: number;
  status: "uploading" | "done";
  steps: BookingUploadStep[];
};

type BulkBookingQueue = {
  items: Array<Record<string, any>>;
  index: number;
};

type CourierBookingOptionsResponse = {
  intent?: string;
  providerName?: string;
  pickupCities?: string[];
  deliveryCities?: string[];
  serviceTypes?: string[];
  citySource?: "carrier_api" | "local";
  serviceTypeSource?: "carrier_api" | "integration";
  error?: string | null;
};

function matchCarrierOption(value: string | undefined, options: string[]): string {
  const normalized = String(value || "").trim().toLocaleLowerCase();
  return options.find((option) => option.trim().toLocaleLowerCase() === normalized) || "";
}


export default function BookingsPage() {
  const { unfulfilledOrders, bookingLoadError, configuredCouriers, courierOperationsSettings, unassignedShipments, pastLoadsheets } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";
  const courierOptionsFetcher = useFetcher<CourierBookingOptionsResponse>();
  const singleBookingFetcher = useFetcher<any>();
  const [uploadProgress, setUploadProgress] = useState<BookingUploadProgress | null>(null);
  const bulkBookingQueueRef = useRef<BulkBookingQueue | null>(null);
  const handledBookingResponseRef = useRef<unknown>(null);

  const [activeTab, setActiveTab] = useState<"BOOK" | "LOADSHEET">("BOOK");

  // Default to first configured courier
  const defaultCourierKey = configuredCouriers[0]?.key || "RIDER";
  const [selectedCourierKey, setSelectedCourierKey] = useState(defaultCourierKey);
  const [selectedShipperProfileIndex, setSelectedShipperProfileIndex] = useState(
    courierOperationsSettings.defaultShipperProfileIndex ?? 0,
  );
  const activeShipperProfile =
    courierOperationsSettings.shipperProfiles[selectedShipperProfileIndex]
    || courierOperationsSettings.shipperProfiles[0]
    || { name: "", phone: "", city: "", address: "" };
  const activeCourier = configuredCouriers.find((c) => c.key === selectedCourierKey) || configuredCouriers[0];

  useEffect(() => {
    if (selectedCourierKey === "RIDER") return;
    courierOptionsFetcher.submit(
      { intent: "LOAD_COURIER_OPTIONS", providerName: selectedCourierKey },
      { method: "post" },
    );
  }, [selectedCourierKey]);

  const fetchedCourierOptions = courierOptionsFetcher.data;
  const activeCourierOptions = fetchedCourierOptions?.intent === "LOAD_COURIER_OPTIONS"
    && fetchedCourierOptions.providerName === selectedCourierKey
    ? fetchedCourierOptions
    : null;
  const courierOptionsLoading = selectedCourierKey !== "RIDER"
    && (courierOptionsFetcher.state !== "idle" || !activeCourierOptions);
  const availableServiceTypes = selectedCourierKey === "RIDER"
    ? ["Normal"]
    : (activeCourierOptions?.serviceTypes || []);
  const availableCityOptions = (serviceType: string) => {
    if (selectedCourierKey === "RIDER") return MAJOR_PAKISTANI_CITIES;
    if (!activeCourierOptions) return [];
    return serviceType === "Reverse" || serviceType === "Reversed"
      ? activeCourierOptions.pickupCities || []
      : activeCourierOptions.deliveryCities || [];
  };

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
  const [appliedFilters, setAppliedFilters] = useState({
    searchOrder: "",
    searchTag: "",
    selectDate: "",
    financialFilter: "ALL",
    fulfillmentFilter: "ALL",
  });

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 20;

  // Viewing line items modal
  const [viewingOrder, setViewingOrder] = useState<UnfulfilledOrder | null>(null);

  // Searchable city picker modal, scoped to the order currently being edited.
  const [cityPickerOrderId, setCityPickerOrderId] = useState<string | null>(null);
  const [citySearchQuery, setCitySearchQuery] = useState("");
  const [cityPickerAnchor, setCityPickerAnchor] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  // Loadsheet selection
  const [selectedShipmentIds, setSelectedShipmentIds] = useState<string[]>([]);
  const [barcodeScanInput, setBarcodeScanInput] = useState("");

  // Filtering orders only when the Search button is pressed.
  const filteredOrders = useMemo(() => {
    return unfulfilledOrders.filter((order) => {
      // Order search
      if (appliedFilters.searchOrder.trim()) {
        const q = appliedFilters.searchOrder.trim().toLowerCase();
        const matches =
          order.name.toLowerCase().includes(q) ||
          order.customerName.toLowerCase().includes(q) ||
          order.customerPhone.includes(q) ||
          order.matchedCity.toLowerCase().includes(q);
        if (!matches) return false;
      }

      // Tag search
      if (appliedFilters.searchTag.trim()) {
        const t = appliedFilters.searchTag.trim().toLowerCase();
        const matchesTag = order.tags.some((tag) => tag.toLowerCase().includes(t));
        if (!matchesTag) return false;
      }

      // Date filter
      if (appliedFilters.selectDate) {
        const orderDateStr = order.createdAt.slice(0, 10);
        if (orderDateStr !== appliedFilters.selectDate) return false;
      }

      // Financial status filter
      if (appliedFilters.financialFilter !== "ALL") {
        const finStatus = (order.displayFinancialStatus || "").toUpperCase();
        if (appliedFilters.financialFilter === "PENDING" && finStatus !== "PENDING") return false;
        if (appliedFilters.financialFilter === "PAID" && finStatus !== "PAID") return false;
        if (appliedFilters.financialFilter === "PARTIALLY_PAID" && finStatus !== "PARTIALLY_PAID") return false;
        if (appliedFilters.financialFilter === "VOIDED" && finStatus !== "VOIDED") return false;
      }

      // The source query intentionally contains only unfulfilled orders.
      if (appliedFilters.fulfillmentFilter !== "ALL"
        && order.displayFulfillmentStatus !== appliedFilters.fulfillmentFilter) return false;

      return true;
    });
  }, [unfulfilledOrders, appliedFilters]);

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

  // Build each courier payload against the current carrier's own city/type lists.
  const bulkBookingPayload = useMemo(() => {
    return selectedOrderIds.flatMap((id) => {
      const order = unfulfilledOrders.find((o) => o.id === id);
      if (!order || order.alreadyBooked) return [];
      const edit = orderEdits[id] || {};
      const serviceType = selectedCourierKey === "RIDER"
        ? "Normal"
        : (availableServiceTypes.includes(edit.type || "Normal") ? (edit.type || "Normal") : (availableServiceTypes[0] || ""));
      const cityOptions = availableCityOptions(serviceType);
      const requestedCity = edit.city !== undefined ? edit.city : (order.matchedCity || "");
      const cityName = matchCarrierOption(requestedCity, cityOptions);

      return [{
        orderId: order.id,
        orderNumber: order.name,
        courier: selectedCourierKey,
        serviceType,
        customerName: edit.name !== undefined ? edit.name : order.customerName,
        customerPhone: edit.phone !== undefined ? edit.phone : order.customerPhone,
        customerAddress: edit.address !== undefined ? edit.address : [order.address1, order.address2].filter(Boolean).join(", ").trim(),
        cityName,
        codAmountPKR: edit.cod !== undefined ? edit.cod : order.suggestedCod,
        weightKg: edit.weight !== undefined ? edit.weight : order.suggestedWeight,
        remarks: edit.remarks || "Allow customer to check flyer before payment",
        items: order.items.map((item) => ({
          title: item.title,
          quantity: item.quantity,
          price: item.price,
          sku: item.sku,
        })),
      }];
    });
  }, [selectedOrderIds, unfulfilledOrders, orderEdits, selectedCourierKey, activeCourierOptions, availableServiceTypes]);

  const selectedBookingIssues = bulkBookingPayload.filter((booking) => {
    return !booking.orderId
      || !String(booking.customerName || "").trim()
      || !isValidPakistaniMobile(String(booking.customerPhone || ""))
      || String(booking.customerAddress || "").trim().length < 8
      || !String(booking.cityName || "").trim()
      || !availableServiceTypes.includes(booking.serviceType)
      || !Number.isFinite(Number(booking.weightKg))
      || Number(booking.weightKg) <= 0
      || Number(booking.weightKg) > 50
      || !Number.isFinite(Number(booking.codAmountPKR))
      || Number(booking.codAmountPKR) < 0;
  });
  const canUploadSelectedOrders = bulkBookingPayload.length > 0
    && selectedBookingIssues.length === 0
    && !courierOptionsLoading
    && (selectedCourierKey === "RIDER" || Boolean(activeCourierOptions && !activeCourierOptions.error));

  const submitSingleBooking = (booking: Record<string, any>) => {
    singleBookingFetcher.submit({
      intent: "BOOK_SINGLE",
      orderId: String(booking.orderId),
      orderNumber: String(booking.orderNumber),
      courier: String(booking.courier),
      serviceType: String(booking.serviceType || "Normal"),
      customerName: String(booking.customerName || ""),
      customerPhone: String(booking.customerPhone || ""),
      customerAddress: String(booking.customerAddress || ""),
      cityName: String(booking.cityName || ""),
      codAmountPKR: String(booking.codAmountPKR),
      weightKg: String(booking.weightKg),
      remarks: String(booking.remarks || ""),
      items: JSON.stringify(booking.items || []),
    }, { method: "post" });
  };

  const startBulkUpload = () => {
    if (!canUploadSelectedOrders || bulkBookingQueueRef.current) return;
    const items = bulkBookingPayload.map((booking) => ({ ...booking }));
    const steps: BookingUploadStep[] = items.map((item, index) => ({
      orderNumber: item.orderNumber,
      status: index === 0 ? "uploading" : "pending",
    }));
    bulkBookingQueueRef.current = { items, index: 0 };
    handledBookingResponseRef.current = singleBookingFetcher.data;
    setUploadProgress({ total: items.length, completed: 0, currentIndex: 0, status: "uploading", steps });
    submitSingleBooking(items[0]);
  };

  useEffect(() => {
    if (singleBookingFetcher.state !== "idle") return;
    const response = singleBookingFetcher.data;
    if (!response || response.intent !== "BOOK_SINGLE" || response === handledBookingResponseRef.current) return;
    const queue = bulkBookingQueueRef.current;
    if (!queue) return;

    handledBookingResponseRef.current = response;
    const currentItem = queue.items[queue.index];
    const results = [...(uploadProgress?.steps || [])];
    results[queue.index] = {
      orderNumber: currentItem.orderNumber,
      status: response.ok ? "success" : "failed",
      message: response.message,
    };

    const nextIndex = queue.index + 1;
    if (nextIndex >= queue.items.length) {
      bulkBookingQueueRef.current = null;
      setUploadProgress({
        total: queue.items.length,
        completed: queue.items.length,
        currentIndex: queue.items.length,
        status: "done",
        steps: results,
      });
      setSelectedOrderIds((current) => current.filter((id) => !queue.items.some((item) => item.orderId === id)));
      return;
    }

    queue.index = nextIndex;
    results[nextIndex] = {
      orderNumber: queue.items[nextIndex].orderNumber,
      status: "uploading",
    };
    setUploadProgress({
      total: queue.items.length,
      completed: nextIndex,
      currentIndex: nextIndex,
      status: "uploading",
      steps: results,
    });
    submitSingleBooking(queue.items[nextIndex]);
  }, [singleBookingFetcher.state, singleBookingFetcher.data, uploadProgress?.steps]);

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

  const cityPickerOrder = cityPickerOrderId
    ? unfulfilledOrders.find((order) => order.id === cityPickerOrderId) || null
    : null;
  const cityPickerEdit = cityPickerOrder ? orderEdits[cityPickerOrder.id] || {} : {};
  const cityPickerServiceType = selectedCourierKey === "RIDER"
    ? "Normal"
    : (availableServiceTypes.includes(cityPickerEdit.type || "Normal")
      ? (cityPickerEdit.type || "Normal")
      : (availableServiceTypes[0] || ""));
  const cityPickerOptions = cityPickerOrder
    ? availableCityOptions(cityPickerServiceType)
    : [];
  const normalizedCitySearch = citySearchQuery.trim().toLocaleLowerCase();
  const cityPickerSelectedCity = cityPickerOrder
    ? matchCarrierOption(
      cityPickerEdit.city !== undefined ? cityPickerEdit.city : cityPickerOrder.matchedCity,
      cityPickerOptions,
    )
    : "";
  const filteredCityPickerOptions = cityPickerOptions.filter((city) =>
    city.toLocaleLowerCase().includes(normalizedCitySearch)
  );

  return (
    <div className="bc-page" style={{ width: "100%", maxWidth: "none", minWidth: 0, padding: "16px 20px", boxSizing: "border-box" }}>

      {bookingLoadError && (
        <div className="bc-note bad" role="alert" style={{ marginBottom: "12px" }}>
          {bookingLoadError}
        </div>
      )}
      {actionData?.message && (
        <div
          className={`bc-note ${actionData.ok ? "ok" : "bad"}`}
          style={{ marginBottom: "12px" }}
          role={actionData.ok ? "status" : "alert"}
        >
          {actionData.message}
        </div>
      )}

      {/* Booking tools — primary actions, courier selector and settings share one responsive row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "8px",
          borderBottom: "1px solid #e2e8f0",
          paddingBottom: "10px",
          marginBottom: "16px",
          width: "100%",
          minWidth: 0,
        }}
      >
        <button
          type="button"
          className={`bc-btn ${activeTab === "BOOK" ? "primary" : ""}`}
          onClick={() => setActiveTab("BOOK")}
          style={{ fontWeight: 700 }}
        >
          Create Booking ({unfulfilledOrders.length} Unfulfilled)
        </button>
        <button
          type="button"
          className={`bc-btn ${activeTab === "LOADSHEET" ? "primary" : ""}`}
          onClick={() => setActiveTab("LOADSHEET")}
        >
          Rider Loadsheet & Scanner ({unassignedShipments.length} Ready)
        </button>

        {activeTab === "BOOK" && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "8px",
              minWidth: 0,
              flex: "0 1 auto",
            }}
          >
            <span style={{ color: "#64748b", fontSize: "12px", fontWeight: 700, whiteSpace: "nowrap" }}>COURIER</span>
            {configuredCouriers.length === 0 ? (
              <Link to="/app/couriers" style={{ color: "#dc2626", fontWeight: 700, fontSize: "13px", textDecoration: "none" }}>
                Set up courier API
              </Link>
            ) : (
              <select
                aria-label="Select courier for booking"
                value={selectedCourierKey}
                onChange={(e) => {
                  setSelectedCourierKey(e.target.value);
                  setCityPickerOrderId(null);
                  setCityPickerAnchor(null);
                  setCitySearchQuery("");
                }}
                style={{
                  boxSizing: "border-box",
                  height: "38px",
                  minWidth: "165px",
                  maxWidth: "220px",
                  padding: "0 12px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "8px",
                  fontSize: "13px",
                  fontWeight: 700,
                  background: "#0f172a",
                  color: "#ffffff",
                  cursor: "pointer",
                }}
              >
                {configuredCouriers.map((courier) => (
                  <option key={courier.key} value={courier.key}>{courier.label}</option>
                ))}
              </select>
            )}
            <Link
              to="/app/couriers"
              style={{ fontSize: "13px", color: "#2563eb", fontWeight: 700, textDecoration: "none", whiteSpace: "nowrap", padding: "8px 4px" }}
            >
              ⚙ Courier Settings
            </Link>
          </div>
        )}

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
          {selectedCourierKey !== "RIDER" && (courierOptionsLoading || activeCourierOptions?.error) && (
            <div
              className={activeCourierOptions?.error ? "bc-note bad" : "bc-note"}
              role={activeCourierOptions?.error ? "alert" : "status"}
              aria-live="polite"
              style={{ margin: "0 0 12px", fontSize: "13px" }}
            >
              {courierOptionsLoading
                ? `Loading ${activeCourier?.label || selectedCourierKey} cities and order types from the carrier API…`
                : activeCourierOptions?.error}
            </div>
          )}

          {/* Responsive search and filter bar */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "10px",
              alignItems: "center",
              width: "100%",
              boxSizing: "border-box",
              background: "#ffffff",
              padding: "12px",
              borderRadius: "10px",
              border: "1px solid #dbe3ee",
              boxShadow: "0 2px 6px rgba(15, 23, 42, 0.04)",
              marginBottom: "14px",
            }}
          >
            <input
              type="text"
              aria-label="Search order"
              placeholder="Search order / customer"
              value={searchOrder}
              onChange={(e) => {
                setSearchOrder(e.target.value);
                setCurrentPage(1);
              }}
              style={{
                flex: "1 1 185px",
                minWidth: 0,
                width: "100%",
                boxSizing: "border-box",
                height: "40px",
                padding: "0 12px",
                border: "1px solid #cbd5e1",
                borderRadius: "7px",
                fontSize: "13px",
                background: "#ffffff",
                color: "#0f172a",
              }}
            />
            <input
              type="text"
              aria-label="Search tag"
              placeholder="Search tag"
              value={searchTag}
              onChange={(e) => {
                setSearchTag(e.target.value);
                setCurrentPage(1);
              }}
              style={{
                flex: "1 1 150px",
                minWidth: 0,
                width: "100%",
                boxSizing: "border-box",
                height: "40px",
                padding: "0 12px",
                border: "1px solid #cbd5e1",
                borderRadius: "7px",
                fontSize: "13px",
                background: "#ffffff",
                color: "#0f172a",
              }}
            />
            <input
              type="date"
              aria-label="Filter by order date"
              value={selectDate}
              onChange={(e) => {
                setSelectDate(e.target.value);
                setCurrentPage(1);
              }}
              style={{
                flex: "1 1 145px",
                minWidth: 0,
                width: "100%",
                boxSizing: "border-box",
                height: "40px",
                padding: "0 10px",
                border: "1px solid #cbd5e1",
                borderRadius: "7px",
                fontSize: "13px",
                background: "#ffffff",
                color: "#0f172a",
              }}
            />
            <select
              aria-label="Filter by financial status"
              value={financialFilter}
              onChange={(e) => {
                setFinancialFilter(e.target.value);
                setCurrentPage(1);
              }}
              style={{
                flex: "1 1 165px",
                minWidth: 0,
                width: "100%",
                boxSizing: "border-box",
                height: "40px",
                padding: "0 10px",
                border: "1px solid #cbd5e1",
                borderRadius: "7px",
                fontSize: "13px",
                background: "#ffffff",
                color: "#0f172a",
              }}
            >
              <option value="ALL">Financial status</option>
              <option value="PENDING">Pending (COD)</option>
              <option value="PAID">Paid</option>
              <option value="PARTIALLY_PAID">Partially paid</option>
              <option value="VOIDED">Voided</option>
            </select>
            <select
              aria-label="Filter by fulfillment status"
              value={fulfillmentFilter}
              onChange={(e) => {
                setFulfillmentFilter(e.target.value);
                setCurrentPage(1);
              }}
              style={{
                flex: "1 1 165px",
                minWidth: 0,
                width: "100%",
                boxSizing: "border-box",
                height: "40px",
                padding: "0 10px",
                border: "1px solid #cbd5e1",
                borderRadius: "7px",
                fontSize: "13px",
                background: "#ffffff",
                color: "#0f172a",
              }}
            >
              <option value="ALL">Fulfillment status</option>
              <option value="UNFULFILLED">Unfulfilled</option>
              <option value="PARTIALLY_FULFILLED">Partially fulfilled</option>
            </select>
            <button
              type="button"
              className="bc-btn"
              onClick={() => {
                setAppliedFilters({
                  searchOrder,
                  searchTag,
                  selectDate,
                  financialFilter,
                  fulfillmentFilter,
                });
                setCurrentPage(1);
              }}
              style={{
                flex: "0 0 auto",
                minWidth: "112px",
                height: "40px",
                padding: "0 20px",
                background: "#16a34a",
                color: "#ffffff",
                border: "1px solid #15803d",
                borderRadius: "7px",
                fontWeight: 700,
                fontSize: "13px",
                cursor: "pointer",
                boxShadow: "0 1px 2px rgba(15, 23, 42, 0.12)",
              }}
            >
              Search
            </button>
          </div>

          {/* Shipper Profile & Pickup Location — pull from active courier credentials */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "12px",
              marginBottom: "12px",
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              padding: "10px 14px",
            }}
          >
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px", flex: 1 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "5px", minWidth: 0 }}>
                <span style={{ fontSize: "11px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>Shipper Profile</span>
                <select
                  aria-label="Shipper Profile"
                  value={String(selectedShipperProfileIndex)}
                  onChange={(event) => setSelectedShipperProfileIndex(Number(event.target.value))}
                  style={{ height: "36px", width: "100%", boxSizing: "border-box", padding: "0 10px", border: "1px solid #cbd5e1", borderRadius: "5px", background: "#fff", color: "#0f172a", fontSize: "13px" }}
                >
                  {courierOperationsSettings.shipperProfiles.map((profile, index) => (
                    <option key={index} value={String(index)}>
                      {profile.name || `Shipper profile #${index + 1}`}{profile.city ? ` | ${profile.city}` : ""}
                    </option>
                  ))}
                </select>
                                <span style={{ fontSize: "11px", color: "#64748b", lineHeight: 1.35 }}>
                  {[activeShipperProfile.phone, activeShipperProfile.address].filter(Boolean).join(" · ") || "Manage sender details in Settings → Shipper profiles"}
                </span>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "5px", minWidth: 0 }}>
                <span style={{ fontSize: "11px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>Pickup Location</span>
                <input
                  aria-label="Pickup Location"
                  readOnly
                  value={activeCourier ? [activeCourier.pickupAddress, activeCourier.pickupCity].filter(Boolean).join(", ") : ""}
                  placeholder="Not set — configure in Courier Settings"
                  style={{ height: "36px", width: "100%", boxSizing: "border-box", padding: "0 10px", border: "1px solid #cbd5e1", borderRadius: "5px", background: "#fff", color: "#0f172a", fontSize: "13px" }}
                />
              </label>
            </div>

            {/* Back / Next Pagination */}
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <button
                type="button"
                className="bc-btn"
                disabled={currentPage === 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                style={{ minWidth: "60px", height: "34px", color: currentPage === 1 ? "#94a3b8" : "#0f172a", fontWeight: 600 }}
              >
                Back
              </button>
              <span style={{ fontSize: "12px", fontWeight: 600, color: "#475569", whiteSpace: "nowrap" }}>
                {filteredOrders.length > 0
                  ? `Page ${currentPage} of ${Math.max(1, Math.ceil(filteredOrders.length / pageSize))} (${filteredOrders.length})`
                  : "0 orders"
                }
              </span>
              <button
                type="button"
                className="bc-btn"
                disabled={currentPage >= Math.ceil(filteredOrders.length / pageSize)}
                onClick={() => setCurrentPage((p) => p + 1)}
                style={{ minWidth: "60px", height: "34px", color: currentPage >= Math.ceil(filteredOrders.length / pageSize) ? "#94a3b8" : "#0f172a", fontWeight: 600 }}
              >
                Next
              </button>
            </div>
          </div>

          {/* Universal Courier Orders Table */}
          <style>{`
            .bc-booking-table-wrap {
              width: 100%;
              min-width: 0;
              overflow-x: hidden;
            }
            .bc-booking-table {
              width: 100%;
              min-width: 0;
              table-layout: fixed;
              border-collapse: separate;
              border-spacing: 0;
            }
            .bc-booking-table th,
            .bc-booking-table td {
              box-sizing: border-box;
              min-width: 0;
              overflow: hidden;
            }
            .bc-booking-table thead tr {
              height: 38px;
            }
            .bc-booking-table tbody tr {
              height: 50px;
            }
            .bc-booking-table tbody td {
              vertical-align: middle;
            }
            .bc-booking-table th {
              padding-top: 7px !important;
              padding-bottom: 7px !important;
              font-size: 12px !important;
              white-space: normal;
              overflow-wrap: anywhere;
              line-height: 1.2;
            }
            .bc-booking-table td {
              line-height: 1.2;
            }
            .bc-booking-table td input,
            .bc-booking-table td select {
              box-sizing: border-box;
              max-width: 100%;
              min-width: 0;
            }
            .bc-booking-table .bc-order-number {
              display: block;
              max-width: 100%;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }
            @media (max-width: 1200px) {
              .bc-booking-table th { font-size: 10px !important; letter-spacing: 0 !important; }
              .bc-booking-table td input,
              .bc-booking-table td select { font-size: 11px !important; padding-left: 5px !important; padding-right: 5px !important; }
            }
          `}</style>
          <div
            className="bc-booking-table-wrap"
            style={{
              overflowX: "hidden",
              width: "100%",
              minWidth: 0,
              background: "#ffffff",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            }}
          >
            <table
              className="bc-booking-table"
              style={{ width: "100%", minWidth: 0, tableLayout: "fixed", borderCollapse: "separate", borderSpacing: 0, textAlign: "left", fontSize: "12px" }}
            >
              <colgroup>
                <col style={{ width: "2.5%" }} />
                <col style={{ width: "2.5%" }} />
                <col style={{ width: "7.5%" }} />
                <col style={{ width: "13.5%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "19%" }} />
                <col style={{ width: "12.5%" }} />
                <col style={{ width: "8%" }} />
                <col style={{ width: "6.5%" }} />
                <col style={{ width: "11%" }} />
                <col style={{ width: "3.5%" }} />
                <col style={{ width: "3.5%" }} />
              </colgroup>
              <thead>
                <tr style={{ background: "#0f172a", color: "#ffffff", fontSize: "12px", fontWeight: 700, letterSpacing: "0.02em" }}>
                  <th style={{ padding: "8px 4px", textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={
                        paginatedOrders.length > 0 &&
                        paginatedOrders.filter((o) => !o.alreadyBooked).every((o) => selectedOrderIds.includes(o.id))
                      }
                      onChange={toggleSelectAll}
                      style={{ accentColor: "#16a34a", cursor: "pointer", width: "15px", height: "15px" }}
                    />
                  </th>
                  <th style={{ padding: "8px 3px", textAlign: "center" }}>#</th>
                  <th style={{ padding: "8px 5px" }}>Order</th>
                  <th style={{ padding: "8px 5px" }}>Customer</th>
                  <th style={{ padding: "8px 5px" }}>Phone</th>
                  <th style={{ padding: "8px 5px" }}>Delivery Address</th>
                  <th style={{ padding: "8px 5px" }}>City</th>
                  <th style={{ padding: "8px 5px" }}>COD (PKR)</th>
                  <th style={{ padding: "8px 5px" }}>Weight (kg)</th>
                  <th style={{ padding: "8px 5px" }}>Service type</th>
                  <th style={{ padding: "8px 3px", textAlign: "center" }}></th>
                  <th style={{ padding: "8px 3px", textAlign: "center" }}></th>
                </tr>
              </thead>
              <tbody>
                {paginatedOrders.length === 0 ? (
                  <tr>
                    <td colSpan={12} style={{ padding: "36px 16px", textAlign: "center", color: "#64748b" }}>
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
                    const currentCod = edit.cod !== undefined ? edit.cod : order.suggestedCod;
                    const currentWeight = edit.weight !== undefined ? edit.weight : order.suggestedWeight;
                    const currentType = selectedCourierKey === "RIDER"
                      ? "Normal"
                      : (availableServiceTypes.includes(edit.type || "Normal") ? (edit.type || "Normal") : (availableServiceTypes[0] || ""));
                    const currentCityOptions = availableCityOptions(currentType);
                    const currentCityCandidate = edit.city !== undefined ? edit.city : order.matchedCity;
                    const currentCity = matchCarrierOption(currentCityCandidate, currentCityOptions);

                    const isSelected = selectedOrderIds.includes(order.id);

                    // Validation status: phone has digits, address has content, city is chosen
                    const isValid = Boolean(
                      currentName.trim()
                      && isValidPakistaniMobile(currentPhone)
                      && currentAddress.trim().length >= 8
                      && currentCity
                      && availableServiceTypes.includes(currentType)
                      && Number.isFinite(Number(currentWeight))
                      && currentWeight > 0
                      && Number.isFinite(Number(currentCod))
                      && currentCod >= 0
                    );

                    return (
                      <tr
                        key={order.id}
                        style={{
                          borderBottom: "1px solid #e2e8f0",
                          background: order.alreadyBooked ? "#f8fafc" : isSelected ? "#f0fdf4" : idx % 2 === 0 ? "#ffffff" : "#fcfcfd",
                        }}
                      >
                        {/* Checkbox */}
                        <td style={{ verticalAlign: "middle", textAlign: "center", padding: "4px 6px" }}>
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
                        <td style={{ verticalAlign: "middle", textAlign: "center", padding: "4px 5px", fontSize: "12px", color: "#64748b", fontWeight: 600 }}>
                          {rowNumber}
                        </td>

                        {/* Order Number Link */}
                        <td style={{ verticalAlign: "middle", padding: "4px 6px" }}>
                          <span
                            className="bc-order-link bc-order-number"
                            style={{
                              color: "#0d9488",
                              fontWeight: 700,
                              fontSize: "12px",
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

                        {/* Customer name and email */}
                        <td style={{ verticalAlign: "middle", padding: "4px 6px" }}>
                          <input
                            type="text"
                            value={currentName}
                            title={currentName}
                            disabled={order.alreadyBooked}
                            onChange={(e) => handleEditOrder(order.id, "name", e.target.value)}
                            style={{
                              boxSizing: "border-box",
                              width: "100%",
                              minWidth: 0,
                              height: "30px",
                              padding: "3px 7px",
                              border: "1px solid #cbd5e1",
                              borderRadius: "5px",
                              fontSize: "12px",
                              background: order.alreadyBooked ? "#f1f5f9" : "#ffffff",
                              color: "#0f172a",
                            }}
                          />
                        </td>

                        {/* Phone */}
                        <td style={{ verticalAlign: "middle", padding: "4px 6px" }}>
                          <input
                            type="text"
                            value={currentPhone}
                            title={currentPhone}
                            placeholder="03001234567"
                            disabled={order.alreadyBooked}
                            onChange={(e) => handleEditOrder(order.id, "phone", e.target.value)}
                            style={{
                              boxSizing: "border-box",
                              width: "100%",
                              minWidth: 0,
                              height: "30px",
                              padding: "3px 7px",
                              border: "1px solid #cbd5e1",
                              borderRadius: "5px",
                              fontSize: "12px",
                              background: order.alreadyBooked ? "#f1f5f9" : "#ffffff",
                              color: "#0f172a",
                            }}
                          />
                        </td>

                        {/* Delivery address and carrier-supported city in a single, aligned column */}
                        <td style={{ verticalAlign: "middle", padding: "4px 6px" }}>
                          <input
                            type="text"
                            value={currentAddress}
                            title={currentAddress}
                            placeholder="Street, Area, Building"
                            disabled={order.alreadyBooked}
                            onChange={(e) => handleEditOrder(order.id, "address", e.target.value)}
                            style={{
                              boxSizing: "border-box",
                              width: "100%",
                              minWidth: 0,
                              height: "30px",
                              padding: "3px 7px",
                              border: "1px solid #cbd5e1",
                              borderRadius: "5px",
                              fontSize: "12px",
                              background: order.alreadyBooked ? "#f1f5f9" : "#ffffff",
                              color: "#0f172a",
                            }}
                          />
                        </td>

                        {/* Searchable, courier-specific city picker */}
                        <td style={{ verticalAlign: "middle", padding: "4px 5px" }}>
                          <button
                            type="button"
                            aria-label={`Choose ${selectedCourierKey} city for ${order.name}`}
                            title={currentCity || "Search carrier cities"}
                            disabled={order.alreadyBooked || courierOptionsLoading || currentCityOptions.length === 0}
                            onClick={(event) => {
                              const rect = event.currentTarget.getBoundingClientRect();
                              const width = Math.min(rect.width, window.innerWidth - 16);
                              const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
                              setCityPickerAnchor({
                                top: rect.top,
                                left,
                                width,
                                maxHeight: Math.max(160, Math.min(360, rect.top - 16)),
                              });
                              setCityPickerOrderId(order.id);
                              setCitySearchQuery("");
                            }}
                            style={{
                              boxSizing: "border-box",
                              width: "100%",
                              minWidth: 0,
                              minHeight: "30px",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: "6px",
                              padding: "3px 6px",
                              border: "1px solid #cbd5e1",
                              borderRadius: "5px",
                              background: order.alreadyBooked ? "#f1f5f9" : "#ffffff",
                              color: currentCity ? "#0f172a" : "#64748b",
                              fontSize: "12px",
                              textAlign: "left",
                              cursor: order.alreadyBooked || courierOptionsLoading || currentCityOptions.length === 0 ? "not-allowed" : "pointer",
                              opacity: order.alreadyBooked ? 0.7 : 1,
                            }}
                          >
                            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {currentCity
                                || (courierOptionsLoading ? "Loading cities…" : currentCityOptions.length ? "Search / select city" : "City list unavailable")}
                            </span>
                            <span aria-hidden="true" style={{ flex: "0 0 auto", color: "#64748b" }}>⌄</span>
                          </button>
                        </td>

                        {/* COD Amount */}
                        <td style={{ verticalAlign: "middle", padding: "4px 6px" }}>
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={currentCod}
                            disabled={order.alreadyBooked}
                            onChange={(e) => handleEditOrder(order.id, "cod", Number(e.target.value))}
                            style={{
                              boxSizing: "border-box",
                              width: "100%",
                              minWidth: 0,
                              height: "30px",
                              padding: "3px 6px",
                              border: "1px solid #cbd5e1",
                              borderRadius: "5px",
                              fontSize: "12px",
                              textAlign: "right",
                              background: order.alreadyBooked ? "#f1f5f9" : "#ffffff",
                              color: "#0f172a",
                            }}
                          />
                        </td>

                        {/* KG Weight */}
                        <td style={{ verticalAlign: "middle", padding: "4px 6px" }}>
                          <input
                            type="number"
                            step="0.1"
                            min="0.1"
                            max="50"
                            value={currentWeight}
                            disabled={order.alreadyBooked}
                            onChange={(e) => handleEditOrder(order.id, "weight", Number(e.target.value))}
                            style={{
                              boxSizing: "border-box",
                              width: "100%",
                              minWidth: 0,
                              height: "30px",
                              padding: "3px 5px",
                              border: "1px solid #cbd5e1",
                              borderRadius: "5px",
                              fontSize: "12px",
                              textAlign: "center",
                              background: order.alreadyBooked ? "#f1f5f9" : "#ffffff",
                              color: "#0f172a",
                            }}
                          />
                        </td>

                        {/* Service Type */}
                        <td style={{ verticalAlign: "middle", padding: "4px 6px" }}>
                          <select
                            value={currentType}
                            disabled={order.alreadyBooked || selectedCourierKey === "RIDER" || courierOptionsLoading || availableServiceTypes.length === 0}
                            onChange={(e) => handleEditOrder(order.id, "type", e.target.value)}
                            style={{
                              boxSizing: "border-box",
                              width: "100%",
                              minWidth: 0,
                              height: "30px",
                              padding: "2px 7px",
                              border: "1px solid #cbd5e1",
                              borderRadius: "5px",
                              fontSize: "12px",
                              background: order.alreadyBooked ? "#f1f5f9" : "#ffffff",
                              color: "#0f172a",
                            }}
                          >
                            {availableServiceTypes.length === 0 && <option value="">{courierOptionsLoading ? "Loading types…" : "No types available"}</option>}
                            {availableServiceTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                          </select>
                        </td>

                        {/* View Items Icon (📑) */}
                        <td style={{ verticalAlign: "middle", textAlign: "center", padding: "4px 3px" }}>
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
                              fontSize: "12px",
                            }}
                          >
                            📑
                          </button>
                        </td>

                        {/* Validation Status Icon (✔ or ✖) */}
                        <td style={{ verticalAlign: "middle", textAlign: "center", padding: "4px 3px" }}>
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

          {/* Sequential Upload Booking action with per-order status */}
          <div style={{ margin: "24px 0 20px", display: "flex", flexDirection: "column", alignItems: "center", gap: "12px" }}>
            {bulkBookingPayload.length > 0 && selectedBookingIssues.length > 0 && (
              <p role="alert" style={{ color: "#b91c1c", fontSize: "13px", margin: 0, textAlign: "center" }}>
                Complete the customer details in the selected rows before uploading. {selectedBookingIssues.length} selected order(s) need attention.
              </p>
            )}
            {uploadProgress && (
              <section
                aria-live="polite"
                aria-busy={uploadProgress.status === "uploading"}
                style={{
                  width: "min(100%, 940px)",
                  boxSizing: "border-box",
                  background: "#ffffff",
                  border: "1px solid #dbe3ee",
                  borderRadius: "12px",
                  padding: "16px",
                  boxShadow: "0 3px 10px rgba(15, 23, 42, 0.05)",
                  textAlign: "left",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap", marginBottom: "10px" }}>
                  <strong style={{ color: "#0f172a", fontSize: "14px" }}>
                    {uploadProgress.status === "uploading"
                      ? `Uploading order ${uploadProgress.currentIndex + 1} of ${uploadProgress.total}: ${uploadProgress.steps[uploadProgress.currentIndex]?.orderNumber || ""}`
                      : "Booking upload finished"}
                  </strong>
                  <span style={{ color: "#64748b", fontSize: "12px", fontWeight: 700 }}>
                    {uploadProgress.completed} / {uploadProgress.total} processed
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-label="Booking upload progress"
                  aria-valuemin={0}
                  aria-valuemax={uploadProgress.total}
                  aria-valuenow={uploadProgress.completed}
                  style={{ height: "7px", overflow: "hidden", background: "#e2e8f0", borderRadius: "999px", marginBottom: "14px" }}
                >
                  <div style={{ height: "100%", width: `${Math.round((uploadProgress.completed / Math.max(1, uploadProgress.total)) * 100)}%`, background: "#16a34a", borderRadius: "999px", transition: "width 160ms ease" }} />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "8px" }}>
                  {uploadProgress.steps.map((step, index) => {
                    const colors = step.status === "success"
                      ? { bg: "#ecfdf5", border: "#a7f3d0", text: "#047857", label: "Booked" }
                      : step.status === "failed"
                        ? { bg: "#fef2f2", border: "#fecaca", text: "#b91c1c", label: "Failed" }
                        : step.status === "uploading"
                          ? { bg: "#eff6ff", border: "#bfdbfe", text: "#1d4ed8", label: "Uploading…" }
                          : { bg: "#f8fafc", border: "#e2e8f0", text: "#64748b", label: "Queued" };
                    return (
                      <div key={`${step.orderNumber}-${index}`} title={step.message || step.orderNumber} style={{ minWidth: 0, padding: "9px 10px", border: `1px solid ${colors.border}`, background: colors.bg, color: colors.text, borderRadius: "8px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "12px", fontWeight: 700 }}>
                          <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: "22px", height: "22px", flex: "0 0 22px", borderRadius: "50%", border: `1px solid ${colors.border}`, background: "#ffffff" }}>{index + 1}</span>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{step.orderNumber}</span>
                          <span style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>{colors.label}</span>
                        </div>
                        {step.status === "failed" && step.message && <div style={{ marginTop: "7px", fontSize: "11px", lineHeight: 1.4, overflowWrap: "anywhere" }}>{step.message}</div>}
                      </div>
                    );
                  })}
                </div>
                {uploadProgress.status === "done" && (
                  <p style={{ margin: "12px 0 0", color: "#334155", fontSize: "13px" }}>
                    {uploadProgress.steps.filter((step) => step.status === "success").length} booked successfully · {uploadProgress.steps.filter((step) => step.status === "failed").length} failed.
                  </p>
                )}
              </section>
            )}

            <button
              type="button"
              onClick={startBulkUpload}
              disabled={isSubmitting || uploadProgress?.status === "uploading" || !canUploadSelectedOrders}
              style={{
                background: canUploadSelectedOrders && uploadProgress?.status !== "uploading" ? "#16834b" : "#94a3b8",
                color: "#ffffff",
                border: "none",
                padding: "13px 38px",
                borderRadius: "8px",
                fontSize: "15px",
                fontWeight: 700,
                letterSpacing: "0.01em",
                cursor: canUploadSelectedOrders && uploadProgress?.status !== "uploading" ? "pointer" : "not-allowed",
                boxShadow: canUploadSelectedOrders && uploadProgress?.status !== "uploading" ? "0 2px 5px rgba(15, 23, 42, 0.15)" : "none",
                transition: "all 140ms ease",
              }}
            >
              {uploadProgress?.status === "uploading"
                ? `Uploading order ${uploadProgress.currentIndex + 1} of ${uploadProgress.total}…`
                : `Upload Booking${bulkBookingPayload.length > 0 ? ` (${bulkBookingPayload.length})` : ""}`}
            </button>
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
                <input type="hidden" name="courier" value={selectedCourierKey} />
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
      {cityPickerOrder && cityPickerAnchor && (
        <div
          role="presentation"
          onClick={() => {
            setCityPickerOrderId(null);
            setCityPickerAnchor(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setCityPickerOrderId(null);
              setCityPickerAnchor(null);
            }
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10000,
            background: "transparent",
          }}
        >
          <section
            role="dialog"
            aria-modal="false"
            aria-labelledby="bc-city-picker-title"
            onClick={(event) => event.stopPropagation()}
            style={{
              position: "fixed",
              left: `${cityPickerAnchor.left}px`,
              bottom: `calc(100vh - ${cityPickerAnchor.top}px + 6px)`,
              width: `${cityPickerAnchor.width}px`,
              maxWidth: "calc(100vw - 16px)",
              maxHeight: `${cityPickerAnchor.maxHeight}px`,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              background: "#ffffff",
              border: "1px solid #cbd5e1",
              borderRadius: "9px",
              boxShadow: "0 8px 24px rgba(15, 23, 42, 0.18)",
              textAlign: "left",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px", padding: "8px 9px", borderBottom: "1px solid #e2e8f0" }}>
              <div style={{ minWidth: 0 }}>
                <h3 id="bc-city-picker-title" style={{ margin: 0, color: "#0f172a", fontSize: "12px", lineHeight: 1.3, fontWeight: 750, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {cityPickerServiceType === "Reverse" || cityPickerServiceType === "Reversed" ? "Pickup city" : "Delivery city"}
                </h3>
                <p style={{ margin: "2px 0 0", color: "#64748b", fontSize: "10px", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {cityPickerOrder.name} · {activeCourier?.label || selectedCourierKey}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close city picker"
                onClick={() => {
                  setCityPickerOrderId(null);
                  setCityPickerAnchor(null);
                }}
                style={{ flex: "0 0 22px", width: "22px", height: "22px", padding: 0, border: "1px solid #e2e8f0", borderRadius: "5px", background: "#ffffff", color: "#475569", cursor: "pointer", fontSize: "15px", lineHeight: 1 }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: "8px 8px 5px" }}>
              <label htmlFor="bc-city-search" style={{ display: "block", marginBottom: "4px", fontSize: "10px", fontWeight: 700, color: "#475569" }}>
                Search city
              </label>
              <input
                id="bc-city-search"
                type="search"
                autoFocus
                autoComplete="off"
                placeholder="Type city name…"
                value={citySearchQuery}
                onChange={(event) => setCitySearchQuery(event.target.value)}
                style={{ boxSizing: "border-box", width: "100%", height: "32px", border: "1px solid #cbd5e1", borderRadius: "6px", padding: "0 8px", outlineColor: "#2563eb", fontSize: "12px", color: "#0f172a", background: "#ffffff" }}
              />
              <div style={{ marginTop: "4px", color: "#64748b", fontSize: "10px" }}>
                {filteredCityPickerOptions.length} {filteredCityPickerOptions.length === 1 ? "match" : "matches"}
              </div>
            </div>

            <div role="listbox" aria-label="Matching carrier cities" style={{ overflowY: "auto", flex: "1 1 auto", minHeight: 0, padding: "0 5px 5px" }}>
              {filteredCityPickerOptions.length === 0 ? (
                <div style={{ margin: "3px", padding: "12px 5px", textAlign: "center", border: "1px dashed #cbd5e1", borderRadius: "6px", color: "#64748b", fontSize: "11px", lineHeight: 1.35 }}>
                  {cityPickerOptions.length === 0
                    ? "No city list available for this courier."
                    : "No cities match. Try another search."}
                </div>
              ) : (
                filteredCityPickerOptions.map((city) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={cityPickerSelectedCity === city}
                    key={city}
                    onClick={() => {
                      handleEditOrder(cityPickerOrder.id, "city", city);
                      setCityPickerOrderId(null);
                      setCityPickerAnchor(null);
                      setCitySearchQuery("");
                    }}
                    style={{
                      boxSizing: "border-box",
                      width: "100%",
                      minHeight: "30px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "6px",
                      padding: "5px 7px",
                      border: "1px solid transparent",
                      borderRadius: "5px",
                      background: cityPickerSelectedCity === city ? "#eff6ff" : "#ffffff",
                      color: "#0f172a",
                      fontSize: "11px",
                      fontWeight: cityPickerSelectedCity === city ? 700 : 500,
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{city}</span>
                    {cityPickerSelectedCity === city && <span aria-hidden="true" style={{ flex: "0 0 auto", color: "#2563eb", fontWeight: 800 }}>✓</span>}
                  </button>
                ))
              )}
            </div>
          </section>
        </div>
      )}

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
