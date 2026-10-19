# Route audit note: `app/routes/apps.returns.tsx`

The uploaded source files did not include `app/routes/apps.returns.tsx`. This patch updates `app/routes/portal.tsx`, but cannot verify or edit the separately named `apps.returns.tsx` route. Do not substitute the internal merchant route `app/routes/app.returns.tsx`.

Before release, inspect the real storefront return route and ensure it follows the same API-only rules:

1. Only PostEx and Leopards can be offered; verify the provider is registered, enabled, connection-tested, and has the required credentials for this `shopifyStoreId`.
2. Use the server-side courier service; never trust a client-supplied tracking/CN number.
3. Create a return/shipment record only when the carrier API reports success and returns a carrier-generated tracking/consignment number.
4. Require the fields actually required by the selected provider, including Pakistani mobile, exact supported city, complete address, and Leopards warehouse settings/weight.
5. Do not show manual AWB entry or a manual fallback. If no provider is configured, explain that API booking is unavailable.
6. For Leopards reverse flow, get written confirmation of the generic `bookPacket` reverse-direction mapping from Leopards and perform staging/UAT before production.
