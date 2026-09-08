# Webacy

## How to connect

All clients connect to `https://api.webacy.com/mcp` with an `x-api-key` header. Get a key at https://developers.webacy.co.

### Claude Code
```bash
claude mcp add webacy --transport http https://api.webacy.com/mcp --header "x-api-key: YOUR_API_KEY"
```

### Claude Desktop
```json
{ "mcpServers": { "webacy": { "type": "http", "url": "https://api.webacy.com/mcp", "headers": { "x-api-key": "YOUR_API_KEY" } } } }
```

### Cursor
```json
{ "mcpServers": { "webacy": { "url": "https://api.webacy.com/mcp", "headers": { "x-api-key": "YOUR_API_KEY" } } } }
```

### Codex CLI (~/.codex/config.toml)
```toml
[mcp_servers.webacy]
url = "https://api.webacy.com/mcp"
http_headers = { "x-api-key" = "YOUR_API_KEY" }
```

### Any MCP client (remote HTTP)
Endpoint `https://api.webacy.com/mcp`, transport HTTP streamable, header `x-api-key: YOUR_API_KEY`.

# Webacy risk engine

Webacy scores blockchain security risk for addresses, tokens, contracts, and DeFi
vaults across 14+ chains. Use this whenever the user asks whether something onchain
is safe, risky, sanctioned, a scam, a honeypot, or trustworthy.

## Tools

<!-- TOOLS:START -->
<!-- Auto-generated from api.webacy.com/mcp tools/list. Do not edit by hand. -->
| Tool | Description |
| --- | --- |
| `get_address_risk` | Analyze the risk profile of a blockchain address (wallet or contract). Returns risk score, risk factors, and detailed security analysis. If the address is a stablecoin, RWA, or other pegged token (e.g. USDC, USDT, PYUSD, DAI), prefer get_rwa_token_risk, which adds depeg / peg-stability analysis. |
| `get_holder_analysis` | Analyze the holder distribution and concentration of a token. Returns top holders, holder counts, and distribution metrics. |
| `get_rwa_token_risk` | Depeg / peg-stability risk analysis for a stablecoin, RWA, or pegged token — e.g. USDC, USDT, PYUSD, DAI, USDe, tokenized treasuries or money-market funds (BUIDL), or commodity tokens (PAXG). PREFER THIS over get_token_risk whenever the asset is a stablecoin, RWA, or otherwise pegged. Returns risk… |
| `get_token_risk` | Analyze the risk profile of a general token contract. Returns token security flags, market data, and economic risk indicators. For stablecoins, RWAs, or other pegged tokens (e.g. USDC, USDT, PYUSD, DAI), prefer get_rwa_token_risk, which adds depeg / peg-stability analysis. |
| `get_vault_risk` | Get detailed risk analysis for an ERC-4626 vault. Returns risk score, risk tier, risk decomposition across 7 categories (structure, governance, liquidity, code quality, asset, performance, protocol), looping data, Morpho markets, and Webacy findings. Also returns the Webacy A+→F letter grade / rati… |
| `list_rwa_tokens` | List RWA and pegged tokens (stablecoins) with depeg risk data. Returns paginated items with ecosystem aggregates (tier counts, denomination breakdown). Each item also carries the Webacy A+→F v3 composite letter grade / rating (\`grade\`), the same grade shown on dd.xyz, or null when the token is not… |
| `list_vaults` | List ERC-4626 vaults with risk scores, filtering, and sorting. Returns paginated vault items with ecosystem aggregates (tier counts, TVL, highest risk, largest TVL). Each item also carries the Webacy A+→F v3 composite letter grade / rating (\`grade\`), the same grade shown on dd.xyz, or null when the… |
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
