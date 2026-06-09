#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { deflateRawSync, inflateSync } from "node:zlib";
import {
  escapeHtml,
  renderMarkdownDoc,
  injectLineNumbers,
} from "../lib/render.js";

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
  ".drawio": "drawio",
  ".dio": "drawio",
  ".puml": "plantuml",
  ".plantuml": "plantuml",
  ".pu": "plantuml",
  ".iuml": "plantuml",
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
  ".puml": "plantuml",
  ".plantuml": "plantuml",
  ".pu": "plantuml",
  ".iuml": "plantuml",
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
// drawio "editable PNG" export: a real PNG with the diagram XML embedded in a
// tEXt chunk. Detected by the .drawio.png double extension.
const isDrawioPng = /\.drawio\.png$/i.test(targetName);
const previewKind = isDrawioPng ? "drawiopng" : PREVIEW_KIND_BY_EXT[ext] || "none";
const defaultView = previewKind === "none" ? "source" : "preview"; // initial view
const lang = isDrawioPng ? "xml" : LANG_BY_EXT[ext] || "text";

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
      // For a drawio editable PNG, the "source" is the XML embedded in it.
      const text = isDrawioPng
        ? formatXml(extractDrawioXml(await readFile(targetPath)))
        : await readFile(targetPath, "utf8");
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(text);
    } catch {
      res.writeHead(404);
      return res.end("");
    }
  }

  // Raw PNG bytes of a drawio editable PNG (shown as the diagram image) -----
  if (url === "/__drawiopng-image" && isDrawioPng) {
    return serveFile(res, targetPath, MIME[".png"]);
  }
  // Shape geometry extracted from the embedded XML, for the clickable overlay.
  if (url === "/__drawiopng-shapes" && isDrawioPng) {
    try {
      const xml = extractDrawioXml(await readFile(targetPath));
      res.writeHead(200, { "content-type": MIME[".json"] });
      return res.end(JSON.stringify(drawioShapes(xml)));
    } catch {
      res.writeHead(200, { "content-type": MIME[".json"] });
      return res.end(JSON.stringify({ shapes: [], bbox: null }));
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
    if (previewKind === "drawio") {
      try {
        const xml = await readFile(targetPath, "utf8");
        const html = renderDrawioDoc(xml);
        res.writeHead(200, { "content-type": MIME[".html"] });
        return res.end(html);
      } catch {
        res.writeHead(404);
        return res.end("");
      }
    }
    if (previewKind === "drawiopng") {
      res.writeHead(200, { "content-type": MIME[".html"] });
      return res.end(renderDrawioPngDoc());
    }
    if (previewKind === "plantuml") {
      try {
        const src = await readFile(targetPath, "utf8");
        const svg = await fetchPlantumlSvg(src);
        const html = renderPlantumlDoc(svg, src);
        res.writeHead(200, { "content-type": MIME[".html"] });
        return res.end(html);
      } catch (e) {
        res.writeHead(200, { "content-type": MIME[".html"] });
        return res.end(
          `<!DOCTYPE html><meta charset="UTF-8"><body style="font-family:sans-serif;padding:24px;color:#b00">図の生成に失敗しました（PlantUMLサーバーに接続できない可能性があります）。ソース表示に切り替えてください。<br><small>${String(
            e.message || e
          )}</small></body>`
        );
      }
    }
    // HTML: inject data-line on each opening tag so preview comments can map
    // back to the source line (enables preview→source comment sync).
    try {
      const raw = await readFile(targetPath, "utf8");
      res.writeHead(200, { "content-type": MIME[".html"] });
      return res.end(injectLineNumbers(raw));
    } catch {
      res.writeHead(404);
      return res.end("");
    }
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
// (Markdown/HTML render helpers moved to ../lib/render.js; imported at top.)

// Render a .drawio file as a diagram using the official GraphViewer (loaded
// from viewer.diagrams.net — requires network). The whole mxfile XML goes into
// the data-mxgraph "xml" key; GraphViewer handles compressed content too.
// ---------------------------------------------------------------------------
// drawio editable PNG: the diagram XML is embedded in a PNG tEXt/zTXt chunk
// under the keyword "mxfile" (URL-encoded). Extract it so we can show the XML
// as source and overlay clickable shape regions on the image.
function extractDrawioXml(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("not a PNG");
  }
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString("latin1", i + 4, i + 8);
    const dataStart = i + 8;
    if (type === "tEXt") {
      const chunk = buf.slice(dataStart, dataStart + len);
      const nul = chunk.indexOf(0);
      const key = chunk.toString("latin1", 0, nul);
      if (key === "mxfile") {
        const val = chunk.toString("latin1", nul + 1);
        return decodeURIComponent(val);
      }
    } else if (type === "zTXt") {
      const chunk = buf.slice(dataStart, dataStart + len);
      const nul = chunk.indexOf(0);
      const key = chunk.toString("latin1", 0, nul);
      if (key === "mxfile") {
        // after keyword\0 + 1 compression-method byte, zlib-compressed text
        const comp = chunk.slice(nul + 2);
        const text = inflateSync(comp).toString("latin1");
        return decodeURIComponent(text);
      }
    }
    if (type === "IEND") break;
    i = dataStart + len + 4; // skip data + CRC
  }
  throw new Error("no embedded mxfile XML found in PNG");
}

// Parse shapes (id, label, geometry) from the mxGraphModel XML, plus the page
// bounding box, so the client can place an overlay region per shape on the
// scaled image. Also records the source line of each cell for sync.
function drawioShapes(xml) {
  const lines = xml.replace(/\r\n?/g, "\n").split("\n");
  const shapes = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  // Iterate over each <mxCell ...> opening tag. Self-closing cells (<mxCell .../>)
  // have no geometry; cells with a body may contain <mxGeometry .../>. We slice
  // the body up to the next </mxCell> or the next <mxCell to avoid one cell's
  // regex swallowing the following cells.
  const openRe = /<mxCell\b([^>]*?)(\/?)>/g;
  let m;
  while ((m = openRe.exec(xml))) {
    const attrs = m[1] || "";
    const selfClose = m[2] === "/";
    const id = (attrs.match(/\bid="([^"]*)"/) || [])[1];
    const value = (attrs.match(/\bvalue="([^"]*)"/) || [])[1] || "";
    const isVertex = /\bvertex="1"/.test(attrs);
    if (!isVertex || selfClose) continue;
    // body = from end of this opening tag to the next </mxCell>
    const bodyStart = m.index + m[0].length;
    const close = xml.indexOf("</mxCell>", bodyStart);
    const inner = xml.slice(bodyStart, close === -1 ? undefined : close);
    const geo = inner.match(/<mxGeometry\b[^>]*\/?>/);
    if (!geo) continue;
    const g = geo[0];
    const x = parseFloat((g.match(/\bx="([-\d.]+)"/) || [])[1]);
    const y = parseFloat((g.match(/\by="([-\d.]+)"/) || [])[1]);
    const w = parseFloat((g.match(/\bwidth="([-\d.]+)"/) || [])[1]);
    const h = parseFloat((g.match(/\bheight="([-\d.]+)"/) || [])[1]);
    if ([x, y, w, h].some((n) => Number.isNaN(n))) continue;
    // source line of this cell
    const upto = xml.slice(0, m.index);
    const line = upto.split("\n").length;
    const label = decodeHtmlEntities(value).replace(/<[^>]+>/g, "").trim();
    shapes.push({ id, label, x, y, w, h, line });
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
  }
  const bbox = shapes.length ? { minX, minY, maxX, maxY } : null;
  return { shapes, bbox };
}

function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// pretty-print the mxfile XML a little so the source view has one tag per line
function formatXml(xml) {
  return xml
    .replace(/>\s*</g, ">\n<")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

// Preview doc for a drawio editable PNG: the image + a clickable overlay built
// client-side from /__drawiopng-shapes.
function renderDrawioPngDoc() {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<style>
  html,body { margin:0; height:100%; background:#fff; }
  #wrap { position:relative; display:inline-block; }
  #host { min-height:100vh; display:flex; align-items:flex-start; justify-content:center; padding:20px; box-sizing:border-box; }
  #img { display:block; max-width:100%; height:auto; }
  .hc-shape { position:absolute; cursor:pointer; border:1.5px solid transparent; border-radius:3px; }
  .hc-shape:hover { border-color:#4f8cff; background:rgba(79,140,255,0.12); }
  .hc-note { position:fixed; bottom:8px; left:8px; font:12px -apple-system,sans-serif; color:#888; z-index:5; pointer-events:none; }
</style></head>
<body>
  <div id="host"><div id="wrap"><img id="img" src="/__drawiopng-image" alt="diagram"></div></div>
  <div class="hc-note">drawio 編集可能PNG（埋め込みXMLから図形を認識）</div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// PlantUML: encode the source with PlantUML's deflate + custom base64, fetch
// the SVG from the public server, and embed it inline so it's same-origin
// (which lets the front-end attach comments to diagram elements).
const PLANTUML_SERVER =
  process.env.PLANTUML_SERVER || "https://www.plantuml.com/plantuml";
const PLANTUML_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

function plantumlEncode64(data) {
  let r = "";
  for (let i = 0; i < data.length; i += 3) {
    const b1 = data[i];
    const b2 = i + 1 < data.length ? data[i + 1] : 0;
    const b3 = i + 2 < data.length ? data[i + 2] : 0;
    r += PLANTUML_ALPHABET[b1 >> 2];
    r += PLANTUML_ALPHABET[((b1 & 0x3) << 4) | (b2 >> 4)];
    if (i + 1 < data.length) r += PLANTUML_ALPHABET[((b2 & 0xf) << 2) | (b3 >> 6)];
    if (i + 2 < data.length) r += PLANTUML_ALPHABET[b3 & 0x3f];
  }
  return r;
}
function plantumlEncode(text) {
  const deflated = deflateRawSync(Buffer.from(text, "utf8"), { level: 9 });
  return plantumlEncode64(deflated);
}
async function fetchPlantumlSvg(src) {
  const url = `${PLANTUML_SERVER}/svg/${plantumlEncode(src)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PlantUML server returned ${res.status}`);
  return await res.text();
}

function renderPlantumlDoc(svg, src) {
  // Strip any XML/DOCTYPE prolog from the SVG so it embeds cleanly inline.
  const inlineSvg = svg.replace(/^[\s\S]*?(<svg)/i, "$1");
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<style>
  html,body { margin:0; height:100%; background:#fff; }
  #wrap { min-height:100vh; display:flex; align-items:flex-start; justify-content:center; padding:20px; box-sizing:border-box; }
  #wrap svg { max-width:100%; height:auto; }
  .hc-note { position:fixed; bottom:8px; left:8px; font:12px -apple-system,sans-serif; color:#888; z-index:5; pointer-events:none; }
</style></head>
<body>
  <div id="wrap">${inlineSvg}</div>
  <div class="hc-note">PlantUML プレビュー（${escapeHtml(PLANTUML_SERVER)}）</div>
</body></html>`;
}

function renderDrawioDoc(xml) {
  // Render via drawio's official lightbox viewer (viewer.diagrams.net), passing
  // the raw diagram XML in the URL fragment (#R<urlencoded xml>). This is the
  // documented share/embed path and renders self-contained — far more reliable
  // than the in-page GraphViewer embed. Requires network access.
  const viewerUrl =
    "https://viewer.diagrams.net/?lightbox=1&highlight=4f8cff&nav=1&toolbar=zoom%20layers#R" +
    encodeURIComponent(xml);
  const srcAttr = viewerUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<style>
  html,body { margin:0; height:100%; background:#fff; }
  iframe { width:100%; height:100vh; border:0; display:block; }
  .hc-note { position:fixed; bottom:8px; left:8px; font:12px -apple-system,sans-serif; color:#888; z-index:5; pointer-events:none; }
</style></head>
<body>
  <iframe src="${srcAttr}" title="drawio preview"></iframe>
  <div class="hc-note">drawio プレビュー（viewer.diagrams.net）</div>
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
