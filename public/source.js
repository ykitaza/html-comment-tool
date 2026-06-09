// Source-mode adapter — GitHub/difit-style line review.
// Renders raw text with line numbers; clicking a line (or dragging a range)
// opens an inline comment box right below the selection, and saved comments
// show as inline thread cards under the line. The right-hand panel still lists
// every comment (kept in sync via core).
//
// Covers JSON / YAML / XML / .drawio / SVG (as text) / Markdown source / plain
// text — anything shown as raw lines.

import {
  truncate,
  addComment,
  updateComment,
  deleteComment,
  buildPrompt,
  copyText,
  lineRangeOf,
} from "./core.js";

export function makeSourceAdapter({ state }) {
  let lines = []; // file split into lines
  let lineEls = []; // <div.src-line> per line (1-indexed via [n-1])
  let selStart = null; // drag anchor (1-indexed line)
  let dragging = false;
  let code; // the code container
  let openWidget = null; // currently-open inline composer element

  async function mount() {
    const text = await (await fetch("/__source")).text();
    lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    buildView();
    renderThreads();
  }

  function buildView() {
    const stage = document.getElementById("frame-wrap");
    stage.innerHTML = "";
    const view = document.createElement("div");
    view.id = "src-view";
    code = document.createElement("div");
    code.id = "src-code";

    lineEls = lines.map((text, idx) => {
      const n = idx + 1;
      const row = document.createElement("div");
      row.className = "src-line";
      row.dataset.line = String(n);

      // hover "+" affordance like GitHub
      const add = document.createElement("span");
      add.className = "src-add";
      add.textContent = "+";
      add.title = "この行にコメント";

      const gutter = document.createElement("span");
      gutter.className = "src-gutter";
      gutter.textContent = String(n);

      const content = document.createElement("span");
      content.className = "src-content";
      content.textContent = text === "" ? "​" : text;

      row.appendChild(add);
      row.appendChild(gutter);
      row.appendChild(content);
      code.appendChild(row);
      return row;
    });

    view.appendChild(code);
    stage.appendChild(view);
    wireSelection();
  }

  // click = single line; drag = range. The "+" or gutter both start it.
  function wireSelection() {
    code.addEventListener("mousedown", (e) => {
      const row = e.target.closest(".src-line");
      if (!row || e.target.closest(".src-thread, .src-composer")) return;
      dragging = true;
      selStart = Number(row.dataset.line);
      paintRange(selStart, selStart);
    });
    code.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const row = e.target.closest(".src-line");
      if (!row) return;
      paintRange(selStart, Number(row.dataset.line));
    });
    code.addEventListener("mouseup", (e) => {
      if (!dragging) return;
      dragging = false;
      const row = e.target.closest(".src-line");
      const end = row ? Number(row.dataset.line) : selStart;
      const a = Math.min(selStart, end);
      const b = Math.max(selStart, end);
      selStart = null;
      openComposer(a, b);
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

  function makeTarget(a, b) {
    const isRange = b > a;
    const snippet = lines.slice(a - 1, b).join("\n");
    return {
      kind: "lines",
      line: a,
      range: isRange ? [a, b] : null,
      selector: isRange ? `L${a}-L${b}` : `L${a}`,
      path: computePath(a),
      snippet,
      quote: truncate(snippet.replace(/\n/g, " ⏎ "), 120),
      anchor: { line: a },
    };
  }

  // ---- inline composer (GitHub-style, opens under the selection) ----------
  function openComposer(a, b) {
    closeWidget();
    const anchorRow = lineEls[b - 1];
    if (!anchorRow) return;
    const target = makeTarget(a, b);

    const box = document.createElement("div");
    box.className = "src-composer";
    box.innerHTML = `
      <div class="src-composer-ref">${target.selector}${
      target.path ? ` · <code>${escapeHtml(target.path)}</code>` : ""
    }</div>
      <textarea class="src-composer-input" rows="3" placeholder="この箇所への指摘・修正指示を書く…"></textarea>
      <div class="src-composer-actions">
        <button class="ghost src-cancel">キャンセル</button>
        <button class="primary src-save">コメント (⌘/Ctrl+Enter)</button>
      </div>`;
    anchorRow.after(box);
    openWidget = box;

    const input = box.querySelector(".src-composer-input");
    input.focus();
    box.querySelector(".src-cancel").addEventListener("click", () => {
      closeWidget();
      clearPaint();
    });
    box.querySelector(".src-save").addEventListener("click", () => commit());
    input.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") commit();
      if (e.key === "Escape") {
        closeWidget();
        clearPaint();
      }
    });

    function commit() {
      const body = input.value.trim();
      if (!body) {
        input.focus();
        return;
      }
      addComment(target, body);
      closeWidget();
      clearPaint();
      relocate(); // redraws threads + gutter marks
    }
  }

  function closeWidget() {
    if (openWidget) {
      openWidget.remove();
      openWidget = null;
    }
  }

  // ---- inline threads (saved comment cards under their line) ---------------
  function renderThreads() {
    // remove existing thread cards
    code.querySelectorAll(".src-thread").forEach((el) => el.remove());
    // group comments by their anchor line (last line of the range). Includes
    // preview-made comments that carry a source line (mdLine / srcLine).
    const byLine = new Map();
    state.comments.forEach((c) => {
      const range = lineRangeOf(c);
      if (!range) return;
      const anchor = range[1];
      if (!byLine.has(anchor)) byLine.set(anchor, []);
      byLine.get(anchor).push(c);
    });
    for (const [anchor, list] of byLine) {
      const row = lineEls[anchor - 1];
      if (!row) continue;
      const thread = document.createElement("div");
      thread.className = "src-thread";
      list.forEach((c) => thread.appendChild(threadCard(c)));
      row.after(thread);
    }
  }

  function threadCard(c) {
    const idx = state.comments.indexOf(c) + 1;
    const card = document.createElement("div");
    card.className = "src-card";
    card.dataset.id = c.id;

    const head = document.createElement("div");
    head.className = "src-card-head";
    // Show a line-based ref. Preview-origin comments are tagged so it's clear
    // they were made in the rendered view.
    const range = lineRangeOf(c);
    const ref = range ? (range[0] === range[1] ? `L${range[0]}` : `L${range[0]}-L${range[1]}`) : c.selector;
    const fromPreview = c.kind !== "lines";
    head.innerHTML = `<span class="comment-num">${idx}</span><span class="src-card-ref">${ref}${
      c.path ? ` · ${escapeHtml(c.path)}` : ""
    }</span>${fromPreview ? `<span class="src-card-tag">プレビュー</span>` : ""}`;

    const copyBtn = document.createElement("button");
    copyBtn.className = "src-card-btn";
    copyBtn.textContent = "📋";
    copyBtn.title = "このコメントだけコピー";
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      copyText(buildPrompt([c]));
      copyBtn.textContent = "✓";
      setTimeout(() => (copyBtn.textContent = "📋"), 1000);
    });
    const editBtn = document.createElement("button");
    editBtn.className = "src-card-btn";
    editBtn.textContent = "✎";
    editBtn.title = "編集";
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      startEdit(card, c);
    });
    const delBtn = document.createElement("button");
    delBtn.className = "src-card-btn danger";
    delBtn.textContent = "🗑";
    delBtn.title = "削除";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteComment(c.id);
      relocate();
    });
    head.appendChild(copyBtn);
    head.appendChild(editBtn);
    head.appendChild(delBtn);

    const body = document.createElement("div");
    body.className = "src-card-body";
    body.textContent = c.body;

    card.appendChild(head);
    card.appendChild(body);
    return card;
  }

  function startEdit(card, c) {
    const body = card.querySelector(".src-card-body");
    const ta = document.createElement("textarea");
    ta.className = "src-composer-input";
    ta.rows = 3;
    ta.value = c.body;
    body.replaceWith(ta);
    ta.focus();
    const finish = (commit) => {
      if (commit) {
        const v = ta.value.trim();
        if (v) updateComment(c.id, v);
      }
      relocate();
    };
    ta.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    ta.addEventListener("blur", () => finish(true));
  }

  // ---- best-effort data path for JSON / YAML (unchanged) ------------------
  function computePath(lineNo) {
    const lang = state.meta.lang;
    if (lang === "yaml") return yamlPath(lineNo);
    if (lang === "json") return jsonPath(lineNo);
    return null;
  }

  function yamlPath(lineNo) {
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
    const stack = [];
    let pendingKey = null;
    for (let i = 0; i < lineNo; i++) {
      const line = lines[i];
      const isTarget = i === lineNo - 1;
      let j = 0;
      while (j < line.length) {
        const ch = line[j];
        if (ch === '"') {
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
          if (line.slice(k + 1).match(/^\s*:/)) pendingKey = str;
          j = k + 1;
          continue;
        }
        if (ch === "{" || ch === "[") {
          stack.push({ key: pendingKey });
          pendingKey = null;
        } else if (ch === "}" || ch === "]") {
          stack.pop();
          pendingKey = null;
        }
        j++;
      }
      if (isTarget) {
        const km = line.match(/^\s*"([^"]+)"\s*:/);
        const keys = stack.map((s) => s.key).filter(Boolean);
        if (km && keys[keys.length - 1] !== km[1]) keys.push(km[1]);
        return keys.length ? keys.join(".") : null;
      }
    }
    const keys = stack.map((s) => s.key).filter(Boolean);
    return keys.length ? keys.join(".") : null;
  }

  // ---- adapter interface --------------------------------------------------
  function relocate() {
    // mark commented lines + (re)draw inline threads
    lineEls.forEach((row) => row.classList.remove("commented"));
    state.comments.forEach((c) => {
      const range = lineRangeOf(c);
      if (!range) return;
      for (let n = range[0]; n <= range[1]; n++) lineEls[n - 1]?.classList.add("commented");
    });
    renderThreads();
  }

  function reveal(c) {
    const range = lineRangeOf(c);
    if (!range) return;
    const row = lineEls[range[0] - 1];
    if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
    flashLines(c);
    // also highlight the matching inline card
    const card = code.querySelector(`.src-card[data-id="${c.id}"]`);
    if (card) {
      card.classList.add("active");
      setTimeout(() => card.classList.remove("active"), 1200);
    }
  }

  function flashLines(c) {
    const range = lineRangeOf(c);
    if (!range) return;
    for (let n = range[0]; n <= range[1]; n++) {
      const row = lineEls[n - 1];
      if (!row) continue;
      row.classList.add("flash");
      setTimeout(() => row.classList.remove("flash"), 900);
    }
  }

  function setActive(id) {
    lineEls.forEach((row) => row.classList.remove("active-line"));
    const c = state.comments.find((x) => x.id === id);
    if (!c) return;
    const range = lineRangeOf(c);
    if (!range) return;
    for (let n = range[0]; n <= range[1]; n++) lineEls[n - 1]?.classList.add("active-line");
  }

  function clearSelection() {
    clearPaint();
    closeWidget();
  }

  return { mount, relocate, reveal, setActive, clearSelection };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
