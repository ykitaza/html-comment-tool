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

// Every file gets a SOURCE view (raw text + line numbers). Some files also get
// a PREVIEW view: HTML renders in an iframe, Markdown renders as converted HTML.
// The client toggles between the two (Obsidian-style). previewKind tells it
// which preview to build; "none" means source-only (no toggle).
const ext = extname(targetPath).toLowerCase();
const PREVIEW_KIND_BY_EXT = {
  ".html": "html",
  ".htm": "html",
  ".md": "markdown",
  ".markdown": "markdown",
};
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
  ".html": "html",
  ".htm": "html",
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
const previewKind = PREVIEW_KIND_BY_EXT[ext] || "none"; // html | markdown | none
const defaultView = previewKind === "none" ? "source" : "preview"; // initial view
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
        previewKind, // "html" | "markdown" | "none"
        defaultView, // "preview" | "source"
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

  // The target shown inside the preview iframe. For HTML this is the file
  // itself; for Markdown it's the converted HTML document.
  if (url === "/target" || url === "/target/") {
    if (previewKind === "markdown") {
      try {
        const md = await readFile(targetPath, "utf8");
        const html = renderMarkdownDoc(md);
        res.writeHead(200, { "content-type": MIME[".html"] });
        return res.end(html);
      } catch {
        res.writeHead(404);
        return res.end("");
      }
    }
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
  console.log(
    `  view          ▸ ${previewKind === "none" ? `source (${lang})` : `preview (${previewKind}) + source`}`
  );
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

// ---------------------------------------------------------------------------
// Minimal, dependency-free Markdown → HTML. Covers the common cases used in
// design docs: headings, lists (incl. nested), fenced & inline code, blockquote,
// tables, hr, links, images, bold/italic/strikethrough. Each top-level block
// carries data-md-line (1-based line in the source .md) so a comment made in
// the preview can reference the original Markdown line.
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderInline(s) {
  // process code spans first so their contents aren't touched by other rules
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return ` ${codes.length - 1} `;
  });
  s = escapeHtml(s);
  // images ![alt](url) then links [text](url)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, a, u) => `<img alt="${a}" src="${u}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, t, u) => `<a href="${u}">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // restore code spans
  s = s.replace(/ (\d+) /g, (_, i) => `<code>${escapeHtml(codes[+i])}</code>`);
  return s;
}

function renderMarkdownBody(md) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const tag = (n) => ` data-md-line="${n}"`;

  while (i < lines.length) {
    const line = lines[i];
    const lineNo = i + 1;

    // blank
    if (!line.trim()) { i++; continue; }

    // fenced code
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const marker = fence[1][0];
      const langName = fence[2].trim();
      const buf = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // closing fence
      out.push(
        `<pre${tag(lineNo)}><code class="lang-${escapeHtml(langName)}">${escapeHtml(buf.join("\n"))}</code></pre>`
      );
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}${tag(lineNo)}>${renderInline(h[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(`<hr${tag(lineNo)}>`);
      i++;
      continue;
    }

    // blockquote (consume consecutive > lines)
    if (/^\s*>/.test(line)) {
      const buf = [];
      const start = lineNo;
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote${tag(start)}>${renderInline(buf.join(" "))}</blockquote>`);
      continue;
    }

    // table (header row + |---| separator)
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const start = lineNo;
      const splitRow = (r) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      const headers = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      let t = `<table${tag(start)}><thead><tr>`;
      t += headers.map((c) => `<th>${renderInline(c)}</th>`).join("");
      t += "</tr></thead><tbody>";
      for (const r of rows) {
        t += "<tr>" + r.map((c) => `<td>${renderInline(c)}</td>`).join("") + "</tr>";
      }
      t += "</tbody></table>";
      out.push(t);
      continue;
    }

    // lists (ordered / unordered, with simple nesting by indent)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const start = lineNo;
      const items = []; // { indent, ordered, html, line }
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        items.push({
          indent: m[1].length,
          ordered: /\d+\./.test(m[2]),
          html: renderInline(m[3]),
          line: i + 1,
        });
        i++;
      }
      out.push(renderList(items, 0, start, tag));
      continue;
    }

    // paragraph (gather until blank / block start)
    const buf = [line];
    const start = lineNo;
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(#{1,6}\s|>|([-*+]|\d+\.)\s|`{3,}|~{3,})/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p${tag(start)}>${renderInline(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}

// Build a (possibly nested) list from flat items grouped by indent.
// Items at the base indent become <li>; runs of deeper-indented items become a
// nested list spliced into the preceding <li>.
function renderList(items, _pos, baseLine, tag) {
  if (!items.length) return "";
  const baseIndent = items[0].indent;
  const ordered = items[0].ordered;
  let html = `<${ordered ? "ol" : "ul"}${tag(baseLine)}>`;
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    let li = `<li${tag(it.line)}>${it.html}`;
    // collect any immediately-following deeper items as a nested list
    let j = i + 1;
    while (j < items.length && items[j].indent > baseIndent) j++;
    if (j > i + 1) {
      li += renderList(items.slice(i + 1, j), 0, items[i + 1].line, tag);
    }
    li += "</li>";
    html += li;
    i = j;
  }
  html += ordered ? "</ol>" : "</ul>";
  return html;
}

function renderMarkdownDoc(md) {
  const body = renderMarkdownBody(md);
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
    line-height: 1.7; color: #1a1a2e; max-width: 820px; margin: 0 auto; padding: 32px 28px 80px; }
  h1,h2,h3,h4 { line-height: 1.3; margin: 1.4em 0 0.5em; }
  h1 { border-bottom: 2px solid #e2e6ef; padding-bottom: .3em; }
  h2 { border-bottom: 1px solid #e8ebf2; padding-bottom: .25em; }
  code { background: #f0f2f7; padding: .15em .4em; border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
  pre { background: #1c2030; color: #e6e9ef; padding: 14px 16px; border-radius: 8px; overflow:auto; }
  pre code { background: none; color: inherit; padding: 0; }
  blockquote { border-left: 4px solid #c9d2e3; margin: 1em 0; padding: .2em 1em; color: #555; background:#f7f9fc; }
  table { border-collapse: collapse; margin: 1em 0; width: 100%; }
  th, td { border: 1px solid #d7dce6; padding: 7px 11px; text-align: left; }
  th { background: #f3f6ff; }
  ul, ol { padding-left: 1.6em; }
  img { max-width: 100%; }
  a { color: #2f6bd6; }
  hr { border: none; border-top: 1px solid #e2e6ef; margin: 1.6em 0; }
</style></head>
<body>
${body}
</body></html>`;
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
