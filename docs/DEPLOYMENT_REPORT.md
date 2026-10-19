# Deployment report

Verified on 19 October 2026.

## GitHub

- Repository: `https://github.com/ali119110/BYNDCART.git`
- Branch: `main`
- Commit: `df020dd6ebcf4ffed3485f5e13879fe6f16ce777`
- Push: confirmed. `git ls-remote` returned that same hash for `refs/heads/main`.

## Tests and build before the push

- Unit tests: 98 passed, 0 failed (`npm test`).
- Typecheck: passed (`npm run typecheck`).
- Production build: passed (`npm run build`).
- ESLint still reports existing `any` usage in older service files. CI already treats that backlog as non-blocking. No new lint rule was added.

## Railway

- Project: `glorious-expression`
- Environment: `production`
- Web service `BYNDCART`: deployment `5b275689-19fe-4d3d-9e88-0ca16521d823`, status `SUCCESS`, commit `df020dd6ebcf4ffed3485f5e13879fe6f16ce777`
- Worker `byndcart-worker`: deployment `8402b209-d73d-47ca-810a-f3527afd199e`, status `SUCCESS`
- Postgres remained the existing database. The worker log shows migration `20261019233000_add_refunds_cod_evidence` applied. The web log then reported 10 migrations and no pending migrations.
- URL: `https://byndcart-production-23f7.up.railway.app`

## Smoke checks

- `GET /health` returned 200 `{"ok":true,"service":"byndcart","database":"up"}`.
- `GET /` returned 302.
- `GET /portal` returned 200. The order lookup form was visible in a browser, with an order field, an email or phone field, and a verification button.
- `GET /app/refunds` returned 200 and showed Refunds and COD in the navigation, plus the refund, exchange-conversion, and evidence forms.
- `GET /webhooks` returned 400 without a signed Shopify payload.
- No refund, courier booking, or inventory change was submitted against production data.

## Not verified

- A signed-in Shopify admin session.
- Every viewport from 320px through 1280px. A 390px emulation was requested, but the captured portal image was still a wide canvas, so those widths are not claimed as passed.
- Live PostEx booking, because no production booking was attempted.
