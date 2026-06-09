// Shared, dependency-free rendering helpers used by both the CLI server
// (bin/cli.js) and the VS Code extension. Pure functions, no Node/DOM APIs.
//
// - renderMarkdownDoc(md)  → full HTML document (mermaid-aware, data-md-line)
// - injectLineNumbers(html) → adds data-line="N" to each opening HTML tag

export function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderInline(s) {
  // process code spans first so their contents aren't touched by other rules
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return ` ${codes.length - 1} `;
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
  s = s.replace(/ (\d+) /g, (_, i) => `<code>${escapeHtml(codes[+i])}</code>`);
  return s;
}

export function renderMarkdownBody(md) {
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
      const code = buf.join("\n");
      // mermaid blocks render as diagrams; mermaid.run() reads .mermaid divs.
      // Keep the raw source in a data attr so we don't lose it if rendering fails.
      if (/^mermaid$/i.test(langName)) {
        const attrSrc = escapeHtml(code).replace(/"/g, "&quot;");
        out.push(
          `<div class="mermaid"${tag(lineNo)} data-mermaid-src="${attrSrc}">${escapeHtml(code)}</div>`
        );
      } else {
        out.push(
          `<pre${tag(lineNo)}><code class="lang-${escapeHtml(langName)}">${escapeHtml(code)}</code></pre>`
        );
      }
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
export function renderList(items, _pos, baseLine, tag) {
  if (!items.length) return "";
  const baseIndent = items[0].indent;
  const ordered = items[0].ordered;
  let html = `<${ordered ? "ol" : "ul"}${tag(baseLine)}>`;
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    let li = `<li${tag(it.line)}>${it.html}`;
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

// Add data-line="N" (1-based source line) to each opening HTML tag, so a
// comment made in the rendered preview can reference the original line. Tags
// inside <script>/<style>/<pre> are left alone. Existing attributes are kept.
export function injectLineNumbers(html) {
  let line = 1;
  let out = "";
  let i = 0;
  const skipTags = { script: true, style: true, pre: true, textarea: true };
  while (i < html.length) {
    const ch = html[i];
    if (ch === "\n") line++;
    if (ch === "<") {
      if (html.startsWith("<!--", i)) {
        const end = html.indexOf("-->", i);
        const chunk = html.slice(i, end === -1 ? html.length : end + 3);
        line += (chunk.match(/\n/g) || []).length;
        out += chunk;
        i += chunk.length;
        continue;
      }
      const m = html.slice(i).match(/^<\/?([a-zA-Z][\w-]*)([^>]*)>/);
      if (m) {
        const isClosing = m[0][1] === "/";
        const tag = m[1].toLowerCase();
        let full = m[0];
        if (!isClosing && !/\sdata-line=/.test(full)) {
          full = full.replace(/^<([a-zA-Z][\w-]*)/, `<$1 data-line="${line}"`);
        }
        out += full;
        const consumed = m[0].length;
        line += (m[0].match(/\n/g) || []).length;
        i += consumed;
        if (!isClosing && skipTags[tag]) {
          const close = html.toLowerCase().indexOf(`</${tag}`, i);
          if (close !== -1) {
            const inner = html.slice(i, close);
            line += (inner.match(/\n/g) || []).length;
            out += inner;
            i = close;
          }
        }
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

export function renderMarkdownDoc(md) {
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
  .mermaid { background:#fff; text-align:center; margin: 1em 0; }
  .mermaid[data-rendered] { padding: 4px; }
  .mermaid-error { background:#fff5f5; border:1px solid #f3c0c0; color:#b00; border-radius:8px; padding:10px 14px; white-space:pre-wrap; font-family:ui-monospace,monospace; font-size:12px; }
</style></head>
<body>
${body}
<script type="module">
  // Render fenced mermaid blocks as diagrams. Loaded from CDN (requires
  // network); if it fails, the raw mermaid source remains visible as text.
  try {
    const mermaid = (await import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs")).default;
    mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
    const blocks = document.querySelectorAll(".mermaid");
    for (let i = 0; i < blocks.length; i++) {
      const el = blocks[i];
      const src = el.getAttribute("data-mermaid-src") || el.textContent;
      try {
        const { svg } = await mermaid.render("mmd-" + i, src);
        el.innerHTML = svg;
        el.setAttribute("data-rendered", "1");
      } catch (e) {
        el.innerHTML = '<div class="mermaid-error">Mermaid 描画エラー: ' +
          String(e && e.message || e) + '</div>';
      }
    }
  } catch (e) {
    // mermaid library failed to load (offline?) — leave raw text blocks as-is.
  }
</script>
</body></html>`;
}
