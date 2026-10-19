# PostEx Merchant API Integration

**Reference used:** *PostEx COD API Integration Guide*, v4.1.9, supplied by the merchant. This guide has no staging base URL listed for these endpoints, so this implementation uses the production host shown in the guide. Test with a dedicated merchant account before going live.

## Authentication and host

Base URL: `https://api.postex.pk/services/integration/api`

Send the merchant-specific token in the HTTP header:

```http
token: <merchant-token>
```

Do not put the token in a URL, browser code, logs, global fallback secret, or customer-visible response. BYNDCART stores this per merchant and encrypts it at rest.

## Connection test and city validation

**GET** `/order/v2/get-operational-city`

Optional query parameter `operationalCityType` can be `Pickup` or `Delivery`. Successful responses documented by PostEx use `statusCode: "200"` and `statusMessage: "SUCCESSFULLY OPERATED"`, with the `dist` list containing city names and pickup/delivery support flags.

BYNDCART tests the token against this endpoint. Before creating a shipment it checks the customer's city against the API list: `Pickup` for a Reverse/return shipment, `Delivery` for a Normal/Replacement shipment. Use the carrier's canonical city name when a city is rejected.

## Create order

**POST** `/order/v3/create-order`

Required fields from the guide:

| Field | BYNDCART mapping |
|---|---|
| `orderRefNumber` | Shopify order number/reference |
| `invoicePayment` | `0` for reverse returns; forward COD amount in PKR if passed by the caller |
| `customerName` | Actual customer name |
| `customerPhone` | Valid Pakistani mobile in `03XXXXXXXXX` format |
| `deliveryAddress` | Actual customer address |
| `cityName` | Carrier-supported city name |
| `invoiceDivision` | `1` for one invoice division |
| `items` | Sum of selected item quantities, minimum one |
| `orderType` | `Reverse` for returns, `Normal` for forward shipments, `Replacement` for exchanges |

Optional `orderDetail`, `transactionNotes`, `pickupAddressCode`, and `storeAddressCode` are passed when available. Customer address/phone are never fabricated; an incomplete request fails before booking.

Success is accepted only when HTTP is successful, response `statusCode` is `200`, and a `dist.trackingNumber` (or documented top-level tracking number) is present. The guide's example response also contains `statusMessage: "ORDER HAS BEEN CREATED"` and `dist.orderStatus: "UnBooked"`.

### Important: UnBooked is not delivered or pickup-confirmed

A generated tracking number means the API accepted/created an order, but its initial status may be `UnBooked`. BYNDCART records the carrier response and does not send a “pickup booked” notification while that carrier status remains UnBooked. Merchants should refresh status and follow their PostEx pickup/load-sheet process.

## Tracking

**GET** `/order/v1/track-order/{trackingNumber}` with the same `token` header.

The guide documents `dist.transactionStatus` and `dist.transactionStatusHistory`; history messages include values/codes such as:

- `0001`: At Merchant's Warehouse
- `0002`, `0006`, `0007`: Returned
- `0003`: At PostEx Warehouse
- `0004`: Package on Route (the guide contains a typo “Root” in one text instance)
- `0005`: Delivered
- `0008`: Delivery Under Review
- `0013`: Attempt Made, followed by a reason

BYNDCART normalizes these into its shared shipment states. Unknown carrier statuses should remain unknown; do not interpret API-level `SUCCESSFULLY OPERATED` as a delivered parcel.

## Cancellation

**PUT** `/order/v1/cancel-order`

Header: `token: <merchant-token>`

JSON body:

```json
{ "trackingNumber": "<PostEx tracking number>" }
```

The supplied guide describes HTTP `200` as cancellation success and `404` as order not found. BYNDCART updates the local status to `CANCELLED` only after the endpoint confirms success.

## PDF documents

**Airway bill / invoice — GET** `/order/v1/get-invoice?trackingNumbers=<tracking-number>`

The guide says a PDF is returned, with a maximum of 10 tracking numbers per request. BYNDCART proxies the PDF through a server-side route that verifies the tracking number belongs to the logged-in merchant before fetching it. The token is never sent to the browser.

**Load sheet — POST** `/order/v2/generate-load-sheet`

JSON body with `trackingNumbers` as an array of PostEx tracking numbers; `pickupAddress` is optional. The response is documented as a PDF. The merchant UI uses this API for a one-shipment load sheet; confirm this behavior with the merchant account before relying on it for dispatch operations.

## Limits and UAT cases

- The supplied guide is v4.1.9; no live account was available here to test these endpoints.
- Verify reverse return behavior, Normal and Replacement order types, COD semantics, valid city names, duplicate order references, and whether the merchant must use address codes.
- Test API errors and ambiguous timeouts carefully; do not automatically retry a timed-out create order without first checking whether PostEx created it.
- Test `UnBooked` progression, tracking status normalization, cancellation rules, invoice PDF and load sheet PDF.

## Supplied PDF page references

- Operational Cities: p. 6
- Create Order: pp. 12–13
- Load Sheet: p. 16
- Order Tracking and status codes: pp. 17–19
- Airway Bill / Invoice: p. 23
- Cancellation: p. 26
