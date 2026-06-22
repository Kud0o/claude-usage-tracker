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

const args = new Set(process.argv.slice(2));
const explicitScope = args.has("--local") ? "local" : args.has("--global") ? "global" : null;
const uninstall = args.has("--uninstall");
const scope = explicitScope || "global"; // bare invocation installs globally

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
}

function addHook(file) {
  const s = readJson(file);
  s.hooks = s.hooks || {};
  s.hooks.Stop = s.hooks.Stop || [];
  const exists = JSON.stringify(s.hooks.Stop).includes(MARKER);
  if (exists) {
    console.log(`  • hook already present in ${file}`);
  } else {
    s.hooks.Stop.push({ hooks: [{ type: "command", command: HOOK_CMD }] });
    writeJson(file, s);
    console.log(`  • registered Stop hook in ${file}`);
  }
}

function removeHook(file) {
  const s = readJson(file);
  if (!s.hooks || !Array.isArray(s.hooks.Stop)) {
    console.log(`  • no Stop hooks in ${file}`);
    return;
  }
  const before = s.hooks.Stop.length;
  s.hooks.Stop = s.hooks.Stop.filter((g) => !JSON.stringify(g).includes(MARKER));
  if (s.hooks.Stop.length === 0) delete s.hooks.Stop;
  if (s.hooks && Object.keys(s.hooks).length === 0) delete s.hooks;
  writeJson(file, s);
  console.log(`  • removed ${before - (s.hooks?.Stop?.length || 0)} hook(s) from ${file}`);
}

function help() {
  console.log(`Claude Code Usage Tracker — installer

  npx -y github:Kud0o/claude-usage-tracker   one-line install (no clone needed)

  node install.mjs               install globally — track every workspace
  node install.mjs --local       track this project only
  node install.mjs --uninstall   remove the hook

After installing, start (or continue) any Claude Code session — each prompt is
recorded into that project's own  .claude-usage/  folder, which holds the data,
its own copy of the viewer, and a config.json of your saved view settings.

View a project (after its first prompt):

  cd <your project> && node .claude-usage/viewer/server.mjs   →  http://localhost:4317

Add  .claude-usage/  to the project's .gitignore. To pool every project into one
shared dashboard instead, set CLAUDE_USAGE_DIR (on the hook + the viewer).
`);
}

if (args.has("--help") || args.has("-h")) {
  help();
} else if (uninstall) {
  console.log("Uninstalling usage tracker hook…");
  removeHook(settingsPath(scope));
  if (!explicitScope) removeHook(settingsPath("local"));
  console.log("Done. (app left in ~/.claude/usage-tracker — delete manually if desired.)");
} else {
  console.log(`Installing usage tracker (${scope})…`);
  copyApp();
  console.log(`  • copied app to ${APP}`);
  addHook(settingsPath(scope));
  console.log(`\nDone. Each project records into its own  .claude-usage/  folder`);
  console.log(`(data + a bundled viewer + saved view config). After a project's first prompt:\n`);
  console.log(`  cd <your project> && node .claude-usage/viewer/server.mjs   →  http://localhost:4317`);
  console.log(`  (tip: add  .claude-usage/  to that project's .gitignore)\n`);
}
