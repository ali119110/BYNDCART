# Public launch checklist

This app is not publicly listed. These items are the remaining gates.

- [x] Embedded Shopify app configuration exists in `shopify.app.toml`.
- [x] Scopes requested: `read_orders`, `write_orders`, `read_products`, `write_products`, `read_customers`.
- [x] Uninstall, scopes update, order, product, and privacy compliance topics are configured.
- [x] Billing models and plan gates exist. Prices still need a partner-dashboard check before listing.
- [ ] App Store listing, screenshots, and review submission.
- [ ] Protected customer data access approved for the production app.
- [ ] Confirm production `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`, `SHOPIFY_APP_URL`, `DATABASE_URL`, and `ENCRYPTION_SECRET` are set on Railway and are not committed.
- [ ] Point `SHOPIFY_APP_URL` at `https://byndcart-production-23f7.up.railway.app` if that is the production host.
- [ ] Run `/health` after deploy and confirm `database: up`.
- [ ] Exercise one manual return, one manual airway bill, one warehouse intake, and one COD CSV import on a development store.
- [ ] Do not book a live courier shipment or refund a real order until that provider test account is authorized.
- [ ] Error monitoring beyond application logs is not installed.
