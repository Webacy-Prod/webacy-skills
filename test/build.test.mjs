import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
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
  renderPendingTable,
  buildProbeUrl,
  classifyProbeStatus,
  probeEndpoints,
} from "../scripts/build-x402.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

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
  // near-match: a differently named response must not be treated as payable
  assert.equal(
    isX402Response({ $ref: "#/components/responses/NotX402PaymentRequired" }),
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

test("buildProbeUrl fills path params by name and appends a chain query", () => {
  assert.equal(
    buildProbeUrl("/addresses/{address}"),
    "https://api.webacy.com/addresses/0x0000000000000000000000000000000000dEaD?chain=eth",
  );
  assert.equal(
    buildProbeUrl("/transactions/{txHash}"),
    `https://api.webacy.com/transactions/0x${"0".repeat(64)}?chain=eth`,
  );
  assert.equal(
    buildProbeUrl("/rwa/supply/{symbol}"),
    "https://api.webacy.com/rwa/supply/USDC?chain=eth",
  );
  // multiple params in one path
  assert.equal(
    buildProbeUrl("/scan/{fromAddress}/eip712"),
    "https://api.webacy.com/scan/0x0000000000000000000000000000000000dEaD/eip712?chain=eth",
  );
});

test("classifyProbeStatus maps the observed statuses seen in practice, else unknown", () => {
  assert.equal(classifyProbeStatus(402), "live");
  assert.equal(classifyProbeStatus(401), "pending");
  assert.equal(classifyProbeStatus(403), "excluded");
  assert.equal(classifyProbeStatus(404), "unknown"); // spec declares a route the backend doesn't serve
  assert.equal(classifyProbeStatus(500), "unknown");
});

test("probeEndpoints attaches a status per endpoint via an injected probe, preserving order", async () => {
  const endpoints = [
    { method: "GET", path: "/a" },
    { method: "GET", path: "/b" },
    { method: "POST", path: "/c" },
  ];
  const seen = [];
  const probe = async (endpoint) => {
    seen.push(endpoint.path);
    return { "/a": "live", "/b": "pending", "/c": "excluded" }[endpoint.path];
  };
  const results = await probeEndpoints(endpoints, { probe, delayMs: 0 });
  assert.deepEqual(seen, ["/a", "/b", "/c"]);
  assert.deepEqual(
    results.map((e) => [e.path, e.status]),
    [
      ["/a", "live"],
      ["/b", "pending"],
      ["/c", "excluded"],
    ],
  );
});

test("renderPendingTable includes a status label and escapes pipes/backticks", () => {
  const table = renderPendingTable([
    { method: "GET", path: "/x", status: "pending", summary: "a | b `c`" },
  ]);
  const row = table.split("\n")[2];
  assert.ok(row.includes("401 - gateway pending"));
  assert.ok(row.includes("\\|"));
  assert.ok(row.includes("\\`"));
});

test("renderPendingTable falls back to the unknown label for an unrecognized status", () => {
  const table = renderPendingTable([
    { method: "GET", path: "/x", status: "something-new", summary: "s" },
  ]);
  assert.ok(table.includes("unverified"));
});

test("build-x402.mjs splits live vs. not-live endpoints from live probe results end to end", async () => {
  const fakeSpec = JSON.stringify({
    paths: {
      "/live": {
        get: {
          summary: "Live endpoint",
          responses: { "402": { $ref: "#/components/responses/X402PaymentRequired" } },
        },
      },
      "/pending": {
        get: {
          summary: "Pending endpoint",
          responses: { "402": { $ref: "#/components/responses/X402PaymentRequired" } },
        },
      },
      "/excluded": {
        get: {
          summary: "Excluded endpoint",
          responses: { "402": { $ref: "#/components/responses/X402PaymentRequired" } },
        },
      },
    },
  });

  const specServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(fakeSpec);
  });
  const apiServer = createServer((req, res) => {
    const status = req.url.startsWith("/live")
      ? 402
      : req.url.startsWith("/pending")
        ? 401
        : 403;
    res.writeHead(status, { "content-type": "application/json" });
    res.end("{}");
  });

  await Promise.all([
    new Promise((resolve) => specServer.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => apiServer.listen(0, "127.0.0.1", resolve)),
  ]);

  const outputPath = join(ROOT, ".tmp-test-x402-skill.md");
  try {
    const { port: specPort } = specServer.address();
    const { port: apiPort } = apiServer.address();
    await execFileAsync("node", [join(ROOT, "scripts/build-x402.mjs")], {
      env: {
        ...process.env,
        WEBACY_OPENAPI_URL: `http://127.0.0.1:${specPort}/openapi.json`,
        WEBACY_API_BASE: `http://127.0.0.1:${apiPort}`,
        WEBACY_X402_OUTPUT_PATH: outputPath,
      },
    });

    const output = await readFile(outputPath, "utf8");
    const liveSection = output.slice(
      output.indexOf("<!-- ENDPOINTS:START -->"),
      output.indexOf("<!-- ENDPOINTS:END -->"),
    );
    const pendingSection = output.slice(output.indexOf("<!-- PENDING_ENDPOINTS:START -->"));

    assert.ok(liveSection.includes("/live"));
    assert.ok(!liveSection.includes("/pending"));
    assert.ok(!liveSection.includes("/excluded"));

    assert.ok(pendingSection.includes("/pending"));
    assert.ok(pendingSection.includes("401 - gateway pending"));
    assert.ok(pendingSection.includes("/excluded"));
    assert.ok(pendingSection.includes("403 - not available via x402"));
  } finally {
    await Promise.all([
      new Promise((resolve) => specServer.close(resolve)),
      new Promise((resolve) => apiServer.close(resolve)),
    ]);
    await rm(outputPath, { force: true });
  }
});

test("build-x402.mjs exits non-zero when the spec has zero x402 endpoints", async () => {
  const emptySpec = JSON.stringify({
    paths: { "/x": { get: { summary: "no payment here", responses: { "200": {} } } } },
  });
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(emptySpec);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    // execFile (not the sync variant): the child must reach back over HTTP to
    // the server above, which is running in this same process/event loop -- a
    // *Sync spawn would block that loop and the request would never be served.
    await assert.rejects(
      execFileAsync("node", [join(ROOT, "scripts/build-x402.mjs")], {
        env: {
          ...process.env,
          WEBACY_OPENAPI_URL: `http://127.0.0.1:${port}/openapi.json`,
        },
      }),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
