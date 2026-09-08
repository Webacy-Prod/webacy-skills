import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  renderToolsTable,
  injectTools,
  collectTools,
} from "../scripts/build.mjs";

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
  const listTools = async (params) => {
    seen.push(params);
    return pages[i++];
  };
  const tools = await collectTools(listTools);
  assert.deepEqual(
    tools.map((t) => t.name),
    ["a", "b", "c"],
  );
  // first call has no cursor, second passes the cursor from page 1
  assert.deepEqual(seen, [undefined, { cursor: "c1" }]);
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
