// html-comment overlay logic
// Runs in the wrapper page (same origin as the target), so it can freely
// reach into the iframe's document.

const iframe = document.getElementById("target");
const frameWrap = document.getElementById("frame-wrap");
const hoverBox = document.getElementById("hover-box");
const markers = document.getElementById("markers");
const commentsEl = document.getElementById("comments");
const countEl = document.getElementById("count");
const hintEl = document.getElementById("hint");
const copyBtn = document.getElementById("copy");
const clearBtn = document.getElementById("clear");
const toast = document.getElementById("copied-toast");
const fileLabel = document.getElementById("file-label");

const composer = document.getElementById("composer");
const composerTarget = document.getElementById("composer-target");
const composerInput = document.getElementById("composer-input");
const composerSave = document.getElementById("composer-save");
const composerCancel = document.getElementById("composer-cancel");

const modeBtns = {
  element: document.getElementById("mode-element"),
  text: document.getElementById("mode-text"),
  off: document.getElementById("mode-off"),
};

let mode = "element"; // element | text | off
let comments = [];
let nextId = 1;
let pending = null; // the in-progress selection awaiting a comment
let editingId = null; // id of comment being edited (reuse composer)

// target metadata, filled from /__meta
let meta = { file: "", path: "", dir: "", clean: false };
let storageKey = null;

// ---------------------------------------------------------------------------
// persistence (localStorage, keyed by the target's absolute path)
function load() {
  if (!storageKey) return;
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return;
    const data = JSON.parse(raw);
    comments = Array.isArray(data.comments) ? data.comments : [];
    nextId = comments.reduce((m, c) => Math.max(m, c.id), 0) + 1;
  } catch {
    comments = [];
  }
}
function save() {
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify({ path: meta.path, comments }));
  } catch {}
}

// ---------------------------------------------------------------------------
// meta — must resolve before we can load saved comments
fetch("/__meta")
  .then((r) => r.json())
  .then((m) => {
    meta = m;
    storageKey = "html-comment:" + m.path;
    fileLabel.textContent = m.file;
    fileLabel.title = m.path; // full path on hover
    document.title = `html-comment — ${m.file}`;
    if (m.clean) {
      localStorage.removeItem(storageKey);
      comments = [];
    } else {
      load();
    }
    renderComments();
    renderPins();
  })
  .catch(() => {});

// flush on tab close + tell the server (so it can shut down like difit)
window.addEventListener("pagehide", () => {
  save();
  try {
    navigator.sendBeacon("/__bye");
  } catch {}
});

// ---------------------------------------------------------------------------
// iframe document access
function doc() {
  return iframe.contentDocument || iframe.contentWindow.document;
}
function win() {
  return iframe.contentWindow;
}

iframe.addEventListener("load", () => {
  attachFrameListeners();
  renderPins();
});

function attachFrameListeners() {
  const d = doc();
  d.addEventListener("mousemove", onFrameHover, true);
  d.addEventListener("mouseleave", hideHover, true);
  d.addEventListener("click", onFrameClick, true);
  d.addEventListener("mouseup", onFrameMouseUp, true);
  // reposition pins on scroll/resize inside the frame
  win().addEventListener("scroll", renderPins, true);
  win().addEventListener("resize", renderPins);
}

// ---------------------------------------------------------------------------
// mode switching
function setMode(m) {
  mode = m;
  for (const [k, btn] of Object.entries(modeBtns)) {
    btn.classList.toggle("active", k === m);
  }
  frameWrap.classList.remove("mode-element", "mode-text");
  if (m === "element") frameWrap.classList.add("mode-element");
  if (m === "text") frameWrap.classList.add("mode-text");
  hideHover();
}
modeBtns.element.addEventListener("click", () => setMode("element"));
modeBtns.text.addEventListener("click", () => setMode("text"));
modeBtns.off.addEventListener("click", () => setMode("off"));
setMode("element");

// ---------------------------------------------------------------------------
// hover highlight (element mode only)
function onFrameHover(e) {
  if (mode !== "element") return hideHover();
  const el = e.target;
  if (!el || el === doc().body || el === doc().documentElement) return hideHover();
  showHoverFor(el);
}

function showHoverFor(el) {
  const r = el.getBoundingClientRect();
  const fr = iframe.getBoundingClientRect();
  // offset by toolbar/frame position within the wrapper
  const top = r.top + fr.top - frameWrap.getBoundingClientRect().top;
  const left = r.left + fr.left - frameWrap.getBoundingClientRect().left;
  Object.assign(hoverBox.style, {
    display: "block",
    top: `${top}px`,
    left: `${left}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
}
function hideHover() {
  hoverBox.style.display = "none";
}

// ---------------------------------------------------------------------------
// element click → start a comment
function onFrameClick(e) {
  if (mode !== "element") return;
  e.preventDefault();
  e.stopPropagation();
  const el = e.target;
  if (!el) return;
  const selector = cssPath(el);
  const snippet = outerHtmlSnippet(el);
  const label = describeEl(el);
  startComposer(
    {
      kind: "element",
      selector,
      snippet,
      label,
      anchor: anchorPoint(el),
    },
    e
  );
}

// text selection → start a comment
function onFrameMouseUp(e) {
  if (mode !== "text") return;
  const sel = win().getSelection();
  if (!sel || sel.isCollapsed) return;
  const text = sel.toString().trim();
  if (!text) return;
  const range = sel.getRangeAt(0);
  const container =
    range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  const selector = cssPath(container);
  startComposer(
    {
      kind: "text",
      selector,
      quote: text,
      label: describeEl(container),
      anchor: rangeAnchor(range),
    },
    e
  );
}

// ---------------------------------------------------------------------------
// composer
function startComposer(target, evt) {
  pending = target;
  editingId = null;
  composerTarget.textContent =
    target.kind === "text"
      ? `“${truncate(target.quote, 80)}”  ·  ${target.selector}`
      : target.selector;
  composerInput.value = "";
  positionComposer(evt);
  composer.classList.remove("hidden");
  composerInput.focus();
}

function openEditComposer(c) {
  pending = null;
  editingId = c.id;
  composerTarget.textContent =
    c.kind === "text" ? `“${truncate(c.quote, 80)}”  ·  ${c.selector}` : c.selector;
  composerInput.value = c.body;
  // place near center
  composer.style.top = "120px";
  composer.style.left = `calc(50% - 160px)`;
  composer.classList.remove("hidden");
  composerInput.focus();
}

function positionComposer(evt) {
  // place the popover near the click, but keep it on-screen
  const fr = iframe.getBoundingClientRect();
  let x = (evt?.clientX ?? 0) + fr.left + 12;
  let y = (evt?.clientY ?? 0) + fr.top + 12;
  const w = 320, h = 160;
  x = Math.min(x, window.innerWidth - w - 12);
  y = Math.min(y, window.innerHeight - h - 12);
  x = Math.max(12, x);
  y = Math.max(12, y);
  composer.style.left = `${x}px`;
  composer.style.top = `${y}px`;
}

function closeComposer() {
  composer.classList.add("hidden");
  pending = null;
  editingId = null;
}

function saveComposer() {
  const body = composerInput.value.trim();
  if (!body) {
    composerInput.focus();
    return;
  }
  if (editingId != null) {
    const c = comments.find((c) => c.id === editingId);
    if (c) c.body = body;
  } else if (pending) {
    comments.push({ id: nextId++, ...pending, body });
  }
  save();
  closeComposer();
  renderComments();
  renderPins();
  // clear any text selection
  try { win().getSelection().removeAllRanges(); } catch {}
}

composerSave.addEventListener("click", saveComposer);
composerCancel.addEventListener("click", closeComposer);
composerInput.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") saveComposer();
  if (e.key === "Escape") closeComposer();
});

// ---------------------------------------------------------------------------
// comment list rendering
function renderComments() {
  countEl.textContent = String(comments.length);
  copyBtn.disabled = comments.length === 0;
  clearBtn.disabled = comments.length === 0;
  hintEl.style.display = comments.length ? "none" : "block";

  commentsEl.innerHTML = "";
  comments.forEach((c, i) => {
    const li = document.createElement("li");
    li.className = "comment";
    li.dataset.id = c.id;

    const head = document.createElement("div");
    head.className = "comment-head";
    head.innerHTML = `
      <span class="comment-num">${i + 1}</span>
      <span class="comment-kind">${c.kind === "text" ? "テキスト" : "要素"}</span>
    `;
    const del = document.createElement("button");
    del.className = "comment-del";
    del.textContent = "🗑";
    del.title = "削除";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      comments = comments.filter((x) => x.id !== c.id);
      save();
      renderComments();
      renderPins();
    });
    // per-comment copy (difit-style "Copy Prompt")
    const copyOne = document.createElement("button");
    copyOne.className = "comment-copy";
    copyOne.textContent = "📋";
    copyOne.title = "このコメントだけAIプロンプトとしてコピー";
    copyOne.addEventListener("click", (e) => {
      e.stopPropagation();
      copyText(buildPrompt([c]));
      flashToast(copyOne, "コピー");
    });
    head.appendChild(copyOne);
    head.appendChild(del);
    li.appendChild(head);

    if (c.kind === "text") {
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
      scrollFrameTo(c);
    });
    li.addEventListener("dblclick", () => openEditComposer(c));

    commentsEl.appendChild(li);
  });
}

function setActive(id) {
  document.querySelectorAll(".comment").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.id) === id);
  });
  document.querySelectorAll(".pin").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.id) === id);
  });
}

// ---------------------------------------------------------------------------
// pins on the iframe
function renderPins() {
  markers.innerHTML = "";
  const frTop = iframe.getBoundingClientRect().top - frameWrap.getBoundingClientRect().top;
  const frLeft = iframe.getBoundingClientRect().left - frameWrap.getBoundingClientRect().left;
  comments.forEach((c, i) => {
    if (!c.anchor) return;
    const el = resolveAnchorEl(c);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = r.left + (c.anchor.fx ?? 0) * r.width + frLeft;
    const y = r.top + (c.anchor.fy ?? 0) * r.height + frTop;
    // skip if scrolled out of view
    const pin = document.createElement("div");
    pin.className = "pin";
    pin.dataset.id = c.id;
    pin.style.left = `${x}px`;
    pin.style.top = `${y}px`;
    pin.innerHTML = `<span>${i + 1}</span>`;
    pin.addEventListener("click", () => {
      setActive(c.id);
      const li = commentsEl.querySelector(`[data-id="${c.id}"]`);
      li?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    markers.appendChild(pin);
  });
}

function resolveAnchorEl(c) {
  try {
    return doc().querySelector(c.selector);
  } catch {
    return null;
  }
}

function scrollFrameTo(c) {
  const el = resolveAnchorEl(c);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(renderPins, 350);
  }
}

// anchor = fractional position within the element's box (so pins follow reflow)
function anchorPoint(el) {
  return { fx: 0.5, fy: 0.5 };
}
function rangeAnchor(range) {
  // anchor at the start of the selection, mapped to its container element
  return { fx: 0.05, fy: 0.1 };
}

// ---------------------------------------------------------------------------
// CSS selector generation — robust, prefers id, falls back to nth-of-type path
function cssPath(el) {
  if (!el || el.nodeType !== 1) return "";
  if (el.id && isUniqueId(el.id)) return `#${cssEscape(el.id)}`;

  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== doc().body && node !== doc().documentElement) {
    let part = node.tagName.toLowerCase();
    if (node.id && isUniqueId(node.id)) {
      parts.unshift(`#${cssEscape(node.id)}`);
      break;
    }
    // add a stable class if present and reasonably specific
    const cls = stableClass(node);
    if (cls) part += `.${cssEscape(cls)}`;
    // disambiguate among siblings of the same tag
    const idx = siblingIndex(node);
    if (idx != null) part += `:nth-of-type(${idx})`;
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(" > ") || el.tagName.toLowerCase();
}

function isUniqueId(id) {
  try {
    return doc().querySelectorAll(`#${cssEscape(id)}`).length === 1;
  } catch {
    return false;
  }
}

function stableClass(node) {
  const list = Array.from(node.classList || []);
  // skip utility-ish/state-ish classes that look dynamic
  const good = list.find(
    (c) => c.length > 1 && !/^(is-|has-|js-|active|open|hover|ng-|css-)/.test(c) && !/\d{4,}/.test(c)
  );
  return good || null;
}

function siblingIndex(node) {
  const parent = node.parentElement;
  if (!parent) return null;
  const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
  if (same.length <= 1) return null;
  return same.indexOf(node) + 1;
}

function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// helpers
function outerHtmlSnippet(el, max = 400) {
  let html = el.outerHTML || "";
  // collapse children if huge: keep opening tag + … + closing tag
  if (html.length > max) {
    const open = html.match(/^<[^>]+>/);
    const close = html.match(/<\/[^>]+>\s*$/);
    if (open && close) {
      html = `${open[0]} … ${close[0]}`;
    } else {
      html = html.slice(0, max) + " …";
    }
  }
  return html.trim();
}

function describeEl(el) {
  if (!el) return "";
  let s = el.tagName.toLowerCase();
  if (el.id) s += `#${el.id}`;
  const txt = (el.textContent || "").trim().replace(/\s+/g, " ");
  if (txt) s += ` — “${truncate(txt, 40)}”`;
  return s;
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---------------------------------------------------------------------------
// clear all
clearBtn.addEventListener("click", () => {
  if (!comments.length) return;
  if (!confirm("コメントをすべて削除しますか？")) return;
  comments = [];
  save();
  renderComments();
  renderPins();
});

// ---------------------------------------------------------------------------
// copy → AI prompt
async function copyText(text) {
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

// brief inline confirmation on a button (used by per-comment copy)
function flashToast(btn, label) {
  const prev = btn.textContent;
  btn.textContent = "✓";
  btn.classList.add("copied");
  setTimeout(() => {
    btn.textContent = prev;
    btn.classList.remove("copied");
  }, 1000);
}

copyBtn.addEventListener("click", async () => {
  await copyText(buildPrompt(comments));
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1600);
});

// Build an AI prompt for a given subset of comments (all, or just one).
function buildPrompt(subset) {
  const list = subset && subset.length ? subset : comments;
  const fullPath = meta.path || meta.file || "the HTML file";
  const single = list.length === 1;
  const lines = [];
  lines.push(`以下は \`${fullPath}\` のレビューコメントです。${single ? "コメント" : "各コメント"}に従ってHTMLを修正してください。`);
  lines.push("");
  lines.push(
    "対象要素を特定するためのCSSセレクタと、必要に応じて該当箇所のHTML/テキストを記載しています。"
  );
  lines.push("");
  list.forEach((c, i) => {
    lines.push(single ? `## コメント` : `## コメント ${i + 1}`);
    lines.push(`- 対象ファイル: \`${fullPath}\``);
    lines.push(`- 対象セレクタ: \`${c.selector}\``);
    if (c.kind === "text" && c.quote) {
      lines.push(`- 対象テキスト: 「${c.quote}」`);
    }
    if (c.kind === "element" && c.snippet) {
      lines.push("- 該当HTML:");
      lines.push("```html");
      lines.push(c.snippet);
      lines.push("```");
    }
    lines.push(`- 指摘 / 修正指示:`);
    lines.push(`  ${c.body.replace(/\n/g, "\n  ")}`);
    lines.push("");
  });
  lines.push("---");
  lines.push(
    "修正後は、変更箇所と変更理由を簡潔に説明してください。セレクタが複数要素にマッチする場合は、コメントの意図に最も合う要素を選んでください。"
  );
  return lines.join("\n");
}

// keep pins aligned when the wrapper window resizes
window.addEventListener("resize", renderPins);
