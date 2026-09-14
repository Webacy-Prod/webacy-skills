import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  renderToolsTable,
  injectTools,
  collectTools,
  parseSseMessages,
} from "../scripts/build.mjs";
import { renderTable, injectBetweenMarkers } from "../scripts/lib.mjs";
import {
  isX402Response,
  collectX402Endpoints,
  renderEndpointsTable,
} from "../scripts/build-x402.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("renderToolsTable escapes pipes/backticks, collapses whitespace, keeps columns", () => {
  const table = renderToolsTable([
    { name: "z_tool", description: "a | b `c`\nd" },
    { name: "a_tool", description: "plain" },
  ]);
  const lines = table.split("\n");
  assert.equal(lines.length, 4); // header + separator + 2 rows
  assert.match(lines[2], /a_tool/); // sorted by name
  assert.match(lines[3], /z_tool/);
  assert.ok(lines[3].includes("\\|"));
  assert.ok(lines[3].includes("\\`"));
  assert.ok(!lines[3].includes("\n"));
  // exactly 3 unescaped pipe delimiters per data row
  const unescapedPipes = lines[3].replace(/\\\|/g, "").match(/\|/g).length;
  assert.equal(unescapedPipes, 3);
});

test("renderToolsTable wraps backtick-containing names in a longer fence", () => {
  const row = renderToolsTable([{ name: "a`b", description: "x" }]).split("\n")[2];
  assert.ok(row.includes("`` a`b ``"));
});

test("renderToolsTable caps long descriptions", () => {
  const long = "x".repeat(500);
  const row = renderToolsTable([{ name: "t", description: long }]).split("\n")[2];
  assert.ok(row.length < long.length);
  assert.ok(row.includes("…"));
});

test("renderToolsTable escapes backslashes so a literal \\| is not a delimiter", () => {
  const row = renderToolsTable([{ name: "t", description: "a \\| b" }]).split("\n")[2];
  // strip every escaped pair; only the 3 real cell delimiters should remain
  const realDelimiters = row.replace(/\\./g, "").match(/\|/g).length;
  assert.equal(realDelimiters, 3);
});

test("collectTools follows nextCursor across pages", async () => {
  const pages = [
    { tools: [{ name: "a" }], nextCursor: "c1" },
    { tools: [{ name: "b" }, { name: "c" }], nextCursor: undefined },
  ];
  let i = 0;
  const seen = [];
  const listPage = async (cursor) => {
    seen.push(cursor);
    return pages[i++];
  };
  const tools = await collectTools(listPage);
  assert.deepEqual(
    tools.map((t) => t.name),
    ["a", "b", "c"],
  );
  // first call has no cursor, second passes the cursor from page 1
  assert.deepEqual(seen, [undefined, "c1"]);
});

test("parseSseMessages extracts JSON-RPC messages from an SSE body", () => {
  const raw =
    ": keep-alive\n\n" +
    'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n' +
    'data: {"jsonrpc":"2.0",\ndata: "id":2,"result":{"ok":true}}\n\n';
  const messages = parseSseMessages(raw);
  assert.equal(messages.length, 2); // keep-alive comment ignored
  assert.equal(messages[0].id, 1);
  assert.deepEqual(messages[0].result.tools, []);
  assert.equal(messages[1].id, 2); // multi-line data joined with newline
});

test("injectTools replaces the marker block and preserves the markers", () => {
  const guide = "# G\n\n<!-- TOOLS:START -->\nold\n<!-- TOOLS:END -->\n\ntail";
  const out = injectTools(guide, "| Tool | Description |\n| --- | --- |");
  assert.ok(out.includes("<!-- TOOLS:START -->"));
  assert.ok(out.includes("<!-- TOOLS:END -->"));
  assert.ok(out.includes("| Tool | Description |"));
  assert.ok(!out.includes("old"));
  assert.ok(out.includes("tail"));
});

test("injectTools throws when the markers are missing", () => {
  assert.throws(() => injectTools("no markers here", "x"), /markers/);
});

test("build.mjs exits non-zero without WEBACY_API_KEY", () => {
  assert.throws(() =>
    execFileSync("node", [join(ROOT, "scripts/build.mjs")], {
      env: { ...process.env, WEBACY_API_KEY: "" },
      stdio: "pipe",
    }),
  );
});

test("renderTable builds a header, separator, and row lines", () => {
  const table = renderTable(["A", "B"], ["| 1 | 2 |"]);
  assert.deepEqual(table.split("\n"), ["| A | B |", "| --- | --- |", "| 1 | 2 |"]);
});

test("injectBetweenMarkers replaces the marker block and preserves the markers", () => {
  const text = "# G\n\n<!-- X:START -->\nold\n<!-- X:END -->\n\ntail";
  const out = injectBetweenMarkers(text, "<!-- X:START -->", "<!-- X:END -->", "new");
  assert.ok(out.includes("<!-- X:START -->"));
  assert.ok(out.includes("<!-- X:END -->"));
  assert.ok(out.includes("new"));
  assert.ok(!out.includes("old"));
  assert.ok(out.includes("tail"));
});

test("injectBetweenMarkers throws when the markers are missing", () => {
  assert.throws(
    () => injectBetweenMarkers("no markers here", "<!-- A -->", "<!-- B -->", "x"),
    /markers/,
  );
});

test("isX402Response only matches a $ref to X402PaymentRequired", () => {
  assert.equal(
    isX402Response({ $ref: "#/components/responses/X402PaymentRequired" }),
    true,
  );
  assert.equal(
    isX402Response({ $ref: "#/components/responses/SomethingElse" }),
    false,
  );
  assert.equal(isX402Response({ description: "plain 402, no ref" }), false);
  assert.equal(isX402Response(undefined), false);
});

test("collectX402Endpoints picks only paths whose 402 references X402PaymentRequired", () => {
  const spec = {
    paths: {
      "/b": {
        get: {
          summary: "B",
          responses: { "402": { $ref: "#/components/responses/X402PaymentRequired" } },
        },
      },
      "/a": {
        post: {
          summary: "A post",
          responses: { "402": { $ref: "#/components/responses/X402PaymentRequired" } },
        },
        get: {
          summary: "A get, not payable",
          responses: { "402": { description: "plain 402" } },
        },
      },
      "/c": {
        get: {
          summary: "No 402 at all",
          responses: { "200": {} },
        },
      },
    },
  };
  const endpoints = collectX402Endpoints(spec);
  assert.deepEqual(
    endpoints.map((e) => `${e.method} ${e.path}`),
    ["POST /a", "GET /b"],
  );
});

test("renderEndpointsTable escapes pipes/backticks in the description", () => {
  const table = renderEndpointsTable([
    { method: "GET", path: "/x", summary: "a | b `c`" },
  ]);
  const row = table.split("\n")[2];
  assert.ok(row.includes("\\|"));
  assert.ok(row.includes("\\`"));
  assert.ok(row.startsWith("| GET | `/x` |"));
});
