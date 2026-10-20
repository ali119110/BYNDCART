# DHL Express MyDHL API — BYNDCART integration

## Source contract

Implemented against the merchant-supplied `dpdhl-express-api-3.3.4.yaml` (MyDHL Express REST API 3.3.4). The contract declares the test host `https://express.api.dhl.com/mydhlapi/test` and production host `https://express.api.dhl.com/mydhlapi`, with HTTP Basic Authentication.

## Current adapter behavior

- **Credential test:** calls `GET /reference-data?datasetName=country`; this verifies the API connection/authentication, not that every shipping product or route is enabled on the merchant's account.
- **Booking:** `POST /shipments` using the saved account number, shipper/receiver contact and postal details, product code, packaging type and positive parcel weight.
- **Tracking:** `GET /shipments/{shipmentTrackingNumber}/tracking` with the account number and detail query parameters.
- **Label:** when the shipment response includes Base64 label document content, the bytes are stored server-side in the `ShipmentDocument` table and delivered only through the authenticated `/app/shipments-label?trackingNumber=…&documentType=LABEL` route. The label bytes and credentials are not returned by a browser-facing loader. No label is fabricated when the carrier does not return one.
- **Cancellation:** disabled in BYNDCART. The supplied REST contract documents `DELETE /pickups/{dispatchConfirmationNumber}` for pickup cancellation, not cancellation of a shipment by tracking number. The app will not claim a shipment cancellation without a matching documented endpoint.

## Safe limitations

Cross-border/customs-declarable bookings are blocked. Current BYNDCART shipment inputs do not contain validated customs line fields such as commodity/HS data and declared item values; the adapter must not invent those fields. Domestic booking still requires a valid DHL product/package code and merchant-enabled destination route. If DHL does not return label bytes, the shipment record has no “label” link rather than mislabeling its tracking URL.

## Required carrier UAT

Test with a DHL test account before production: credential test, supported domestic lane, label bytes/document type, tracking event mapping, wrong credentials/account number, unsupported product and service responses, missing address/contact fields, and a cross-border attempt that must be rejected without booking. No live DHL booking is claimed by this code package.
