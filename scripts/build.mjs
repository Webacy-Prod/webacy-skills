#!/usr/bin/env node
// Single source of truth -> generated client artifacts.
// Fetches the live Webacy MCP tool list and regenerates skills/webacy/SKILL.md
// and AGENTS.md. Canonical content lives in src/ -- edit that, not the outputs.
import { readFile, writeFile } from "node:fs/promises";
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

// Fixed client order for the "How to connect" section.
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
    const { tools } = await client.listTools();
    return tools;
  } catch (err) {
    fail(`failed to fetch tools from ${ENDPOINT}: ${err?.message ?? err}`);
  } finally {
    await client.close().catch(() => {});
  }
}

function renderToolsTable(tools) {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const rows = sorted.map((t) => {
    const desc = (t.description ?? "").replace(/\s+/g, " ").trim();
    return `| \`${t.name}\` | ${desc} |`;
  });
  return ["| Tool | Description |", "| --- | --- |", ...rows].join("\n");
}

function injectTools(guide, tableMarkdown) {
  const start = guide.indexOf(TOOLS_START);
  const end = guide.indexOf(TOOLS_END);
  if (start === -1 || end === -1 || end < start)
    fail("src/guide.md is missing the TOOLS markers");
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

async function main() {
  const metaRaw = (await readFile(p("src/meta.yml"), "utf8")).trim();
  const meta = parseYaml(metaRaw);
  if (!meta?.name || !meta?.description)
    fail("src/meta.yml must define name and description");
  // meta.yml is already valid YAML frontmatter, so reuse it verbatim.
  const frontmatter = `---\n${metaRaw}\n---`;

  const guideSrc = await readFile(p("src/guide.md"), "utf8");

  const connects = {};
  for (const f of CONNECT_ORDER) {
    connects[f] = (await readFile(p("src/connect", f), "utf8")).trim();
  }

  const tools = await fetchTools();
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

  process.exit(0);
}

main().catch((err) => fail(err?.stack ?? String(err)));
