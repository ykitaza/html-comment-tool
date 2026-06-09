// Best-effort structural "data path" for JSON / YAML source, used to annotate
// line comments (e.g. `services.web.ports`). These are pragmatic heuristics,
// not full parsers: they give the AI a useful locator hint and fall back to
// null when unsure. Pure functions over an array of source lines.

// Dispatch by language; returns a dotted path string or null.
export function dataPathFor(lang, lines, lineNo) {
  if (lang === "yaml") return yamlPath(lines, lineNo);
  if (lang === "json") return jsonPath(lines, lineNo);
  return null;
}

// YAML: walk upward, collecting "key:" lines at strictly-decreasing indent.
export function yamlPath(lines, lineNo) {
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

// JSON: track the key preceding each open brace/bracket; strings are skipped so
// braces inside string values don't shift depth. The stack at the target line
// (plus the line's own leading key) is the path.
export function jsonPath(lines, lineNo) {
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
      // avoid double-counting when an opening brace on this line already pushed
      // the leading key onto the stack
      if (km && keys[keys.length - 1] !== km[1]) keys.push(km[1]);
      return keys.length ? keys.join(".") : null;
    }
  }
  const keys = stack.map((s) => s.key).filter(Boolean);
  return keys.length ? keys.join(".") : null;
}
