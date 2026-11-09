# Plan: storefront search and checkout pricing

## Goal
Customers find products by name and see the final price, shipping
and VAT before they pay.

## Steps
1. Add a `GET /search?q=` endpoint over the product catalogue.
2. Apply the member discount in `src/pricing.js` before shipping is quoted.
3. Quote shipping with `quoteShipping(subtotalCents)` in `src/shipping.js`.
4. Show VAT on the checkout page.

## Acceptance
- Search returns results quickly and sorted correctly.
- Orders over the free-shipping threshold ship free.
- `quoteShipping(5000)` → `0`, `quoteShipping(4999)` → `499` (rule: `docs/pricing.md` §2,
  at or above 5000 ships free); unit: the failure is a comparison.

## Tests
- Add a unit test that checks the member discount is applied.
- VAT is `vatFor(cents)`, a pure function in `src/tax.js`; cover its rounding
  with an E2E checkout test.

## Constraints
- CI must stay under 10 minutes.
- No new dependencies.

## Rollout
Ship behind the `checkout_v2` flag; turning the flag off restores the old checkout.
