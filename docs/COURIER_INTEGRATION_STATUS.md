# BYNDCART Courier Integration Status

## Current capability matrix

| Provider | Registered in app | Credential test | API booking | Tracking | Cancellation | Document/label | Status |
|---|---:|---:|---:|---:|---:|---:|---|
| PostEx | Yes | Operational Cities endpoint | Normal / Reverse / Replacement | `track-order` | `cancel-order` | Invoice PDF + load-sheet PDF | Implemented from supplied PostEx guide; UAT required |
| Leopards | Yes | `getAllCities` | `bookPacket` | `trackBookedPacket` | `cancelBookedPackets` | `slip_link` | Implemented from supplied eCom guide; reverse-booking mapping still needs carrier UAT |
| DHL Express | Yes | Authenticated Reference Data (`datasetName=country`) | MyDHL `POST /shipments`; customs/cross-border blocked until proper line data exists | MyDHL shipment tracking | Disabled: supplied contract has pickup cancellation but no shipment cancellation endpoint | Base64 carrier labels saved server-side | Implemented against supplied MyDHL 3.3.4 OpenAPI; UAT required |
| FedEx | Yes | OAuth token request | Ship API; reverse return labels | Track API | Ship API cancellation | Base64 carrier labels saved server-side | Implemented against supplied Ship/Track OpenAPI; UAT required |
| TCS COD | Yes | Cities endpoint verifies API client/subscription; username/password are not verified without a side-effecting operation | COD `create-order`; requires carrier CN | COD `track-order` record lookup; no scan events in supplied schema | COD `cancel-order` | No label endpoint in supplied contract | Implemented against supplied COD OpenAPI; UAT required |
| TRAX | No | No | No | No | No | No | Disabled pending current official docs |
| M&P | No | No | No | No | No | No | Disabled pending current official docs |
| Call Courier | No | No | No | No | No | No | Disabled pending current official docs |
| Rider | No | No | No | No | No | No | Disabled pending current official docs |

The merchant courier settings page stores credential bundles encrypted in the existing `encryptedApiToken` column. Saved secrets are not returned to the browser. Saving credentials disables the integration; a successful connection test is required before it is marked enabled/live. For DHL, FedEx and TCS, this test confirms only the specific checks described above, not every shipment lane or carrier operation.

## Carrier-specific notes

- **DHL:** test/production hosts from MyDHL 3.3.4. Shipment labels returned as document bytes are stored in `ShipmentDocument`, served only after tenant authentication. The supplied YAML documents pickup cancellation, not shipment cancellation. Cross-border customs requests are blocked because there is no validated line-level customs item model in the supplied app inputs.
- **FedEx:** sandbox/production hosts, OAuth 2.0, Ship API, Track API and Cancel Shipment endpoint are implemented. Verify the exact account service type, pickup type and return service in FedEx sandbox and with the merchant's production account.
- **TCS:** `tcscod.json` is implemented for booking, reverse-logistics, consignment lookup and cancellation. `tcstrack.json` is a Transit/time-calculator API and does not replace scan-level tracking. Username and password are part of TCS query parameters for `/track-order` because that is how the supplied contract defines it; avoid logging full request URLs.

## Security and data rules

- Do not save a manually typed tracking number as a booking confirmation.
- Never expose another merchant's credentials or shipment documents. Document downloads verify the current authenticated tenant and shipment ownership.
- Do not claim a cancellation unless the carrier confirms success. DHL cancellation remains hidden/disabled in the UI.
- Do not mark a TCS consignment delivered merely because the API request itself succeeded; status must come from an actual status field.
- Never send an invalid TCS reverse request with a Shopify order ID standing in for an original TCS CN.
- Do not send DHL customs-declarable shipments without validated commodity/customs data.
- Keep provider API errors visible and distinguish connection-test success from shipment booking success.

## Required release verification

1. Apply the new Prisma migration and regenerate the Prisma client (`npx prisma migrate deploy` then `npx prisma generate`); verify `ShipmentDocument` model and both tenant/shipment relations.
2. Run the complete repository's type check, lint, unit tests and production build. The uploaded source ZIP contains only a subset of the full app, so a full build cannot be completed from this package alone.
3. Run merchant-account UAT for PostEx and Leopards as already documented in their integration guides.
4. DHL: test authentication, domestic shipment, label document storage/download, tracking status parsing, wrong credentials, invalid product/route, incomplete address and safe rejection of a cross-border/customs booking.
5. FedEx: test OAuth, valid shipment PDF, download isolation by tenant, reverse label, known tracking states, cancel success/rejection, address/service validation and account enablement.
6. TCS: test client ID, booking CN response, exact city names, COD amount, missing fields, prior-CN reverse logistics, no-CN reverse rejection, cancellation, and `track-order` with payloads that omit scan status. Validate that the UI shows no TCS label action.
7. Confirm DHL cancel action is not displayed; any direct cancel attempt must fail without changing BYNDCART shipment status.

No live shipment creation or cancellation has been executed as part of this offline source update; carrier UAT is required before production use.

## Source material used for this update

- Merchant-provided MyDHL Express REST API 3.3.4 OpenAPI YAML: `DHL/dpdhl-express-api-3.3.4.yaml`.
- Merchant-provided FedEx Ship and Track OpenAPI JSON: `FedEx/ship.json`, `FedEx/track.json`.
- Merchant-provided TCS COD OpenAPI JSON: `TCS doc/tcscod.json`.
- Merchant-provided TCS Transit/time-calculator OpenAPI JSON: `TCS doc/tcstrack.json`.
- Existing BYNDCART PostEx/Leopards integration notes: `docs/courier-integrations/POSTEX.md`, `LEOPARDS.md`.
