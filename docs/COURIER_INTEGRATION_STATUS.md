# BYNDCART Courier Integration Status

## Current capability matrix

| Provider | Registered in app | Credential test | API booking | Tracking | Cancellation | Document/label | Status |
|---|---:|---:|---:|---:|---:|---:|---|
| PostEx | Yes | Operational Cities endpoint | Normal / Reverse / Replacement | `track-order` | `cancel-order` | Invoice PDF + load sheet PDF | Implemented from supplied PostEx guide; UAT required |
| Leopards | Yes | `getAllCities` | `bookPacket` | `trackBookedPacket` | `cancelBookedPackets` | `slip_link` | Implemented from supplied eCom guide; reverse-booking mapping needs carrier UAT |
| TRAX | No | No | No | No | No | No | Disabled pending current official docs |
| TCS | No | No | No | No | No | No | Disabled pending current subscribed API contract |
| M&P | No | No | No | No | No | No | Disabled pending current official docs |
| Call Courier | No | No | No | No | No | No | Disabled pending current official docs |
| Rider | No | No | No | No | No | No | Disabled pending current official docs |

A provider appears in the courier UI only if it is registered. The dormant class definitions for other providers are not registered, so those names cannot be selected via `CourierRegistry`.

## Credential flow

- PostEx uses the store's own API token in the `token` HTTP header.
- Leopards uses `api_key` and `api_password` in JSON request bodies. The merchant can select production or staging; credentials must match that environment.
- Credential fields are stored encrypted inside the existing `encryptedApiToken` column as a versioned JSON bundle, which also reads legacy single-token records.
- Browser loaders receive only configured field names, non-secret settings, and masked credential previews. They never receive decrypted secrets.
- Saving changes disables the integration. The merchant must test the connection again to mark the configuration enabled/verified.
- Booking, tracking, cancellation and authenticated PostEx PDF routes enforce tenant-scoped records and verified credential configuration.

## PostEx workflow

1. The merchant enters a PostEx token and optionally the documented pickup/store address codes.
2. Test Connection calls the official Operational Cities endpoint.
3. The return form requires the customer pickup phone/address/city. City availability is verified against the carrier endpoint.
4. The server posts `orderType="Reverse"` to `/order/v3/create-order` and requires HTTP success, `statusCode=200`, and a carrier tracking number.
5. The documented create response may be `UnBooked`. BYNDCART records the API-created order/tracking reference but does not falsely announce that pickup is complete. Tracking can later be refreshed.
6. Shipment management offers tracking refresh, carrier cancellation, PostEx invoice PDF download, and load sheet PDF generation through the official APIs.

## Leopards workflow

1. The merchant enters API key/password, selects the matching environment, and configures warehouse city/address/contact/phone and a default weight in grams.
2. Test Connection posts credentials to `/getAllCities/format/json/` and enables the integration only after `status=1` and a city list are returned.
3. At booking time, BYNDCART resolves the sender and recipient city IDs from the live city list and checks origin/destination permissions.
4. `/bookPacket/format/json/` must return `status=1` and `track_number` before BYNDCART creates the shipment record. A provider `slip_link` is saved as the label URL.
5. Tracking and cancellation use `/trackBookedPacket/format/json/` and `/cancelBookedPackets/format/json/`.
6. For returns, the code reverses shipper/consignee and origin/destination. The supplied document describes generic packet booking and not a dedicated reverse-booking operation. This mapping must be verified with Leopards on staging before production returns are enabled.

## API safety & data rules

- Do not save a manually typed tracking number as a booking confirmation.
- Do not create a shipment if the carrier has not returned its own tracking/CN number with its documented success status.
- Never fall back to a global PostEx token or another merchant's credentials.
- Pakistani mobile numbers are normalized and validated; no dummy phone number or address is substituted.
- City IDs are not guessed. Leopards city IDs are read from `getAllCities`; PostEx city names are checked against its Operational Cities endpoint.
- COD/PKR amounts must come from the caller's authoritative Shopify/payment data. The adapter defaults missing COD to zero rather than fabricating a value.
- Keep API failures visible to merchants; do not label a connection check as a confirmed shipment.

## Required release verification

1. Run the full app's type check, lint, tests and production build.
2. Test PostEx valid/invalid token; supported/unsupported cities; Normal, Reverse and Replacement order types; API error; `UnBooked` state; later delivered/returned tracking; cancellation; invoice and load sheet PDFs.
3. Test Leopards production and staging separately with matching credentials; city permission rejection; booking success/failure; CN tracking; cancellation; slip URL; default weight; COD zero/non-zero; and reverse-direction shipment with Leopards' written confirmation.
4. Confirm the new `app.shipments-label.tsx` route is registered by the project's route configuration.
5. Verify the app proxy/customer route used by the storefront is the one being deployed; `app/routes/apps.returns.tsx` was not supplied in the upload and has not been modified by this patch.
6. Confirm in the app UI that only PostEx and Leopards are offered; there must be no manual airway-bill form or fallback path.

## Source material

- *PostEx COD API Integration Guide*, version 4.1.9, supplied PDF: Operational Cities (p. 6), Order Creation (pp. 12–13), Tracking (pp. 17–19), Load Sheet (p. 16), Airway Bill / Invoice (p. 23), Cancel Order (p. 26).
- *Leopards eCom Merchant APIs*, version 2.0, supplied PDF: production/staging URL and auth (p. 3), City List (pp. 4–6), Tracking (pp. 8–16), Book a Packet (pp. 17–20), Cancel Booked Packets (pp. 31–32).
