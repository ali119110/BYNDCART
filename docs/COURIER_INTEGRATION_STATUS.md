# BYNDCART Courier Integrations — Verified Source Status

> This document describes behavior visible in the courier routes and services in this code package. It does not claim that a carrier API is live merely because a merchant can save credentials. Vendor API schemas and production credentials must be independently tested before a carrier is described as production-ready.

## Current integration status

| Carrier | Credentials supported in Settings | Live booking implemented in BYNDCART | Live tracking | Live cancellation | Operational workflow |
|---|---|---|---|---|---|
| PostEx | API token | Return pickup only, when the store token and real pickup phone/address are supplied | Not implemented | Not implemented | Test the connection, submit a return through the customer portal, and confirm that a tracking number is returned. If it is not confirmed, book with PostEx and record the airway bill manually. |
| Leopards | API key/password | No | No | No | Book directly with Leopards and record the airway bill manually. Saving credentials does not verify a connection. |
| Trax | API token | No | No | No | Book directly with Trax and record the airway bill manually. Saving credentials does not verify a connection. |
| TCS | API key and cost center code | No | No | No | Book directly with TCS and record the airway bill manually. Saving credentials does not verify a connection. |
| M&P | API token | No | No | No | Book directly with M&P and record the airway bill manually. Saving credentials does not verify a connection. |
| CallCourier | Login/API credential | No | No | No | Book directly with CallCourier and record the airway bill manually. Saving credentials does not verify a connection. |
| Rider | Optional account reference | No | No | No | Manual airway-bill workflow only. |

`CourierRegistry.getRegisteredAdapters()` lists all seven carriers for merchant configuration and the customer courier selector. An entry in that list means the carrier is registered in BYNDCART; it does not mean booking, tracking, or cancellation APIs are implemented. Unknown provider names are rejected instead of silently falling back to TCS.

## Merchant courier settings

The merchant-facing settings route is `app/routes/app.couriers.tsx`.

- `SAVE_CONFIG` stores the merchant's token with encryption through `saveMerchantCourierConfig` and enables the config.
- The API token is not read back into the browser. An empty token when editing an already-configured courier means “keep the saved token”; enter a new token to replace it.
- `SET_DEFAULT_REVERSE` selects the default return/inbound courier.
- `SET_DEFAULT_FORWARD` selects the default exchange/outbound courier.
- If the requested default is absent, `getDefaultMerchantCourier` falls back to the first enabled config; if none exists, it falls back to TCS. For that reason, merchants should set both defaults explicitly.
- A default can currently be set before a carrier has credentials, so a selected manual-only or unconfigured carrier may still require an airway bill.
- The database config `isLive` flag is not proof that a carrier connection was tested. In this implementation it is not set to true by the save flow.
- Only PostEx's `testConnection()` makes an HTTP request (to its operational-cities endpoint). For other carriers, a credential-input check is not a live connection test; the merchant UI must say so clearly.

## Return request flow

1. `app/routes/portal.tsx` resolves the store and displays the registered courier options. Its default selection comes from `getDefaultMerchantCourier(storeId, "REVERSE")`.
2. After OTP verification, the customer selects return items and a courier.
3. `app/services/portal.server.ts` checks the customer session, plan gate, and return policy before creating a return request.
4. It loads the courier credentials for the **same `shopifyStoreId`** using `getDecryptedCourierCredentials` and passes them to `generateReturnLabel`.
5. PostEx live return booking requires an API token plus a real pickup phone number and full pickup address. BYNDCART must not substitute placeholder phone numbers, addresses, or an app-wide token.
6. A booking is considered confirmed only when the adapter returns success, `isLive: true`, and a non-empty tracking number. Only a confirmed booking is immediately registered in `ShipmentTrack`.
7. If booking is not confirmed, the return request can still be submitted, but the customer must be told that the request was recorded and that the airway bill is pending. Do not present that outcome as a confirmed shipment.
8. The current PostEx response parser does not populate `LabelResult.costPKR`. As a result, the current refund calculation does not deduct a PostEx pickup fee from the displayed estimate. The UI must describe the amount as an estimate before any unquoted courier fee; do not document the current value as a final courier-cost-adjusted refund.

## Forward and exchange shipment behavior

The current PostEx endpoint used by this code is the return-order endpoint. BYNDCART must not call that endpoint for a forward or replacement shipment. Until a verified PostEx forward API workflow is implemented, forward/exchange shipment creation returns an unconfirmed result and requires a manual airway bill.

`app/services/shipments.server.ts` resolves the `FORWARD` default for `FORWARD` and `EXCHANGE` shipment types; `RETURN` uses the reverse/return default.

## Shipment records and manual airway bills

- `app/routes/app.shipments.tsx` is a record-entry screen, not a booking screen.
- A manual entry requires a real synced order, a courier, shipment type, and the confirmed airway bill/tracking number. A label URL is optional and must be an HTTP(S) URL.
- The route must use the real `shopifyOrderId` stored against the merchant's order; it must never generate a fake Shopify Order GID.
- Manual records start at `LABEL_CREATED`. That status means a label/airway bill is recorded; it does not mean a carrier event was independently verified.
- `ShipmentTrack` records are stored by `registerShipmentTrack` and listed by `getStoreShipments`.
- All current adapters return `UNKNOWN` for live tracking. PostEx booking is live, but this is not a live tracking integration.
- Current manual entry associates the shipment with the order. The route does not currently accept a related return-request or exchange-request ID, so it should not be documented as linking a manually entered airway bill to a specific request record unless that linkage is added separately.

## Files involved

- `app/routes/app.couriers.tsx` — merchant credential configuration, default selection, PostEx connection test UI.
- `app/services/courier.server.ts` — adapter registry, credential persistence, and carrier adapter behaviors.
- `app/routes/portal.tsx` — customer return portal and courier selection.
- `app/services/portal.server.ts` — policy/session checks, return submission, and return-label request.
- `app/routes/app.shipments.tsx` — manual airway-bill entry and shipment list.
- `app/services/shipments.server.ts` — shipment record persistence and status sync.

## Before calling a carrier integration production-ready

For each provider, verify the carrier's current official documentation, required payload fields, authentication method, sandbox/production endpoints, booking response schema, label format, tracking API, cancellation API, and idempotency behavior. Then add integration tests using test credentials and test addresses. The code status table above should only be updated after those steps are proven.
