# UI and UX audit

The merchant app stays on the existing Shopify embedded shell and Polaris web components. A second component library was not added.

## What changed

- Navigation includes Refunds and COD beside the existing returns, exchanges, warehouse, shipments, analytics, settings, couriers, notifications, and billing links.
- Card hover motion that shifted layout was removed.
- Focus outlines and reduced-motion handling are in the shared stylesheet.
- New refund, evidence, and COD screens use one page width, one form column, status badges, and horizontally scrollable tables.
- The dashboard adds queue counts that link to the screen that owns the work. Each count is a database `count` for the current store: pending returns, pending exchanges, in-transit shipments, warehouse intakes still `RECEIVED`, pending refunds, COD rows in `EXPECTED`, `IMPORTED`, or `DISPUTED`, and failed shipments.

## Dashboard control-center follow-up

- The dashboard now separates request cohorts (selected creation date) from live operational backlog counts.
- The dashboard shows a prioritized attention list for failed shipments, COD disputes, stale tracking, pending refunds, warehouse inspections, and requests awaiting review.
- COD reconciliation exposure and pending refund exposure are shown without mixing currencies or labeling pending/merchant-confirmed records as payment-provider verified.
- Store sync freshness, webhook registration, failed background jobs, and unprocessed webhook events are visible. Raw sync errors are not exposed in the UI.
- Lifecycle cards show current request status distributions, and courier summaries report stored shipment statuses rather than claiming an SLA.
- The dashboard no longer runs an initial Shopify sync synchronously from the page loader.
- Analytics labels distinguish request share from unit return rate, use confirmed refund records for payout totals, and show product return units requested rather than counting item rows.
- See [Dashboard metric definitions](./DASHBOARD_METRIC_DEFINITIONS.md) for the source, date field, denominator, and limitations of these metrics.

## What was left in place

- Returns, exchanges, warehouse, settings, couriers, analytics, billing, and the customer portal already had working screens. Their information architecture was not replaced.
- Empty states already existed on the dashboard lists and remain.

## Known UI limits

- Wide existing tables scroll inside the page on small screens. They were not all rewritten into cards.
- Evidence files are listed by name and size. The binary is not rendered in the table, so a saved photo is not previewed in the admin list.
