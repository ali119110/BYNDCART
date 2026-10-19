# Courier capability matrix

This matrix records what BYNDCART actually does. A saved API token is not a verified booking. No tracking number is created unless the courier response includes one, or a merchant types an airway bill. PostEx live booking is return pickup only and needs the store token plus a real pickup phone and address. Forward and exchange booking are not implemented. See `docs/COURIER_INTEGRATION_STATUS.md`.

| Provider | Credentials can be stored | Live booking in this release | Tracking poll | Cancellation | COD settlement API | Manual airway bill |
|---|---|---|---|---|---|---|
| PostEx | Yes | Attempts `POST https://api.postex.pk/services/integration/api/order/create-return-order` with the merchant token. Success requires a tracking number in the response. | Not verified. Status stays unconfirmed. | Not verified. | Not connected | Yes |
| Leopards | Yes | Not implemented. No request is sent. | Not verified | Not verified | Not connected | Yes |
| Trax | Yes | Not implemented. No request is sent. | Not verified | Not verified | Not connected | Yes |
| TCS | Yes | Not implemented. No request is sent. | Not verified | Not verified | Not connected | Yes |
| M&P | Yes | Not implemented. No request is sent. | Not verified | Not verified | Not connected | Yes |
| Call Courier | Yes | Not implemented. No request is sent. | Not verified | Not verified | Not connected | Yes |
| Rider | Account reference only | Not implemented. No public booking contract is wired. | Not verified | Not verified | Not connected | Yes |

Connection tests for Leopards, Trax, TCS, M&P, Call Courier, and Rider only confirm that a credential was saved. They do not claim the carrier accepted it. PostEx is the only provider whose connection test calls a carrier URL, and it reports failure when that call does not succeed.

Official sites used as starting points, not as proof of a specific endpoint: PostEx, Leopards, TCS, Trax, M&P, Call Courier, and Rider.
