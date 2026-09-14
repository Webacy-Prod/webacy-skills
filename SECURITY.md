# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability. Instead:

- Use GitHub's [private vulnerability reporting](https://github.com/Webacy-Prod/webacy-skills/security/advisories/new)
  for this repository, or
- Contact the Webacy team at https://webacy.com.

We aim to acknowledge reports within 3 business days.

## Scope

This repository packages connection configs and a portable agent guide for the
hosted Webacy MCP server (`https://api.webacy.com/mcp`). It contains **no
secrets**: API keys are supplied by the user at runtime via the `x-api-key`
header and are never committed here.

Reports about the hosted Webacy API itself (rather than this packaging repo)
should also go to the Webacy team via the channels above.

## API keys

Never commit a `WEBACY_API_KEY`. Get one at https://developers.webacy.co and
store it as a local environment variable or a CI secret. The `.gitignore`
excludes `.env`, `.env.local`, and `.env*.local` — other `.env*` files (for
example `.env.production`) are **not** ignored, so keep keys out of those too.
