#!/usr/bin/env node
// Claude Code `Stop` hook: after each response, re-derive this session's turns
// from the transcript and upsert them into the shared per-workspace ndjson.
//
// Robustness contract: never block Claude. Everything is wrapped in try/catch,
// nothing is written to stdout, and the process always exits 0.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTurns } from "./lib/transcript.mjs";
import { upsertSession } from "./lib/store.mjs";
import {
  workspaceFile,
  workspaceLabel,
  settingsCandidates,
  deriveTranscriptPath,
} from "./lib/paths.mjs";
import { ensureProjectConfig, isEnabled, applyFieldSelection } from "./lib/config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bump when the bundled viewer changes so existing projects refresh their copy
// on the next prompt (after the user re-installs the app via npx). Keep in step
// with viewer changes.
const VIEWER_VERSION = "6";

// Make each project self-contained: copy the viewer + a default config into
// <project>/.claude-usage/ so it can be viewed in place. Skipped in aggregate
// mode (CLAUDE_USAGE_DIR). Idempotent and best-effort; re-copies when the
// bundled viewer is missing or out of date.
function ensureBundle(cwd) {
  if (process.env.CLAUDE_USAGE_DIR) return;
  try {
    const base = path.join(cwd, ".claude-usage");
    const viewerSrc = path.join(__dirname, "..", "viewer");
    const viewerDst = path.join(base, "viewer");
    const verFile = path.join(viewerDst, ".version");
    const have = fs.existsSync(verFile) ? fs.readFileSync(verFile, "utf8").trim() : null;
    const stale = !fs.existsSync(path.join(viewerDst, "server.mjs")) || have !== VIEWER_VERSION;
    if (fs.existsSync(viewerSrc) && stale) {
      fs.rmSync(viewerDst, { recursive: true, force: true });
      fs.cpSync(viewerSrc, viewerDst, { recursive: true });
      fs.writeFileSync(verFile, VIEWER_VERSION + "\n");
    }
    // Ensure the viewer keys exist (tracking/fields may already have been seeded
    // by ensureProjectConfig). Merge, don't clobber.
    const cfgFile = path.join(base, "config.json");
    fs.mkdirSync(base, { recursive: true });
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) || {}; } catch {}
    let changed = false;
    if (!cfg.title) { cfg.title = path.basename(cwd); changed = true; }
    if (typeof cfg.port !== "number") { cfg.port = 4317; changed = true; }
    if (!cfg.ui || typeof cfg.ui !== "object") { cfg.ui = {}; changed = true; }
    if (changed) fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
  } catch {}
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function readEffort(cwd) {
  let effort = null;
  for (const f of settingsCandidates(cwd)) {
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      if (j && typeof j.effortLevel === "string") effort = j.effortLevel;
    } catch {}
  }
  return effort;
}

async function main() {
  const raw = readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw) || {};
  } catch {}

  const sessionId = payload.session_id || payload.sessionId;
  const cwd = payload.cwd || process.cwd();
  let transcript = payload.transcript_path || payload.transcriptPath;
  if (!transcript && sessionId) transcript = deriveTranscriptPath(cwd, sessionId);
  if (!transcript) return;

  // Per-project config: seeded from the global defaults on first sight, then
  // owned by the project. Skip recording when the project disabled tracking.
  const cfg = await ensureProjectConfig(cwd);
  if (!isEnabled(cfg)) return;

  const effortLevel = readEffort(cwd);
  const turns = buildTurns(transcript, { effortLevel });
  if (!turns.length) return;

  // Tag every record with a human workspace label for the viewer.
  const label = workspaceLabel(cwd);
  for (const t of turns) t.workspace = label;

  const sid = sessionId || (turns[0] && turns[0].sessionId);
  if (!sid) return;

  // Strip the field groups this project disabled.
  const slim = turns.map((t) => applyFieldSelection(t, cfg.fields));
  await upsertSession(workspaceFile(cwd), sid, slim);
  ensureBundle(cwd);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
