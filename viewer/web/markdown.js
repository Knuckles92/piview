/* Minimal markdown → HTML for plan documents. Escapes HTML; no raw HTML passthrough. */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineMarkdown(text) {
  let s = escapeHtml(text);
  // code
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  // bold / italic
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/_([^_]+)_/g, "<em>$1</em>");
  // links
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  // strikethrough
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return s;
}

/**
 * @param {string} src
 * @returns {string} HTML
 */
export function renderMarkdown(src) {
  if (!src || !String(src).trim()) return "";

  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let inCode = false;
  let codeLang = "";
  let codeBuf = [];
  let listType = null; // "ul" | "ol" | "task"
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${inlineMarkdown(para.join(" "))}</p>`);
    para = [];
  };

  const closeList = () => {
    if (!listType) return;
    out.push(listType === "ol" ? "</ol>" : "</ul>");
    listType = null;
  };

  const openList = (type) => {
    if (listType === type) return;
    closeList();
    listType = type;
    out.push(type === "ol" ? "<ol>" : type === "task" ? '<ul class="task-list">' : "<ul>");
  };

  while (i < lines.length) {
    const line = lines[i];

    if (inCode) {
      if (/^```/.test(line)) {
        out.push(
          `<pre><code class="lang-${escapeHtml(codeLang)}">${escapeHtml(codeBuf.join("\n"))}</code></pre>`,
        );
        inCode = false;
        codeBuf = [];
        codeLang = "";
      } else {
        codeBuf.push(line);
      }
      i++;
      continue;
    }

    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushPara();
      closeList();
      inCode = true;
      codeLang = fence[1] || "";
      i++;
      continue;
    }

    if (/^\s*---+\s*$/.test(line) || /^\s*\*\*\*+\s*$/.test(line)) {
      flushPara();
      closeList();
      out.push("<hr />");
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMarkdown(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // Plan: label as h2-ish
    if (/^\*{0,2}Plan:\*{0,2}\s*$/i.test(line.trim())) {
      flushPara();
      closeList();
      out.push("<h2>Plan</h2>");
      i++;
      continue;
    }

    const task = line.match(/^\s*(?:[-*]|\d+[.)])\s+\[([ xX~!])\]\s+(.+)$/);
    if (task) {
      flushPara();
      openList("task");
      const mark = task[1].toLowerCase();
      const checked = mark === "x" ? " checked" : "";
      const cls =
        mark === "x" ? "done" : mark === "~" ? "skipped" : mark === "!" ? "failed" : "pending";
      const cont = [];
      while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) {
        i++;
        cont.push(`<div class="list-cont">${inlineMarkdown(lines[i].trim())}</div>`);
      }
      out.push(
        `<li class="task ${cls}"><input type="checkbox" disabled${checked} /> <div class="task-body"><span>${inlineMarkdown(task[2])}</span>${cont.join("")}</div></li>`,
      );
      i++;
      continue;
    }

    const ol = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (ol) {
      flushPara();
      openList("ol");
      const cont = [];
      while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) {
        i++;
        cont.push(`<div class="list-cont">${inlineMarkdown(lines[i].trim())}</div>`);
      }
      out.push(`<li>${inlineMarkdown(ol[2])}${cont.join("")}</li>`);
      i++;
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ul) {
      flushPara();
      openList("ul");
      const cont = [];
      while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) {
        i++;
        cont.push(`<div class="list-cont">${inlineMarkdown(lines[i].trim())}</div>`);
      }
      out.push(`<li>${inlineMarkdown(ul[1])}${cont.join("")}</li>`);
      i++;
      continue;
    }

    if (!line.trim()) {
      flushPara();
      closeList();
      i++;
      continue;
    }

    closeList();
    para.push(line.trim());
    i++;
  }

  if (inCode) {
    out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  }
  flushPara();
  closeList();
  return out.join("\n");
}

/** Update numbered checkbox markers in markdown to match live step statuses. */
export function syncMarkdownCheckboxes(md, steps) {
  if (!md || !steps?.length) return md;
  let out = md;
  for (const s of steps) {
    const box =
      s.status === "done"
        ? "[x]"
        : s.status === "skipped"
          ? "[~]"
          : s.status === "failed"
            ? "[!]"
            : "[ ]";
    const re = new RegExp(`(^|\\n)(\\s*${s.step}[.)]\\s+)\\[[ xX~!]\\]`, "g");
    out = out.replace(re, `$1$2${box}`);
  }
  return out;
}

/**
 * Keep an authored plan document intact when persisting checklist edits.
 * Plans that originated as structured steps still need a readable document,
 * so synthesize one only when no markdown was supplied.
 */
export function ensurePlanMarkdown(plan) {
  return (plan.markdown || "").trim() ? plan.markdown : synthesizePlanMarkdown(plan);
}

/** Synthesize markdown from structured steps when no document was provided. */
export function synthesizePlanMarkdown(plan) {
  const lines = [];
  const title = (plan.title || "").trim();
  lines.push(title ? `# ${title}` : "# Plan", "");
  for (const s of plan.steps || []) {
    const box =
      s.status === "done"
        ? "[x]"
        : s.status === "skipped"
          ? "[~]"
          : s.status === "failed"
            ? "[!]"
            : "[ ]";
    lines.push(`${s.step}. ${box} **${s.title || "Untitled"}**`);
    if (s.detail?.trim()) {
      for (const line of s.detail.trim().split("\n")) {
        lines.push(`   ${line}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}
