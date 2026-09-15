# webacy-skills

Agent-agnostic packaging of the [Webacy](https://webacy.com) onchain risk engine.
This repo ships two skills, favoring no particular agent or UI:

1. **`webacy`** — connection configs for Claude Code, Claude Desktop, Cursor, Codex,
   and generic MCP clients to Webacy's hosted MCP server
   (`https://api.webacy.com/mcp`, HTTP streamable, `x-api-key` auth), plus a portable
   agent guide for reading results.
2. **`webacy-x402`** — call Webacy's REST API (`https://api.webacy.com`) pay-per-
   request via x402, in USDC on Base, with no API key.

## Layout

- `src/` — canonical, hand-edited sources for the `webacy` skill: `meta.yml`,
  `guide.md`, and one `connect/*.md` per client.
- `src/x402/` — canonical, hand-edited sources for the `webacy-x402` skill:
  `meta.yml` and `guide.md`.
- `skills/webacy/SKILL.md`, `skills/webacy-x402/SKILL.md`, and `AGENTS.md` —
  **generated**; do not edit by hand.
- `scripts/build.mjs` — fetches the live MCP tool list and regenerates the `webacy`
  skill + `AGENTS.md`.
- `scripts/build-x402.mjs` — fetches the public OpenAPI spec, live-probes every
  endpoint it declares as x402-payable (unauthenticated requests against
  `api.webacy.com`; the spec can be ahead of the gateway), and regenerates the
  `webacy-x402` skill split into endpoints verified live vs. not yet.
- `scripts/lib.mjs` — pure helpers shared by both generators.

## Generated files

Both skills are generated from `src/`; a weekly GitHub Action
(`.github/workflows/sync.yml`) reruns both builds and opens a PR whenever the output
drifts. `scripts/build.mjs` needs a `WEBACY_API_KEY` repository secret;
`scripts/build-x402.mjs` needs no secret — the spec and the endpoints it probes are
all unauthenticated — but it does make ~33 live requests against production, so it
takes longer (seconds, not instant) than a pure static-file build.

**Edit `src/`, never the generated files.**

## Build locally

```bash
npm install
WEBACY_API_KEY=your_key npm run build   # webacy (MCP) skill + AGENTS.md
npm run build:x402                      # webacy-x402 skill, no key needed
```

## Links

- MCP server docs: https://docs.webacy.com/integrations/mcp-server
- x402 payment flow: https://docs.webacy.com/x402-payments
- Get an API key: https://developers.webacy.co
