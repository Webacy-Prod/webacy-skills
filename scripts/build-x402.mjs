#!/usr/bin/env node
// Single source of truth -> generated x402 skill.
// Fetches the public Webacy OpenAPI spec, then live-probes every endpoint the
// spec declares as x402-payable and regenerates skills/webacy-x402/SKILL.md
// split by what the gateway actually returned. The spec can be ahead of the
// gateway (a declared endpoint may still 401/403/404 in prod) -- probing is
// how we avoid teaching agents a flow that fails on undeployed routes.
// Canonical content lives in src/x402/ -- edit that, not the output. Needs no
// secret: the spec and the probed endpoints are all unauthenticated.
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

// Overridable so tests can point this at a local spec without touching the
// live public one.
const OPENAPI_URL =
  process.env.WEBACY_OPENAPI_URL || "https://docs.webacy.com/openapi.json";
// Overridable for the same reason -- tests probe a local stub server instead
// of the live REST API.
const API_BASE = process.env.WEBACY_API_BASE || "https://api.webacy.com";
const ENDPOINTS_START = "<!-- ENDPOINTS:START -->";
const ENDPOINTS_END = "<!-- ENDPOINTS:END -->";
const PENDING_START = "<!-- PENDING_ENDPOINTS:START -->";
const PENDING_END = "<!-- PENDING_ENDPOINTS:END -->";
const GENERATED_COMMENT =
  "<!-- Auto-generated from docs.webacy.com/openapi.json. Do not edit by hand. -->";
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const X402_RESPONSE_REF = "#/components/responses/X402PaymentRequired";
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_DELAY_MS = 150; // gentle on the x402 rate limiter (60/min observed)
const STATUS_LABELS = {
  pending: "401 - gateway pending",
  excluded: "403 - not available via x402",
  unknown: "unverified (probe failed or returned an unexpected status)",
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...parts) => join(ROOT, ...parts);
// Overridable so tests never clobber the committed generated skill.
const OUTPUT_PATH = process.env.WEBACY_X402_OUTPUT_PATH || p("skills/webacy-x402/SKILL.md");

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
// component via $ref, by exact path -- substring matching would also accept
// a near-miss like #/components/responses/NotX402PaymentRequired.
function isX402Response(response) {
  return Boolean(response) && response.$ref === X402_RESPONSE_REF;
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
    (e) => `| ${e.method} | ${renderName(e.path)} | ${renderDescription(e.summary)} |`,
  );
  return renderTable(["Method", "Path", "Description"], rows);
}

function renderPendingTable(endpoints) {
  const rows = endpoints.map(
    (e) =>
      `| ${e.method} | ${renderName(e.path)} | ${STATUS_LABELS[e.status] ?? STATUS_LABELS.unknown} | ${renderDescription(e.summary)} |`,
  );
  return renderTable(["Method", "Path", "Status", "Description"], rows);
}

// Best-effort placeholder for a path parameter, chosen by name. The x402
// gateway gate fires before business-logic/param validation (confirmed by
// live testing against api.webacy.com), so any syntactically plausible value
// is enough to observe whether a declared endpoint is actually gated.
function placeholderFor(paramName) {
  const name = paramName.toLowerCase();
  if (name.includes("hash")) return `0x${"0".repeat(64)}`;
  if (name.includes("symbol")) return "USDC";
  return "0x0000000000000000000000000000000000dEaD";
}

function buildProbeUrl(path) {
  const filled = path.replace(/\{([^}]+)\}/g, (_, name) => placeholderFor(name));
  return `${API_BASE}${filled}?chain=eth`;
}

// Map an observed HTTP status to what it implies about live x402 support.
// Anything other than the three statuses we've seen in practice (402 = live,
// 401 = implemented but not yet gateway-enabled, 403 = explicitly excluded)
// is "unknown" rather than assumed live -- e.g. a 404 means the spec declares
// a route the backend doesn't even serve.
function classifyProbeStatus(httpStatus) {
  if (httpStatus === 402) return "live";
  if (httpStatus === 401) return "pending";
  if (httpStatus === 403) return "excluded";
  return "unknown";
}

async function probeOne(endpoint) {
  const url = buildProbeUrl(endpoint.path);
  try {
    const res = await fetch(url, {
      method: endpoint.method,
      headers: endpoint.method === "POST" ? { "content-type": "application/json" } : undefined,
      body: endpoint.method === "POST" ? "{}" : undefined,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // A 402 isn't necessarily the x402 challenge -- an authenticated caller
    // with a past-due subscription gets a plain-JSON 402 with no
    // payment-required header (see guide.md). Don't count that as live.
    if (res.status === 402 && !res.headers.get("payment-required")) return "unknown";
    return classifyProbeStatus(res.status);
  } catch {
    // Network error, timeout, or abort -- we couldn't observe a status, so
    // don't claim the endpoint is live.
    return "unknown";
  }
}

// Probe each endpoint's live status, sequentially (gentle on the shared x402
// rate limit) through an injectable `probe` fn so this is unit-testable
// without live network. Never throws: an individual probe failure just
// yields "unknown" for that endpoint.
async function probeEndpoints(endpoints, { probe = probeOne, delayMs = PROBE_DELAY_MS } = {}) {
  const results = [];
  for (const endpoint of endpoints) {
    results.push({ ...endpoint, status: await probe(endpoint) });
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return results;
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

  const probed = await probeEndpoints(endpoints);
  const live = probed.filter((e) => e.status === "live");
  const notLive = probed.filter((e) => e.status !== "live");

  const liveTable = live.length
    ? renderEndpointsTable(live)
    : "_None of the spec-declared endpoints are live right now -- see the table below._";
  const pendingTable = notLive.length
    ? renderPendingTable(notLive)
    : "_None -- every spec-declared endpoint is live._";

  let guide;
  try {
    guide = injectBetweenMarkers(
      guideSrc,
      ENDPOINTS_START,
      ENDPOINTS_END,
      `${GENERATED_COMMENT}\n${liveTable}`,
    );
    guide = injectBetweenMarkers(
      guide,
      PENDING_START,
      PENDING_END,
      `${GENERATED_COMMENT}\n${pendingTable}`,
    );
  } catch {
    fail("src/x402/guide.md is missing the ENDPOINTS or PENDING_ENDPOINTS markers");
  }
  guide = guide.trim();

  const skill = `${frontmatter}\n\n${guide}\n`;
  await writeIfChanged(OUTPUT_PATH, skill);
}

export {
  isX402Response,
  collectX402Endpoints,
  renderEndpointsTable,
  renderPendingTable,
  buildProbeUrl,
  classifyProbeStatus,
  probeEndpoints,
};

const invokedDirectly =
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => fail(err?.stack ?? String(err)));
}
