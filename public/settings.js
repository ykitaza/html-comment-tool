// Settings drawer (prompt templates) + panel collapse + panel resize.
// Wired up once at boot; independent of which view adapter is active.

import {
  TEMPLATE_PRESETS,
  template,
  saveTemplate,
  currentTemplateBody,
  formatComments,
  state,
} from "./core.js";

const PANEL_WIDTH_KEY = "html-comment:panelWidth";
const PANEL_OPEN_KEY = "html-comment:panelOpen";

export function initSettings() {
  setupPanelToggle();
  setupResizer();
  setupDrawer();
}

// ---------------------------------------------------------------------------
// collapse / expand the comment panel
function setupPanelToggle() {
  const app = document.getElementById("app");
  const showBtn = document.getElementById("show-panel");
  const collapseBtn = document.getElementById("collapse-panel");
  const toggleBtn = document.getElementById("toggle-panel");

  function setOpen(open) {
    app.classList.toggle("panel-collapsed", !open);
    showBtn.classList.toggle("hidden", open);
    try {
      localStorage.setItem(PANEL_OPEN_KEY, open ? "1" : "0");
    } catch {}
  }
  const saved = localStorage.getItem(PANEL_OPEN_KEY);
  if (saved === "0") setOpen(false);

  collapseBtn?.addEventListener("click", () => setOpen(false));
  toggleBtn?.addEventListener("click", () =>
    setOpen(app.classList.contains("panel-collapsed"))
  );
  showBtn?.addEventListener("click", () => setOpen(true));
}

// ---------------------------------------------------------------------------
// drag-resize the panel width
function setupResizer() {
  const app = document.getElementById("app");
  const resizer = document.getElementById("resizer");
  if (!resizer) return;

  const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
  if (saved >= 240 && saved <= 900) setWidth(saved);

  let dragging = false;
  resizer.addEventListener("mousedown", (e) => {
    dragging = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = Math.min(900, Math.max(240, window.innerWidth - e.clientX));
    setWidth(w);
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    const w = parseInt(getComputedStyle(app).gridTemplateColumns.split(" ").pop());
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(w));
    } catch {}
  });

  function setWidth(px) {
    app.style.setProperty("--panel-w", `${px}px`);
  }
}

// ---------------------------------------------------------------------------
// the prompt-template settings drawer
function setupDrawer() {
  const drawer = document.getElementById("settings");
  const backdrop = document.getElementById("settings-backdrop");
  const openBtn = document.getElementById("open-settings");
  const closeBtn = document.getElementById("settings-close");
  const sel = document.getElementById("template-select");
  const body = document.getElementById("template-body");
  const preview = document.getElementById("template-preview");
  const saveBtn = document.getElementById("template-save");
  const resetBtn = document.getElementById("template-reset");

  // populate the dropdown: presets + custom
  for (const [key, t] of Object.entries(TEMPLATE_PRESETS)) {
    sel.appendChild(new Option(t.label, key));
  }
  sel.appendChild(new Option("カスタム", "custom"));

  function syncFromState() {
    sel.value = template.key;
    body.value = currentTemplateBody();
    refreshPreview();
  }

  function refreshPreview() {
    // preview using the textarea's current content against current comments
    const tpl = body.value;
    const list = state.comments;
    const fullPath = state.meta.path || state.meta.file || "the file";
    preview.textContent = tpl
      .replace(/\{\{\s*file\s*\}\}/g, fullPath)
      .replace(/\{\{\s*count\s*\}\}/g, String(list.length))
      .replace(/\{\{\s*comments\s*\}\}/g, list.length ? formatComments(list) : "（コメントなし）");
  }

  function open() {
    syncFromState();
    drawer.classList.remove("hidden");
    backdrop.classList.remove("hidden");
  }
  function close() {
    drawer.classList.add("hidden");
    backdrop.classList.add("hidden");
  }

  openBtn?.addEventListener("click", open);
  closeBtn?.addEventListener("click", close);
  backdrop?.addEventListener("click", close);

  sel.addEventListener("change", () => {
    template.key = sel.value;
    body.value = currentTemplateBody();
    saveTemplate();
    refreshPreview();
  });

  body.addEventListener("input", refreshPreview);

  saveBtn.addEventListener("click", () => {
    // editing always becomes "custom" unless it still equals the preset
    const presetBody = TEMPLATE_PRESETS[sel.value]?.body;
    if (sel.value !== "custom" && body.value === presetBody) {
      template.key = sel.value;
      template.customBody = null;
    } else {
      template.key = "custom";
      template.customBody = body.value;
      sel.value = "custom";
    }
    saveTemplate();
    refreshPreview();
    flash(saveBtn, "保存しました");
  });

  resetBtn.addEventListener("click", () => {
    const key = sel.value === "custom" ? "fix" : sel.value;
    template.key = key;
    template.customBody = null;
    sel.value = key;
    body.value = currentTemplateBody();
    saveTemplate();
    refreshPreview();
  });
}

function flash(btn, label) {
  const prev = btn.textContent;
  btn.textContent = "✓ " + label;
  setTimeout(() => (btn.textContent = prev), 1200);
}
