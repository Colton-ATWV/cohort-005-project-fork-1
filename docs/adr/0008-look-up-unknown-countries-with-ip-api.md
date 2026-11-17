---
status: deprecated
---

# Look up a buyer's country with ip-api.com when the request does not carry one

This decision no longer applies. Country resolution now uses the dev session
override or the `CF-IPCountry` header, then returns unknown (full price) without
a network lookup. See [country.server.ts](../../app/lib/country.server.ts).
The original decision is retained below for historical context.

Purchasing-power prices depend on the buyer's country. Behind Cloudflare the request carries it in the `CF-IPCountry` header, but not every request comes through Cloudflare. When the header is missing, `resolveCountry` looks up the first `X-Forwarded-For` address on ip-api.com's free endpoint, and only falls back to full price if that lookup fails.

## Considered Options

- **Bundle a MaxMind GeoLite2 database.** Rejected: it needs a licence key, a download of tens of megabytes, and an update every month.
- **Charge full price whenever the country is unknown.** Rejected: it overcharges exactly the learners purchasing-power pricing is for.

## Consequences

The course list, the purchase page and every lesson page for a discounted purchase can wait on a network call. The free endpoint is plain HTTP and limited to 45 requests a minute.
