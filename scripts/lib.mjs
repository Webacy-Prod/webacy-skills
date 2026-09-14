#!/usr/bin/env node
// Pure helpers shared by scripts/build.mjs and scripts/build-x402.mjs. No
// network or process-exit side effects apart from `fail` (which is meant to
// halt a generator script) and `writeIfChanged` (file I/O).
import { readFile, writeFile } from "node:fs/promises";

function fail(msg) {
  console.error(`build: ${msg}`);
  process.exit(1);
}

// Render a name as an inline code span safe inside a markdown table cell.
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
function renderDescription(description, maxLength = 300) {
  const clean = String(description ?? "").replace(/\s+/g, " ").trim();
  const capped =
    clean.length > maxLength
      ? `${clean.slice(0, maxLength - 1).trimEnd()}…`
      : clean;
  return capped
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`");
}

// Build a markdown table from a header row and pre-rendered data rows (each
// row already a full "| a | b |" string).
function renderTable(headers, rows) {
  const headerRow = `| ${headers.join(" | ")} |`;
  const sepRow = `| ${headers.map(() => "---").join(" | ")} |`;
  return [headerRow, sepRow, ...rows].join("\n");
}

// Replace the content between startMarker and endMarker (both kept) with
// `${startMarker}\n${block}\n${endMarker}`. Throws if either marker is missing
// or out of order.
function injectBetweenMarkers(text, startMarker, endMarker, block) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start)
    throw new Error(`missing markers ${startMarker} / ${endMarker}`);
  const before = text.slice(0, start);
  const after = text.slice(end + endMarker.length);
  return `${before}${startMarker}\n${block}\n${endMarker}${after}`;
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

export {
  fail,
  renderName,
  renderDescription,
  renderTable,
  injectBetweenMarkers,
  writeIfChanged,
};
