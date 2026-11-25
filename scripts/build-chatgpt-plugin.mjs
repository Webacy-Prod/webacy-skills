#!/usr/bin/env node
// Builds the Webacy ChatGPT plugin ZIP for upload at platform.openai.com/plugins.
//
// Package format: OpenAI's portable "Agent Plugins" layout (root plugin.json +
// mcp.json + skills/ + assets/), the format OpenAI's submission docs recommend:
// https://developers.openai.com/plugins/deploy/submission
//
// Sources (hand-edited): src/chatgpt-plugin/{plugin.json,mcp.json,connect.md,assets/}
// and src/meta.yml. The skill body (guide + synced tools table) is taken from the
// generated skills/webacy/SKILL.md, so the plugin follows the weekly tool sync
// without a network call or API key. The x-api-key "How to connect" section is
// replaced by connect.md: in ChatGPT the user connects with OAuth.
//
// Every package is checked against OpenAI's documented upload and submission
// rules before the ZIP is written; any violation fails the build.
//
// Output: dist/chatgpt-plugin/ (unpacked, for inspection) and
// dist/webacy-chatgpt-plugin.zip. Override the directory with CHATGPT_PLUGIN_OUT_DIR.
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import Ajv2020 from "ajv/dist/2020.js";
import { fail } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...parts) => join(ROOT, ...parts);

const ZIP_NAME = "webacy-chatgpt-plugin.zip";
const MCP_ENDPOINT = "https://api.webacy.com/mcp";
const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const GUIDE_HEADING = "# Webacy risk engine";

// The public Agent Plugins schemas, vendored from the $schema URLs above so the
// check runs offline. To refresh: download both URLs into schemas/agent-plugins/1.0.0/.
const ajv = new Ajv2020({ allErrors: true, strict: false });
const loadSchema = (name) =>
  ajv.compile(JSON.parse(readFileSync(p("schemas", "agent-plugins", "1.0.0", name), "utf8")));
const validatePluginSchema = loadSchema("plugin.schema.json");
const validateMcpSchema = loadSchema("mcp.schema.json");

// Report ajv errors as "<file><path> <message>" lines.
const schemaErrors = (file, errors) =>
  (errors ?? []).map((e) => `${file}${e.instancePath || ""} fails the Agent Plugins schema: ${e.message}`);

// Category titles accepted by the dashboard. Copied by hand: last checked 2026-11-25
// against https://developers.openai.com/plugins/deploy/submission. If the portal
// rejects a value, the portal wins: update this list.
const CATEGORIES = new Set([
  "Productivity",
  "Creativity",
  "Developer Tools",
  "Business & Operations",
  "Data & Analytics",
  "Communication",
  "Education & Research",
  "Security",
  "Finance",
  "Healthcare",
  "Travel",
  "Entertainment",
  "Other",
]);

// Upload limits. Copied by hand: last checked 2026-11-25 against
// https://developers.openai.com/plugins/deploy/submission-errors.
const LIMITS = {
  zipBytes: 100 * 1024 * 1024,
  unpackedBytes: 512 * 1024 * 1024,
  entries: 5000,
  pathSegments: 20,
  imageBytes: 5 * 1024 * 1024,
};

// Keys the upload rejects anywhere in the manifests: secrets belong in the portal.
const FORBIDDEN_KEYS = new Set(["clientSecret", "test_credentials", "reviewer_instructions"]);

// ---------------------------------------------------------------------------
// Small parsers

// Parse the YAML frontmatter subset our skills use: `key: value` scalars and
// folded block scalars (`key: >-` followed by indented lines). Returns
// { data, body } or null when the text has no frontmatter.
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const data = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const [, key, raw] = kv;
    if (/^[>|][-+]?$/.test(raw)) {
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      data[key] = raw.startsWith(">") ? parts.join(" ") : parts.join("\n");
    } else {
      data[key] = raw.replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  return { data, body: m[2] };
}

// Width and height of a PNG from its IHDR chunk, or null if not a PNG.
function pngSize(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) return null;
  if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// WCAG relative luminance contrast ratio between two #RRGGBB colors.
function contrastRatio(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Tool names listed in a skill's generated tools table (`| \`name\` | ... |`).
function toolsFromSkill(skillText) {
  return [...skillText.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// ZIP writer/reader (deflate or stored per entry, no dependencies, deterministic)

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Write a ZIP of regular files. `files` is a Map of archive path -> Buffer.
// Entries are sorted and stamped 1980-01-01 so identical input gives identical bytes.
function createZip(files) {
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of [...files.keys()].sort()) {
    const data = files.get(name);
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// Read a ZIP written by createZip (or any ZIP without ZIP64/encryption) back
// into a Map of path -> Buffer, verifying every CRC. Used by tests and by the
// build's own post-write check.
function readZip(zip) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1) throw new Error("not a zip: no end of central directory");
  const count = zip.readUInt16LE(eocd + 10);
  let ptr = zip.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(ptr) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = zip.readUInt16LE(ptr + 10);
    const crc = zip.readUInt32LE(ptr + 16);
    const compSize = zip.readUInt32LE(ptr + 20);
    const nameLen = zip.readUInt16LE(ptr + 28);
    const extraLen = zip.readUInt16LE(ptr + 30);
    const commentLen = zip.readUInt16LE(ptr + 32);
    const localOffset = zip.readUInt32LE(ptr + 42);
    const name = zip.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = zip.subarray(start, start + compSize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if (crc32(data) !== crc) throw new Error(`crc mismatch for ${name}`);
    files.set(name, data);
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ---------------------------------------------------------------------------
// Validation against OpenAI's documented rules. Returns a list of problems;
// an empty list means the package is ready to upload.

function validatePackage(files) {
  const errors = [];
  const err = (msg) => errors.push(msg);
  const text = (path) => files.get(path)?.toString("utf8");
  const isHttps = (u) => {
    try {
      const url = new URL(u);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  };
  const checkLen = (label, value, max, required = true) => {
    if (value === undefined || value === null || value === "") {
      if (required) err(`${label} is required`);
      return;
    }
    if (typeof value !== "string") return err(`${label} must be a string`);
    if (value.length > max) err(`${label} is ${value.length} characters, max ${max}`);
  };

  // Archive shape.
  let unpacked = 0;
  if (files.size > LIMITS.entries) err(`${files.size} entries, max ${LIMITS.entries}`);
  for (const [path, data] of files) {
    unpacked += data.length;
    const segments = path.split("/");
    if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path))
      err(`path ${path} must be relative and use /`);
    if (segments.some((s) => s === "" || s === "." || s === ".."))
      err(`path ${path} has an empty, . or .. segment`);
    if (segments.length > LIMITS.pathSegments)
      err(`path ${path} has more than ${LIMITS.pathSegments} segments`);
    const base = segments[segments.length - 1];
    if (base === ".app.json") err(`${path}: app configuration is not allowed in a ZIP upload`);
    if (segments[0] === ".codex-plugin")
      err(`${path}: .codex-plugin is ignored when plugin.json declares extensions.com.openai`);
    if (segments[0] === "hooks" || base === "hooks.json")
      err(`${path}: lifecycle hooks are not allowed`);
  }
  if (unpacked > LIMITS.unpackedBytes) err(`unpacked size ${unpacked} exceeds 512 MiB`);

  // No credentials anywhere. ChatGPT connects with OAuth, so the API-key header
  // must not even be mentioned (it would also mean the connect section leaked in).
  for (const [path, data] of files) {
    if (/\.(png|jpe?g|webp)$/i.test(path)) continue;
    const body = data.toString("utf8");
    if (/x-api-key/i.test(body)) err(`${path} mentions x-api-key; ChatGPT uses OAuth`);
    if (/YOUR_API_KEY|Bearer\s+[A-Za-z0-9._~+/-]{8,}|sk-[A-Za-z0-9]{16,}/.test(body))
      err(`${path} looks like it contains a credential or key placeholder`);
  }
  const walkKeys = (label, value) => {
    if (Array.isArray(value)) return value.forEach((v) => walkKeys(label, v));
    if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(k)) err(`${label}: "${k}" is not allowed in the package`);
        walkKeys(label, v);
      }
  };

  // plugin.json
  let manifest;
  try {
    manifest = JSON.parse(text("plugin.json") ?? "");
  } catch {
    err("plugin.json is missing or not valid JSON");
    return errors;
  }
  walkKeys("plugin.json", manifest);
  if (manifest.$schema !== PLUGIN_SCHEMA) err(`plugin.json $schema must be ${PLUGIN_SCHEMA}`);
  if (!validatePluginSchema(manifest))
    errors.push(...schemaErrors("plugin.json", validatePluginSchema.errors));
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.name ?? "") || manifest.name.length > 64)
    err("plugin.json name must be lowercase letters, numbers and hyphens, max 64");
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(manifest.version ?? ""))
    err("plugin.json version must be a semantic version");
  checkLen("plugin.json description", manifest.description, 1024);
  checkLen("plugin.json author.name", manifest.author?.name, 120);
  if (manifest.author?.url && !isHttps(manifest.author.url)) err("author.url must be HTTPS");
  if ((manifest.keywords ?? []).length > 25) err("plugin.json keywords: max 25");

  const ext = manifest.extensions?.["com.openai"];
  if (!ext) {
    err('plugin.json needs extensions["com.openai"]');
    return errors;
  }
  const ui = ext.interface ?? {};
  checkLen("interface.displayName", ui.displayName, 30);
  checkLen("interface.shortDescription", ui.shortDescription, 30);
  checkLen("interface.longDescription", ui.longDescription, 4000);
  checkLen("interface.developerName", ui.developerName, 80);
  if (!CATEGORIES.has(ui.category)) err(`interface.category "${ui.category}" is not a dashboard category`);
  const caps = ui.capabilities ?? [];
  if (caps.length > 20) err("interface.capabilities: max 20");
  caps.forEach((c, i) => checkLen(`interface.capabilities[${i}]`, c, 120));
  for (const key of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
    if (!isHttps(ui[key])) err(`interface.${key} is required for MCP review and must be HTTPS`);
    else if (ui[key].length > 1024) err(`interface.${key}: max 1024 characters`);
  }
  const prompts = [].concat(ui.defaultPrompt ?? []);
  if (prompts.length > 3) err("interface.defaultPrompt: max 3");
  if (new Set(prompts).size !== prompts.length) err("interface.defaultPrompt entries must be unique");
  prompts.forEach((pr, i) => {
    checkLen(`interface.defaultPrompt[${i}]`, pr, 128);
    if (/@\w/.test(pr)) err(`interface.defaultPrompt[${i}] must not @mention an app`);
  });
  for (const [key, against, label] of [
    ["brandColor", "#FFFFFF", "white"],
    ["brandColorDark", "#212121", "#212121"],
  ]) {
    if (ui[key] === undefined) continue;
    if (!/^#[0-9A-Fa-f]{6}$/.test(ui[key])) err(`interface.${key} must be #RRGGBB`);
    else if (contrastRatio(ui[key], against) < 2)
      err(`interface.${key} needs at least 2:1 contrast against ${label}`);
  }
  for (const key of ["logo", "composerIcon", "logoDark", "composerIconDark"]) {
    const ref = ui[key];
    if (ref === undefined) {
      if (key === "logo" || key === "composerIcon") err(`interface.${key} is required`);
      continue;
    }
    if (!ref.startsWith("./")) {
      err(`interface.${key} must be a ./-relative path`);
      continue;
    }
    const img = files.get(ref.slice(2));
    if (!img) {
      err(`interface.${key} points to missing file ${ref}`);
      continue;
    }
    if (img.length > LIMITS.imageBytes) err(`${ref} is larger than 5 MiB`);
    const size = pngSize(img);
    if (!size) err(`${ref} must be a PNG (the build only checks PNG dimensions)`);
    else if (size.width !== size.height) err(`${ref} must be square, got ${size.width}x${size.height}`);
    else if (size.width < 48 || size.width > 4096) err(`${ref} must be 48 to 4096 px, got ${size.width}`);
  }

  // Skills: immediate children of skills/, each with a valid SKILL.md.
  const skillDirs = new Set(
    [...files.keys()].filter((f) => f.startsWith("skills/")).map((f) => f.split("/")[1]),
  );
  if (skillDirs.size === 0) err("the plugin needs at least one skill in skills/");
  const tools = new Set();
  for (const dir of skillDirs) {
    if (dir.startsWith(".")) err(`skills/${dir} must not be hidden`);
    const skill = text(`skills/${dir}/SKILL.md`);
    if (!skill) {
      err(`skills/${dir}/SKILL.md is missing`);
      continue;
    }
    const fm = parseFrontmatter(skill);
    if (!fm) {
      err(`skills/${dir}/SKILL.md needs YAML frontmatter`);
      continue;
    }
    if (fm.data.name !== dir) err(`skills/${dir}/SKILL.md name must be "${dir}"`);
    checkLen(`skills/${dir} description`, fm.data.description, 1024);
    if (!fm.body.trim()) err(`skills/${dir}/SKILL.md body is empty`);
    if (`${manifest.name}:${dir}`.length > 64) err(`${manifest.name}:${dir} is longer than 64 characters`);
    toolsFromSkill(skill).forEach((t) => tools.add(t));
  }

  // mcp.json: one remote server, OAuth, no headers or secrets.
  let mcp;
  try {
    mcp = JSON.parse(text("mcp.json") ?? "");
  } catch {
    err("mcp.json is missing or not valid JSON");
    return errors;
  }
  walkKeys("mcp.json", mcp);
  if (mcp.$schema !== MCP_SCHEMA) err(`mcp.json $schema must be ${MCP_SCHEMA}`);
  // The public schema closes each server object (additionalProperties: false), but
  // OpenAI's docs put auth in a server-level extensions["com.openai"] block and show
  // it next to this same $schema:
  // https://developers.openai.com/plugins/build/plugins#configure-mcp-authentication
  // So check everything else against the schema with that one block removed; the
  // auth checks below cover the block itself.
  for (const [name, server] of Object.entries(mcp.mcpServers ?? {})) {
    const extKeys = Object.keys(server?.extensions ?? {});
    if (extKeys.some((k) => k !== "com.openai"))
      err(`mcp.json ${name}.extensions may only hold "com.openai", found ${extKeys.join(", ")}`);
  }
  const mcpForSchema = structuredClone(mcp);
  for (const server of Object.values(mcpForSchema.mcpServers ?? {}))
    if (server && typeof server === "object") delete server.extensions;
  if (!validateMcpSchema(mcpForSchema)) errors.push(...schemaErrors("mcp.json", validateMcpSchema.errors));
  const servers = Object.entries(mcp.mcpServers ?? {});
  if (servers.length !== 1) err(`mcp.json must declare exactly one server, found ${servers.length}`);
  for (const [name, server] of servers) {
    if (server.url !== MCP_ENDPOINT) err(`mcp.json ${name}.url must be ${MCP_ENDPOINT}`);
    if (server.type !== "streamable-http") err(`mcp.json ${name}.type must be streamable-http`);
    if (server.headers && Object.keys(server.headers).length)
      err(`mcp.json ${name} must not declare headers`);
    const auth = server.extensions?.["com.openai"]?.auth;
    if (auth?.type !== "oauth" && auth?.type !== "mixed")
      err(`mcp.json ${name} auth.type must be oauth (the portal has no API-key flow)`);
    // client rules from the OAuth configuration reference:
    // https://developers.openai.com/plugins/build/plugins#oauth-configuration-reference
    if (auth?.client !== undefined) {
      const client = auth.client;
      if (!client || typeof client !== "object" || Array.isArray(client))
        err(`mcp.json ${name} auth.client must be an object`);
      else if (!["provided", "dcr", "cimd"].includes(client.mode))
        err(`mcp.json ${name} auth.client.mode must be provided, dcr or cimd when client is present`);
      else if (client.mode === "provided" && !client.clientId)
        err(`mcp.json ${name}: a provided client needs clientId`);
      else if (client.mode !== "provided" && client.clientId)
        err(`mcp.json ${name}: a ${client.mode} client must not set clientId`);
    }
  }

  // Review cases: exactly 5 positive and 3 negative for initial MCP review.
  const cases = ext.review?.test_cases;
  const positive = cases?.positive ?? [];
  const negative = cases?.negative ?? [];
  if (positive.length !== 5) err(`review.test_cases.positive needs exactly 5 cases, has ${positive.length}`);
  if (negative.length !== 3) err(`review.test_cases.negative needs exactly 3 cases, has ${negative.length}`);
  positive.forEach((c, i) => {
    for (const key of ["description", "prompt", "tools_triggered", "expected_behavior"])
      if (!c?.[key]) err(`review.test_cases.positive[${i}].${key} is required`);
    for (const tool of String(c?.tools_triggered ?? "").split(/\s*,\s*/).filter(Boolean))
      if (!tools.has(tool)) err(`review.test_cases.positive[${i}] names unknown tool ${tool}`);
  });
  negative.forEach((c, i) => {
    for (const key of ["description", "prompt"])
      if (!c?.[key]) err(`review.test_cases.negative[${i}].${key} is required`);
  });
  if (ext.review?.commerce !== undefined && typeof ext.review.commerce !== "boolean")
    err("review.commerce must be a boolean");
  if (ext.onboardingSkill && !files.has(ext.onboardingSkill.replace(/^\.\//, "")))
    err("onboardingSkill must point to an included SKILL.md");

  return errors;
}

// ---------------------------------------------------------------------------
// Assembly

// Build the ChatGPT skill: meta.yml frontmatter + the guide section (with the
// synced tools table) of the generated skill + ChatGPT connection notes.
function buildSkill(metaRaw, connect, generatedSkill) {
  const start = generatedSkill.indexOf(GUIDE_HEADING);
  if (start === -1) throw new Error(`skills/webacy/SKILL.md has no "${GUIDE_HEADING}" section`);
  const guide = generatedSkill.slice(start).trim();
  return `---\n${metaRaw.trim()}\n---\n\n${guide}\n\n${connect.trim()}\n`;
}

// List regular files under dir, skipping dotfiles (.DS_Store and the like) so
// editor and OS litter never ships in the ZIP.
async function listFiles(dir, prefix = "") {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(join(dir, entry.name), rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

async function assemble() {
  const src = (...parts) => p("src", "chatgpt-plugin", ...parts);
  const files = new Map();
  files.set("plugin.json", await readFile(src("plugin.json")));
  files.set("mcp.json", await readFile(src("mcp.json")));
  for (const rel of await listFiles(src("assets")))
    files.set(`assets/${rel}`, await readFile(src("assets", rel)));
  const skill = buildSkill(
    await readFile(p("src", "meta.yml"), "utf8"),
    await readFile(src("connect.md"), "utf8"),
    await readFile(p("skills", "webacy", "SKILL.md"), "utf8"),
  );
  files.set("skills/webacy/SKILL.md", Buffer.from(skill, "utf8"));
  return files;
}

async function main() {
  const outDir = process.env.CHATGPT_PLUGIN_OUT_DIR || p("dist");
  const files = await assemble();
  const errors = validatePackage(files);
  if (errors.length) fail(`ChatGPT plugin is not valid:\n  - ${errors.join("\n  - ")}`);

  const zip = createZip(files);
  if (zip.length > LIMITS.zipBytes) fail(`ZIP is ${zip.length} bytes, max 100 MB`);
  const roundTrip = readZip(zip);
  if (roundTrip.size !== files.size) fail("ZIP round-trip lost entries");

  const unpackedDir = join(outDir, "chatgpt-plugin");
  await rm(unpackedDir, { recursive: true, force: true });
  for (const [path, data] of files) {
    await mkdir(dirname(join(unpackedDir, path)), { recursive: true });
    await writeFile(join(unpackedDir, path), data);
  }
  const zipPath = join(outDir, ZIP_NAME);
  await writeFile(zipPath, zip);
  console.log(`wrote: ${zipPath} (${files.size} files, ${zip.length} bytes)`);
}

const invokedDirectly =
  process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => fail(e.stack || String(e)));
}

export {
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
};
