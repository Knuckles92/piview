/* Minimal markdown → HTML for plan documents. Escapes HTML; no raw HTML passthrough. */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Resolve markdown image src to a browser-safe URL, or null if disallowed. */
export function safeImageSrc(raw) {
  const src = String(raw || "").trim();
  if (!src) return null;

  // Workspace-relative assets written by the plan editor → local UI route
  const piviewAsset = src.match(/^(?:\.\/)?\.piview\/assets\/([A-Za-z0-9._-]+)$/);
  if (piviewAsset) return `/assets/${piviewAsset[1]}`;

  if (/^\/assets\/[A-Za-z0-9._-]+$/.test(src)) return src;

  if (/^https?:\/\//i.test(src)) return src;

  // data:image/png;base64,... (and friends) — reject anything else under data:
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/i.test(src)) {
    return src.replace(/\s+/g, "");
  }

  return null;
}

function inlineMarkdown(text) {
  let s = escapeHtml(text);
  // images first (before links) — ![alt](src)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
    const safe = safeImageSrc(src.replace(/&amp;/g, "&"));
    if (!safe) return escapeHtml(`![${alt}](${src})`);
    return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(alt)}" loading="lazy" />`;
  });
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

    // Standalone image line → block figure-ish paragraph
    const onlyImg = line.match(/^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/);
    if (onlyImg) {
      flushPara();
      closeList();
      const safe = safeImageSrc(onlyImg[2]);
      if (safe) {
        out.push(
          `<p class="md-image"><img src="${escapeHtml(safe)}" alt="${escapeHtml(onlyImg[1])}" loading="lazy" /></p>`,
        );
      } else {
        out.push(`<p>${inlineMarkdown(line.trim())}</p>`);
      }
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

/** Strip common markdown wrappers from a step title line. */
export function stripStepTitleDecor(text) {
  let t = String(text || "").trim();
  // optional checkbox already stripped by caller; strip bold/italic/code
  t = t.replace(/^\*\*(.+)\*\*$/, "$1");
  t = t.replace(/^__(.+)__$/, "$1");
  t = t.replace(/^\*(.+)\*$/, "$1");
  t = t.replace(/^_(.+)_$/, "$1");
  t = t.replace(/^`(.+)`$/, "$1");
  // trailing bold markers left by partial wraps
  t = t.replace(/\*\*$/, "").replace(/^\*\*/, "");
  return t.trim();
}

function statusFromCheckboxMark(mark) {
  if (!mark) return undefined;
  const m = mark.toLowerCase();
  if (m === "x") return "done";
  if (m === "~") return "skipped";
  if (m === "!") return "failed";
  if (m === " " || m === "") return "pending";
  return undefined;
}

/**
 * First ATX heading (# …) becomes the plan title, if present.
 * @param {string} md
 * @returns {string|undefined}
 */
export function parsePlanTitleFromMarkdown(md) {
  if (!md) return undefined;
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    // skip thematic breaks / empty
    const h = line.match(/^#\s+(.+)$/);
    if (h) {
      const title = stripStepTitleDecor(h[1]);
      return title || undefined;
    }
    // stop at first non-blank non-heading? Allow YAML-less docs: first real content
    // Only treat leading H1 as title; later H1s are body.
    break;
  }
  return undefined;
}

/**
 * Parse numbered plan steps from markdown.
 * Supports:
 *   1. Title
 *   2. [x] **Title**
 *   3. [ ] Title
 *      indented detail lines
 *
 * @param {string} md
 * @returns {{ title: string, detail?: string, status?: string }[]}
 */
export function parseStepsFromMarkdown(md) {
  if (!md || !String(md).trim()) return [];

  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  const steps = [];
  let i = 0;
  let inCode = false;

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      inCode = !inCode;
      i++;
      continue;
    }
    if (inCode) {
      i++;
      continue;
    }

    // Numbered item, optional checkbox
    const m = line.match(/^\s*(\d+)[.)]\s+(?:\[([ xX~!])\]\s+)?(.+)$/);
    if (m) {
      const mark = m[2];
      const title = stripStepTitleDecor(m[3]);
      const detailLines = [];
      while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) {
        i++;
        // preserve relative indent content (trim only the list indent)
        detailLines.push(lines[i].replace(/^\s{2,}/, ""));
      }
      const detail = detailLines.join("\n").trim();
      const status = statusFromCheckboxMark(mark);
      if (title) {
        steps.push({
          title,
          detail: detail || undefined,
          status,
        });
      }
      i++;
      continue;
    }

    i++;
  }

  return steps;
}

function newStepId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Map numbered markdown items onto existing structured steps by index.
 * Preserves id (and status when the markdown has no checkbox) for matching indices.
 * Resizes the list to the parsed length.
 *
 * @param {string} md
 * @param {Array<{id: string, step: number, title: string, detail?: string, status: string, files?: string[], notes?: string}>} existingSteps
 * @returns {{ title?: string, steps: typeof existingSteps }}
 */
export function syncStepsFromMarkdown(md, existingSteps = []) {
  const parsed = parseStepsFromMarkdown(md);
  const title = parsePlanTitleFromMarkdown(md);
  const prev = Array.isArray(existingSteps) ? existingSteps : [];

  const steps = parsed.map((p, index) => {
    const old = prev[index];
    const status =
      p.status !== undefined
        ? p.status
        : old?.status && ["pending", "active", "done", "skipped", "failed"].includes(old.status)
          ? old.status
          : "pending";
    return {
      id: old?.id || newStepId(),
      step: index + 1,
      title: p.title || old?.title || "Untitled",
      detail: p.detail !== undefined ? p.detail : old?.detail,
      status,
      files: old?.files,
      notes: old?.notes,
    };
  });

  return { title, steps };
}
