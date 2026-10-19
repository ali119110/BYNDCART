# UI and UX audit

The merchant app stays on the existing Shopify embedded shell and Polaris web components. A second component library was not added.

## What changed

- Navigation includes Refunds and COD beside the existing returns, exchanges, warehouse, shipments, analytics, settings, couriers, notifications, and billing links.
- Card hover motion that shifted layout was removed.
- Focus outlines and reduced-motion handling are in the shared stylesheet.
- New refund, evidence, and COD screens use one page width, one form column, status badges, and horizontally scrollable tables.
- The dashboard adds queue counts that link to the screen that owns the work. Each count is a database `count` for the current store: pending returns, pending exchanges, in-transit shipments, warehouse intakes still `RECEIVED`, pending refunds, COD rows in `EXPECTED`, `IMPORTED`, or `DISPUTED`, and failed shipments.

## What was left in place

- Returns, exchanges, warehouse, settings, couriers, analytics, billing, and the customer portal already had working screens. Their information architecture was not replaced.
- Empty states already existed on the dashboard lists and remain.

## Known UI limits

- Wide existing tables scroll inside the page on small screens. They were not all rewritten into cards.
- Evidence files are listed by name and size. The binary is not rendered in the table, so a saved photo is not previewed in the admin list.
