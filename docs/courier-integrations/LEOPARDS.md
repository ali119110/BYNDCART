# Leopards Courier eCom Merchant API Integration

**Reference used:** *eCom Merchant APIs*, version 2.0, supplied by the merchant.

## API environments and credentials

Production base URL:

`https://merchantapi.leopardscourier.com/api/`

Staging base URL:

`https://merchantapistaging.leopardscourier.com/api/`

The guide says live API credentials are created in the Leopards merchant portal under API Management in API Settings. The requests use two distinct JSON-body fields:

- `api_key`
- `api_password`

These are not interchangeable and are not sent as bearer tokens. BYNDCART stores both encrypted in the existing per-merchant credential envelope. Select Production or Staging to match the credentials; never test production credentials against staging or vice versa.

## Connection test and city list

**POST** `/getAllCities/format/json/`

JSON body:

```json
{ "api_key": "...", "api_password": "..." }
```

Successful response: `status: 1`, `error: 0`, and `city_list`, with city `id`, `name`, `shipment_type`, `allow_as_origin`, and `allow_as_destination` fields. BYNDCART only enables the configuration after this response is verified.

City IDs are fetched from this endpoint rather than hard-coded. Before booking, the adapter requires an exact city-name match and checks whether the city is allowed for the requested origin/destination role. Ask the merchant to enter the city as it appears in the Leopards city list.

## Book a packet

**POST** `/bookPacket/format/json/`

The guide documents a single generic packet-booking endpoint, not a separate return-specific endpoint. Relevant body fields are:

| API field | Purpose / BYNDCART mapping |
|---|---|
| `api_key`, `api_password` | Merchant credentials |
| `booked_packet_weight` | Integer in grams; BYNDCART uses shipment `weightKg` if provided, otherwise the required configured default weight |
| `booked_packet_no_piece` | Sum of selected item quantities, minimum one |
| `booked_packet_collect_amount` | COD collection amount in PKR; zero for customer returns, otherwise passed by the caller |
| `booked_packet_order_id` | Shopify order number/reference |
| `origin_city`, `destination_city` | IDs resolved from `getAllCities` and checked for permitted roles |
| `shipment_id` | Integer numeric suffix from the Shopify order GID; confirm any account-specific semantics with Leopards |
| `shipment_name_eng`, `shipment_email`, `shipment_phone`, `shipment_address` | Shipper/sender details |
| `consignment_name_eng`, `consignment_email`, `consignment_phone`, `consignment_address` | Receiver/consignee details |
| `special_instructions` | Order/shipment note |
| `return_address`, `return_city` | Optional return-to-sender address and city |

The guide documents weight in grams and the sender/consignee/address fields as described above. It permits city values `self` or an integer city ID; BYNDCART resolves city names to integer IDs from the API.

Success requires HTTP success, `status: 1`, and a non-empty `track_number`. The API may return `slip_link`; BYNDCART stores it as the shipment label link. An HTTP 200 alone is not considered a booking.

### Reverse return mapping: mandatory UAT confirmation

For a customer return, BYNDCART sends the customer's details as the sender and the merchant's configured warehouse as the consignee, and reverses the city direction accordingly. This is inferred from the generic `bookPacket` fields in the supplied PDF because that PDF does not document a separate reverse pickup endpoint or explicitly describe the reverse-flow mapping. **Do not launch customer returns on Leopards production until the Leopards integration team confirms this payload and it passes a staging/UAT booking.**

For forward and replacement/exchange shipments, the merchant warehouse is the sender and customer is the consignee.

## Tracking

**POST** `/trackBookedPacket/format/json/`

JSON body:

```json
{
  "api_key": "...",
  "api_password": "...",
  "track_numbers": "<CN number>"
}
```

The guide documents `status: 1` and `packet_list`; the packet contains `track_number`, `booked_packet_status`, `status_remarks` and a `Tracking Detail` array. Event details include status, receiver name, activity date/time and reason, though the PDF uses inconsistent field spellings (`Staus`, `Reciever_Name`, etc.). The implementation tolerates common spellings and preserves the carrier's raw response for diagnosis.

BYNDCART maps carrier state to its shared statuses conservatively. A status that cannot be mapped should remain `UNKNOWN`; do not interpret connection success as delivery.

## Cancellation

**POST** `/cancelBookedPackets/format/json/`

JSON body:

```json
{
  "api_key": "...",
  "api_password": "...",
  "cn_numbers": "<CN number>"
}
```

The guide supports comma-separated CN values. BYNDCART cancels one shipment at a time and updates the internal `CANCELLED` state only when the API returns `status: 1`.

## Labels

A successful `bookPacket` response may include `slip_link`; BYNDCART keeps that carrier-provided URL. The supplied PDF describes the slip link as a browser-openable link, but BYNDCART has not implemented a separate Leopards PDF proxy or forced-download route.

## UAT cases

- Verify connection on staging using staging-issued key/password.
- Test exact city names and origin/destination permissions.
- Test weight grams, pieces, COD amount, warehouse sender/consignee details, order reference, and the optional return-address behavior.
- Obtain written Leopards confirmation for reverse pickup semantics; test successful and failed return bookings.
- Test CN tracking and cancellation, plus link availability/expiry for `slip_link`.
- Test API timeouts carefully: do not blindly retry a packet-book request until confirming whether Leopards created the first CN.

## Supplied PDF page references

- Base URLs and authentication: p. 3
- City list: pp. 4–6
- Tracking: pp. 8–16
- Book a Packet: pp. 17–20
- Cancel Booked Packets: pp. 31–32
