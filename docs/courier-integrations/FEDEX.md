# FedEx Ship and Track APIs — BYNDCART integration

## Source contract

Implemented against the supplied `FedEx/ship.json` and `FedEx/track.json`. Sandbox host: `https://apis-sandbox.fedex.com`; production host: `https://apis.fedex.com`. OAuth 2.0 bearer tokens are obtained from `/oauth/token` and cached in process memory until near expiry.

## Current adapter behavior

- **Credential test:** verifies OAuth using API client ID and secret; it does not place a shipment.
- **Forward/exchange booking:** `POST /ship/v1/shipments`, with merchant shipper, customer recipient, account, selected service/packaging, package weight and PDF label response.
- **Return label:** uses the FedEx return-shipment special service and `PRINT_RETURN_LABEL` return type.
- **Tracking:** `POST /track/v1/trackingnumbers`; the response is mapped to BYNDCART's standard status with raw payload retained for diagnostics.
- **Cancellation:** `PUT /ship/v1/shipments/cancel`; BYNDCART changes its own status to `CANCELLED` only after FedEx confirms success.
- **Label:** Base64 label content is stored in `ShipmentDocument` and served only through the authenticated, tenant-scoped `/app/shipments-label?trackingNumber=…&documentType=LABEL` route. Credentials and label bytes are not exposed to the browser loader.

## Configuration

Store-specific settings cover environment, grant type, client ID/secret, optional child credentials, FedEx account number, merchant contact/address, service type, packaging type, pickup type and default parcel weight. Service codes, credentials and destination eligibility remain account-specific; successful OAuth is not proof a selected service is available.

## Required carrier UAT

Test sandbox OAuth, invalid/expired credentials, valid shipment with PDF bytes, label download authorization, return shipment label, tracking with known delivered/in-transit numbers, cancellation success/rejection, multiple-package cancellation behavior, address validation, service availability, and production account approval. No live FedEx shipment is claimed by this package.
