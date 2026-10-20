# Route audit note: `app/routes/apps.returns.tsx`

The uploaded source files did not include `app/routes/apps.returns.tsx`. The supplied courier-settings ZIP does not include `app/routes/apps.returns.tsx` or `app/routes/portal.tsx`, so this courier update cannot verify or edit the customer-facing storefront route. Do not substitute the internal merchant route `app/routes/app.returns.tsx`.

Before release, inspect the real storefront return route and ensure it follows the same API-only rules:

1. Offer only a provider registered in `CourierRegistry`, enabled, connection-tested, and configured with the required credentials for this `shopifyStoreId`. The current registry includes PostEx, Leopards, DHL Express, FedEx and TCS; provider-specific restrictions in the capability matrix still apply (for example, no DHL shipment cancellation, and TCS reverse logistics requires a prior TCS consignment).
2. Use the server-side courier service; never trust a client-supplied tracking/CN number.
3. Create a return/shipment record only when the carrier API reports success and returns a carrier-generated tracking/consignment number.
4. Require the fields actually required by the selected provider, including Pakistani mobile, exact supported city, complete address, and Leopards warehouse settings/weight.
5. Do not show manual AWB entry or a manual fallback. If no provider is configured, explain that API booking is unavailable.
6. For Leopards reverse flow, get written confirmation of the generic `bookPacket` reverse-direction mapping from Leopards and perform staging/UAT before production.
