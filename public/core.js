// Shared review engine: comment store, persistence, panel/composer UI, and
// AI-prompt generation. Mode-specific behaviour (how a target is displayed and
// how a selection becomes a comment) lives in an "adapter" that the bootstrap
// wires in. This is shared by render mode (HTML iframe) and source mode (raw
// text with line numbers).

export const els = {
  panel: document.getElementById("panel"),
  comments: document.getElementById("comments"),
  count: document.getElementById("count"),
  hint: document.getElementById("hint"),
  copy: document.getElementById("copy"),
  clear: document.getElementById("clear"),
  toast: document.getElementById("copied-toast"),
  fileLabel: document.getElementById("file-label"),
  composer: document.getElementById("composer"),
  composerTarget: document.getElementById("composer-target"),
  composerInput: document.getElementById("composer-input"),
  composerSave: document.getElementById("composer-save"),
  composerCancel: document.getElementById("composer-cancel"),
};

export const state = {
  comments: [],
  nextId: 1,
  meta: { file: "", path: "", dir: "", clean: false, viewMode: "render", lang: "text" },
  storageKey: null,
};

let adapter = null; // set by init()
let pending = null; // selection awaiting a comment
let editingId = null; // comment being edited

// ---------------------------------------------------------------------------
// persistence (localStorage, keyed by absolute path)
function load() {
  if (!state.storageKey) return;
  try {
    const raw = localStorage.getItem(state.storageKey);
    if (!raw) return;
    const data = JSON.parse(raw);
    state.comments = Array.isArray(data.comments) ? data.comments : [];
    state.nextId = state.comments.reduce((m, c) => Math.max(m, c.id), 0) + 1;
  } catch {
    state.comments = [];
  }
}
export function save() {
  if (!state.storageKey) return;
  try {
    localStorage.setItem(
      state.storageKey,
      JSON.stringify({ path: state.meta.path, comments: state.comments })
    );
  } catch {}
}

// ---------------------------------------------------------------------------
// comment mutations — used by adapters that manage their own inline UI
// (e.g. the GitHub-style source view). Each persists + re-renders the panel.
export function addComment(target, body) {
  const c = { id: state.nextId++, ...target, body };
  state.comments.push(c);
  save();
  renderComments();
  return c;
}
export function updateComment(id, body) {
  const c = state.comments.find((x) => x.id === id);
  if (c) {
    c.body = body;
    save();
    renderComments();
  }
  return c;
}
export function deleteComment(id) {
  state.comments = state.comments.filter((x) => x.id !== id);
  save();
  renderComments();
}

// ---------------------------------------------------------------------------
// init: fetch meta, restore comments, let the adapter mount its view
export async function init(makeAdapter) {
  const meta = await (await fetch("/__meta")).json();
  state.meta = meta;
  state.storageKey = "html-comment:" + meta.path;
  els.fileLabel.textContent = meta.file;
  els.fileLabel.title = meta.path;
  document.title = `html-comment — ${meta.file}`;

  if (meta.clean) {
    localStorage.removeItem(state.storageKey);
    state.comments = [];
  } else {
    load();
  }
  loadTemplate(); // restore the user's chosen prompt template

  // makeAdapter may return an adapter, or a "controller" that manages multiple
  // views and exposes its own mount(). Either way it must satisfy the adapter
  // interface (mount/relocate/reveal/setActive/clearSelection).
  adapter = makeAdapter({ state, startComposer, refresh, useAdapter });
  await adapter.mount();
  renderComments();
  adapter.relocate?.();

  // flush + tell the server on tab close (difit-style shutdown)
  window.addEventListener("pagehide", () => {
    save();
    try {
      navigator.sendBeacon("/__bye");
    } catch {}
  });
}

// Swap the active adapter (used when toggling preview/source). The new adapter
// must already be mounted. Re-renders the panel + repositions markers.
export function useAdapter(next) {
  adapter = next;
  renderComments();
  adapter?.relocate?.();
}

// adapters call this after the view changes (scroll/resize/reflow)
export function refresh() {
  adapter?.relocate?.();
}

// ---------------------------------------------------------------------------
// composer (shared popover). `target` is the selection descriptor the adapter
// built; it must carry { kind, selector, label } and optionally { quote, snippet, anchor }.
export function startComposer(target, position) {
  pending = target;
  editingId = null;
  els.composerTarget.textContent = composerLabel(target);
  els.composerInput.value = "";
  placeComposer(position);
  els.composer.classList.remove("hidden");
  els.composerInput.focus();
}

function openEditComposer(c) {
  pending = null;
  editingId = c.id;
  els.composerTarget.textContent = composerLabel(c);
  els.composerInput.value = c.body;
  els.composer.style.top = "120px";
  els.composer.style.left = "calc(50% - 160px)";
  els.composer.classList.remove("hidden");
  els.composerInput.focus();
}

function composerLabel(c) {
  if (c.quote) return `“${truncate(c.quote, 80)}”  ·  ${c.selector}`;
  return c.selector;
}

function placeComposer(pos) {
  const w = 320, h = 160;
  let x = (pos?.x ?? window.innerWidth / 2 - w / 2);
  let y = (pos?.y ?? 120);
  x = Math.max(12, Math.min(x, window.innerWidth - w - 12));
  y = Math.max(12, Math.min(y, window.innerHeight - h - 12));
  els.composer.style.left = `${x}px`;
  els.composer.style.top = `${y}px`;
}

function closeComposer() {
  els.composer.classList.add("hidden");
  pending = null;
  editingId = null;
}

function saveComposer() {
  const body = els.composerInput.value.trim();
  if (!body) {
    els.composerInput.focus();
    return;
  }
  if (editingId != null) {
    const c = state.comments.find((c) => c.id === editingId);
    if (c) c.body = body;
  } else if (pending) {
    state.comments.push({ id: state.nextId++, ...pending, body });
  }
  save();
  closeComposer();
  renderComments();
  adapter?.relocate?.();
  adapter?.clearSelection?.();
}

els.composerSave.addEventListener("click", saveComposer);
els.composerCancel.addEventListener("click", closeComposer);
els.composerInput.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") saveComposer();
  if (e.key === "Escape") closeComposer();
});

// ---------------------------------------------------------------------------
// comment list rendering
export function renderComments() {
  els.count.textContent = String(state.comments.length);
  els.copy.disabled = state.comments.length === 0;
  els.clear.disabled = state.comments.length === 0;
  els.hint.style.display = state.comments.length ? "none" : "block";

  els.comments.innerHTML = "";
  state.comments.forEach((c, i) => {
    const li = document.createElement("li");
    li.className = "comment";
    li.dataset.id = c.id;

    const head = document.createElement("div");
    head.className = "comment-head";
    head.innerHTML = `
      <span class="comment-num">${i + 1}</span>
      <span class="comment-kind">${kindLabel(c)}</span>
    `;
    const copyOne = document.createElement("button");
    copyOne.className = "comment-copy";
    copyOne.textContent = "📋";
    copyOne.title = "このコメントだけAIプロンプトとしてコピー";
    copyOne.addEventListener("click", (e) => {
      e.stopPropagation();
      copyText(buildPrompt([c]));
      flashToast(copyOne);
    });
    const del = document.createElement("button");
    del.className = "comment-del";
    del.textContent = "🗑";
    del.title = "削除";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      state.comments = state.comments.filter((x) => x.id !== c.id);
      save();
      renderComments();
      adapter?.relocate?.();
    });
    head.appendChild(copyOne);
    head.appendChild(del);
    li.appendChild(head);

    if (c.quote) {
      const q = document.createElement("div");
      q.className = "comment-quote";
      q.textContent = `“${truncate(c.quote, 160)}”`;
      li.appendChild(q);
    }
    const sel = document.createElement("div");
    sel.className = "comment-sel";
    sel.textContent = c.selector;
    li.appendChild(sel);

    const body = document.createElement("div");
    body.className = "comment-body";
    body.textContent = c.body;
    li.appendChild(body);

    li.addEventListener("click", () => {
      setActive(c.id);
      adapter?.reveal?.(c);
    });
    li.addEventListener("dblclick", () => openEditComposer(c));
    els.comments.appendChild(li);
  });
}

function kindLabel(c) {
  if (c.kind === "lines") return c.range ? `L${c.range[0]}-L${c.range[1]}` : `L${c.line}`;
  const at = c.mdLine || c.srcLine ? ` · L${c.mdLine || c.srcLine}` : "";
  if (c.kind === "text") return "テキスト" + at;
  if (c.kind === "element") return "要素" + at;
  return c.kind || "";
}

export function setActive(id) {
  document.querySelectorAll(".comment").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.id) === id);
  });
  adapter?.setActive?.(id);
}

// ---------------------------------------------------------------------------
// clear all
els.clear.addEventListener("click", () => {
  if (!state.comments.length) return;
  if (!confirm("コメントをすべて削除しますか？")) return;
  state.comments = [];
  save();
  renderComments();
  adapter?.relocate?.();
});

// ---------------------------------------------------------------------------
// copy → AI prompt
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

function flashToast(btn) {
  const prev = btn.textContent;
  btn.textContent = "✓";
  btn.classList.add("copied");
  setTimeout(() => {
    btn.textContent = prev;
    btn.classList.remove("copied");
  }, 1000);
}

els.copy.addEventListener("click", async () => {
  await copyText(buildPrompt(state.comments));
  els.toast.classList.add("show");
  setTimeout(() => els.toast.classList.remove("show"), 1600);
});

// ---------------------------------------------------------------------------
// Prompt templates. The user picks a preset (or edits a custom one) in the
// settings drawer. A template is plain text with placeholders:
//   {{file}}     → absolute path of the target
//   {{count}}    → number of comments
//   {{comments}} → the formatted list of comments (locator + snippet + note)
// The {{comments}} block is generated by formatComments() so every mode
// (HTML/Markdown/source) produces consistent, actionable locators.
export const TEMPLATE_PRESETS = {
  fix: {
    label: "修正を依頼",
    body:
      "以下は `{{file}}` のレビューコメントです（{{count}}件）。各コメントに従ってファイルを修正してください。\n" +
      "対象箇所を特定するための位置情報（セレクタ／行番号など）と、必要に応じて該当箇所の内容を記載しています。\n\n" +
      "{{comments}}\n\n" +
      "---\n" +
      "修正後は、変更箇所と変更理由を簡潔に説明してください。" +
      "位置情報が複数箇所にマッチする場合は、コメントの意図に最も合う箇所を選んでください。",
  },
  question: {
    label: "質問する",
    body:
      "以下は `{{file}}` に対する質問・確認事項です（{{count}}件）。\n" +
      "それぞれの箇所について、質問に回答してください。修正はまだ行わず、まず説明と提案をお願いします。\n\n" +
      "{{comments}}\n\n" +
      "---\n" +
      "不明点があれば質問し返してください。",
  },
  review: {
    label: "レビュー観点で意見",
    body:
      "以下は `{{file}}` のレビューコメントです（{{count}}件）。\n" +
      "各箇所について、指摘の妥当性・代替案・潜在的な問題を、レビュアーの視点で評価してください。\n\n" +
      "{{comments}}\n\n" +
      "---\n" +
      "総合的な所感と、優先して対応すべき項目があれば最後にまとめてください。",
  },
  plain: {
    label: "コメントのみ（指示文なし）",
    body: "{{file}}（{{count}}件）\n\n{{comments}}",
  },
};

export const DEFAULT_TEMPLATE_KEY = "fix";

// active template state (restored from localStorage in init)
export const template = { key: DEFAULT_TEMPLATE_KEY, customBody: null };

function templateStorageKey() {
  return "html-comment:template"; // global, not per-file
}
export function loadTemplate() {
  try {
    const raw = localStorage.getItem(templateStorageKey());
    if (raw) {
      const t = JSON.parse(raw);
      if (t.key) template.key = t.key;
      if (typeof t.customBody === "string") template.customBody = t.customBody;
    }
  } catch {}
}
export function saveTemplate() {
  try {
    localStorage.setItem(templateStorageKey(), JSON.stringify(template));
  } catch {}
}
// The currently-effective template body (custom overrides the preset).
export function currentTemplateBody() {
  if (template.key === "custom") return template.customBody || "";
  return TEMPLATE_PRESETS[template.key]?.body || TEMPLATE_PRESETS[DEFAULT_TEMPLATE_KEY].body;
}

// Format one comment into its locator + snippet + note block.
function formatComment(c, index, total) {
  const fullPath = state.meta.path || state.meta.file || "the file";
  const single = total === 1;
  const out = [];
  out.push(single ? `## コメント` : `## コメント ${index + 1}`);
  out.push(`- 対象ファイル: \`${fullPath}\``);
  if (c.kind === "lines") {
    const ref = c.range ? `L${c.range[0]}-L${c.range[1]}` : `L${c.line}`;
    out.push(`- 対象行: \`${ref}\``);
    if (c.path) out.push(`- データパス: \`${c.path}\``);
    if (c.snippet) {
      out.push("- 該当箇所:");
      out.push("```" + (state.meta.lang || ""));
      out.push(c.snippet);
      out.push("```");
    }
  } else if (c.mdLine) {
    out.push(`- 対象行(Markdown): \`L${c.mdLine}\``);
    if (c.quote) out.push(`- 対象テキスト: 「${c.quote}」`);
  } else {
    out.push(`- 対象セレクタ: \`${c.selector}\``);
    if (c.srcLine) out.push(`- 対象行: \`L${c.srcLine}\``);
    if (c.kind === "text" && c.quote) out.push(`- 対象テキスト: 「${c.quote}」`);
    if (c.kind === "element" && c.snippet) {
      out.push("- 該当HTML:");
      out.push("```html");
      out.push(c.snippet);
      out.push("```");
    }
  }
  out.push(`- 指摘 / 修正指示:`);
  out.push(`  ${c.body.replace(/\n/g, "\n  ")}`);
  return out.join("\n");
}

export function formatComments(list) {
  return list.map((c, i) => formatComment(c, i, list.length)).join("\n\n");
}

// Build an AI prompt for a subset (all, or one) by filling the active template.
export function buildPrompt(subset) {
  const list = subset && subset.length ? subset : state.comments;
  const fullPath = state.meta.path || state.meta.file || "the file";
  const body = currentTemplateBody();
  return body
    .replace(/\{\{\s*file\s*\}\}/g, fullPath)
    .replace(/\{\{\s*count\s*\}\}/g, String(list.length))
    .replace(/\{\{\s*comments\s*\}\}/g, formatComments(list));
}

export function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// The source line range a comment refers to, if any — so the source view can
// show preview-made comments inline too. Returns [start, end] or null.
// - line comments carry .line / .range
// - preview comments carry .mdLine (Markdown) or .srcLine (HTML), set by render
export function lineRangeOf(c) {
  if (c.kind === "lines") {
    return c.range ? [c.range[0], c.range[1]] : [c.line, c.line];
  }
  const n = c.mdLine || c.srcLine;
  return n ? [n, n] : null;
}
