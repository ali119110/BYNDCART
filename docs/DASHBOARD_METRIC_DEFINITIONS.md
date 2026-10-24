# Dashboard metric definitions

This document describes the dashboard's current semantics. All store-specific database queries must be scoped by `shopifyStoreId`; adding a KPI must preserve that tenant boundary.

## Date ranges and time semantics

- **Return requests / Exchange requests / Recent activity:** request `createdAt` falls within the selected range.
- **Return intake:** warehouse intake is in `RECEIVED` or `INSPECTED`, has a related return request, and `receivedAt` falls within the selected range.
- **Incoming exchanges:** currently `APPROVED` or `RECEIVED`, and the request was created during the selected range. This is a current-state cohort, not a historical status count.
- **Replacement order linked:** an exchange request created during the selected range has a non-null `newOrderId`. It does not mean a replacement shipment was delivered.
- **Live operational queues:** current backlog counts ignore the selected historical date range.
- **Courier snapshot:** shipment records created in the selected range, grouped by the latest status stored in BYNDCART. It is not a verified carrier SLA or delivery-success benchmark.

Date filters use an inclusive start and an exclusive end for custom calendar dates. Client-supplied timezone names are validated; invalid values fall back to UTC. Invalid custom date ranges are disclosed and fall back to 30 days rather than being silently accepted.

## Financial semantics

- **Pending refunds:** counts refund records with `PENDING` status. The amount is summed only for records whose stored currency is `PKR`; other currencies are not converted.
- **Confirmed refunds (Analytics):** sums `RefundRecord` rows marked `CONFIRMED`, grouped by currency and filtered by `confirmedAt` for the selected period. This is BYNDCART merchant-confirmed status, not independent evidence from a payment provider. The page shows PKR separately and discloses other currencies.
- **Unreconciled COD:** count and expected amount for settlements in `EXPECTED`, `IMPORTED`, or `DISPUTED`. This amount is the sum of expected amounts, not a bank-verified payable amount.
- **COD disputes:** count of rows with `DISPUTED` status.
- **Recorded exchange price difference:** sums recorded exchange item price differences on completed exchanges. Currency is not stored on the exchange item in the current schema, so no currency symbol or conversion is asserted.

## Operational health

- **Stale tracking:** shipments whose latest stored status is `IN_TRANSIT` or `OUT_FOR_DELIVERY` and whose `updatedAt` is older than 48 hours. This is a stale-data heuristic, not proof a parcel has stopped moving.
- **Failed jobs:** background jobs in `FAILED` status scoped to the current store.
- **Unprocessed webhook events:** webhook event rows in `processed = false` for the current store.
- **Sync/webhook health:** display stored `syncStatus`, `lastSyncAt`, `lastSyncError` existence, and `webhookStatus`; raw error details are deliberately not rendered to merchants on this dashboard.
- **Lifecycle:** current status distribution for return and exchange requests. It has no event-history time dimension because the current models do not preserve a complete transition history.
- **Warehouse-confirmed return ratio:** warehouse-confirmed units (`ReturnItem.quantity` where item status is `RECEIVED` or `INSPECTED`, and parent return request is not cancelled/rejected) divided by ordered units in the same `Order.shopifyCreatedAt` cohort. Orders whose stored `fulfillmentStatus` is `CANCELLED` are excluded. A return received after the selected order period still contributes to that period's cohort. The metric is unavailable if no ordered-unit denominator exists. Because the Order cache does not store complete shipped/paid quantities for each order, this is a return-to-ordered-unit ratio, not a fully net-of-unfulfilled-sales rate.
- **Product / SKU return performance:** groups line items by SKU where available (otherwise variant/product ID), within the selected order cohort. It shows requested units, warehouse-confirmed received/inspected units, ordered units, and the product/SKU return ratio. A complete order sync and accurate return-item status transitions are required.

## Known limitations / next data requirements

- The return-to-ordered-unit ratio is cohort-based; unfulfilled orders remain in the denominator, and incomplete order sync, missing item status transitions, or duplicate intake/return records can skew it. Values over 100% should be investigated rather than silently capped. Request-share percentages remain separately labeled and are not called return rates.
- Historical stage conversion and average time between stages require durable lifecycle events; current status alone cannot reconstruct past transitions reliably.
- Carrier performance rates should only be presented when live tracking events and delivery statuses are genuinely available for the relevant carrier.
- Store sessions, conversion rate, marketing ROAS, and traffic-based metrics require a validated Shopify analytics or analytics-platform source; they should not be inferred from BYNDCART return records.
- Any financial KPI must remain currency-aware and must not silently add amounts with different currencies or infer fees not persisted in the source records.
