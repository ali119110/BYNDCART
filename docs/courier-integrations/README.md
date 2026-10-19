# BYNDCART Courier Integration Guides

Only PostEx and Leopards are currently registered in BYNDCART. Their implementation notes are based on the merchant-supplied API PDFs:

- [PostEx Merchant API](POSTEX.md)
- [Leopards eCom Merchant API](LEOPARDS.md)
- [Overall live/disabled status and release checklist](../COURIER_INTEGRATION_STATUS.md)

The following providers are deliberately disabled because this patch does not include a current verified integration contract and end-to-end implementation for them:

- [TRAX](TRAX.md)
- [TCS](TCS.md)
- [M&P](MP.md)
- [Call Courier](CALL-COURIER.md)
- [Rider](RIDER.md)

Do not re-register a disabled adapter just to make it visible in the UI. First obtain the provider's current official booking, tracking, cancellation, auth, response and UAT documentation; implement it; add tests; and only then register it.
