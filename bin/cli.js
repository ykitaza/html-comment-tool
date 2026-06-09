#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "..", "public");

// ---- argument parsing -------------------------------------------------------
const argv = process.argv.slice(2);
let targetArg;
let port = 4900; // difit-style fixed default; falls back to next free port
let openBrowser = true;
let clean = false; // start with comments cleared for this file
let keepAlive = false; // keep server up after the browser disconnects

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--port" || a === "-p") {
    port = Number(argv[++i]);
  } else if (a === "--no-open") {
    openBrowser = false;
  } else if (a === "--clean") {
    clean = true;
  } else if (a === "--keep-alive") {
    keepAlive = true;
  } else if (a === "--help" || a === "-h") {
    printHelp();
    process.exit(0);
  } else if (!a.startsWith("-")) {
    targetArg = a;
  }
}

if (!targetArg) {
  printHelp();
  process.exit(1);
}

const targetPath = resolve(process.cwd(), targetArg);
try {
  const s = await stat(targetPath);
  if (!s.isFile()) throw new Error("not a file");
} catch {
  console.error(`✗ Cannot read file: ${targetPath}`);
  process.exit(1);
}

// The directory the target lives in becomes the web root for its assets
// (so relative <link>/<img>/<script> in the target keep working).
const targetDir = dirname(targetPath);
const targetName = relative(targetDir, targetPath);

// Decide how to present the file. "render" = show it as a live page in the
// iframe (HTML). "source" = show the raw text with line numbers and let the
// user comment on lines/ranges (JSON, YAML, XML, .drawio, plain text, ...).
const ext = extname(targetPath).toLowerCase();
const RENDER_EXTS = new Set([".html", ".htm"]);
// language hint for the source viewer's syntax highlighting / path extraction
const LANG_BY_EXT = {
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".xml": "xml",
  ".drawio": "xml",
  ".svg": "xml",
  ".md": "markdown",
  ".markdown": "markdown",
  ".csv": "csv",
  ".txt": "text",
  ".js": "javascript",
  ".mjs": "javascript",
  ".ts": "typescript",
  ".css": "css",
  ".toml": "toml",
  ".ini": "ini",
  ".sh": "shell",
};
const viewMode = RENDER_EXTS.has(ext) ? "render" : "source";
const lang = LANG_BY_EXT[ext] || "text";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

function mimeFor(p) {
  return MIME[extname(p).toLowerCase()] || "application/octet-stream";
}

// Guard against path traversal: resolved path must stay inside `root`.
function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const joined = resolve(root, "." + decoded);
  if (joined !== root && !joined.startsWith(root + sep)) return null;
  return joined;
}

async function serveFile(res, filePath, fallbackType) {
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": fallbackType || mimeFor(filePath) });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
  }
}

// Deferred shutdown: /__bye schedules an exit, but any subsequent request
// (e.g. a reload re-fetching the page) cancels it. So a reload survives, while
// actually closing the tab — with no follow-up request — lets it shut down.
let shutdownTimer = null;
function cancelShutdown() {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
}

const server = createServer(async (req, res) => {
  const url = req.url || "/";

  // Any real request means the browser is still (or again) here.
  if (url !== "/__bye") cancelShutdown();

  // Overlay UI (the wrapper) ------------------------------------------------
  if (url === "/" || url === "/index.html") {
    return serveFile(res, join(PUBLIC_DIR, "index.html"), MIME[".html"]);
  }
  // Any of the wrapper's own JS/CSS modules, served from PUBLIC_DIR.
  const uiAsset = url.match(/^\/([a-z0-9_-]+\.(?:js|css))$/i);
  if (uiAsset) {
    const candidate = join(PUBLIC_DIR, uiAsset[1]);
    // only if it actually exists in PUBLIC_DIR (else fall through to target dir)
    try {
      await stat(candidate);
      return serveFile(res, candidate);
    } catch {
      /* not a UI asset — fall through to target-relative serving */
    }
  }

  // Metadata about the target (so the UI can show the file name) ------------
  if (url === "/__meta") {
    res.writeHead(200, { "content-type": MIME[".json"] });
    return res.end(
      JSON.stringify({
        file: targetName,
        path: targetPath,
        dir: targetDir,
        clean,
        viewMode, // "render" | "source"
        lang,
      })
    );
  }

  // Raw text of the target, for the source viewer --------------------------
  if (url === "/__source") {
    try {
      const text = await readFile(targetPath, "utf8");
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(text);
    } catch {
      res.writeHead(404);
      return res.end("");
    }
  }

  // The target HTML, rendered inside the iframe ----------------------------
  if (url === "/target" || url === "/target/") {
    return serveFile(res, targetPath, MIME[".html"]);
  }

  // Browser tab closed/navigated away: schedule shutdown unless --keep-alive.
  // A reload fires this too, but the reload's immediate page re-fetch will
  // cancel the timer before it elapses (difit-like: close ends, reload stays).
  if (url === "/__bye") {
    res.writeHead(204);
    res.end();
    if (!keepAlive) {
      cancelShutdown();
      shutdownTimer = setTimeout(() => {
        console.log("\n  Browser closed — shutting down. (use --keep-alive to stay up)\n");
        process.exit(0);
      }, 1500);
    }
    return;
  }

  // Any other path: serve relative to the target's directory so the
  // target's own assets (css/js/images) load correctly inside the iframe.
  const filePath = safeJoin(targetDir, url);
  if (!filePath) {
    res.writeHead(403);
    return res.end("403 Forbidden");
  }
  return serveFile(res, filePath);
});

// Try the requested port; if it's in use, walk forward to the next free one
// (difit behaviour). Give up after a handful of attempts.
let attempts = 0;
function listen(p) {
  server.listen(p, "127.0.0.1");
}
server.on("error", (err) => {
  if (err.code === "EADDRINUSE" && attempts < 20) {
    attempts++;
    listen(port + attempts);
  } else {
    console.error(`✗ Could not start server: ${err.message}`);
    process.exit(1);
  }
});
server.on("listening", () => {
  const actualPort = server.address().port;
  const link = `http://127.0.0.1:${actualPort}/`;
  console.log(`\n  html-comment  ▸ reviewing  ${targetName}`);
  console.log(`  full path     ▸ ${targetPath}`);
  console.log(`  mode          ▸ ${viewMode}${viewMode === "source" ? ` (${lang})` : ""}`);
  console.log(`  serving dir   ▸ ${targetDir}`);
  console.log(`  open          ▸ ${link}`);
  if (clean) console.log(`  comments      ▸ cleared (--clean)`);
  if (keepAlive) console.log(`  keep-alive    ▸ on`);
  console.log(`\n  Ctrl+C to stop.\n`);
  if (openBrowser) open(link);
});
listen(port);

function open(url) {
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  const child = spawn(cmd, [url], { stdio: "ignore", detached: true, shell: platform === "win32" });
  child.on("error", () => {/* ignore: user can open manually */});
  child.unref();
}

function printHelp() {
  console.log(`
  html-comment — wrap an HTML file in a comment overlay for AI review

  Usage:
    html-comment <file.html> [options]

  Options:
    -p, --port <n>   Port to listen on (default: 4900, falls back if busy)
        --no-open    Do not auto-open the browser
        --clean      Start with this file's saved comments cleared
        --keep-alive Keep the server running after the browser disconnects
    -h, --help       Show this help

  Example:
    npx html-comment ./design.html
`);
}
