// drawio editable-PNG adapter. Shows the PNG (offline, exact), and overlays a
// clickable region per shape using geometry from the embedded XML. Clicking a
// shape captures its id/label + source line so the comment maps to the XML.

export function makeDrawioPngAdapter({ startComposer }) {
  const frameWrap = document.getElementById("frame-wrap");
  let iframe;
  let shapes = [];
  let bbox = null;

  async function mount() {
    frameWrap.innerHTML = "";
    iframe = document.createElement("iframe");
    iframe.id = "target";
    iframe.title = "target";
    iframe.src = "/target";
    frameWrap.appendChild(iframe);

    try {
      const data = await (await fetch("/__drawiopng-shapes")).json();
      shapes = data.shapes || [];
      bbox = data.bbox;
    } catch {
      shapes = [];
    }

    await new Promise((res) => {
      iframe.addEventListener("load", () => {
        buildOverlay();
        res();
      });
    });
  }

  function doc() {
    return iframe.contentDocument || iframe.contentWindow.document;
  }

  // Build a clickable region per shape, positioned over the rendered image by
  // mapping XML coords (bbox) → image pixels. Re-runs on image load/resize.
  function buildOverlay() {
    const d = doc();
    const img = d.getElementById("img");
    const wrap = d.getElementById("wrap");
    if (!img || !wrap || !bbox) return;

    const place = () => {
      // remove old regions
      wrap.querySelectorAll(".hc-shape").forEach((e) => e.remove());
      const iw = img.clientWidth, ih = img.clientHeight;
      if (!iw || !ih) return;
      // The drawio PNG export crops to the diagram bbox with a small margin.
      // Map shape coords within [minX..maxX] to [0..iw]. This assumes the image
      // is the diagram bbox; a small uniform inset handles the export margin.
      const bw = bbox.maxX - bbox.minX || 1;
      const bh = bbox.maxY - bbox.minY || 1;
      const sx = iw / bw;
      const sy = ih / bh;
      for (const s of shapes) {
        const el = d.createElement("div");
        el.className = "hc-shape";
        el.style.left = `${(s.x - bbox.minX) * sx}px`;
        el.style.top = `${(s.y - bbox.minY) * sy}px`;
        el.style.width = `${s.w * sx}px`;
        el.style.height = `${s.h * sy}px`;
        el.title = s.label || s.id;
        el.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openComposer(s, e);
        });
        wrap.appendChild(el);
      }
    };

    if (img.complete) place();
    else img.addEventListener("load", place);
    // reposition on container resize
    if (iframe.contentWindow)
      iframe.contentWindow.addEventListener("resize", place);
    relocateFns.place = place;
  }

  const relocateFns = { place: null };

  function openComposer(shape, e) {
    const fr = iframe.getBoundingClientRect();
    startComposer(
      {
        kind: "element",
        selector: `図形「${shape.label || shape.id}」`,
        label: shape.label || shape.id,
        quote: shape.label || undefined,
        shapeId: shape.id,
        srcLine: shape.line || undefined,
        anchor: { fx: 0.5, fy: 0.5 },
      },
      { x: e.clientX + fr.left + 12, y: e.clientY + fr.top + 12 }
    );
  }

  // adapter interface
  function relocate() {
    // mark commented shapes + reflow overlay
    relocateFns.place?.();
    const d = doc();
    d.querySelectorAll(".hc-shape").forEach((el) => el.classList.remove("commented"));
    // (visual marker handled via title; pins not needed on image)
  }
  function reveal() {/* image view: nothing to scroll precisely */}
  function setActive() {}
  function clearSelection() {}

  return { mount, relocate, reveal, setActive, clearSelection };
}
