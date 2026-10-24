# Shopify Fulfillment Sync for Courier Bookings

BYNDCART creates a Shopify fulfillment only after a courier adapter confirms a tracking number. A courier booking and a Shopify fulfillment are separate operations, so a carrier booking can exist even when Shopify rejects the fulfillment mutation.

## Current behavior

- Uses Shopify Admin GraphQL `fulfillmentCreate` and checks both top-level GraphQL errors and mutation `userErrors`.
- Adds `read_merchant_managed_fulfillment_orders` and `write_merchant_managed_fulfillment_orders` to the configured Shopify scopes.
- Keeps the confirmed carrier booking and tracking number if Shopify fulfillment sync fails. The booking page warns the operator not to book that parcel again.
- The Shipments page exposes **Sync Shopify fulfillment** for saved forward and replacement shipments. The action verifies tenant ownership and shipment type, reuses the existing tracking number, and checks the live Shopify order before creating a fulfillment. A matching existing fulfillment is treated as already synced to avoid duplicates.
- Return shipments do not fulfill the original Shopify order.

## Existing shipments that were booked before this fix

1. Deploy the BYNDCART code.
2. Deploy the Shopify app configuration so the additional scopes are applied (from a checkout of this repo, run `shopify app deploy` with the correct Shopify CLI account/app).
3. Reauthorize the app/install so the merchant grants the new fulfillment-order scopes.
4. Open **Shipments**, search for the order number or tracking number, and click **Sync Shopify fulfillment**. Do not book the shipment with PostEx again.
5. Confirm the order's fulfillment status and tracking details in Shopify Admin.

If Shopify reports that no fulfillment order is available, check the order's assigned fulfillment location and whether another fulfillment service manages it. The sync action deliberately refuses to create a duplicate fulfillment when Shopify already marks the order fulfilled with different or missing tracking information.
