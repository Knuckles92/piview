/**
 * Render agent file-change diffs (unified or side-by-side).
 */

const LAYOUT_KEY = "piview.diffLayout";

/**
 * @typedef {"unified"|"split"} DiffLayout
 * @typedef {{ type: "context"|"add"|"del", text: string, oldLine?: number, newLine?: number }} DiffHunkLine
 * @typedef {{ oldStart: number, oldLines: number, newStart: number, newLines: number, lines: DiffHunkLine[] }} DiffHunk
 * @typedef {{
 *   path: string,
 *   operation: string,
 *   before: string|null,
 *   after: string,
 *   additions: number,
 *   deletions: number,
 *   hasDiff: boolean,
 *   unavailableReason?: string,
 *   updatedAt: number,
 *   hunks: DiffHunk[],
 * }} FileChangeView
 */

/** @returns {DiffLayout} */
export function getDiffLayout() {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    if (v === "split" || v === "unified") return v;
  } catch {
    /* ignore */
  }
  return "unified";
}

/** @param {DiffLayout} layout */
export function setDiffLayout(layout) {
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} [path]
 * @returns {Promise<FileChangeView[]>}
 */
export async function fetchChanges(path) {
  const url = path
    ? `/api/changes?path=${encodeURIComponent(path)}`
    : "/api/changes";
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to load changes (${res.status})`);
  }
  const data = await res.json();
  if (path) return data.change ? [data.change] : [];
  return Array.isArray(data.changes) ? data.changes : [];
}

/**
 * @param {HTMLElement} root
 * @param {{ changes: FileChangeView[], layout: DiffLayout, title: string }} opts
 */
export function renderDiffView(root, { changes, layout, title }) {
  root.replaceChildren();
  root.className = `diff-body layout-${layout}`;

  const heading = document.createElement("div");
  heading.className = "diff-title-bar";
  const h = document.createElement("h3");
  h.id = "diff-dialog-title";
  h.textContent = title;
  heading.append(h);
  root.append(heading);

  if (!changes.length) {
    const empty = document.createElement("p");
    empty.className = "diff-empty";
    empty.textContent = "No file changes to show.";
    root.append(empty);
    return;
  }

  for (const change of changes) {
    root.append(renderFileSection(change, layout, changes.length > 1));
  }
}

/**
 * @param {FileChangeView} change
 * @param {DiffLayout} layout
 * @param {boolean} showHeader
 */
function renderFileSection(change, layout, showHeader) {
  const section = document.createElement("section");
  section.className = "diff-file";

  if (showHeader) {
    const head = document.createElement("header");
    head.className = "diff-file-head";
    const path = document.createElement("code");
    path.textContent = change.path;
    const meta = document.createElement("span");
    meta.className = "diff-file-meta";
    meta.append(...diffMetaNodes(change));
    head.append(path, meta);
    section.append(head);
  } else {
    const meta = document.createElement("div");
    meta.className = "diff-file-meta-row";
    meta.append(...diffMetaNodes(change));
    section.append(meta);
  }

  if (!change.hasDiff || change.unavailableReason) {
    const note = document.createElement("p");
    note.className = "diff-unavailable";
    note.textContent = change.unavailableReason
      ? `Diff unavailable: ${change.unavailableReason}`
      : "Diff unavailable for this file.";
    section.append(note);
    return section;
  }

  if (!change.hunks.length) {
    const note = document.createElement("p");
    note.className = "diff-empty";
    note.textContent = "No line changes (content identical).";
    section.append(note);
    return section;
  }

  if (layout === "split") {
    section.append(renderSplit(change.hunks));
  } else {
    section.append(renderUnified(change.hunks));
  }
  return section;
}

/** @param {FileChangeView} change */
function diffMetaNodes(change) {
  const nodes = [];
  const op = document.createElement("span");
  op.textContent = change.operation;
  nodes.push(op);
  if (typeof change.additions === "number" || typeof change.deletions === "number") {
    const stats = document.createElement("span");
    stats.className = "diff-stats";
    const add = document.createElement("span");
    add.className = "diff-additions";
    add.textContent = `+${change.additions ?? 0}`;
    const del = document.createElement("span");
    del.className = "diff-deletions";
    del.textContent = `−${change.deletions ?? 0}`;
    stats.append(add, document.createTextNode(" "), del);
    nodes.push(stats);
  }
  return nodes;
}

/** @param {DiffHunk[]} hunks */
function renderUnified(hunks) {
  const pre = document.createElement("pre");
  pre.className = "diff-unified";
  for (const hunk of hunks) {
    const header = document.createElement("div");
    header.className = "diff-hunk-header";
    header.textContent = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    pre.append(header);
    for (const line of hunk.lines) {
      pre.append(unifiedLine(line));
    }
  }
  return pre;
}

/** @param {DiffHunkLine} line */
function unifiedLine(line) {
  const row = document.createElement("div");
  row.className = `diff-line diff-line-${line.type}`;
  const gutterOld = document.createElement("span");
  gutterOld.className = "diff-gutter";
  gutterOld.textContent = line.type === "add" ? "" : String(line.oldLine ?? "");
  const gutterNew = document.createElement("span");
  gutterNew.className = "diff-gutter";
  gutterNew.textContent = line.type === "del" ? "" : String(line.newLine ?? "");
  const prefix = document.createElement("span");
  prefix.className = "diff-prefix";
  prefix.textContent = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
  const text = document.createElement("span");
  text.className = "diff-text";
  text.textContent = line.text;
  row.append(gutterOld, gutterNew, prefix, text);
  return row;
}

/** @param {DiffHunk[]} hunks */
function renderSplit(hunks) {
  const wrap = document.createElement("div");
  wrap.className = "diff-split";

  for (const hunk of hunks) {
    const header = document.createElement("div");
    header.className = "diff-hunk-header split-span";
    header.textContent = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    wrap.append(header);

    /** @type {{ left: DiffHunkLine|null, right: DiffHunkLine|null }[]} */
    const rows = [];
    let i = 0;
    const lines = hunk.lines;
    while (i < lines.length) {
      const line = lines[i];
      if (line.type === "context") {
        rows.push({ left: line, right: line });
        i++;
        continue;
      }
      /** @type {DiffHunkLine[]} */
      const dels = [];
      /** @type {DiffHunkLine[]} */
      const adds = [];
      while (i < lines.length && lines[i].type === "del") {
        dels.push(lines[i]);
        i++;
      }
      while (i < lines.length && lines[i].type === "add") {
        adds.push(lines[i]);
        i++;
      }
      const n = Math.max(dels.length, adds.length);
      for (let j = 0; j < n; j++) {
        rows.push({ left: dels[j] ?? null, right: adds[j] ?? null });
      }
    }

    for (const { left, right } of rows) {
      const row = document.createElement("div");
      row.className = "diff-split-row";
      row.append(splitCell(left, "old"), splitCell(right, "new"));
      wrap.append(row);
    }
  }
  return wrap;
}

/**
 * @param {DiffHunkLine|null} line
 * @param {"old"|"new"} side
 */
function splitCell(line, side) {
  const cell = document.createElement("div");
  const type = line ? line.type : "empty";
  cell.className = `diff-split-cell diff-line-${type}`;
  const gutter = document.createElement("span");
  gutter.className = "diff-gutter";
  if (line) {
    gutter.textContent = String(side === "old" ? (line.oldLine ?? "") : (line.newLine ?? ""));
  }
  const text = document.createElement("span");
  text.className = "diff-text";
  text.textContent = line ? line.text : "";
  cell.append(gutter, text);
  return cell;
}
