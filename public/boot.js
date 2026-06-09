// Entry point. Builds a controller that owns up to two views — PREVIEW
// (rendered) and SOURCE (raw text) — and an Obsidian-style toggle between them.
// Each view is its own adapter; the controller mounts them lazily and tells the
// core engine which one is active.
import { init, useAdapter } from "./core.js";
import { makeRenderAdapter } from "./render.js";
import { makeSourceAdapter } from "./source.js";

init((ctx) => {
  const { state } = ctx;
  const previewKind = state.meta.previewKind; // html | markdown | none
  const hasPreview = previewKind !== "none";

  const toggle = document.getElementById("view-toggle");
  const btnPreview = document.getElementById("view-preview");
  const btnSource = document.getElementById("view-source");
  const toolbar = document.getElementById("toolbar");
  const frameWrap = document.getElementById("frame-wrap");

  let current = null; // "preview" | "source"
  let active = null; // the currently-mounted adapter

  // The render adapter serves both HTML and Markdown previews (both iframes).
  const factories = {
    preview: () => makeRenderAdapter(ctx),
    source: () => makeSourceAdapter(ctx),
  };

  // Mount a view fresh. Re-mounting is cheap: source re-fetches text, preview
  // reloads the iframe. This keeps element refs valid and state simple — the
  // comment store lives in core, so nothing is lost across switches.
  async function show(view) {
    if (view === current) return;
    frameWrap.innerHTML = "";
    const a = factories[view]();
    await a.mount();
    active = a;
    current = view;
    syncButtons();
    syncToolbar();
    useAdapter(a);
  }

  function syncButtons() {
    btnPreview?.classList.toggle("active", current === "preview");
    btnSource?.classList.toggle("active", current === "source");
  }
  function syncToolbar() {
    // selection sub-modes only make sense in HTML preview
    const showModes = current === "preview" && previewKind === "html";
    toolbar.classList.toggle("source-mode", !showModes);
  }

  // controller satisfies the adapter interface via the active sub-adapter
  const controller = {
    async mount() {
      if (hasPreview) {
        toggle.hidden = false;
        btnPreview.addEventListener("click", () => show("preview"));
        btnSource.addEventListener("click", () => show("source"));
      } else {
        toggle.hidden = true;
      }
      const start = state.meta.defaultView === "source" || !hasPreview ? "source" : "preview";
      frameWrap.innerHTML = "";
      active = factories[start]();
      await active.mount();
      current = start;
      syncButtons();
      syncToolbar();
      // core will call relocate() on the returned object; delegate below
    },
    relocate: () => active?.relocate?.(),
    reveal: (c) => active?.reveal?.(c),
    setActive: (id) => active?.setActive?.(id),
    clearSelection: () => active?.clearSelection?.(),
  };
  return controller;
});
