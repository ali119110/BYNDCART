# TCS COD API — BYNDCART integration

## Source contract and distinction between API products

Implemented against the supplied `TCS doc/tcscod.json` OpenAPI contract. It declares production base URL `https://api.tcscourier.com/production/v1/cod` and uses `X-IBM-Client-Id`. The separately supplied `tcstrack.json` is the **Transit / time-in-transit calculator API** (`/stations`, `/postal-codes/{stationId}`, `/services/{productId}`, `/products`, `/time-calculator`); it is not a live consignment scan-tracking API.

## Current adapter behavior

- **Credential test:** calls `GET /cities` and checks the API client/subscription. The supplied contract provides no documented, non-mutating request that verifies COD username/password and cost center together; those fields are validated by the corresponding operation when used.
- **Forward booking:** `POST /create-order`, with consignee, origin/destination city, phone/email/address, package weight, pieces, COD amount, service and fragile fields. BYNDCART records a shipment only after a successful API response contains the carrier-issued CN/consignment number.
- **Return/reverse logistics:** `POST /reverse-logistics` is called only when BYNDCART has a prior TCS consignment for the same merchant/order. It will not substitute a Shopify order ID or claim a new reverse shipment unless the API returns a CN.
- **Consignment lookup:** `GET /track-order` with username, password and `referenceNo`. The supplied `cnDetail` response contains consignment/customer/route/weight/service/COD details, but does not define scan events or a status field. If no shipment status is actually returned, BYNDCART reports `UNKNOWN` rather than inventing a delivered/in-transit state.
- **Cancellation:** `PUT /cancel-order`; app shipment status changes only after TCS returns a successful cancellation response.
- **Shipping labels:** no label endpoint or label document schema is provided in these supplied TCS files, so BYNDCART does not claim to generate or download a TCS label.

## Configuration

Merchant settings include client ID, username/password, cost-center code, warehouse origin city, default weight, service code and fragile setting. Customer shipment requests also need a valid Pakistani mobile, complete address, destination city and email. No placeholder address/phone is generated.

## Required carrier UAT

Verify client ID subscription, username/password/cost center correctness, city names, booking response shape and CN, reverse-logistics response/CN behavior, cancellation success/rejection, track-order response shape and privacy implications of the API's documented credentials-in-query parameters. If TCS later supplies its actual live scan-tracking API or label endpoint, implement it as a separate contract-backed capability rather than misusing the Transit calculator. No live TCS booking is claimed by this code package.
