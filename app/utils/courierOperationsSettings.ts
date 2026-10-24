export type ShipperProfile = {
  name: string;
  phone: string;
  email: string;
  city: string;
  address: string;
};

export type CourierOperationsSettings = {
  autoCourierTracking: boolean;
  sendDeliveryUpdates: boolean;
  deliveryUpdatePage: string;
  deliveryUpdateTemplate: string;
  fraudCheckEnabled: boolean;
  fraudTagDefinition: string;
  duplicateCheckEnabled: boolean;
  duplicateCheckDurationMinutes: number;
  labelWebsite: string;
  labelLogoUrl: string;
  labelSize: "A4_3" | "A4_4" | "THERMAL_4X6";
  defaultShipperProfileIndex: number;
  shipperProfiles: ShipperProfile[];
};

export const DEFAULT_COURIER_OPERATIONS_SETTINGS: CourierOperationsSettings = {
  // Preserve BYNDCART's existing on-demand live tracking behavior for stores not yet configured.
  autoCourierTracking: true,
  // Customer messaging is opt-in so a newly installed store cannot send billable messages unexpectedly.
  sendDeliveryUpdates: false,
  deliveryUpdatePage: "COURIER_LOGS",
  deliveryUpdateTemplate:
    "Dear [customer_name] - [customer_phone], your order # [order_number] of amount Rs [order_amount] has been shipped.[line][line]*Courier:* [courier_name][line]*Tracking:* [tracking_number][line][line]Track your parcel: [tracking_url]",
  fraudCheckEnabled: false,
  fraudTagDefinition: "courier: Trusted - if customer delivery ratio > 85%",
  duplicateCheckEnabled: false,
  duplicateCheckDurationMinutes: 30,
  labelWebsite: "",
  labelLogoUrl: "",
  labelSize: "A4_3",
  defaultShipperProfileIndex: 0,
  shipperProfiles: [
    { name: "", phone: "", email: "", city: "", address: "" },
    { name: "", phone: "", email: "", city: "", address: "" },
    { name: "", phone: "", email: "", city: "", address: "" },
  ],
};

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function boundedSettingText(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

/** Normalize the JSON settings so older stores always receive a complete, safe shape. */
export function normalizeCourierOperationsSettings(value: unknown): CourierOperationsSettings {
  const raw = asRecord(value);
  const profilesValue = Array.isArray(raw.shipperProfiles) ? raw.shipperProfiles : [];
  const shipperProfiles = Array.from({ length: 3 }, (_, index) => {
    const profile = asRecord(profilesValue[index]);
    return {
      name: boundedSettingText(profile.name, 100),
      phone: boundedSettingText(profile.phone, 40),
      email: boundedSettingText(profile.email, 200),
      city: boundedSettingText(profile.city, 100),
      address: boundedSettingText(profile.address, 500),
    };
  });
  const duration = Number(raw.duplicateCheckDurationMinutes);
  const labelSize = ["A4_3", "A4_4", "THERMAL_4X6"].includes(String(raw.labelSize))
    ? String(raw.labelSize) as CourierOperationsSettings["labelSize"]
    : DEFAULT_COURIER_OPERATIONS_SETTINGS.labelSize;
  const defaultIndex = Number(raw.defaultShipperProfileIndex);

  return {
    autoCourierTracking: typeof raw.autoCourierTracking === "boolean"
      ? raw.autoCourierTracking
      : DEFAULT_COURIER_OPERATIONS_SETTINGS.autoCourierTracking,
    sendDeliveryUpdates: typeof raw.sendDeliveryUpdates === "boolean"
      ? raw.sendDeliveryUpdates
      : DEFAULT_COURIER_OPERATIONS_SETTINGS.sendDeliveryUpdates,
    deliveryUpdatePage: raw.deliveryUpdatePage === "SHIPMENTS" ? "SHIPMENTS" : "COURIER_LOGS",
    deliveryUpdateTemplate: boundedSettingText(
      raw.deliveryUpdateTemplate ?? DEFAULT_COURIER_OPERATIONS_SETTINGS.deliveryUpdateTemplate,
      4000,
    ),
    fraudCheckEnabled: raw.fraudCheckEnabled === true,
    fraudTagDefinition: boundedSettingText(
      raw.fraudTagDefinition ?? DEFAULT_COURIER_OPERATIONS_SETTINGS.fraudTagDefinition,
      160,
    ),
    duplicateCheckEnabled: raw.duplicateCheckEnabled === true,
    duplicateCheckDurationMinutes: [15, 30, 60, 120, 240].includes(duration)
      ? duration
      : DEFAULT_COURIER_OPERATIONS_SETTINGS.duplicateCheckDurationMinutes,
    labelWebsite: boundedSettingText(raw.labelWebsite, 200),
    labelLogoUrl: boundedSettingText(raw.labelLogoUrl, 1000),
    labelSize,
    defaultShipperProfileIndex: Number.isInteger(defaultIndex) && defaultIndex >= 0 && defaultIndex < 3 ? defaultIndex : 0,
    shipperProfiles,
  };
}
