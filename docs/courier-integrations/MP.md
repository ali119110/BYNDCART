# M&P / Muller & Phipps — integration notes

## Public API evidence

M&P's official website confirms domestic/courier, COD and reverse-logistics services, but a public, official, complete developer API specification was not found during this research.

An independent community package, `hammadmajid/mulphilog`, is explicitly marked **WIP** and explicitly says it is not sponsored, affiliated, endorsed or approved by M&P. It documents a possible credential shape:

- `username`
- `password`
- `accountNo` (parent account)
- `insertType`
- `returnLocation`
- `subAccountId`

It also gives example fields such as pickup `locationID`, consignee details, destination city, pieces, weight, COD amount, customer reference, product details, service, remarks and insurance value. This is useful for asking the M&P account manager the right questions, but it is not sufficient evidence to ship a production integration.

## Request from M&P

Obtain the current official API document/collection, the supported environment and endpoints, authentication scheme, credential fields, city/location lookup methods, account-specific `insertType`/return location/sub-account values, booking response/CN shape, label endpoint, tracking and cancellation operations, and supported return pickup model.

## BYNDCART status: disabled

M&P is not registered in `CourierRegistry`, is not shown as a bookable integration, and cannot create or track shipments in the current package. The notes above are research context only and are not an implementation contract. Obtain current first-party documentation and test credentials before adding an adapter. No manual airway-bill fallback is allowed.
