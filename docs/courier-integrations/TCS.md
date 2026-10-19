# TCS — integration notes

## Use the correct TCS API product

TCS exposes multiple API products. The official COD/ECOM guide documents more than one auth scheme:

- ECOM authentication: `POST/GET` behavior is described by the versioned guide at `https://envio.tcscourier.com/COD-API-UserManual.pdf`; the ECOM token endpoint is `https://ociconnect.tcscourier.com/ecom/api/authentication/token`, using merchant-provided `username` and `password` and returning `accesstoken`/expiry.
- A separate authorization API section in that guide describes `clientId` and `clientsecret`. Those credentials are not interchangeable with the ECOM username/password set; use the auth flow that matches the API product enabled for the merchant.

The official TCS developer portal supports API keys/application setup, and TCS requires successful UAT before production access approval.

## ECOM endpoints present in the guide

- Auth/token: `https://ociconnect.tcscourier.com/ecom/api/authentication/token`
- Create booking: `https://ociconnect.tcscourier.com/ecom/api/booking/create`
- Reverse pickup request: `https://ociconnect.tcscourier.com/ecom/api/booking/reverse`
- CN status update: `https://ociconnect.tcscourier.com/ecom/api/booking/getcnupdate`
- Print label: `https://ociconnect.tcscourier.com/ecom/api/print/label`
- Tracking: `https://ociconnect.tcscourier.com/tracking/api/Tracking/GetDynamicTrackDetail`

The guide's reverse operation accepts an existing TCS consignment number (plus optional cost center/consignee mobile); it is **not automatically equivalent to creating a brand-new return shipment with a new CN**. Use it only for the workflow it supports and persist the returned result appropriately.

## Credential/UI fields

For the ECOM product, configure at least:

- TCS ECOM username
- TCS ECOM password
- TCS account/cost center code
- Merchant registered shipper details and required city/area codes
- Environment (UAT vs production) where supported

Do not call the field “API token” if the merchant provides a username/password pair. Auth should acquire and refresh its access token according to the official response expiry.

## Payload notes

The official create-booking payload includes an account number (`tcsaccount`) and structured shipper/consignee data, with Pakistani country code `PK`, city names/codes, phone, address, and shipment details. Tracking requires a TCS CN/consignment number. Map fields only when the BYNDCART source model has them; otherwise block booking with a validation message rather than substituting fake phone numbers, cities, or addresses.

## BYNDCART status: disabled

This is research-only context, **not an enabled implementation** in the current package. TCS is not registered in `CourierRegistry`, not offered by the courier settings UI or customer portal, and cannot book shipments. The endpoints/auth notes above should be re-verified with TCS because the merchant supplied PostEx and Leopards PDFs—not a TCS contract. Before enabling TCS, obtain the current account-specific API pack, implement all required operations, test UAT, and then register it. No manual airway-bill fallback is allowed.

## Verification required

TCS production API access requires successful UAT and production approval. No live bookings were performed in this research. Confirm current method/content-type details in the portal because the guide uses unusual GET-with-body examples for some operations.
