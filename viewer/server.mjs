#!/usr/bin/env node
// Self-contained, zero-dependency viewer. Reads ONE project's records + config
// from a `.claude-usage` folder and serves the dashboard.
//
// It figures out which folder to read, in priority order:
//   1. $CLAUDE_USAGE_DIR                       (explicit / aggregate mode)
//   2. its own sibling folder, when this file was copied into a project at
//      <project>/.claude-usage/viewer/server.mjs   → reads <project>/.claude-usage
//   3. <argv path>/.claude-usage  or  <cwd>/.claude-usage
//
//   node server.mjs                 # reads ./.claude-usage
//   node server.mjs /path/to/proj   # reads that project
//   PORT=8080 node server.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");

function resolveDataDir() {
  if (process.env.CLAUDE_USAGE_DIR) return process.env.CLAUDE_USAGE_DIR;
  // Bundled inside a project: <project>/.claude-usage/viewer/server.mjs
  if (
    path.basename(__dirname) === "viewer" &&
    path.basename(path.dirname(__dirname)) === ".claude-usage"
  ) {
    return path.dirname(__dirname);
  }
  const base = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  return path.join(base, ".claude-usage");
}

const DATA_DIR = resolveDataDir();
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

// ---- per-project viewer config ----
function loadConfig() {
  let c = {};
  try {
    c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {};
  } catch {}
  if (!c.title) c.title = path.basename(path.dirname(DATA_DIR)) || "workspace";
  if (!c.ui || typeof c.ui !== "object") c.ui = {};
  return c;
}
function saveConfig(patch) {
  const c = loadConfig();
  const next = { ...c, ...patch, ui: { ...c.ui, ...(patch && patch.ui) } };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  } catch {}
  return next;
}

const PORT = Number(process.env.PORT) || loadConfig().port || 4317;

// ---- data ----
function loadEvents() {
  let files = [];
  try {
    files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".ndjson"));
  } catch {
    return [];
  }
  const events = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(DATA_DIR, f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        events.push(JSON.parse(s));
      } catch {}
    }
  }
  events.sort((a, b) => Date.parse(b.ts || 0) - Date.parse(a.ts || 0));
  return events;
}

function toListItem(e) {
  const { prompt, response, ...rest } = e;
  return {
    ...rest,
    promptPreview: (prompt || "").slice(0, 280),
    responsePreview: (response || "").slice(0, 280),
  };
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
const readBody = (req) =>
  new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });

const server = http.createServer(async (req, res) => {
  const route = new URL(req.url, "http://localhost").pathname;
  try {
    if (route === "/api/events") {
      return send(res, 200, JSON.stringify(loadEvents().map(toListItem)));
    }
    if (route.startsWith("/api/event/")) {
      const id = decodeURIComponent(route.slice("/api/event/".length));
      const e = loadEvents().find((x) => x.id === id);
      return e ? send(res, 200, JSON.stringify(e)) : send(res, 404, "{}");
    }
    if (route === "/api/config") {
      if (req.method === "POST") {
        let patch = {};
        try {
          patch = JSON.parse(await readBody(req)) || {};
        } catch {}
        return send(res, 200, JSON.stringify(saveConfig(patch)));
      }
      return send(res, 200, JSON.stringify(loadConfig()));
    }
    // static
    let rel = (route === "/" ? "/index.html" : route).replace(/\.\.+/g, "");
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return send(res, 403, "forbidden", "text/plain");
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || "application/octet-stream");
  } catch (err) {
    if (err.code === "ENOENT") return send(res, 404, "not found", "text/plain");
    return send(res, 500, "error", "text/plain");
  }
});

server.listen(PORT, () => {
  console.log(`\n  Claude usage viewer  ->  http://localhost:${PORT}`);
  console.log(`  project: ${loadConfig().title}`);
  console.log(`  reading: ${DATA_DIR}\n`);
});
