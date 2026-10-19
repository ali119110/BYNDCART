# Implementation roadmap

Completed in this change set:

1. Stopped courier adapters from inventing tracking numbers, label URLs, transit updates, or cancellations.
2. Kept manual airway-bill recording as the fallback for every courier.
3. Left the existing PostEx create-return request in place and accepted it only when the response contains a tracking number.
4. Added refund records for Shopify, store credit, bank transfer, Easypaisa, JazzCash, and manual methods. Confirmation is an explicit merchant action.
5. Added exchange-to-refund conversion that cancels the internal exchange and opens a pending refund. It does not call Shopify refund.
6. Added evidence storage for JPEG, PNG, WebP, and MP4 up to 1.5 MB, or an HTTPS URL.
7. Added COD settlements with manual entry, RFC 4180-style CSV import, duplicate file and reference checks, and CSV export.
8. Added operational dashboard counts from the same database tables.
9. Added server-side role checks when a mapped staff email exists. Offline install sessions are not locked out.
10. Added `/health` for process and database readiness.
11. Tightened shared layout styles for small screens and added Refunds and COD navigation.

Not done, because it would require a verified external contract or partner approval:

- Live booking, tracking, and settlement for Leopards, Trax, TCS, M&P, Call Courier, and Rider.
- PostEx tracking and cancellation.
- Camera scanning.
- WhatsApp sending.
- Shopify App Store submission.
