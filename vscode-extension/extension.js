// html-comment VS Code extension.
// Opens the selected file in a Webview that reuses the browser tool's UI
// (public/*.js). A small shim maps the UI's fetch() calls to data the
// extension provides, and persists comments in the workspace state.
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");

// Where the shared UI lives. We bundle a copy of public/ under media/ at
// package time; in dev it can also resolve the sibling ../public.
function uiRoot(context) {
  const bundled = path.join(context.extensionPath, "media");
  if (fs.existsSync(path.join(bundled, "core.js"))) return bundled;
  return path.join(context.extensionPath, "..", "public");
}

// Shared render lib (Markdown→HTML, HTML line injection). Bundled into media/
// at package time; falls back to ../lib in dev. It's ESM, so dynamic-import it.
async function loadRenderLib(context) {
  const bundled = path.join(context.extensionPath, "media", "render-lib.mjs");
  const dev = path.join(context.extensionPath, "..", "lib", "render.js");
  const target = fs.existsSync(bundled) ? bundled : dev;
  return import(require("url").pathToFileURL(target).href);
}

const PREVIEW_KIND_BY_EXT = {
  ".html": "html", ".htm": "html",
  ".md": "markdown", ".markdown": "markdown",
};
const LANG_BY_EXT = {
  ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".xml": "xml",
  ".svg": "xml", ".md": "markdown", ".markdown": "markdown",
  ".html": "html", ".htm": "html", ".csv": "csv", ".txt": "text",
  ".js": "javascript", ".ts": "typescript", ".css": "css",
  ".puml": "plantuml", ".plantuml": "plantuml",
};

function activate(context) {
  const disposable = vscode.commands.registerCommand("htmlComment.review", async (uri) => {
    const target = uri || vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      vscode.window.showWarningMessage("レビューするファイルを選択してください。");
      return;
    }
    openReview(context, target);
  });
  context.subscriptions.push(disposable);
}

async function openReview(context, fileUri) {
  const fsPath = fileUri.fsPath;
  const fileName = path.basename(fsPath);
  const ext = path.extname(fsPath).toLowerCase();

  const panel = vscode.window.createWebviewPanel(
    "htmlCommentReview",
    `Review: ${fileName}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const root = uiRoot(context);
  const webview = panel.webview;
  const uiUri = (f) => webview.asWebviewUri(vscode.Uri.file(path.join(root, f)));

  // read the file's text (source view)
  let source = "";
  try {
    source = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString("utf8");
  } catch (e) {
    source = "";
  }

  // HTML / Markdown get a rendered preview (built on the host); everything else
  // is source-only. drawio/plantuml previews aren't wired into the extension yet.
  const previewKind = PREVIEW_KIND_BY_EXT[ext] || "none";
  let previewHtml = null;
  if (previewKind !== "none") {
    try {
      const lib = await loadRenderLib(context);
      previewHtml =
        previewKind === "markdown"
          ? lib.renderMarkdownDoc(source)
          : lib.injectLineNumbers(source);
    } catch (e) {
      // rendering failed → fall back to source-only
    }
  }

  const meta = {
    file: fileName,
    path: fsPath,
    dir: path.dirname(fsPath),
    clean: false,
    previewKind: previewHtml ? previewKind : "none",
    defaultView: previewHtml ? "preview" : "source",
    lang: LANG_BY_EXT[ext] || "text",
  };

  // restore saved comments from workspace state
  const storeKey = "htmlComment:" + fsPath;
  const saved = context.workspaceState.get(storeKey, null);

  webview.html = buildHtml(webview, uiUri, { meta, source, saved, previewHtml });

  // messages from the webview: persist + clipboard + open-line
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === "save") {
      await context.workspaceState.update(storeKey, msg.payload);
    } else if (msg.type === "copy") {
      await vscode.env.clipboard.writeText(msg.text);
      vscode.window.showInformationMessage("AIプロンプトをコピーしました。");
    } else if (msg.type === "reveal" && typeof msg.line === "number") {
      // jump the real editor to the commented line
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      const pos = new vscode.Position(Math.max(0, msg.line - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  });
}

function buildHtml(webview, uiUri, data) {
  // frame-src 'self' allows the srcdoc preview iframe; https:/'unsafe-eval'
  // let the Markdown preview's mermaid (ESM from cdn.jsdelivr.net) run.
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline' https:`,
    `script-src ${webview.cspSource} 'unsafe-inline' 'unsafe-eval' https:`,
    `font-src ${webview.cspSource} https: data:`,
    `connect-src ${webview.cspSource} https:`,
    `frame-src 'self' data:`,
  ].join("; ");

  // The bootstrap data + a fetch shim are injected before the UI modules load.
  const injected = JSON.stringify(data).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${uiUri("overlay.css")}">
</head>
<body>
  <div id="app">
    <main id="stage">
      <div id="toolbar">
        <span id="file-label">…</span>
        <div id="view-toggle" class="seg" hidden>
          <button id="view-preview" class="seg-btn">👁 プレビュー</button>
          <button id="view-source" class="seg-btn">&lt;&gt; ソース</button>
        </div>
        <span class="spacer"></span>
        <button id="mode-element" class="mode-btn active">⬚ 要素を選択</button>
        <button id="mode-text" class="mode-btn">✎ テキスト選択</button>
        <button id="mode-off" class="mode-btn">✋ 操作モード</button>
        <button id="open-settings" class="icon-btn" title="設定">⚙</button>
        <button id="toggle-panel" class="icon-btn" title="パネル開閉">⟩</button>
      </div>
      <div id="frame-wrap"></div>
    </main>
    <div id="resizer"></div>
    <aside id="panel">
      <header>
        <h1>コメント</h1><span id="count" class="badge">0</span>
        <span class="spacer"></span>
        <button id="collapse-panel" class="icon-btn" title="パネルを隠す">⟩</button>
      </header>
      <div id="hint" class="hint">左の<strong>行をクリック</strong>するか<strong>範囲を選択（ドラッグ）</strong>するとコメントを追加できます。</div>
      <ul id="comments"></ul>
      <footer>
        <button id="copy" class="primary" disabled>📋 AIプロンプトをコピー</button>
        <button id="clear" class="ghost" disabled>すべて削除</button>
        <div id="copied-toast" class="toast">コピーしました</div>
      </footer>
    </aside>
  </div>

  <button id="show-panel" class="show-panel hidden">⟨ コメント</button>

  <div id="settings" class="drawer hidden">
    <div class="drawer-head"><h2>設定 — プロンプトテンプレート</h2><button id="settings-close" class="icon-btn">✕</button></div>
    <div class="drawer-body">
      <label class="field-label">テンプレート</label>
      <select id="template-select"></select>
      <p class="field-help">プロンプトの口調・目的を選びます。編集すると「カスタム」として保存されます。</p>
      <label class="field-label">本文テンプレート</label>
      <textarea id="template-body" rows="10" spellcheck="false"></textarea>
      <div class="field-vars">変数: <code>{{file}}</code> <code>{{comments}}</code> <code>{{count}}</code></div>
      <div class="drawer-actions"><button id="template-reset" class="ghost">プリセットに戻す</button><button id="template-save" class="primary">保存</button></div>
      <div class="drawer-preview-wrap"><label class="field-label">プレビュー</label><pre id="template-preview" class="drawer-preview"></pre></div>
    </div>
  </div>
  <div id="settings-backdrop" class="backdrop hidden"></div>

  <div id="composer" class="composer hidden">
    <div class="composer-target" id="composer-target"></div>
    <textarea id="composer-input" rows="3" placeholder="この箇所への指摘・修正指示を書く…"></textarea>
    <div class="composer-actions"><button id="composer-cancel" class="ghost">キャンセル</button><button id="composer-save" class="primary">追加 (⌘/Ctrl+Enter)</button></div>
  </div>

  <script>
    // --- host bridge: feed the shared UI without an HTTP server ---
    const vscode = acquireVsCodeApi();
    const BOOT = ${injected};

    // preview HTML (HTML/Markdown) → render adapter loads it via iframe srcdoc
    if (BOOT.previewHtml) window.__PREVIEW_HTML__ = BOOT.previewHtml;

    // localStorage shim backed by the extension's workspace state
    const savedComments = BOOT.saved; // {path, comments} | null
    const _persist = {};
    window.__hcPersist = (key, value) => {
      _persist[key] = value;
      if (key.startsWith("html-comment:") && key === ("html-comment:" + BOOT.meta.path)) {
        try { vscode.postMessage({ type: "save", payload: JSON.parse(value) }); } catch {}
      }
    };
    // a minimal localStorage replacement (webview localStorage isn't persisted)
    const _ls = {};
    if (savedComments) _ls["html-comment:" + BOOT.meta.path] = JSON.stringify(savedComments);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k) => (k in _ls ? _ls[k] : null),
        setItem: (k, v) => { _ls[k] = v; window.__hcPersist(k, v); },
        removeItem: (k) => { delete _ls[k]; },
      },
    });

    // fetch shim: the UI calls /__meta and /__source
    const _realFetch = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = (url, opts) => {
      const u = String(url);
      if (u === "/__meta") return Promise.resolve(new Response(JSON.stringify(BOOT.meta), { headers: { "content-type": "application/json" } }));
      if (u === "/__source") return Promise.resolve(new Response(BOOT.source, { headers: { "content-type": "text/plain" } }));
      if (_realFetch) return _realFetch(url, opts);
      return Promise.reject(new Error("blocked: " + u));
    };

    // clipboard via host (webview clipboard is restricted)
    if (!navigator.clipboard) navigator.clipboard = {};
    navigator.clipboard.writeText = (t) => { vscode.postMessage({ type: "copy", text: t }); return Promise.resolve(); };
  </script>
  <script type="module" src="${uiUri("boot.js")}"></script>
</body>
</html>`;
}

function deactivate() {}

module.exports = { activate, deactivate };
