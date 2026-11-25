import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseFrontmatter,
  pngSize,
  contrastRatio,
  toolsFromSkill,
  crc32,
  createZip,
  readZip,
  validatePackage,
  buildSkill,
  assemble,
} from "../scripts/build-chatgpt-plugin.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

// Deep-copy the real package and apply `mutate` to its parsed plugin.json / mcp.json.
async function mutated({ manifest, mcp, files: editFiles } = {}) {
  const files = new Map(await assemble());
  if (manifest) {
    const m = JSON.parse(files.get("plugin.json").toString("utf8"));
    manifest(m);
    files.set("plugin.json", Buffer.from(JSON.stringify(m)));
  }
  if (mcp) {
    const m = JSON.parse(files.get("mcp.json").toString("utf8"));
    mcp(m);
    files.set("mcp.json", Buffer.from(JSON.stringify(m)));
  }
  if (editFiles) editFiles(files);
  return validatePackage(files);
}

const ui = (m) => m.extensions["com.openai"].interface;
const server = (m) => m.mcpServers.webacy;

test("the committed plugin sources pass validation", async () => {
  assert.deepEqual(validatePackage(await assemble()), []);
});

test("the package contains exactly the expected files", async () => {
  const files = await assemble();
  assert.deepEqual([...files.keys()].sort(), [
    "assets/logo.png",
    "mcp.json",
    "plugin.json",
    "skills/webacy/SKILL.md",
  ]);
});

test("the ChatGPT skill keeps the synced tools and drops API-key instructions", async () => {
  const skill = (await assemble()).get("skills/webacy/SKILL.md").toString("utf8");
  const fm = parseFrontmatter(skill);
  assert.equal(fm.data.name, "webacy");
  assert.match(fm.data.description, /^Assess onchain risk with Webacy/);
  assert.ok(toolsFromSkill(skill).includes("get_address_risk"));
  assert.match(skill, /OAuth/);
  assert.doesNotMatch(skill, /x-api-key|YOUR_API_KEY|How to connect/);
});

test("buildSkill fails loudly when the guide heading is missing", () => {
  assert.throws(() => buildSkill("name: x", "c", "no guide here"), /Webacy risk engine/);
});

test("mcp.json points at production with OAuth DCR and no headers", async () => {
  const mcp = JSON.parse((await assemble()).get("mcp.json").toString("utf8"));
  const s = server(mcp);
  assert.equal(s.url, "https://api.webacy.com/mcp");
  assert.deepEqual(s.extensions["com.openai"].auth, { type: "oauth", client: { mode: "dcr" } });
  assert.equal(s.headers, undefined);
});

test("validation rejects listing text over OpenAI's limits", async () => {
  const errors = await mutated({
    manifest: (m) => {
      ui(m).displayName = "x".repeat(31);
      ui(m).shortDescription = "y".repeat(31);
    },
  });
  assert.ok(errors.some((e) => e.includes("displayName is 31 characters, max 30")));
  assert.ok(errors.some((e) => e.includes("shortDescription is 31 characters, max 30")));
});

test("validation rejects unknown categories, non-HTTPS URLs and bad prompts", async () => {
  const errors = await mutated({
    manifest: (m) => {
      ui(m).category = "Crypto";
      ui(m).privacyPolicyURL = "http://www.webacy.com/privacy-policy";
      delete ui(m).termsOfServiceURL;
      ui(m).defaultPrompt = ["a", "a", "@webacy check this", "d"];
    },
  });
  for (const expected of [
    'category "Crypto"',
    "privacyPolicyURL is required for MCP review and must be HTTPS",
    "termsOfServiceURL is required",
    "defaultPrompt: max 3",
    "must be unique",
    "must not @mention",
  ])
    assert.ok(errors.some((e) => e.includes(expected)), `missing: ${expected}\n${errors.join("\n")}`);
});

test("validation enforces brand color contrast", async () => {
  const errors = await mutated({
    manifest: (m) => {
      ui(m).brandColor = "#F0F0F0";
      ui(m).brandColorDark = "#222222";
    },
  });
  assert.ok(errors.some((e) => e.includes("brandColor needs at least 2:1 contrast against white")));
  assert.ok(errors.some((e) => e.includes("brandColorDark needs at least 2:1")));
});

test("validation requires exactly 5 positive and 3 negative review cases with known tools", async () => {
  const errors = await mutated({
    manifest: (m) => {
      const cases = m.extensions["com.openai"].review.test_cases;
      cases.positive.pop();
      cases.positive[0].tools_triggered = "get_address_risk, transfer_funds";
      cases.negative.push({ description: "extra", prompt: "extra" });
    },
  });
  assert.ok(errors.some((e) => e.includes("positive needs exactly 5 cases, has 4")));
  assert.ok(errors.some((e) => e.includes("negative needs exactly 3 cases, has 4")));
  assert.ok(errors.some((e) => e.includes("unknown tool transfer_funds")));
});

test("validation rejects secrets, headers, API-key auth and app configuration", async () => {
  const errors = await mutated({
    mcp: (m) => {
      server(m).headers = { "x-api-key": "abc" };
      server(m).extensions["com.openai"].auth = { type: "api_key", clientSecret: "s" };
    },
    files: (files) => files.set(".app.json", Buffer.from("{}")),
  });
  for (const expected of [
    "must not declare headers",
    "auth.type must be oauth",
    '"clientSecret" is not allowed',
    "mentions x-api-key",
    "app configuration is not allowed",
  ])
    assert.ok(errors.some((e) => e.includes(expected)), `missing: ${expected}\n${errors.join("\n")}`);
});

test("validation rejects unsafe archive paths and missing or non-square icons", async () => {
  const notSquare = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(notSquare);
  notSquare.write("IHDR", 12, "latin1");
  notSquare.writeUInt32BE(100, 16);
  notSquare.writeUInt32BE(50, 20);
  const errors = await mutated({
    manifest: (m) => {
      ui(m).composerIcon = "./assets/missing.png";
    },
    files: (files) => {
      files.set("assets/logo.png", notSquare);
      files.set("skills/../evil.md", Buffer.from("x"));
    },
  });
  assert.ok(errors.some((e) => e.includes("must be square, got 100x50")));
  assert.ok(errors.some((e) => e.includes("missing file ./assets/missing.png")));
  assert.ok(errors.some((e) => e.includes("empty, . or .. segment")));
});

test("validation rejects a skill whose name does not match its directory", async () => {
  const errors = await mutated({
    files: (files) => files.set("skills/other/SKILL.md", Buffer.from("---\nname: webacy\ndescription: d\n---\nbody\n")),
  });
  assert.ok(errors.some((e) => e.includes('skills/other/SKILL.md name must be "other"')));
});

test("parseFrontmatter handles folded and plain scalars", () => {
  const fm = parseFrontmatter("---\nname: 'a'\ndescription: >-\n  one\n  two\n---\nbody\n");
  assert.deepEqual(fm.data, { name: "a", description: "one two" });
  assert.equal(fm.body, "body\n");
  assert.equal(parseFrontmatter("no frontmatter"), null);
});

test("contrastRatio and pngSize", async () => {
  assert.equal(Math.round(contrastRatio("#000000", "#FFFFFF")), 21);
  assert.equal(contrastRatio("#123456", "#123456"), 1);
  const logo = await readFile(join(ROOT, "src/chatgpt-plugin/assets/logo.png"));
  assert.deepEqual(pngSize(logo), { width: 200, height: 200 });
  assert.equal(pngSize(Buffer.from("not a png")), null);
});

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("createZip round-trips and is deterministic", () => {
  const files = new Map([
    ["b.txt", Buffer.from("hello ".repeat(100))],
    ["a/c.bin", Buffer.from([0, 1, 2, 3])],
  ]);
  const zip = createZip(files);
  assert.ok(zip.equals(createZip(files)));
  const back = readZip(zip);
  assert.deepEqual([...back.keys()], ["a/c.bin", "b.txt"]);
  for (const [k, v] of files) assert.ok(back.get(k).equals(v));
});

test("build script writes a valid ZIP with the plugin at the archive root", async () => {
  const out = await mkdtemp(join(tmpdir(), "chatgpt-plugin-"));
  try {
    await execFileAsync(process.execPath, [join(ROOT, "scripts/build-chatgpt-plugin.mjs")], {
      env: { ...process.env, CHATGPT_PLUGIN_OUT_DIR: out },
    });
    const files = readZip(await readFile(join(out, "webacy-chatgpt-plugin.zip")));
    assert.ok(files.has("plugin.json"));
    assert.deepEqual(validatePackage(files), []);
    const unpacked = await readFile(join(out, "chatgpt-plugin", "plugin.json"));
    assert.ok(unpacked.equals(files.get("plugin.json")));
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
