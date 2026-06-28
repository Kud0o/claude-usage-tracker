#!/usr/bin/env node
// Installer for the Claude Code usage tracker.
//
//   node install.mjs --global     register the Stop hook for ALL workspaces (~/.claude/settings.json)
//   node install.mjs --local      register only for this project (./.claude/settings.local.json)
//   node install.mjs --uninstall  remove the hook (add --global/--local to pick which file)
//
// Copies the app into ~/.claude/usage-tracker/app and points the hook there,
// so the tracker keeps working even if this repo moves. Existing settings keys
// are preserved.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const APP = path.join(HOME, ".claude", "usage-tracker", "app");
const HOOK_CMD = `node "${path.join(APP, "src", "record.mjs")}"`;
const MARKER = "usage-tracker"; // identifies our hook for idempotency / uninstall

// ---- console styling (zero-dep ANSI; auto-off when not a TTY or NO_COLOR) ----
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : `${s}`);
const bold = sgr(1), dim = sgr(2), green = sgr("32;1"), red = sgr("31;1"), cyan = sgr(36), gray = sgr(90);
const ok = (msg) => console.log(`  ${green("✓")} ${msg}`);
const skip = (msg) => console.log(`  ${gray("•")} ${dim(msg)}`);
const fail = (msg) => console.log(`  ${red("✗")} ${msg}`);
const cmd = (s) => cyan(s);
const rule = () => console.log(gray("  ────────────────────────────────────────────"));
function banner(subtitle) {
  console.log();
  console.log(`  ${bold(cyan("Claude Usage Tracker"))}  ${dim("·")}  ${dim(subtitle)}`);
  rule();
}

const args = new Set(process.argv.slice(2));
const explicitScope = args.has("--local") ? "local" : args.has("--global") ? "global" : null;
const uninstall = args.has("--uninstall");
const update = args.has("--update");
const scope = explicitScope || "global"; // bare invocation installs globally
const VERSION = readJson(path.join(REPO, "package.json")).version || "0";

function settingsPath(scope) {
  return scope === "local"
    ? path.join(process.cwd(), ".claude", "settings.local.json")
    : path.join(HOME, ".claude", "settings.json");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

function copyApp() {
  fs.rmSync(APP, { recursive: true, force: true });
  fs.mkdirSync(APP, { recursive: true });
  fs.cpSync(path.join(REPO, "src"), path.join(APP, "src"), { recursive: true });
  fs.cpSync(path.join(REPO, "viewer"), path.join(APP, "viewer"), { recursive: true });
  // The per-project bundle ships viewer/ only (no src/). Copy the self-contained
  // global-config module next to the viewer so the bundled server can import it.
  fs.cpSync(path.join(REPO, "src", "lib", "config.mjs"), path.join(APP, "viewer", "config.mjs"));
}

const FIELD_GROUPS = ["text", "tokens", "cost", "context", "timing", "skills", "counts", "meta"];
function allFields() {
  const f = {};
  for (const g of FIELD_GROUPS) f[g] = true;
  return f;
}
function globalDefaults() {
  const file = path.join(HOME, ".claude", "usage-tracker", "config.json");
  let c = readJson(file);
  const fields = allFields();
  if (c.fields && typeof c.fields === "object") for (const g of FIELD_GROUPS) if (typeof c.fields[g] === "boolean") fields[g] = c.fields[g];
  return { enabledDefault: typeof c.enabledDefault === "boolean" ? c.enabledDefault : true, fields };
}

// Create the global defaults TEMPLATE (~/.claude/usage-tracker/config.json) the
// first time only — projects inherit a copy of it. Never overwrite user edits.
function seedGlobalConfig() {
  const file = path.join(HOME, ".claude", "usage-tracker", "config.json");
  if (fs.existsSync(file)) return file;
  const cfg = { schema: 2, enabledDefault: true, fields: allFields() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return file;
}

// A --local install makes the project self-contained: write its tracking + field
// config into <cwd>/.claude-usage/config.json (enabled, seeded from global), so it
// records immediately without relying on the global template.
function seedProjectConfig(cwd) {
  const base = path.join(cwd, ".claude-usage");
  const file = path.join(base, "config.json");
  const def = globalDefaults();
  const c = readJson(file);
  if (!c.title) c.title = path.basename(cwd);
  if (typeof c.port !== "number") c.port = 4317;
  if (!c.ui || typeof c.ui !== "object") c.ui = {};
  c.tracking = { enabled: true, ...(c.tracking || {}) };
  c.fields = { ...def.fields, ...(c.fields || {}) };
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n");
  return file;
}

function addHook(file) {
  const s = readJson(file);
  s.hooks = s.hooks || {};
  s.hooks.Stop = s.hooks.Stop || [];
  const exists = JSON.stringify(s.hooks.Stop).includes(MARKER);
  if (exists) {
    skip(`Stop hook already registered  ${gray(file)}`);
  } else {
    s.hooks.Stop.push({ hooks: [{ type: "command", command: HOOK_CMD }] });
    writeJson(file, s);
    ok(`registered Stop hook  ${gray(file)}`);
  }
}

function removeHook(file) {
  const s = readJson(file);
  if (!s.hooks || !Array.isArray(s.hooks.Stop)) {
    skip(`no hooks found  ${gray(file)}`);
    return;
  }
  const before = s.hooks.Stop.length;
  s.hooks.Stop = s.hooks.Stop.filter((g) => !JSON.stringify(g).includes(MARKER));
  const removed = before - s.hooks.Stop.length;
  if (s.hooks.Stop.length === 0) delete s.hooks.Stop;
  if (s.hooks && Object.keys(s.hooks).length === 0) delete s.hooks;
  writeJson(file, s);
  if (removed) ok(`removed ${removed} hook(s)  ${gray(file)}`);
  else skip(`no matching hook  ${gray(file)}`);
}

function help() {
  banner("installer");
  console.log();
  console.log(`  ${bold("Usage")}`);
  console.log(`    ${cmd("npx -y github:Kud0o/claude-usage-tracker")}   ${dim("one-line install")}`);
  console.log(`    ${cmd("node install.mjs")}              ${dim("install globally — every workspace")}`);
  console.log(`    ${cmd("node install.mjs --local")}      ${dim("this project only")}`);
  console.log(`    ${cmd("node install.mjs --update")}     ${dim("refresh app to the latest version")}`);
  console.log(`    ${cmd("node install.mjs --uninstall")}  ${dim("remove the hook")}`);
  console.log();
  console.log(`  ${bold("View a project")}  ${dim("(after its first prompt)")}`);
  console.log(`    ${cmd("node .claude-usage/viewer/server.mjs")}   ${dim("→ http://localhost:4317")}`);
  console.log();
  console.log(dim(`  Each project records into its own  .claude-usage/  folder (data + a`));
  console.log(dim(`  bundled viewer + saved settings). Add it to the project's .gitignore.`));
  console.log(dim(`  Set CLAUDE_USAGE_DIR to pool every project into one shared dashboard.`));
  console.log();
}

if (args.has("--help") || args.has("-h")) {
  help();
} else if (update) {
  banner("update");
  console.log();
  copyApp();
  ok(`updated app to v${VERSION}  ${gray(APP)}`);
  addHook(settingsPath(scope)); // ensure the hook exists; no-op if already there
  const gc = seedGlobalConfig();
  skip(`config  ${gray(gc)}`);
  console.log();
  console.log(`  ${green("✓")} ${bold("Up to date.")} ${dim("Open projects refresh their viewer on the next prompt.")}`);
  console.log();
} else if (uninstall) {
  banner("uninstall");
  console.log();
  removeHook(settingsPath(scope));
  if (!explicitScope) removeHook(settingsPath("local"));
  console.log();
  console.log(`  ${bold("Done.")}`);
  console.log(dim(`  App + recorded data left in  ~/.claude/usage-tracker  — delete manually if desired.`));
  console.log();
} else {
  banner(`install · ${scope}`);
  console.log();
  copyApp();
  ok(`copied app v${VERSION}  ${gray(APP)}`);
  addHook(settingsPath(scope));
  const gc = seedGlobalConfig();
  ok(`global defaults  ${gray(gc)}`);
  if (scope === "local") {
    const pc = seedProjectConfig(process.cwd());
    ok(`project config  ${gray(pc)}`);
    console.log();
    console.log(`  ${green("✓")} ${bold("This project is tracked.")} ${dim("Its config lives in the folder; tune it in ⚙ settings.")}`);
  } else {
    console.log();
    console.log(`  ${green("✓")} ${bold("Tracking on by default.")} ${dim("Each project inherits an editable copy of the global defaults.")}`);
    console.log(dim(`  Disable or tune a project from its dashboard ⚙ settings (writes that project's config).`));
  }
  console.log();
  console.log(`  ${bold("View a project")}  ${dim("(after its first prompt)")}`);
  console.log(`    ${cmd("cd <your project>")}`);
  console.log(`    ${cmd("node .claude-usage/viewer/server.mjs")}   ${dim("→ http://localhost:4317")}`);
  console.log();
  console.log(dim(`  Tip: add  .claude-usage/  to that project's .gitignore.`));
  console.log();
}
