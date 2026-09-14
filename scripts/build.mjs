#!/usr/bin/env node
// Single source of truth -> generated client artifacts.
// Fetches the live Webacy MCP tool list and regenerates skills/webacy/SKILL.md
// and AGENTS.md. Canonical content lives in src/ -- edit that, not the outputs.
import { readFile, readdir } from "node:fs/promises";
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

const ENDPOINT = "https://api.webacy.com/mcp";
// MCP protocol revision we advertise on the initialize handshake.
const PROTOCOL_VERSION = "2025-06-18";
// Revisions whose initialize + tools/list wire shape this client can drive. If
// the server negotiates anything outside this set we disconnect rather than
// speak an incompatible protocol.
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
const TOOLS_START = "<!-- TOOLS:START -->";
const TOOLS_END = "<!-- TOOLS:END -->";
const GENERATED_COMMENT =
  "<!-- Auto-generated from api.webacy.com/mcp tools/list. Do not edit by hand. -->";
const CONNECT_INTRO =
  "All clients connect to `https://api.webacy.com/mcp` with an `x-api-key` header. Get a key at https://developers.webacy.co.";
const MAX_DESCRIPTION = 300;

// Fixed client order for the "How to connect" section. main() asserts this
// covers every file in src/connect so a new client can never be silently dropped.
const CONNECT_ORDER = [
  "claude-code.md",
  "claude-desktop.md",
  "cursor.md",
  "codex.md",
  "generic-http.md",
];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...parts) => join(ROOT, ...parts);

// Parse a Server-Sent Events body into the JSON-RPC messages it carries.
// Exported for testing; blank-line-separated events, `data:` payloads only.
function parseSseMessages(raw) {
  const messages = [];
  for (const event of raw.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // ignore keep-alive comments / non-JSON events
    }
  }
  return messages;
}

// A response may come back as a single JSON body or as an SSE stream; return
// the JSON-RPC message for `expectedId` (or the first result/error otherwise).
async function readJsonRpc(res, expectedId) {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const messages = parseSseMessages(await res.text());
    const match =
      messages.find((m) => m.id === expectedId) ??
      messages.find((m) => "result" in m || "error" in m);
    if (!match) fail(`no JSON-RPC response for id ${expectedId} in SSE stream`);
    return match;
  }
  try {
    return await res.json();
  } catch (err) {
    fail(`invalid JSON-RPC response from ${ENDPOINT}: ${err?.message ?? err}`);
  }
}

// Minimal MCP Streamable HTTP client built on fetch alone, so no third-party
// dependency code runs in the process that holds WEBACY_API_KEY.
async function fetchTools() {
  const apiKey = process.env.WEBACY_API_KEY;
  if (!apiKey) fail("missing WEBACY_API_KEY environment variable");

  let sessionId;
  let protocolVersion = PROTOCOL_VERSION;
  let nextId = 0;

  const rpc = async (method, params, { notification = false } = {}) => {
    const payload = { jsonrpc: "2.0", method };
    if (!notification) payload.id = ++nextId;
    if (params !== undefined) payload.params = params;

    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-api-key": apiKey,
      "mcp-protocol-version": protocolVersion,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;

    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      fail(`request to ${ENDPOINT} failed: ${err?.message ?? err}`);
    }

    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      fail(
        `${method} -> HTTP ${res.status} ${res.statusText}` +
          (text ? `: ${text.slice(0, 300)}` : ""),
      );
    }
    if (notification) return undefined; // 202 Accepted, no body

    const message = await readJsonRpc(res, payload.id);
    if (message.error)
      fail(`${method} -> MCP error ${message.error.code}: ${message.error.message}`);
    if (!("result" in message))
      fail(`${method} -> malformed JSON-RPC response from ${ENDPOINT} (no result)`);
    return message.result;
  };

  const init = await rpc("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "webacy-skills-build", version: "1.0.0" },
  });
  // The server answers with the revision it will use. Only adopt it if we can
  // actually drive that revision; otherwise disconnect (per the MCP lifecycle).
  const serverVersion = init?.protocolVersion;
  if (serverVersion && !SUPPORTED_PROTOCOL_VERSIONS.has(serverVersion))
    fail(
      `${ENDPOINT} negotiated unsupported MCP revision ${serverVersion} ` +
        `(client supports ${[...SUPPORTED_PROTOCOL_VERSIONS].join(", ")})`,
    );
  if (serverVersion) protocolVersion = serverVersion;
  await rpc("notifications/initialized", undefined, { notification: true });

  return collectTools((cursor) =>
    rpc("tools/list", cursor !== undefined ? { cursor } : {}),
  );
}

// tools/list is paginated; follow nextCursor until it is exhausted so no tool
// is dropped when the server splits the list across pages. `listPage` takes a
// cursor (undefined on the first call) and resolves to a tools/list result.
async function collectTools(listPage) {
  const tools = [];
  let cursor;
  do {
    const page = await listPage(cursor);
    tools.push(...(page.tools ?? []));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return tools;
}

function renderToolsTable(tools) {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const rows = sorted.map(
    (t) => `| ${renderName(t.name)} | ${renderDescription(t.description, MAX_DESCRIPTION)} |`,
  );
  return renderTable(["Tool", "Description"], rows);
}

function injectTools(guide, tableMarkdown) {
  try {
    return injectBetweenMarkers(
      guide,
      TOOLS_START,
      TOOLS_END,
      `${GENERATED_COMMENT}\n${tableMarkdown}`,
    );
  } catch {
    throw new Error("src/guide.md is missing the TOOLS markers");
  }
}

async function assertConnectOrderComplete() {
  const present = (await readdir(p("src/connect")))
    .filter((f) => f.endsWith(".md"))
    .sort();
  const missing = present.filter((f) => !CONNECT_ORDER.includes(f));
  if (missing.length)
    fail(`src/connect has files missing from CONNECT_ORDER: ${missing.join(", ")}`);
}

async function main() {
  const metaRaw = (await readFile(p("src/meta.yml"), "utf8")).trim();
  if (!/^name:\s*\S/m.test(metaRaw) || !/^description:\s*\S/m.test(metaRaw))
    fail("src/meta.yml must define name and description");
  // meta.yml is already valid YAML frontmatter, so reuse it verbatim.
  const frontmatter = `---\n${metaRaw}\n---`;

  const guideSrc = await readFile(p("src/guide.md"), "utf8");

  await assertConnectOrderComplete();
  const connects = {};
  for (const f of CONNECT_ORDER) {
    connects[f] = (await readFile(p("src/connect", f), "utf8")).trim();
  }

  const tools = await fetchTools();
  if (!tools.length)
    fail(`${ENDPOINT} returned zero tools; refusing to publish an empty skill`);
  const table = renderToolsTable(tools);
  const guide = injectTools(guideSrc, table).trim();

  const skillConnect = [
    "## How to connect",
    CONNECT_INTRO,
    connects["claude-code.md"],
    "For other clients (Claude Desktop, Cursor, Codex, generic HTTP), see [AGENTS.md](../../AGENTS.md).",
  ].join("\n\n");
  const skill = `${frontmatter}\n\n${skillConnect}\n\n${guide}\n`;

  const agentsConnect = [
    "## How to connect",
    CONNECT_INTRO,
    ...CONNECT_ORDER.map((f) => connects[f]),
  ].join("\n\n");
  const agents = `# Webacy\n\n${agentsConnect}\n\n${guide}\n`;

  await writeIfChanged(p("skills/webacy/SKILL.md"), skill);
  await writeIfChanged(p("AGENTS.md"), agents);
}

export {
  renderName,
  renderDescription,
  renderToolsTable,
  injectTools,
  collectTools,
  parseSseMessages,
};

const invokedDirectly =
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => fail(err?.stack ?? String(err)));
}
