# Rider Logistics (Pakistan) — integration notes

## API status

The public material located during research confirms that third-party commerce platforms offer Rider integration, including bookings, labels and tracking, but it does not publish Rider Logistics' own technical API endpoint/authentication contract. Do not confuse this with RiderX or unrelated rider/delivery APIs in other countries.

## Request from Rider

Obtain from Rider Logistics / merchant account manager:

- Official API documentation/OpenAPI/Postman collection and staging/production URLs.
- Authentication fields and whether the account uses a token, client key/secret, login/password or some combination.
- Booking/return/replacement payloads, required city/service codes, address/phone/weight/COD rules and units.
- CN/tracking field in the success response, label retrieval, tracking status schema, cancellation support and error examples.
- Merchant account IDs/warehouse setup, rate limits, webhooks/polling, idempotency and UAT credentials.

## BYNDCART status: disabled

Rider is not registered in `CourierRegistry`, is not shown as a bookable carrier, and cannot create, track, or cancel a shipment in this package. Obtain a current official API contract and complete UAT before adding it. No manual airway-bill fallback is allowed.
