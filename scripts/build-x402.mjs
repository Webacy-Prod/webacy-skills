#!/usr/bin/env node
// Single source of truth -> generated x402 skill.
// Fetches the public Webacy OpenAPI spec and regenerates
// skills/webacy-x402/SKILL.md with the endpoints that accept x402 pay-per-
// request payment. Canonical content lives in src/x402/ -- edit that, not
// the output. Needs no secret: the spec is public.
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  fail,
  renderName,
  renderDescription,
  renderTable,
  injectBetweenMarkers,
  writeIfChanged,
} from "./lib.mjs";

const OPENAPI_URL = "https://docs.webacy.com/openapi.json";
const ENDPOINTS_START = "<!-- ENDPOINTS:START -->";
const ENDPOINTS_END = "<!-- ENDPOINTS:END -->";
const GENERATED_COMMENT =
  "<!-- Auto-generated from docs.webacy.com/openapi.json. Do not edit by hand. -->";
const MAX_DESCRIPTION = 300;
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...parts) => join(ROOT, ...parts);

async function fetchOpenApiSpec() {
  let res;
  try {
    res = await fetch(OPENAPI_URL);
  } catch (err) {
    fail(`request to ${OPENAPI_URL} failed: ${err?.message ?? err}`);
  }
  if (!res.ok) fail(`${OPENAPI_URL} -> HTTP ${res.status} ${res.statusText}`);
  try {
    return await res.json();
  } catch (err) {
    fail(`invalid JSON from ${OPENAPI_URL}: ${err?.message ?? err}`);
  }
}

// A 402 response is x402-payable when it references the X402PaymentRequired
// component via $ref (how the spec always expresses it today).
function isX402Response(response) {
  if (!response || typeof response.$ref !== "string") return false;
  return response.$ref.includes("X402PaymentRequired");
}

// Collect { method, path, summary } for every operation whose 402 response is
// the x402 challenge, sorted by path then method.
function collectX402Endpoints(spec) {
  const endpoints = [];
  for (const [path, methods] of Object.entries(spec?.paths ?? {})) {
    for (const [method, op] of Object.entries(methods ?? {})) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const response402 = op?.responses?.["402"];
      if (!isX402Response(response402)) continue;
      endpoints.push({
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? op.description ?? "",
      });
    }
  }
  return endpoints.sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
}

function renderEndpointsTable(endpoints) {
  const rows = endpoints.map(
    (e) =>
      `| ${e.method} | ${renderName(e.path)} | ${renderDescription(e.summary, MAX_DESCRIPTION)} |`,
  );
  return renderTable(["Method", "Path", "Description"], rows);
}

async function main() {
  const metaRaw = (await readFile(p("src/x402/meta.yml"), "utf8")).trim();
  if (!/^name:\s*\S/m.test(metaRaw) || !/^description:\s*\S/m.test(metaRaw))
    fail("src/x402/meta.yml must define name and description");
  const frontmatter = `---\n${metaRaw}\n---`;

  const guideSrc = await readFile(p("src/x402/guide.md"), "utf8");

  const spec = await fetchOpenApiSpec();
  const endpoints = collectX402Endpoints(spec);
  if (!endpoints.length)
    fail(`${OPENAPI_URL} has zero x402 endpoints; refusing to publish an empty skill`);
  const table = renderEndpointsTable(endpoints);

  let guide;
  try {
    guide = injectBetweenMarkers(
      guideSrc,
      ENDPOINTS_START,
      ENDPOINTS_END,
      `${GENERATED_COMMENT}\n${table}`,
    );
  } catch {
    fail("src/x402/guide.md is missing the ENDPOINTS markers");
  }
  guide = guide.trim();

  const skill = `${frontmatter}\n\n${guide}\n`;
  await writeIfChanged(p("skills/webacy-x402/SKILL.md"), skill);
}

export { isX402Response, collectX402Endpoints, renderEndpointsTable };

const invokedDirectly =
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => fail(err?.stack ?? String(err)));
}
