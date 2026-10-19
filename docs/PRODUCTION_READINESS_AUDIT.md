# Production readiness audit

Baseline inspected on 19 October 2026 from `main` at `5551c64` before this change set. The app is a Shopify embedded React Router application with Prisma and PostgreSQL, deployed on Railway as a web service, a worker, and Postgres.

## Working before this change

- Shopify OAuth, Prisma session storage, and store registration after install.
- Tenant scoping through `requireTenantContext`.
- Manual return and exchange creation from synced orders.
- Return and exchange state machines.
- Customer portal order lookup with OTP, then return submission.
- Warehouse intake and inspection records.
- Email notification templates and logs, with idempotency keys.
- Billing plan records and Shopify subscription helpers.
- Webhook signature checks, duplicate webhook ids, and a Postgres job queue.
- Privacy webhook handlers for customer data request, customer redact, and shop redact.

## Partially working before this change

- PostEx had a real request path, but a failed or missing response still stored a made-up tracking number and a made-up label URL.
- Leopards, Trax, TCS, M&P, and Call Courier always returned made-up tracking numbers with `success: true`.
- Dashboard counts came from the database, but they did not show the operational queues.
- Staff roles existed only as `ADMIN` and `MEMBER` and were not enforced on actions.
- Refunds could be attempted through the existing Shopify sync path, with no ledger for bank transfer, Easypaisa, JazzCash, or store credit.

## Missing before this change

- COD reconciliation, CSV import, and duplicate-file protection.
- Evidence attachments.
- A health endpoint.
- Exchange-to-refund conversion that does not pretend Shopify was refunded.
- Rider as an explicit manual courier.

## Broken or unsafe before this change

- Courier failure was presented as a successful booking. That path was removed. Manual airway bills still save.

## Still blocked

- Public App Store listing and review. Not submitted from this environment.
- Live booking for Leopards, Trax, TCS, M&P, Call Courier, and Rider. Official booking contracts were not verified here, so those adapters do not call guessed URLs.
- PostEx tracking, cancellation, and COD settlement feeds.
- WhatsApp delivery. The registry exists; sending is not a completed production integration.
- Camera barcode scanning. Warehouse search accepts a typed airway bill, order number, or SKU. Camera scanning is not claimed.
- Protected customer data approval is a Shopify partner-dashboard step and was not verified.
