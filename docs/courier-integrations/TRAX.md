# TRAX Logistics (Pakistan) — integration notes

## API status

During this research, a current public, official technical reference with authentication schema, base URL, booking payload, response schema, tracking, label and cancellation endpoints could not be verified. TRAX/Sonic has account-based e-commerce integration, but third-party public setup content is not a substitute for its API contract.

## Do not guess credentials

Do not label the required fields as `API token`, `client ID/client secret`, or username/password until TRAX supplies the current account-specific API guide. A web guide that conflates TRAX with Call Courier is not reliable enough to derive authentication fields.

## Request from TRAX

Ask the merchant account manager for:

1. Current official API spec/OpenAPI/Postman collection and base URLs for staging and production.
2. Authentication method and credential field names; credential rotation/expiry rules.
3. Create forward shipment, create reverse pickup/return, exchange/replacement, tracking, label download and cancel operations.
4. Required shipper, consignee, origin/destination city code, service type, weight unit, COD amount, reference and pickup-window fields.
5. Success/error examples, idempotency support, rate limits, webhooks/polling cadence and test credentials.
6. Merchant account service configuration and return pickup procedure.

## BYNDCART status: disabled

TRAX is not registered in `CourierRegistry`, is not shown as a bookable carrier, and cannot create, track, or cancel a shipment in this package. Obtain a current official API contract and complete UAT before adding it. No manual airway-bill fallback is allowed.
