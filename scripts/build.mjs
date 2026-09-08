#!/usr/bin/env node
// Single source of truth -> generated client artifacts.
// Fetches the live Webacy MCP tool list and regenerates skills/webacy/SKILL.md
// and AGENTS.md. Canonical content lives in src/ -- edit that, not the outputs.
import { readFile, writeFile, readdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ENDPOINT = "https://api.webacy.com/mcp";
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

function fail(msg) {
  console.error(`build: ${msg}`);
  process.exit(1);
}

async function fetchTools() {
  const apiKey = process.env.WEBACY_API_KEY;
  if (!apiKey) fail("missing WEBACY_API_KEY environment variable");

  const client = new Client({ name: "webacy-skills-build", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    requestInit: { headers: { "x-api-key": apiKey } },
  });

  try {
    await client.connect(transport);
    return await collectTools((params) => client.listTools(params));
  } catch (err) {
    fail(`failed to fetch tools from ${ENDPOINT}: ${err?.message ?? err}`);
  } finally {
    await client.close().catch(() => {});
  }
}

// tools/list is paginated; follow nextCursor until it is exhausted so no tool
// is dropped when the server splits the list across pages.
async function collectTools(listTools) {
  const tools = [];
  let cursor;
  do {
    const page = await listTools(cursor !== undefined ? { cursor } : undefined);
    tools.push(...(page.tools ?? []));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return tools;
}

// Render a tool name as an inline code span safe inside a markdown table cell.
// Pipes must be escaped even inside code spans; backticks need a longer fence.
function renderName(name) {
  const cell = String(name ?? "").replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
  if (!cell.includes("`")) return `\`${cell}\``;
  const longestRun = Math.max(...(cell.match(/`+/g) || [""]).map((r) => r.length));
  const fence = "`".repeat(longestRun + 1);
  return `${fence} ${cell} ${fence}`;
}

// Render a description as plain text safe inside a markdown table cell:
// collapse whitespace, cap length, then escape table/markdown control chars.
function renderDescription(description) {
  const clean = String(description ?? "").replace(/\s+/g, " ").trim();
  const capped =
    clean.length > MAX_DESCRIPTION
      ? `${clean.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…`
      : clean;
  return capped
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`");
}

function renderToolsTable(tools) {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const rows = sorted.map(
    (t) => `| ${renderName(t.name)} | ${renderDescription(t.description)} |`,
  );
  return ["| Tool | Description |", "| --- | --- |", ...rows].join("\n");
}

function injectTools(guide, tableMarkdown) {
  const start = guide.indexOf(TOOLS_START);
  const end = guide.indexOf(TOOLS_END);
  if (start === -1 || end === -1 || end < start)
    throw new Error("src/guide.md is missing the TOOLS markers");
  const before = guide.slice(0, start);
  const after = guide.slice(end + TOOLS_END.length);
  const block = `${TOOLS_START}\n${GENERATED_COMMENT}\n${tableMarkdown}\n${TOOLS_END}`;
  return `${before}${block}${after}`;
}

async function writeIfChanged(path, content) {
  let current = null;
  try {
    current = await readFile(path, "utf8");
  } catch {
    // file does not exist yet
  }
  if (current === content) {
    console.log(`unchanged: ${path}`);
    return false;
  }
  await writeFile(path, content);
  console.log(`wrote: ${path}`);
  return true;
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
  const meta = parseYaml(metaRaw);
  if (!meta?.name || !meta?.description)
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

export { renderName, renderDescription, renderToolsTable, injectTools, collectTools };

const invokedDirectly =
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => fail(err?.stack ?? String(err)));
}
