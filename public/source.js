// Source-mode adapter: render raw text with line numbers and let the user
// comment on a line or a line range. Covers JSON / YAML / XML / .drawio / SVG
// (as text) / plain text — anything that isn't rendered as a live page.

import { truncate } from "./core.js";

export function makeSourceAdapter({ state, startComposer }) {
  let lines = []; // file split into lines
  let lineEls = []; // <div.src-line> per line (1-indexed via [n-1])
  let selStart = null; // drag anchor (1-indexed line)
  let container; // scroll container

  async function mount() {
    const text = await (await fetch("/__source")).text();
    // normalise newlines; keep a trailing empty line out
    lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    buildView();
  }

  function buildView() {
    const stage = document.getElementById("frame-wrap");
    stage.innerHTML = ""; // replace the iframe area
    container = document.createElement("div");
    container.id = "src-view";
    const code = document.createElement("div");
    code.id = "src-code";

    lineEls = lines.map((text, idx) => {
      const n = idx + 1;
      const row = document.createElement("div");
      row.className = "src-line";
      row.dataset.line = String(n);

      const gutter = document.createElement("span");
      gutter.className = "src-gutter";
      gutter.textContent = String(n);

      const content = document.createElement("span");
      content.className = "src-content";
      content.textContent = text === "" ? "​" : text; // keep empty lines clickable

      row.appendChild(gutter);
      row.appendChild(content);
      code.appendChild(row);
      return row;
    });

    container.appendChild(code);
    stage.appendChild(container);
    wireSelection(code);
  }

  // click = single line; drag across gutters/lines = range
  function wireSelection(code) {
    code.addEventListener("mousedown", (e) => {
      const row = e.target.closest(".src-line");
      if (!row) return;
      // let the user still select text with a modifier; plain drag = line range
      selStart = Number(row.dataset.line);
      paintRange(selStart, selStart);
    });
    code.addEventListener("mousemove", (e) => {
      if (selStart == null) return;
      const row = e.target.closest(".src-line");
      if (!row) return;
      paintRange(selStart, Number(row.dataset.line));
    });
    code.addEventListener("mouseup", (e) => {
      if (selStart == null) return;
      const row = e.target.closest(".src-line");
      const end = row ? Number(row.dataset.line) : selStart;
      const a = Math.min(selStart, end);
      const b = Math.max(selStart, end);
      selStart = null;
      openFor(a, b, e);
    });
  }

  function paintRange(a, b) {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    lineEls.forEach((row, idx) => {
      const n = idx + 1;
      row.classList.toggle("selecting", n >= lo && n <= hi);
    });
  }

  function clearPaint() {
    lineEls.forEach((row) => row.classList.remove("selecting"));
  }

  function openFor(a, b, e) {
    const isRange = b > a;
    const snippet = lines.slice(a - 1, b).join("\n");
    const ref = isRange ? `L${a}-L${b}` : `L${a}`;
    const dataPath = computePath(a); // best-effort for json/yaml
    const target = {
      kind: "lines",
      line: a,
      range: isRange ? [a, b] : null,
      selector: ref, // shown in the panel's locator slot
      path: dataPath,
      snippet,
      quote: truncate(snippet.replace(/\n/g, " ⏎ "), 120),
      anchor: { line: a },
    };
    startComposer(target, { x: e.clientX + 12, y: e.clientY + 12 });
  }

  // ---- best-effort data path for JSON / YAML -----------------------------
  // Not a full parser — a pragmatic heuristic that gives the AI a useful hint
  // ("- データパス: `services.web.ports`"). Falls back to nothing if unsure.
  function computePath(lineNo) {
    const lang = state.meta.lang;
    if (lang === "yaml") return yamlPath(lineNo);
    if (lang === "json") return jsonPath(lineNo);
    return null;
  }

  function yamlPath(lineNo) {
    // walk upward, tracking the indentation stack of "key:" lines
    const stack = [];
    let lastIndent = Infinity;
    const path = [];
    for (let i = lineNo - 1; i >= 0; i--) {
      const raw = lines[i];
      if (!raw || !raw.trim() || /^\s*#/.test(raw)) continue;
      const indent = raw.match(/^\s*/)[0].length;
      const m = raw.match(/^\s*([\w.\-]+)\s*:/);
      if (m && indent < lastIndent) {
        path.unshift(m[1]);
        lastIndent = indent;
        if (indent === 0) break;
      }
    }
    return path.length ? path.join(".") : null;
  }

  function jsonPath(lineNo) {
    // Tokenise braces/brackets up to (and including) the target line, tracking
    // the key that immediately precedes each opening brace. The stack of those
    // keys, at the target's depth, is the path. Strings are skipped so braces
    // inside string values don't shift depth.
    const stack = []; // { key } per open container
    let pendingKey = null; // most recent "key": seen at the current level
    let reachedTarget = false;

    for (let i = 0; i < lineNo && !reachedTarget; i++) {
      const line = lines[i];
      const isTarget = i === lineNo - 1;
      let j = 0;
      while (j < line.length) {
        const ch = line[j];
        if (ch === '"') {
          // read a string token; if it's a key (followed by ':'), remember it
          let k = j + 1;
          let str = "";
          while (k < line.length) {
            if (line[k] === "\\") {
              str += line[k + 1] || "";
              k += 2;
              continue;
            }
            if (line[k] === '"') break;
            str += line[k];
            k++;
          }
          const after = line.slice(k + 1).match(/^\s*:/);
          if (after) pendingKey = str;
          j = k + 1;
          continue;
        }
        if (ch === "{" || ch === "[") {
          stack.push({ key: ch === "[" ? pendingKey : pendingKey });
          pendingKey = null;
        } else if (ch === "}" || ch === "]") {
          stack.pop();
          pendingKey = null;
        }
        j++;
      }
      // The target line's own "key": is part of the path (e.g. "pagination": {)
      if (isTarget) {
        reachedTarget = true;
        const km = line.match(/^\s*"([^"]+)"\s*:/);
        const keys = stack.map((s) => s.key).filter(Boolean);
        // Append the line's leading key — unless an opening brace on this same
        // line already pushed it onto the stack (avoid double-counting).
        if (km && keys[keys.length - 1] !== km[1]) keys.push(km[1]);
        return keys.length ? keys.join(".") : null;
      }
    }
    const keys = stack.map((s) => s.key).filter(Boolean);
    return keys.length ? keys.join(".") : null;
  }

  // ---- locator / markers --------------------------------------------------
  function relocate() {
    // mark commented lines in the gutter
    lineEls.forEach((row) => row.classList.remove("commented"));
    state.comments.forEach((c) => {
      if (c.kind !== "lines") return;
      const [a, b] = c.range || [c.line, c.line];
      for (let n = a; n <= b; n++) {
        const row = lineEls[n - 1];
        if (row) row.classList.add("commented");
      }
    });
  }

  function reveal(c) {
    if (c.kind !== "lines") return;
    const row = lineEls[(c.line || (c.range && c.range[0]) || 1) - 1];
    if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
    flashLines(c);
  }

  function flashLines(c) {
    const [a, b] = c.range || [c.line, c.line];
    for (let n = a; n <= b; n++) {
      const row = lineEls[n - 1];
      if (!row) continue;
      row.classList.add("flash");
      setTimeout(() => row.classList.remove("flash"), 900);
    }
  }

  function setActive(id) {
    lineEls.forEach((row) => row.classList.remove("active-line"));
    const c = state.comments.find((x) => x.id === id);
    if (!c || c.kind !== "lines") return;
    const [a, b] = c.range || [c.line, c.line];
    for (let n = a; n <= b; n++) lineEls[n - 1]?.classList.add("active-line");
  }

  function clearSelection() {
    clearPaint();
  }

  return { mount, relocate, reveal, setActive, clearSelection };
}
