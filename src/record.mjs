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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Make each project self-contained: copy the viewer + a default config into
// <project>/.claude-usage/ so it can be viewed in place. Skipped in aggregate
// mode (CLAUDE_USAGE_DIR). Idempotent and best-effort.
function ensureBundle(cwd) {
  if (process.env.CLAUDE_USAGE_DIR) return;
  try {
    const base = path.join(cwd, ".claude-usage");
    const viewerSrc = path.join(__dirname, "..", "viewer");
    const viewerDst = path.join(base, "viewer");
    if (fs.existsSync(viewerSrc) && !fs.existsSync(path.join(viewerDst, "server.mjs"))) {
      fs.cpSync(viewerSrc, viewerDst, { recursive: true });
    }
    const cfg = path.join(base, "config.json");
    if (!fs.existsSync(cfg)) {
      fs.mkdirSync(base, { recursive: true });
      fs.writeFileSync(
        cfg,
        JSON.stringify({ title: path.basename(cwd), port: 4317, ui: {} }, null, 2) + "\n"
      );
    }
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

  const effortLevel = readEffort(cwd);
  const turns = buildTurns(transcript, { effortLevel });
  if (!turns.length) return;

  // Tag every record with a human workspace label for the viewer.
  const label = workspaceLabel(cwd);
  for (const t of turns) t.workspace = label;

  const sid = sessionId || (turns[0] && turns[0].sessionId);
  if (!sid) return;
  await upsertSession(workspaceFile(cwd), sid, turns);
  ensureBundle(cwd);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
