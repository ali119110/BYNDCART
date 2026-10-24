import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_COURIER_OPERATIONS_SETTINGS,
  normalizeCourierOperationsSettings,
} from "../services/settings.server";

test("shared courier settings provide safe defaults for existing stores", () => {
  const settings = normalizeCourierOperationsSettings(null);

  assert.equal(settings.autoCourierTracking, true);
  assert.equal(settings.sendDeliveryUpdates, false);
  assert.equal(settings.deliveryUpdatePage, "COURIER_LOGS");
  assert.equal(settings.duplicateCheckDurationMinutes, 30);
  assert.equal(settings.labelSize, "A4_3");
  assert.equal(settings.shipperProfiles.length, 3);
  assert.deepEqual(settings.shipperProfiles[0], {
    name: "",
    phone: "",
    email: "",
    city: "",
    state: "",
    postalCode: "",
    countryCode: "PK",
    address: "",
  });
});
test("shared courier settings normalize saved profile and label options", () => {
  const settings = normalizeCourierOperationsSettings({
    autoCourierTracking: false,
    sendDeliveryUpdates: false,
    fraudCheckEnabled: true,
    fraudTagDefinition: "courier: Trusted - if customer delivery ratio > 90%",
    duplicateCheckEnabled: true,
    duplicateCheckDurationMinutes: 60,
    labelWebsite: "fear.com.pk",
    labelLogoUrl: "https://cdn.shopify.com/logo.png",
    labelSize: "THERMAL_4X6",
    defaultShipperProfileIndex: 1,
    shipperProfiles: [
      {
        name: "FEAR",
        phone: "03703298156",
        email: "dispatch@fear.com.pk",
        city: "Karachi",
        state: "Sindh",
        postalCode: "74000",
        countryCode: "PK",
        address: "Row E, Block 4",
      },
      {
        name: "Warehouse 2",
        phone: "03001234567",
        email: "",
        city: "Lahore",
        state: "",
        postalCode: "",
        countryCode: "PK",
        address: "Second Street",
      },
    ],
  });

  assert.equal(settings.autoCourierTracking, false);
  assert.equal(settings.sendDeliveryUpdates, false);
  assert.equal(settings.fraudCheckEnabled, true);
  assert.equal(settings.duplicateCheckEnabled, true);
  assert.equal(settings.duplicateCheckDurationMinutes, 60);
  assert.equal(settings.labelSize, "THERMAL_4X6");
  assert.equal(settings.defaultShipperProfileIndex, 1);
  assert.equal(settings.shipperProfiles[0].name, "FEAR");
  assert.equal(settings.shipperProfiles[1].city, "Lahore");
  assert.equal(settings.shipperProfiles[0].email, "dispatch@fear.com.pk");
  assert.equal(settings.shipperProfiles[0].countryCode, "PK");
  assert.equal(settings.shipperProfiles[0].postalCode, "74000");
  assert.deepEqual(settings.shipperProfiles[2], {
    name: "",
    phone: "",
    email: "",
    city: "",
    state: "",
    postalCode: "",
    countryCode: "PK",
    address: "",
  });
});
test("invalid shared courier preferences fall back instead of breaking booking", () => {
  const settings = normalizeCourierOperationsSettings({
    duplicateCheckDurationMinutes: 19,
    labelSize: "INVALID_SIZE",
    defaultShipperProfileIndex: 9,
    shipperProfiles: [
      { name: "  Example Merchant  ", address: " x ".repeat(400) },
    ],
  });

  assert.equal(settings.duplicateCheckDurationMinutes, 30);
  assert.equal(
    settings.labelSize,
    DEFAULT_COURIER_OPERATIONS_SETTINGS.labelSize,
  );
  assert.equal(settings.defaultShipperProfileIndex, 0);
  assert.equal(settings.shipperProfiles[0].name, "Example Merchant");
  assert.equal(settings.shipperProfiles[0].address.length, 500);
  assert.equal(settings.shipperProfiles.length, 3);
});
