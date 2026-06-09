// Render-mode adapter: show the target HTML in an iframe and let the user
// comment by clicking an element or selecting text. Produces "element" and
// "text" comments carrying a robust CSS selector + an HTML snippet.

import { truncate } from "./core.js";

export function makeRenderAdapter({ state, startComposer }) {
  const frameWrap = document.getElementById("frame-wrap");
  let iframe, hoverBox, markers;
  let mode = "element"; // element | text | off
  let pumlLines = null; // .puml source lines (for plantuml label→line mapping)

  function doc() {
    return iframe.contentDocument || iframe.contentWindow.document;
  }
  function win() {
    return iframe.contentWindow;
  }

  async function mount() {
    // (re)build the stage: iframe + overlay layers
    frameWrap.innerHTML = "";
    iframe = document.createElement("iframe");
    iframe.id = "target";
    iframe.title = "target";
    // In a host without an HTTP server (VS Code webview), the preview HTML is
    // injected as a string; load it via srcdoc (same-origin → clickable).
    // Otherwise load the CLI's /target endpoint.
    if (typeof window.__PREVIEW_HTML__ === "string") {
      iframe.srcdoc = window.__PREVIEW_HTML__;
    } else {
      iframe.src = "/target";
    }
    markers = document.createElement("div");
    markers.id = "markers";
    hoverBox = document.createElement("div");
    hoverBox.id = "hover-box";
    frameWrap.appendChild(iframe);
    frameWrap.appendChild(markers);
    frameWrap.appendChild(hoverBox);

    setupToolbar();
    // for PlantUML, load the source lines so clicks can map labels → line refs
    if (state.meta.previewKind === "plantuml" && pumlLines === null) {
      try {
        const text = await (await fetch("/__source")).text();
        pumlLines = text.replace(/\r\n?/g, "\n").split("\n");
      } catch {
        pumlLines = [];
      }
    }
    await new Promise((res) => {
      iframe.addEventListener("load", () => {
        attachFrameListeners();
        relocate();
        res();
      });
    });
  }

  function setupToolbar() {
    const map = { element: "mode-element", text: "mode-text", off: "mode-off" };
    for (const [m, id] of Object.entries(map)) {
      const old = document.getElementById(id);
      if (!old) continue;
      // replace with a clone to drop any listeners from a previous mount
      const btn = old.cloneNode(true);
      old.replaceWith(btn);
      btn.addEventListener("click", () => setMode(m));
    }
    // drawio is a cross-origin iframe (view-only). Everything else defaults to
    // element-select. PlantUML is same-origin inline SVG, so clicks work — but
    // we locate via the clicked label's text + source line (IDs are unstable).
    setMode(state.meta.previewKind === "drawio" ? "off" : "element");
  }

  function setMode(m) {
    mode = m;
    const map = { element: "mode-element", text: "mode-text", off: "mode-off" };
    for (const [k, id] of Object.entries(map)) {
      document.getElementById(id)?.classList.toggle("active", k === m);
    }
    frameWrap.classList.remove("mode-element", "mode-text");
    if (m === "element") frameWrap.classList.add("mode-element");
    if (m === "text") frameWrap.classList.add("mode-text");
    hideHover();
  }

  function attachFrameListeners() {
    const d = doc();
    d.addEventListener("mousemove", onHover, true);
    d.addEventListener("mouseleave", hideHover, true);
    d.addEventListener("click", onClick, true);
    d.addEventListener("mouseup", onMouseUp, true);
    win().addEventListener("scroll", relocate, true);
    win().addEventListener("resize", relocate);
  }

  // ---- hover highlight ----------------------------------------------------
  function onHover(e) {
    if (mode !== "element") return hideHover();
    const el = e.target;
    if (!el || el === doc().body || el === doc().documentElement) return hideHover();
    const r = el.getBoundingClientRect();
    const fr = iframe.getBoundingClientRect();
    const base = frameWrap.getBoundingClientRect();
    Object.assign(hoverBox.style, {
      display: "block",
      top: `${r.top + fr.top - base.top}px`,
      left: `${r.left + fr.left - base.left}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  }
  function hideHover() {
    if (hoverBox) hoverBox.style.display = "none";
  }

  // ---- selection → comment ------------------------------------------------
  function onClick(e) {
    if (mode !== "element") return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    if (!el) return;
    if (state.meta.previewKind === "plantuml") return onPlantumlClick(el, e);
    startComposer(
      {
        kind: "element",
        selector: cssPath(el),
        snippet: outerHtmlSnippet(el),
        label: describeEl(el),
        ...lineRefOf(el), // mdLine (Markdown) or srcLine (HTML) for sync
        anchor: { fx: 0.5, fy: 0.5 },
      },
      framePos(e)
    );
  }

  // PlantUML: SVG element IDs are unstable, so locate by the clicked label's
  // text and map it back to the first matching line in the .puml source.
  function onPlantumlClick(el, e) {
    // climb to a node that carries readable text (the SVG <text> or its group)
    let label = (el.textContent || "").trim().replace(/\s+/g, " ");
    if (!label && el.closest) {
      const g = el.closest("g");
      if (g) label = (g.textContent || "").trim().replace(/\s+/g, " ");
    }
    const srcLine = label ? findPumlLine(label) : null;
    startComposer(
      {
        kind: "element",
        selector: label ? `図要素「${truncate(label, 30)}」` : "図要素",
        label,
        quote: label || undefined,
        srcLine: srcLine || undefined,
        anchor: { fx: 0.5, fy: 0.5 },
      },
      framePos(e)
    );
  }

  // first source line whose text contains the label (longest-token match)
  function findPumlLine(label) {
    if (!pumlLines) return null;
    const needle = label.split(/\s+/).sort((a, b) => b.length - a.length)[0] || label;
    for (let i = 0; i < pumlLines.length; i++) {
      if (pumlLines[i].includes(needle)) return i + 1;
    }
    return null;
  }

  function onMouseUp(e) {
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
    startComposer(
      {
        kind: "text",
        selector: cssPath(container),
        quote: text,
        label: describeEl(container),
        ...lineRefOf(container),
        anchor: { fx: 0.05, fy: 0.1 },
      },
      framePos(e)
    );
  }

  // Nearest ancestor's source line number, for preview→source sync.
  // Markdown blocks carry data-md-line; injected HTML carries data-line.
  function lineRefOf(el) {
    let n = el;
    while (n && n.nodeType === 1) {
      if (n.dataset?.mdLine) return { mdLine: Number(n.dataset.mdLine) };
      if (n.dataset?.line) return { srcLine: Number(n.dataset.line) };
      n = n.parentElement;
    }
    return {};
  }

  function framePos(e) {
    const fr = iframe.getBoundingClientRect();
    return { x: (e.clientX ?? 0) + fr.left + 12, y: (e.clientY ?? 0) + fr.top + 12 };
  }

  // ---- pins ---------------------------------------------------------------
  function relocate() {
    if (!markers) return;
    markers.innerHTML = "";
    const fr = iframe.getBoundingClientRect();
    const base = frameWrap.getBoundingClientRect();
    const frTop = fr.top - base.top;
    const frLeft = fr.left - base.left;
    state.comments.forEach((c, i) => {
      if (!c.anchor || !c.selector) return;
      const el = resolve(c);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const pin = document.createElement("div");
      pin.className = "pin";
      pin.dataset.id = c.id;
      pin.style.left = `${r.left + (c.anchor.fx ?? 0) * r.width + frLeft}px`;
      pin.style.top = `${r.top + (c.anchor.fy ?? 0) * r.height + frTop}px`;
      pin.innerHTML = `<span>${i + 1}</span>`;
      pin.addEventListener("click", () => {
        document.querySelector(`.comment[data-id="${c.id}"]`)?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      });
      markers.appendChild(pin);
    });
  }

  function resolve(c) {
    // PlantUML comments aren't located by CSS selector (unstable IDs) but by
    // the clicked label's text — re-find the matching SVG <text> element so
    // the pin reappears after the diagram is re-rendered (e.g. view toggle).
    if (state.meta.previewKind === "plantuml") {
      const label = (c.quote || "").trim();
      if (!label) return null;
      const texts = doc().querySelectorAll("svg text");
      for (const t of texts) {
        if ((t.textContent || "").trim() === label) return t;
      }
      // fall back to a partial match on the longest token
      const needle = label.split(/\s+/).sort((a, b) => b.length - a.length)[0] || label;
      for (const t of texts) {
        if ((t.textContent || "").includes(needle)) return t;
      }
      return null;
    }
    try {
      return doc().querySelector(c.selector);
    } catch {
      return null;
    }
  }

  function reveal(c) {
    const el = resolve(c);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(relocate, 350);
    }
  }

  function setActive(id) {
    document.querySelectorAll(".pin").forEach((el) => {
      el.classList.toggle("active", Number(el.dataset.id) === id);
    });
  }

  function clearSelection() {
    try {
      win().getSelection().removeAllRanges();
    } catch {}
  }

  // ---- CSS selector generation -------------------------------------------
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id && uniqueId(el.id)) return `#${esc(el.id)}`;
    const parts = [];
    let node = el;
    const d = doc();
    while (node && node.nodeType === 1 && node !== d.body && node !== d.documentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id && uniqueId(node.id)) {
        parts.unshift(`#${esc(node.id)}`);
        break;
      }
      const cls = stableClass(node);
      if (cls) part += `.${esc(cls)}`;
      const idx = siblingIndex(node);
      if (idx != null) part += `:nth-of-type(${idx})`;
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ") || el.tagName.toLowerCase();
  }
  function uniqueId(id) {
    try {
      return doc().querySelectorAll(`#${esc(id)}`).length === 1;
    } catch {
      return false;
    }
  }
  function stableClass(node) {
    const list = Array.from(node.classList || []);
    return (
      list.find(
        (c) =>
          c.length > 1 &&
          !/^(is-|has-|js-|active|open|hover|ng-|css-)/.test(c) &&
          !/\d{4,}/.test(c)
      ) || null
    );
  }
  function siblingIndex(node) {
    const parent = node.parentElement;
    if (!parent) return null;
    const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
    return same.length <= 1 ? null : same.indexOf(node) + 1;
  }
  function esc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function outerHtmlSnippet(el, max = 400) {
    let html = el.outerHTML || "";
    if (html.length > max) {
      const open = html.match(/^<[^>]+>/);
      const close = html.match(/<\/[^>]+>\s*$/);
      html = open && close ? `${open[0]} … ${close[0]}` : html.slice(0, max) + " …";
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

  return { mount, relocate, reveal, setActive, clearSelection };
}
