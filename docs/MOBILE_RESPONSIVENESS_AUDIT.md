# Mobile responsiveness audit

Checked in code and with the shared stylesheet. After deployment, a browser opened the production portal and the refunds screen. The portal form and the refund forms were readable, and the navigation wrapped onto two rows. A full pass at 320, 375, 390, 430, 768, 1024, and 1280 pixels was not completed. A 390px emulation was requested, but the captured image remained a wide canvas, so those widths are not marked as verified.

## Layout rules in the app

- The viewport meta tag is set.
- Page sections use `minmax(min(100%, ...), 1fr)`, so grids collapse to one column before they overflow.
- Body horizontal overflow is hidden.
- Navigation links wrap.
- Below 760px, nav and page padding shrink.
- New tables sit in an overflow container instead of stretching the page.
- Form controls on the new screens use a 16px font size so mobile browsers do not zoom on focus.
- Buttons are normal form submits, not hover-only controls.

## Warehouse and portal

- Warehouse lookup remains a typed search for airway bill, order number, or SKU. Camera scanning was not added and is not described as available.
- The customer portal was already a single-column lookup and OTP flow. Courier failure no longer shows a fabricated tracking number.

## Not verified in a browser

- Pixel-perfect checks at each width listed above.
- Embedded Shopify admin on a phone.
