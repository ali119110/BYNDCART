# Courier capability matrix

Only PostEx and Leopards are registered. TRAX, TCS, M&P, Call Courier, and Rider are disabled. BYNDCART does not accept a manually typed airway bill. A shipment record is created only after the carrier API returns its own tracking number. See `docs/COURIER_INTEGRATION_STATUS.md` and `docs/courier-integrations/`.

| Provider | Registered | Booking | Tracking | Cancellation | Label |
|---|---|---|---|---|---|
| PostEx | Yes | `POST /order/v3/create-order` with `Reverse`, `Normal`, or `Replacement` | `GET /order/v1/track-order/{trackingNumber}` | `PUT /order/v1/cancel-order` | Invoice PDF via the authenticated `/app/shipments-label` proxy, plus load-sheet PDF |
| Leopards | Yes | Documented `POST /bookPacket/format/json/` only. Returns reverse the shipper and consignee on that endpoint. No separate reverse endpoint is documented. | `POST /trackBookedPacket/format/json/` | `POST /cancelBookedPackets/format/json/` | `slip_link` from a successful booking |
| TRAX, TCS, M&P, Call Courier, Rider | No | Not available | Not available | Not available | Not available |

Leopards return booking still needs staging confirmation with the carrier before production customer returns. PostEx, city checks, `UnBooked` status, cancellation, and PDFs still need a merchant account for UAT.
