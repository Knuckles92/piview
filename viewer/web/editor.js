/**
 * Lightweight markdown textarea helpers + toolbar actions for the plan editor.
 */

/**
 * @param {HTMLTextAreaElement} ta
 * @returns {{ start: number, end: number, value: string, selected: string }}
 */
export function getSelection(ta) {
  const start = ta.selectionStart ?? 0;
  const end = ta.selectionEnd ?? 0;
  const value = ta.value ?? "";
  return { start, end, value, selected: value.slice(start, end) };
}

/**
 * Replace the current selection (or insert at caret) and restore focus/selection.
 * @param {HTMLTextAreaElement} ta
 * @param {string} text
 * @param {{ selectStart?: number, selectEnd?: number } | number} [sel]
 *   If number: caret offset relative to insertion start.
 *   If object: absolute selection in the new value coordinates relative to insert start
 *   (selectStart/selectEnd offsets from the start of `text` within the new value).
 */
export function replaceSelection(ta, text, sel) {
  const { start, end, value } = getSelection(ta);
  const before = value.slice(0, start);
  const after = value.slice(end);
  ta.value = before + text + after;

  let selStart;
  let selEnd;
  if (typeof sel === "number") {
    selStart = selEnd = start + sel;
  } else if (sel && typeof sel === "object") {
    selStart = start + (sel.selectStart ?? text.length);
    selEnd = start + (sel.selectEnd ?? sel.selectStart ?? text.length);
  } else {
    selStart = selEnd = start + text.length;
  }

  ta.focus();
  ta.setSelectionRange(selStart, selEnd);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Wrap selection with prefix/suffix; if empty, insert placeholder and select it. */
export function wrapSelection(ta, prefix, suffix = prefix, placeholder = "") {
  const { selected } = getSelection(ta);
  if (selected) {
    replaceSelection(ta, prefix + selected + suffix, {
      selectStart: prefix.length,
      selectEnd: prefix.length + selected.length,
    });
    return;
  }
  const inner = placeholder || "";
  replaceSelection(ta, prefix + inner + suffix, {
    selectStart: prefix.length,
    selectEnd: prefix.length + inner.length,
  });
}

/** Toggle a line prefix on each line of the selection (or current line). */
export function toggleLinePrefix(ta, prefix) {
  const { start, end, value } = getSelection(ta);
  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  let lineEnd = value.indexOf("\n", end);
  if (lineEnd < 0) lineEnd = value.length;

  const block = value.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  const allPrefixed = lines.every((l) => l.startsWith(prefix) || l.trim() === "");
  const next = lines
    .map((l) => {
      if (!l.trim()) return l;
      if (allPrefixed) {
        return l.startsWith(prefix) ? l.slice(prefix.length) : l;
      }
      return prefix + l;
    })
    .join("\n");

  const before = value.slice(0, lineStart);
  const after = value.slice(lineEnd);
  ta.value = before + next + after;
  ta.focus();
  ta.setSelectionRange(lineStart, lineStart + next.length);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Set ATX heading level (1–6) on the current line / selected lines. */
export function setHeading(ta, level) {
  const hashes = "#".repeat(Math.min(6, Math.max(1, level)));
  const { start, end, value } = getSelection(ta);
  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  let lineEnd = value.indexOf("\n", end);
  if (lineEnd < 0) lineEnd = value.length;

  const block = value.slice(lineStart, lineEnd);
  const lines = block.split("\n").map((l) => {
    const stripped = l.replace(/^\s*#{1,6}\s+/, "").replace(/^\s+/, "");
    if (!stripped) return l;
    return `${hashes} ${stripped}`;
  });
  const next = lines.join("\n");
  const before = value.slice(0, lineStart);
  const after = value.slice(lineEnd);
  ta.value = before + next + after;
  ta.focus();
  ta.setSelectionRange(lineStart, lineStart + next.length);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Insert a fenced code block around selection. */
export function insertCodeBlock(ta) {
  const { selected } = getSelection(ta);
  const body = selected || "code";
  const text = "```\n" + body + "\n```";
  if (selected) {
    replaceSelection(ta, text);
  } else {
    replaceSelection(ta, text, { selectStart: 4, selectEnd: 4 + body.length });
  }
}

/** Insert markdown link; select URL if no selection. */
export function insertLink(ta) {
  const { selected } = getSelection(ta);
  if (selected) {
    const text = `[${selected}](https://)`;
    replaceSelection(ta, text, {
      selectStart: selected.length + 3,
      selectEnd: selected.length + 3 + "https://".length,
    });
  } else {
    const text = "[label](https://)";
    replaceSelection(ta, text, { selectStart: 1, selectEnd: 6 });
  }
}

/** Insert horizontal rule on its own lines. */
export function insertHr(ta) {
  const { start, value } = getSelection(ta);
  const needsNLBefore = start > 0 && value[start - 1] !== "\n";
  const needsNLAfter = start < value.length && value[start] !== "\n";
  const text = `${needsNLBefore ? "\n" : ""}\n---\n${needsNLAfter ? "\n" : ""}`;
  replaceSelection(ta, text);
}

/**
 * Insert an image markdown snippet.
 * @param {HTMLTextAreaElement} ta
 * @param {string} path  markdown src (e.g. .piview/assets/x.png)
 * @param {string} [alt]
 */
export function insertImage(ta, path, alt = "screenshot") {
  const { start, value } = getSelection(ta);
  const atLineStart = start === 0 || value[start - 1] === "\n";
  const prefix = atLineStart ? "" : "\n\n";
  const suffix = "\n\n";
  const snip = `${prefix}![${alt}](${path})${suffix}`;
  replaceSelection(ta, snip);
}

/**
 * Apply a named toolbar action.
 * @param {HTMLTextAreaElement} ta
 * @param {string} action
 * @param {Record<string, unknown>} [extra]
 */
export function runToolbarAction(ta, action, extra = {}) {
  if (!ta) return;
  switch (action) {
    case "h1":
      setHeading(ta, 1);
      break;
    case "h2":
      setHeading(ta, 2);
      break;
    case "h3":
      setHeading(ta, 3);
      break;
    case "bold":
      wrapSelection(ta, "**", "**", "bold");
      break;
    case "italic":
      wrapSelection(ta, "*", "*", "italic");
      break;
    case "strike":
      wrapSelection(ta, "~~", "~~", "text");
      break;
    case "code":
      wrapSelection(ta, "`", "`", "code");
      break;
    case "codeblock":
      insertCodeBlock(ta);
      break;
    case "quote":
      toggleLinePrefix(ta, "> ");
      break;
    case "ul":
      toggleLinePrefix(ta, "- ");
      break;
    case "ol":
      toggleLinePrefix(ta, "1. ");
      break;
    case "task":
      toggleLinePrefix(ta, "- [ ] ");
      break;
    case "link":
      insertLink(ta);
      break;
    case "hr":
      insertHr(ta);
      break;
    case "image":
      if (extra.path) insertImage(ta, String(extra.path), String(extra.alt || "screenshot"));
      else {
        // placeholder for file picker flow
        const { selected } = getSelection(ta);
        const alt = selected || "image";
        const text = `![${alt}](path)`;
        replaceSelection(ta, text, {
          selectStart: alt.length + 4,
          selectEnd: alt.length + 4 + 4,
        });
      }
      break;
    default:
      break;
  }
}

/**
 * Wire toolbar buttons that have data-md-action.
 * @param {HTMLElement} toolbar
 * @param {() => HTMLTextAreaElement | null} getTextarea
 * @param {{ onImage?: () => void }} [hooks]
 */
export function bindToolbar(toolbar, getTextarea, hooks = {}) {
  if (!toolbar) return () => {};

  const onClick = (ev) => {
    const btn = ev.target.closest("[data-md-action]");
    if (!btn || !toolbar.contains(btn)) return;
    ev.preventDefault();
    const action = btn.getAttribute("data-md-action");
    if (action === "image" && hooks.onImage) {
      hooks.onImage();
      return;
    }
    const ta = getTextarea();
    if (!ta) return;
    runToolbarAction(ta, action);
  };

  toolbar.addEventListener("click", onClick);
  return () => toolbar.removeEventListener("click", onClick);
}
