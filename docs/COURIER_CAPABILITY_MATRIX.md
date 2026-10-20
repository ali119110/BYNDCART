# Courier capability matrix

A shipment record is created only after a carrier API confirms booking and returns its tracking/CN number. No manual airway-bill fallback is exposed.

| Provider | Registered | Booking | Tracking | Cancellation | Label/document |
|---|---|---|---|---|---|
| PostEx | Yes | `POST /order/v3/create-order` with `Reverse`, `Normal`, or `Replacement` | `GET /order/v1/track-order/{trackingNumber}` | `PUT /order/v1/cancel-order` | Invoice PDF via authenticated `/app/shipments-label`; load-sheet PDF |
| Leopards | Yes | `POST /bookPacket/format/json/` | `POST /trackBookedPacket/format/json/` | `POST /cancelBookedPackets/format/json/` | Carrier `slip_link` |
| DHL Express | Yes | `POST /shipments` with MyDHL Basic Auth | `GET /shipments/{trackingNumber}/tracking` | **Not enabled:** the supplied REST contract documents pickup cancellation, not shipment cancellation | Carrier label bytes stored in tenant-scoped `ShipmentDocument` and returned by authenticated `/app/shipments-label` |
| FedEx | Yes | `POST /ship/v1/shipments` via OAuth 2.0; reverse uses return-shipment service | `POST /track/v1/trackingnumbers` | `PUT /ship/v1/shipments/cancel` | Carrier PDF label bytes stored in tenant-scoped `ShipmentDocument` and returned by authenticated `/app/shipments-label` |
| TCS COD | Yes | `POST /create-order`; requires confirmed carrier CN | `GET /track-order` consignment lookup only; supplied contract does not define scan statuses | `PUT /cancel-order` | No label endpoint in supplied contract |
| TRAX, M&P, Call Courier, Rider | No | Not available | Not available | Not available | Not available |

**Important TCS distinction:** the separate supplied TCS Transit API is an ETA/time-in-transit calculator, not live consignment scan tracking. TCS reverse logistics requires a prior TCS consignment and only counts as a new booking if TCS returns a consignment number. DHL cross-border/customs-declarable bookings are blocked until validated customs line data is available. DHL, FedEx and TCS require carrier-account UAT before production use.
