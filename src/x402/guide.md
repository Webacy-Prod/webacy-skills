# Webacy REST API via x402

Webacy's REST API (`https://api.webacy.com`) supports **x402**: pay-per-request
access in USDC on Base, with no API key. Use this when an agent holds a Base wallet
with USDC and wants ad hoc access to Webacy's onchain risk data without provisioning
or storing an API key. If the agent has (or can get) an API key instead, prefer the
`webacy` MCP skill.

Signing is done by a Base wallet or an x402 client library (e.g. `x402-fetch`,
`x402-axios`) — this skill documents the flow, it does not sign payments itself.

## The flow

1. **Request** one of the endpoints below with no `x-api-key` header. The response is
   **HTTP 402** with a base64-encoded `PAYMENT-REQUIRED` header.
2. **Decode** that header to JSON and read `accepts[0]`: `scheme` (`exact`), `network`
   (`eip155:8453`, Base mainnet), `amount` (USDC, 6-decimal base units), `asset` (the
   USDC contract address on Base), `payTo` (the deposit address), and
   `maxTimeoutSeconds`. Some endpoints additionally include an `extensions.bazaar`
   block with the endpoint's input/output JSON schema and a `routeTemplate`, for
   generic x402 clients that discover endpoints rather than reading this table — it
   is not present on every response (e.g. `/addresses/{address}` has it,
   `/transactions/{txHash}` does not, as of this writing), so check for it rather
   than assuming it.
3. **Pay** `amount` of `asset` to `payTo` on Base.
4. **Retry** the identical request with a `PAYMENT-SIGNATURE` header carrying the
   signed payment proof. The response unlocks the resource and returns an
   `x-credit-token` header plus `x-credit-balance-cu` (Compute Units remaining).
5. **Reuse the credit token**: send it back as an `x-credit-token` header on later
   requests to spend the prepaid balance instead of paying again, until
   `x-credit-balance-cu` reaches zero.

## Headers

| Header | Direction | Purpose |
| --- | --- | --- |
| `PAYMENT-REQUIRED` | Response (402) | Base64-encoded JSON payment challenge: the `accepts` array and, on some endpoints, a `bazaar` schema/route info block. |
| `PAYMENT-SIGNATURE` | Request | Signed proof of on-chain payment, sent on retry. |
| `x-credit-token` | Both | Bearer token for a prepaid CU balance; send it back to spend the balance instead of paying again. |
| `x-credit-balance-cu` | Response | Compute Units remaining on the token after the call. |

## Pricing

x402 charges the same base per-endpoint Compute Unit (CU) cost as API-key access,
with a **$0.50 minimum per payment**. If a payment covers more CUs than the request
needs, the surplus becomes prepaid balance on the returned `x-credit-token` — reuse it
on later calls instead of paying again.

## Supported chains

Base (`eip155:8453`) with USDC only, today. Additional chains are planned.

## Endpoints

The OpenAPI spec declares these endpoints as x402-payable (a `402` response
referencing `X402PaymentRequired`), all relative to `https://api.webacy.com`. **The
spec can be ahead of the live gateway**, so at every generation this skill re-probes
each declared endpoint (an unauthenticated request against production) and splits
the list below by what was actually observed, not just what the spec claims.

### Live now

Verified to return `402 Payment Required` at last generation — use these with the
flow above.

<!-- ENDPOINTS:START -->
<!-- ENDPOINTS:END -->

### Spec-declared, not yet live

The spec declares these as x402-payable, but the last probe got a different status:
`401` means the gateway hasn't enabled x402 there yet (use an API key — the `webacy`
MCP skill — for these in the meantime); `403` means the endpoint is explicitly
excluded from keyless x402; `unverified` means the probe itself failed to get a clear
answer (network hiccup, unexpected status) — don't read anything into it either way.

<!-- PENDING_ENDPOINTS:START -->
<!-- PENDING_ENDPOINTS:END -->

## Reading results

- Risk scores are 0-100; higher is riskier. Treat high scores as a strong signal to
  warn the user, not a final verdict.
- Sanctions: an "unknown" screening result is NOT "clean" - say screening was
  inconclusive.
- Fund-flow indicators flag exposure to OFAC-sanctioned entities, mixers, hackers,
  and drainers.
- Holder analysis: high sniper or bundled-buyer counts suggest manipulative launch
  activity.

## Errors and limits

- A 402 with no `PAYMENT-REQUIRED` header (plain JSON, `"error": "Subscription
  payment required"`) means an API-key caller's subscription is past due - this is
  not the x402 challenge and paying again won't fix it.
- A `401` on an endpoint in "Spec-declared, not yet live" means x402 isn't
  gateway-enabled there yet - it is not a bad request or a bad payment.
- Bad input comes back as a 4xx error describing the fix - retry with corrected
  arguments instead of giving up.
- Never fabricate a score if a request failed - report the failure plainly.

## Links

- x402 payment flow: https://docs.webacy.com/x402-payments
- OpenAPI spec (source of the endpoint list above): https://docs.webacy.com/openapi.json
