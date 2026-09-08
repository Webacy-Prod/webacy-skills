# Webacy risk engine

Webacy scores blockchain security risk for addresses, tokens, contracts, and DeFi
vaults across 14+ chains. Use this whenever the user asks whether something onchain
is safe, risky, sanctioned, a scam, a honeypot, or trustworthy.

## Tools

<!-- TOOLS:START -->
<!-- Auto-generated from api.webacy.com/mcp tools/list. Do not edit by hand. -->
<!-- TOOLS:END -->

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

- Bad input comes back as a tool error describing the fix - retry with corrected
  arguments instead of giving up.
- Rate-limit errors suggest a wait time; back off and retry, or tell the user their
  plan limit was hit.
- Never fabricate a score if a tool call failed - report the failure plainly.
