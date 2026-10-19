# Call Courier — integration notes

## Available evidence and its age

A legacy Call Courier web-service guide mirrored on third-party document sites describes a `SaveBooking` operation on the `cod.callcourier.com.pk` host. Its payload mentions `loginId`, consignee name/reference/mobile/address, origin, destination city ID, service type ID, pieces, weight, description, domestic/international origin, COD amount, handling options and shipper name/phone/area/city/address/email. Related operations list city, area and service-type lookups.

The publicly located copy is old and is not a current first-party API specification. It is not enough to assume the current authentication method, HTTP method, HTTPS compatibility, booking response structure, tracking endpoint, label endpoint or cancellation behavior.

## Credential shape

The legacy `SaveBooking` guide explicitly uses `loginId`; it does **not** establish that portal passwords should be sent as query parameters. The merchant portal itself has login ID/password, but that does not prove the API should receive both. Do not send a password in a URL or log full booking URLs containing customer data.

## Request from Call Courier

Ask for the current supported HTTPS API docs/Postman collection; test and production base URLs; API authentication (login ID, API password, token or other); booking request and response examples; destination city/service/shipper area lookup APIs; tracking; label printing; cancellation; reverse pickups; request rate limits; idempotency behavior; and UAT credentials.

## BYNDCART status: disabled

Call Courier is not registered in `CourierRegistry`, is not shown as a bookable integration, and cannot create or track shipments in the current package. The notes above are research context only and are not an implementation contract. Obtain current first-party documentation and test credentials before adding an adapter. No manual airway-bill fallback is allowed.
