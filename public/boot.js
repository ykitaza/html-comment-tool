// Entry point: fetch meta, pick the right adapter for the file's view mode,
// and hand it to the shared review engine.
import { init } from "./core.js";
import { makeRenderAdapter } from "./render.js";
import { makeSourceAdapter } from "./source.js";

init((ctx) => {
  const mode = ctx.state.meta.viewMode;
  // toolbar mode buttons only make sense in render mode
  const toolbar = document.getElementById("toolbar");
  if (mode !== "render" && toolbar) toolbar.classList.add("source-mode");
  return mode === "render" ? makeRenderAdapter(ctx) : makeSourceAdapter(ctx);
});
