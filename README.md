# webacy-skills

Agent-agnostic packaging of the [Webacy](https://webacy.com) onchain risk engine.
This repo ships two skills, favoring no particular agent or UI:

1. **`webacy`** — connection configs for Claude Code, Claude Desktop, Cursor, Codex,
   and generic MCP clients to Webacy's hosted MCP server
   (`https://api.webacy.com/mcp`, HTTP streamable, `x-api-key` auth), plus a portable
   agent guide for reading results.
2. **`webacy-x402`** — call Webacy's REST API (`https://api.webacy.com`) pay-per-
   request via x402, in USDC on Base, with no API key.

It also builds a **ChatGPT plugin** ZIP (see [ChatGPT plugin](#chatgpt-plugin)).

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
- `src/chatgpt-plugin/` — hand-edited sources for the ChatGPT plugin: `plugin.json`
  (listing, review cases), `mcp.json` (server + OAuth), `connect.md`, `assets/`.
- `scripts/build-chatgpt-plugin.mjs` — validates and zips the ChatGPT plugin into
  `dist/` (git-ignored).
- `schemas/agent-plugins/1.0.0/` — vendored copies of the public Agent Plugins
  schemas the plugin manifests declare; the build validates against them offline.

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
npm run build:chatgpt-plugin            # ChatGPT plugin ZIP, no key needed
```

## ChatGPT plugin

A plugin package for [ChatGPT](https://developers.openai.com/plugins/build/plugins),
uploaded at [platform.openai.com/plugins](https://platform.openai.com/plugins). It
bundles the `webacy` skill and Webacy's hosted MCP server
(`https://api.webacy.com/mcp`). Users connect with OAuth: ChatGPT discovers
`auth.webacy.com` from the server's protected-resource metadata and registers itself
with Dynamic Client Registration. The package holds no API key or other secret.

It uses OpenAI's portable package format
([submission docs](https://developers.openai.com/plugins/deploy/submission)):

```
plugin.json              # identity, listing (extensions.com.openai.interface), review prompts and cases
mcp.json                 # one streamable-http server, auth: { type: oauth, client: { mode: dcr } }
skills/webacy/SKILL.md   # guide + synced tools table, API-key instructions swapped for OAuth notes
assets/logo.png          # logo and composer icon (256x256 PNG, from developers.webacy.com/icon-256.png)
```

### Build

```bash
npm run build:chatgpt-plugin
# -> dist/webacy-chatgpt-plugin.zip (and dist/chatgpt-plugin/ unpacked)
```

The skill comes from the generated `skills/webacy/SKILL.md`, so the plugin picks up
the weekly tool sync without network access. Before writing the ZIP, the build checks
the package against OpenAI's documented
[upload](https://developers.openai.com/plugins/deploy/submission-errors) and
submission rules: field lengths, category, HTTPS listing URLs, icon size (listing logo
at least 256 px, per OpenAI's Plugin Creator `prepare-plugin-submission` checklist),
brand color contrast, review prompts, exactly 5 positive and 3 negative review cases
naming real tools, OAuth
(no API-key auth, headers or secrets), and archive path rules. Any violation fails
the build. CI runs it on every PR and uploads the ZIP as a workflow artifact.

Both manifests are also validated with ajv against the Agent Plugins schemas they
declare. One documented exception: OpenAI puts MCP auth in a server-level
`extensions["com.openai"]` block
([MCP authentication](https://developers.openai.com/plugins/build/plugins#configure-mcp-authentication)),
which the public `mcp.schema.json` doesn't allow yet, so that block is removed
before the schema check and validated by the build's own auth rules instead.

To change the listing or review cases, edit `src/chatgpt-plugin/plugin.json` and bump
`version` before uploading a new version.

### Submit

Done by a person in the OpenAI dashboard
([submission guide](https://developers.openai.com/plugins/deploy/submission)):

1. The Webacy OpenAI organization must have a verified developer identity, and the
   submitter needs Owner or Apps Management Write access. EU data-residency projects
   can't submit MCP plugins.
2. At platform.openai.com/plugins, choose **Upload new or existing plugin**, pick the
   identity, and upload `webacy-chatgpt-plugin.zip`.
3. Under **MCPs**, connect the server. Before domain verification, configure
   `https://api.webacy.com/.well-known/openai-apps-challenge` to return the token the
   portal shows, as plain text (that path has no route yet; tracked in
   [WEB-7113](https://linear.app/webacy/issue/WEB-7113)). Then complete domain
   verification, authorize with a Webacy account, and wait for the tool scan. The scan
   expects `readOnlyHint`, `openWorldHint` and `destructiveHint` annotations on every
   tool; the server doesn't set them yet (tracked in
   [WEB-7127](https://linear.app/webacy/issue/WEB-7127)).
4. Fill in what the package can't carry: a demo recording URL, supported countries,
   and reviewer test credentials (a Webacy account without MFA).
5. Submit for review. After approval, choose when to publish. The MCP URL can't
   change after publication.

## Links

- MCP server docs: https://docs.webacy.com/integrations/mcp-server
- x402 payment flow: https://docs.webacy.com/x402-payments
- Get an API key: https://developers.webacy.co
