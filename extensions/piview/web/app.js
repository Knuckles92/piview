/* piview frontend — talks to the extension UI bridge via /api/* and event stream */

import { bindToolbar, insertImage } from "./editor.js";
import {
  fetchChanges,
  getDiffLayout,
  renderDiffView,
  setDiffLayout,
} from "./diff-view.js";
import { executionDashboardModel, formatDuration } from "./execution-dashboard.js";
import {
  ensurePlanMarkdown,
  renderMarkdown,
  synthesizePlanMarkdown,
  syncMarkdownCheckboxes,
  syncStepsFromMarkdown,
} from "./markdown.js";

const state = {
  plan: { v: 1, mode: "off", steps: [], updatedAt: 0 },
  selectedId: null,
  /** @type {Set<string>} multi-select for bulk actions */
  selectedIds: new Set(),
  dirty: false,
  connected: false,
  cwd: "",
  tab: "plan",
  /** @type {"preview"|"edit"|"split"} */
  planView: "preview",
  /** Draft markdown while editing the plan document (may differ from plan.markdown). */
  editingDraft: null,
  editing: false,
  /** @type {string|null} */
  activeOutlineId: null,
  findOpen: false,
  findQuery: "",
  /** @type {{ start: number, end: number }[]} */
  findMatches: [],
  findIndex: 0,
  /** @type {string|null} */
  dragStepId: null,
  /** @type {string} status filter: all|pending|active|done|skipped|failed */
  stepsStatusFilter: "all",
  stepsSearch: "",
  /** @type {string|null} expanded step on execution dashboard */
  executionExpandedId: null,
  /** Only auto-expand failed/active once per execution session */
  executionDidAutoExpand: false,
  /** @type {string|null} selected Q&A response tab (null = live plan) */
  activeResponseId: null,
  /** @type {"unified"|"split"} */
  diffLayout: getDiffLayout(),
  /** @type {string|null} path currently shown in single-file diff dialog */
  diffPath: null,
  /** @type {boolean} true when viewing all changes */
  diffAll: false,
};

const $ = (id) => document.getElementById(id);

/** @type {number|null} */
let outlineScrollRaf = null;
let outlineScrollBound = false;
/** @type {number|null} */
let findDebounceTimer = null;
const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function setDirty(v) {
  state.dirty = v;
  $("dirty").classList.toggle("hidden", !v);
  $("btn-apply").disabled = !v;
}

const TAB_STORAGE_KEY = "piview.tab";
const RESPONSE_TAB_STORAGE_KEY = "piview.activeResponseId";

/** @returns {{ id: string, title: string, markdown: string, createdAt: number }|null} */
function getActiveResponse() {
  const id = state.activeResponseId;
  if (!id) return null;
  return (state.plan.responses || []).find((r) => r.id === id) ?? null;
}

function persistActiveResponseId() {
  try {
    if (state.activeResponseId) {
      sessionStorage.setItem(RESPONSE_TAB_STORAGE_KEY, state.activeResponseId);
    } else {
      sessionStorage.removeItem(RESPONSE_TAB_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

function clearActiveResponse() {
  if (!state.activeResponseId) return;
  state.activeResponseId = null;
  persistActiveResponseId();
}

/** @param {string|null|undefined} id */
function selectResponse(id) {
  if (!id) {
    clearActiveResponse();
    return;
  }
  const found = (state.plan.responses || []).find((r) => r.id === id);
  if (!found) {
    clearActiveResponse();
    return;
  }
  state.activeResponseId = id;
  persistActiveResponseId();
  if (state.editing) {
    state.editing = false;
    state.editingDraft = null;
    state.planView = "preview";
  }
  if (state.tab !== "plan") setTab("plan");
}

/**
 * @param {Array<{ id: string }>} prev
 * @param {Array<{ id: string }>} next
 * @returns {string|null} id of newest response that was not in prev
 */
function newestResponseId(prev, next) {
  if (!next?.length) return null;
  const prevIds = new Set((prev || []).map((r) => r.id));
  for (let i = next.length - 1; i >= 0; i--) {
    if (!prevIds.has(next[i].id)) return next[i].id;
  }
  return null;
}

/** Keep activeResponseId valid; auto-select newly arrived responses. */
function syncActiveResponse(prevResponses, nextResponses, { autoSelectNew = true } = {}) {
  const next = nextResponses || [];
  if (autoSelectNew) {
    const fresh = newestResponseId(prevResponses || [], next);
    if (fresh) {
      selectResponse(fresh);
      return;
    }
  }
  if (state.activeResponseId && !next.some((r) => r.id === state.activeResponseId)) {
    clearActiveResponse();
  }
}

function restoreActiveResponseId() {
  try {
    return sessionStorage.getItem(RESPONSE_TAB_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

async function dismissResponse(id) {
  if (!id) return;
  const prev = state.plan.responses || [];
  state.plan = {
    ...state.plan,
    responses: prev.filter((r) => r.id !== id),
  };
  if (state.activeResponseId === id) clearActiveResponse();
  render();
  try {
    await api("/api/dismiss-response", { id });
  } catch (e) {
    showErr(e);
  }
}

function renderResponseTabs() {
  const nav = $("response-tabs");
  if (!nav) return;
  const responses = state.plan.responses || [];
  nav.replaceChildren();
  nav.classList.toggle("hidden", responses.length === 0);
  for (const resp of responses) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "response-tab" + (state.activeResponseId === resp.id ? " active" : "");
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", state.activeResponseId === resp.id ? "true" : "false");
    btn.title = resp.title;
    btn.dataset.responseId = resp.id;

    const label = document.createElement("span");
    label.className = "response-tab-label";
    label.textContent = resp.title;
    btn.append(label);

    const close = document.createElement("span");
    close.className = "response-tab-close";
    close.setAttribute("role", "button");
    close.setAttribute("aria-label", `Dismiss ${resp.title}`);
    close.tabIndex = 0;
    close.textContent = "×";
    close.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void dismissResponse(resp.id);
    });
    close.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        ev.stopPropagation();
        void dismissResponse(resp.id);
      }
    });
    btn.append(close);

    btn.addEventListener("click", () => {
      if (state.activeResponseId === resp.id) {
        clearActiveResponse();
      } else {
        selectResponse(resp.id);
      }
      render();
    });
    nav.append(btn);
  }
}

function showToast(message, kind = "ok", ms = 2800) {
  const host = $("toast-host");
  if (!host) {
    $("activity").textContent = message;
    return;
  }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.append(el);
  window.setTimeout(() => {
    el.remove();
  }, ms);
  $("activity").textContent = message;
}

function openShortcutsHelp() {
  const dlg = $("shortcuts-dialog");
  if (dlg && typeof dlg.showModal === "function" && !dlg.open) dlg.showModal();
}

/**
 * Prompt when server state arrives while local edits are dirty.
 * @param {object} serverPlan
 * @returns {Promise<"keep"|"take">}
 */
function promptPlanConflict(serverPlan) {
  const dlg = $("conflict-dialog");
  if (!dlg || typeof dlg.showModal !== "function") {
    return Promise.resolve("keep");
  }
  return new Promise((resolve) => {
    const onClose = () => {
      dlg.removeEventListener("close", onClose);
      const value = dlg.returnValue === "take" ? "take" : "keep";
      resolve(value);
    };
    dlg.addEventListener("close", onClose);
    dlg.returnValue = "keep";
    // Stash for debugging / future diff UI
    dlg.dataset.serverUpdatedAt = String(serverPlan?.updatedAt || "");
    dlg.showModal();
  });
}

/** @type {Promise<"keep"|"take">|null} */
let conflictPrompt = null;
/** @type {number} */
let lastKeptServerUpdatedAt = 0;

async function resolveIncomingPlan(serverPlan) {
  const prevResponses = state.plan.responses || [];

  if (isExecutionDashboard(serverPlan)) {
    const prev = state.selectedId;
    const wasExec = isExecutionDashboard(state.plan);
    state.plan = serverPlan;
    state.dirty = false;
    state.editing = false;
    state.editingDraft = null;
    if (!wasExec) {
      state.executionExpandedId = null;
      state.executionDidAutoExpand = false;
    }
    if (!serverPlan.steps?.some((s) => s.id === prev)) {
      state.selectedId = serverPlan.steps?.[0]?.id ?? null;
    }
    syncActiveResponse(prevResponses, serverPlan.responses);
    setDirty(false);
    render();
    return;
  }

  if (!(state.dirty || state.editing)) {
    const prev = state.selectedId;
    state.plan = serverPlan;
    if (!serverPlan.steps?.some((s) => s.id === prev)) {
      state.selectedId = serverPlan.steps?.[0]?.id ?? null;
    }
    syncActiveResponse(prevResponses, serverPlan.responses);
    setDirty(false);
    render();
    return;
  }

  const bodySame =
    JSON.stringify(serverPlan.steps || []) === JSON.stringify(state.plan.steps || []) &&
    (serverPlan.markdown || "") === (state.plan.markdown || "") &&
    (serverPlan.title || "") === (state.plan.title || "");

  // Absorb responses/mode/cwd/execution without clobbering local body edits
  if (bodySame) {
    state.plan.cwd = serverPlan.cwd || state.plan.cwd;
    state.plan.mode = serverPlan.mode || state.plan.mode;
    state.plan.responses = serverPlan.responses;
    if (serverPlan.execution) state.plan.execution = serverPlan.execution;
    state.plan.updatedAt = Math.max(state.plan.updatedAt || 0, serverPlan.updatedAt || 0);
    syncActiveResponse(prevResponses, serverPlan.responses);
    setDirty(state.dirty);
    render();
    return;
  }

  // Already chose Keep for this (or older) server snapshot — don't re-prompt
  if ((serverPlan.updatedAt || 0) <= lastKeptServerUpdatedAt) {
    state.plan.cwd = serverPlan.cwd || state.plan.cwd;
    state.plan.mode = serverPlan.mode || state.plan.mode;
    state.plan.responses = serverPlan.responses;
    syncActiveResponse(prevResponses, serverPlan.responses);
    setDirty(state.dirty);
    render();
    return;
  }

  // Meaningful remote change while dirty — ask once (serialize prompts)
  if (!conflictPrompt) {
    conflictPrompt = promptPlanConflict(serverPlan).finally(() => {
      conflictPrompt = null;
    });
  }
  const choice = await conflictPrompt;
  if (choice === "take") {
    const prev = state.selectedId;
    state.plan = serverPlan;
    state.editing = false;
    state.editingDraft = null;
    state.planView = "preview";
    lastKeptServerUpdatedAt = 0;
    if (!serverPlan.steps?.some((s) => s.id === prev)) {
      state.selectedId = serverPlan.steps?.[0]?.id ?? null;
    }
    syncActiveResponse(prevResponses, serverPlan.responses);
    setDirty(false);
    showToast("Loaded server plan", "ok");
    render();
  } else {
    // Keep local; still absorb connection metadata + responses
    lastKeptServerUpdatedAt = serverPlan.updatedAt || Date.now();
    state.plan.cwd = serverPlan.cwd || state.plan.cwd;
    state.plan.responses = serverPlan.responses;
    syncActiveResponse(prevResponses, serverPlan.responses);
    showToast("Kept local edits", "warn");
    setDirty(true);
    render();
  }
}

function progressText(plan) {
  const total = plan.steps?.length || 0;
  const done = (plan.steps || []).filter((s) => s.status === "done" || s.status === "skipped").length;
  return total ? `${done}/${total} complete` : "";
}

function planMarkdownSource(plan) {
  const md = (plan.markdown || "").trim();
  if (md) return syncMarkdownCheckboxes(md, plan.steps);
  if (plan.steps?.length) return synthesizePlanMarkdown(plan);
  return "";
}

function currentEditorMarkdown() {
  if (state.editing && state.editingDraft !== null) return state.editingDraft;
  return planMarkdownSource(state.plan);
}

function renderPlanMarkdown(src) {
  const el = $("plan-md");
  if (!src || !String(src).trim()) {
    el.innerHTML = `<p class="empty">No plan yet. Ask pi for a plan in plan mode.${
      state.editing ? " Start typing on the left, or press <kbd>E</kbd>." : " Press <kbd>E</kbd> or Edit to write one."
    }</p>`;
    renderOutlineFromPreview();
    if (state.findOpen) applyFindHighlights();
    return;
  }
  el.innerHTML = renderMarkdown(src);
  wirePlanTaskCheckboxes(el);
  renderOutlineFromPreview();
  if (state.findOpen) applyFindHighlights();
}

/**
 * Toggle a numbered plan step from the preview checkbox.
 * Updates structured status + markdown markers and marks the plan dirty.
 * @param {number} stepNum
 * @param {boolean} checked
 */
function togglePlanStepFromPreview(stepNum, checked) {
  if (isExecutionDashboard()) return;
  if (!Number.isFinite(stepNum) || stepNum < 1) return;

  const status = checked ? "done" : "pending";
  let md = currentEditorMarkdown();
  const steps = Array.isArray(state.plan.steps) ? state.plan.steps : [];
  let step = steps.find((s) => s.step === stepNum);

  if (!step && md) {
    // Ensure structured steps exist so Steps tab stays in sync
    const synced = syncStepsFromMarkdown(md, steps);
    if (synced.title) state.plan.title = synced.title;
    state.plan.steps = synced.steps;
    step = state.plan.steps.find((s) => s.step === stepNum);
  }

  if (step) step.status = status;

  if (md) {
    const re = new RegExp(`(^|\\n)(\\s*${stepNum}[.)]\\s+)\\[[ xX~!]\\]`, "g");
    const box = checked ? "[x]" : "[ ]";
    const next = md.replace(re, `$1$2${box}`);
    md = next;
    state.plan.markdown = md;
    if (state.editing) {
      state.editingDraft = md;
      const ta = $("plan-editor");
      if (ta && ta !== document.activeElement) ta.value = md;
      else if (ta) ta.value = md;
    }
  } else if (step) {
    // Step-only plan: keep markdown empty until apply synthesizes it
    state.plan.markdown = ensurePlanMarkdown({
      ...state.plan,
      markdown: "",
    });
    if (state.editing) {
      state.editingDraft = state.plan.markdown;
      const ta = $("plan-editor");
      if (ta) ta.value = state.editingDraft;
    }
  }

  state.plan.updatedAt = Date.now();
  setDirty(true);
  render();
}

function wirePlanTaskCheckboxes(root) {
  if (!root || isExecutionDashboard()) return;

  const flipStep = (stepNum) => {
    const step = (state.plan.steps || []).find((s) => s.step === stepNum);
    // Prefer structured status; fall back to flipping toward done
    const checked = step ? step.status !== "done" : true;
    togglePlanStepFromPreview(stepNum, checked);
  };

  for (const li of root.querySelectorAll("li.task[data-plan-step]")) {
    const input = li.querySelector('input[type="checkbox"]');
    if (!input) continue;
    input.disabled = false;

    input.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      flipStep(Number(li.getAttribute("data-plan-step")));
    });
    input.addEventListener("dblclick", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    li.addEventListener("click", (ev) => {
      if (ev.target instanceof Element && ev.target.closest("a, input, button")) return;
      ev.preventDefault();
      ev.stopPropagation();
      flipStep(Number(li.getAttribute("data-plan-step")));
    });
    li.addEventListener("dblclick", (ev) => {
      // Don't enter edit mode when double-clicking a task row
      ev.preventDefault();
      ev.stopPropagation();
    });
  }
}

// --- Find in plan -----------------------------------------------------------

function findMatchesInText(text, query) {
  if (!query) return [];
  const hay = String(text);
  const needle = String(query);
  const lowerHay = hay.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  if (!lowerNeedle) return [];
  /** @type {{ start: number, end: number }[]} */
  const matches = [];
  let from = 0;
  while (from < lowerHay.length) {
    const i = lowerHay.indexOf(lowerNeedle, from);
    if (i < 0) break;
    matches.push({ start: i, end: i + needle.length });
    from = i + Math.max(1, needle.length);
  }
  return matches;
}

function clearFindHighlights(root = $("plan-md")) {
  if (!root) return;
  for (const mark of [...root.querySelectorAll("mark.plan-find-hit")]) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

function highlightQueryInElement(root, query, currentIndex) {
  clearFindHighlights(root);
  if (!root || !query) return 0;

  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  /** @type {Text[]} */
  const nodes = [];
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (!(n instanceof Text) || !n.nodeValue) continue;
    if (n.parentElement?.closest("mark.plan-find-hit")) continue;
    nodes.push(n);
  }

  let hit = 0;
  for (const textNode of nodes) {
    const value = textNode.nodeValue || "";
    const lower = value.toLowerCase();
    /** @type {{ start: number, end: number }[]} */
    const local = [];
    let from = 0;
    while (from < lower.length) {
      const i = lower.indexOf(needle, from);
      if (i < 0) break;
      local.push({ start: i, end: i + query.length });
      from = i + Math.max(1, query.length);
    }
    if (!local.length) continue;

    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const m of local) {
      if (m.start > cursor) frag.append(document.createTextNode(value.slice(cursor, m.start)));
      const mark = document.createElement("mark");
      mark.className = "plan-find-hit" + (hit === currentIndex ? " current" : "");
      mark.textContent = value.slice(m.start, m.end);
      frag.append(mark);
      hit += 1;
      cursor = m.end;
    }
    if (cursor < value.length) frag.append(document.createTextNode(value.slice(cursor)));
    textNode.parentNode?.replaceChild(frag, textNode);
  }
  return hit;
}

function scrollTextareaToOffset(ta, offset) {
  if (!ta) return;
  const value = ta.value || "";
  const linesBefore = value.slice(0, offset).split("\n").length - 1;
  const style = getComputedStyle(ta);
  let lineHeight = parseFloat(style.lineHeight);
  if (!Number.isFinite(lineHeight)) {
    lineHeight = (parseFloat(style.fontSize) || 14) * 1.55;
  }
  const padding = parseFloat(style.paddingTop) || 0;
  ta.scrollTop = Math.max(0, linesBefore * lineHeight - ta.clientHeight / 3 + padding);
}

function updateFindCountUi() {
  const el = $("plan-find-count");
  if (!el) return;
  const total = state.findMatches.length;
  const q = state.findQuery;
  if (!q) {
    el.textContent = "0/0";
    el.classList.remove("no-matches");
    return;
  }
  if (!total) {
    el.textContent = "0/0";
    el.classList.add("no-matches");
    return;
  }
  el.textContent = `${state.findIndex + 1}/${total}`;
  el.classList.remove("no-matches");
}

function applyFindHighlights() {
  const md = $("plan-md");
  const showPreview = md && !md.classList.contains("hidden") && !$("plan-preview-pane")?.classList.contains("hidden");
  if (showPreview) {
    highlightQueryInElement(md, state.findQuery, state.findIndex);
    const current = md.querySelector("mark.plan-find-hit.current");
    if (current) {
      current.scrollIntoView({
        block: "center",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    }
  } else {
    clearFindHighlights(md);
  }
}

function applyFindEditorSelection() {
  const ta = $("plan-editor");
  const match = state.findMatches[state.findIndex];
  if (!ta || ta.classList.contains("hidden") || !match) return;
  // Don't steal focus from the find input while typing the query
  const findInput = $("plan-find-input");
  const typingQuery = document.activeElement === findInput;
  if (!typingQuery) ta.focus();
  try {
    ta.setSelectionRange(match.start, match.end);
  } catch {
    /* ignore */
  }
  scrollTextareaToOffset(ta, match.start);
}

function runFind({ keepIndex = false } = {}) {
  const input = $("plan-find-input");
  const query = input ? input.value : state.findQuery;
  state.findQuery = query;
  const src = currentEditorMarkdown();
  const prevIndex = state.findIndex;
  state.findMatches = findMatchesInText(src, query);
  if (!state.findMatches.length) {
    state.findIndex = 0;
  } else if (!keepIndex || prevIndex >= state.findMatches.length) {
    state.findIndex = keepIndex ? Math.min(prevIndex, state.findMatches.length - 1) : 0;
  }
  updateFindCountUi();
  applyFindHighlights();
  if (!document.activeElement || document.activeElement !== $("plan-find-input")) {
    applyFindEditorSelection();
  } else if ($("plan-editor") && !$("plan-editor").classList.contains("hidden")) {
    // Still move the selection without stealing focus
    const ta = $("plan-editor");
    const match = state.findMatches[state.findIndex];
    if (match) {
      try {
        ta.setSelectionRange(match.start, match.end);
      } catch {
        /* ignore */
      }
      scrollTextareaToOffset(ta, match.start);
    }
  }
}

function findNext(dir = 1) {
  if (!state.findMatches.length) {
    runFind();
    return;
  }
  const n = state.findMatches.length;
  state.findIndex = (state.findIndex + dir + n * 10) % n;
  updateFindCountUi();
  applyFindHighlights();
  applyFindEditorSelection();
}

function openFind(seed = "") {
  if (state.tab !== "plan") setTab("plan");
  state.findOpen = true;
  $("plan-find")?.classList.remove("hidden");
  const input = $("plan-find-input");
  if (input) {
    if (seed && !input.value) input.value = seed;
    input.focus();
    input.select();
  }
  runFind({ keepIndex: true });
}

function closeFind() {
  if (!state.findOpen) return;
  state.findOpen = false;
  state.findQuery = "";
  state.findMatches = [];
  state.findIndex = 0;
  const input = $("plan-find-input");
  if (input) input.value = "";
  $("plan-find")?.classList.add("hidden");
  clearFindHighlights($("plan-md"));
  updateFindCountUi();
}

function scheduleFindRefresh() {
  if (!state.findOpen) return;
  if (findDebounceTimer != null) clearTimeout(findDebounceTimer);
  findDebounceTimer = window.setTimeout(() => {
    findDebounceTimer = null;
    runFind({ keepIndex: true });
  }, 120);
}

// --- Export / copy ----------------------------------------------------------

function planExportMarkdown() {
  return currentEditorMarkdown() || planMarkdownSource(state.plan) || "";
}

function planChecklistText(plan = state.plan) {
  const steps = plan.steps || [];
  const title = (plan.title || "").trim();
  const lines = [];
  if (title) lines.push(title, "");
  if (!steps.length) {
    // Fall back to stripping markdown to a plain checklist of numbered tasks
    const md = planExportMarkdown();
    const fromMd = md
      .split("\n")
      .map((line) => {
        const m = line.match(/^\s*(\d+)[.)]\s+(?:\[([ xX~!])\]\s+)?(.+)$/);
        if (!m) return null;
        const mark = (m[2] || " ").toLowerCase();
        const box = mark === "x" ? "[x]" : mark === "~" ? "[~]" : mark === "!" ? "[!]" : "[ ]";
        const raw = m[3].replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim();
        return `${m[1]}. ${box} ${raw}`;
      })
      .filter(Boolean);
    lines.push(...fromMd);
    return lines.join("\n").trim() + (lines.length ? "\n" : "");
  }
  for (const s of steps) {
    const box =
      s.status === "done"
        ? "[x]"
        : s.status === "skipped"
          ? "[~]"
          : s.status === "failed"
            ? "[!]"
            : "[ ]";
    lines.push(`${s.step}. ${box} ${s.title || "Untitled"}`);
  }
  return lines.join("\n") + "\n";
}

function safeDownloadBasename(name) {
  const base = String(name || "plan")
    .trim()
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return base || "plan";
}

async function copyTextToClipboard(text) {
  const value = String(text ?? "");
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  // Fallback for older embedded browsers
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(ta);
  if (!ok) throw new Error("Clipboard copy failed");
}

function downloadTextFile(filename, text, mime = "text/markdown;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function closeExportMenu() {
  $("export-menu-panel")?.classList.add("hidden");
  $("btn-export")?.setAttribute("aria-expanded", "false");
}

function toggleExportMenu() {
  const panel = $("export-menu-panel");
  if (!panel) return;
  const open = panel.classList.contains("hidden");
  if (open) {
    panel.classList.remove("hidden");
    $("btn-export")?.setAttribute("aria-expanded", "true");
  } else {
    closeExportMenu();
  }
}

async function runExportAction(action) {
  closeExportMenu();
  try {
    if (action === "copy-md") {
      const md = planExportMarkdown();
      if (!md.trim()) throw new Error("Nothing to copy");
      await copyTextToClipboard(md);
      showToast("Markdown copied", "ok");
      return;
    }
    if (action === "download-md") {
      const md = planExportMarkdown();
      if (!md.trim()) throw new Error("Nothing to download");
      const name = `${safeDownloadBasename(state.plan.title || "plan")}.md`;
      downloadTextFile(name, md.endsWith("\n") ? md : md + "\n");
      showToast(`Downloaded ${name}`, "ok");
      return;
    }
    if (action === "copy-checklist") {
      const text = planChecklistText();
      if (!text.trim()) throw new Error("No checklist to copy");
      await copyTextToClipboard(text);
      showToast("Checklist copied", "ok");
      return;
    }
  } catch (e) {
    showErr(e);
  }
}

/** Build the sticky H1–H3 outline from rendered preview headings. */
function renderOutlineFromPreview() {
  const md = $("plan-md");
  const nav = $("plan-outline");
  const list = $("plan-outline-list");
  if (!md || !nav || !list) return;

  const headings = [...md.querySelectorAll("h1[id], h2[id], h3[id]")].map((h) => ({
    id: h.id,
    level: Number(h.tagName[1]),
    text: (h.textContent || "").trim() || h.id,
  }));

  list.replaceChildren();
  if (!headings.length) {
    nav.classList.add("hidden");
    state.activeOutlineId = null;
    return;
  }

  nav.classList.remove("hidden");
  for (const item of headings) {
    const li = document.createElement("li");
    li.className = `plan-outline-item level-${item.level}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "plan-outline-link";
    btn.dataset.outlineId = item.id;
    btn.title = item.text;
    btn.textContent = item.text;
    if (item.id === state.activeOutlineId) btn.classList.add("active");
    btn.addEventListener("click", () => jumpToOutlineHeading(item.id));
    li.append(btn);
    list.append(li);
  }

  // Keep spy in sync after re-render (content height may change)
  requestAnimationFrame(() => updateOutlineScrollSpy());
}

function setActiveOutlineId(id) {
  state.activeOutlineId = id || null;
  const list = $("plan-outline-list");
  if (!list) return;
  for (const btn of list.querySelectorAll(".plan-outline-link")) {
    btn.classList.toggle("active", btn.dataset.outlineId === state.activeOutlineId);
  }
  const active = list.querySelector(".plan-outline-link.active");
  if (active && typeof active.scrollIntoView === "function") {
    active.scrollIntoView({ block: "nearest" });
  }
}

function jumpToOutlineHeading(id) {
  const scroll = $("plan-md-scroll");
  const target = id ? document.getElementById(id) : null;
  if (!scroll || !target) return;

  const scrollRect = scroll.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const next = scroll.scrollTop + (targetRect.top - scrollRect.top) - 12;
  scroll.scrollTo({
    top: Math.max(0, next),
    behavior: prefersReducedMotion() ? "auto" : "smooth",
  });
  setActiveOutlineId(id);
}

function updateOutlineScrollSpy() {
  const scroll = $("plan-md-scroll");
  const md = $("plan-md");
  if (!scroll || !md || scroll.classList.contains("hidden")) return;

  const headings = [...md.querySelectorAll("h1[id], h2[id], h3[id]")];
  if (!headings.length) return;

  const scrollRect = scroll.getBoundingClientRect();
  const marker = scrollRect.top + 28;
  let current = headings[0].id;

  for (const h of headings) {
    const top = h.getBoundingClientRect().top;
    if (top <= marker) current = h.id;
    else break;
  }

  // Near bottom: pin last heading so the final section can activate
  if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 4) {
    current = headings[headings.length - 1].id;
  }

  if (current !== state.activeOutlineId) setActiveOutlineId(current);
}

function onOutlineScroll() {
  if (outlineScrollRaf != null) return;
  outlineScrollRaf = requestAnimationFrame(() => {
    outlineScrollRaf = null;
    updateOutlineScrollSpy();
  });
}

function bindOutlineScrollSpy() {
  const scroll = $("plan-md-scroll");
  if (!scroll || outlineScrollBound) return;
  scroll.addEventListener("scroll", onOutlineScroll, { passive: true });
  outlineScrollBound = true;
}

function isExecutionDashboard(plan = state.plan) {
  return plan.mode === "executing" || plan.mode === "complete";
}

function updatePlanChrome() {
  const isPlan = state.tab === "plan";
  const locked = isExecutionDashboard();
  const viewingResponse = isPlan && !!getActiveResponse();
  const editing = isPlan && state.editing && !locked && !viewingResponse;
  $("btn-edit-plan")?.classList.toggle("hidden", !isPlan || editing || locked || viewingResponse);
  $("btn-done-edit")?.classList.toggle("hidden", !editing);
  $("btn-add")?.classList.toggle("hidden", isPlan || locked);
  $("export-menu")?.classList.toggle("hidden", !isPlan || viewingResponse);
  $("btn-execute")?.classList.toggle("hidden", locked);
  $("btn-apply")?.classList.toggle("hidden", locked || viewingResponse);
  $("plan-editor-bar")?.classList.toggle("hidden", !editing);
  $("plan-title")?.classList.toggle("hidden", viewingResponse);
  if (!isPlan || viewingResponse) closeExportMenu();

  const view = state.editing && !viewingResponse ? state.planView : "preview";
  $("view-plan")?.setAttribute("data-plan-mode", view);
  $("view-plan")?.classList.toggle("viewing-response", viewingResponse);

  for (const btn of document.querySelectorAll("[data-plan-view]")) {
    btn.classList.toggle("active", btn.getAttribute("data-plan-view") === state.planView);
  }

  const showEditor = editing && (view === "edit" || view === "split");
  const showPreview = !editing || view === "preview" || view === "split" || viewingResponse;
  $("plan-editor")?.classList.toggle("hidden", !showEditor);
  $("plan-preview-pane")?.classList.toggle("hidden", !showPreview);
  $("plan-md")?.classList.toggle("hidden", !showPreview);
  $("md-toolbar")?.classList.toggle("hidden", !showEditor);
  if (showPreview) {
    requestAnimationFrame(() => updateOutlineScrollSpy());
  }
}

function setTab(tab) {
  state.tab = tab === "steps" ? "steps" : "plan";
  const isPlan = state.tab === "plan";
  $("tab-plan").classList.toggle("active", isPlan);
  $("tab-steps").classList.toggle("active", !isPlan);
  $("tab-plan").setAttribute("aria-selected", isPlan ? "true" : "false");
  $("tab-steps").setAttribute("aria-selected", isPlan ? "false" : "true");
  $("view-plan").classList.toggle("hidden", !isPlan);
  $("view-steps").classList.toggle("hidden", isPlan);
  try {
    sessionStorage.setItem(TAB_STORAGE_KEY, state.tab);
  } catch {
    /* ignore */
  }
  updatePlanChrome();
  updateStepsBulkBar();
}

function restoreTab() {
  try {
    const saved = sessionStorage.getItem(TAB_STORAGE_KEY);
    if (saved === "steps" || saved === "plan") return saved;
  } catch {
    /* ignore */
  }
  return "plan";
}

function setPlanView(view) {
  if (view !== "preview" && view !== "edit" && view !== "split") return;
  state.planView = view;
  // Keep draft → preview in sync when splitting / previewing while editing
  if (state.editing) {
    const ta = $("plan-editor");
    if (ta && state.editingDraft !== null) ta.value = state.editingDraft;
    renderPlanMarkdown(currentEditorMarkdown());
  }
  updatePlanChrome();
  if (state.editing && (view === "edit" || view === "split")) {
    requestAnimationFrame(() => $("plan-editor")?.focus());
  }
}

function enterPlanEdit(preferredView) {
  if (isExecutionDashboard()) return;
  clearActiveResponse();
  if (state.tab !== "plan") setTab("plan");
  if (!state.editing) {
    state.editing = true;
    state.editingDraft = planMarkdownSource(state.plan);
    const ta = $("plan-editor");
    if (ta) ta.value = state.editingDraft;
  }
  state.planView = preferredView || (state.planView === "preview" ? "edit" : state.planView);
  if (state.planView === "preview") state.planView = "edit";
  renderPlanMarkdown(currentEditorMarkdown());
  updatePlanChrome();
  requestAnimationFrame(() => $("plan-editor")?.focus());
}

async function exitPlanEdit({ applyIfDirty = true } = {}) {
  if (!state.editing) return;
  if (applyIfDirty && state.dirty) {
    try {
      await applyEdits();
    } catch (e) {
      showErr(e);
      return;
    }
  }
  state.editing = false;
  state.editingDraft = null;
  state.planView = "preview";
  updatePlanChrome();
  renderPlanMarkdown(planMarkdownSource(state.plan));
}

function renderExecutionDashboard(plan) {
  const model = executionDashboardModel(plan);
  const complete = plan.mode === "complete";
  const active = model.activeStep;
  const running = model.runningActivity;
  $("steps-editor").classList.add("hidden");
  $("execution-dashboard").classList.remove("hidden");
  $("execution-mode").textContent = complete ? "Execution complete" : "Plan execution";
  $("execution-title").textContent = plan.title || (complete ? "Plan complete" : "Executing plan");
  $("execution-percent").textContent = `${model.percent}%`;
  $("execution-progress-label").textContent = `${model.completed} of ${model.total} complete`;
  const progress = $("execution-progress");
  progress.style.setProperty("--progress", `${model.percent}%`);
  progress.setAttribute("aria-valuenow", String(model.percent));
  $("execution-live").textContent = complete
    ? "All execution activity has settled."
    : running
      ? `Running ${running.summary || running.toolName}${running.path ? ` · ${running.path}` : ""}`
      : active
        ? `Working on step ${active.step}: ${active.title || "Untitled step"}`
        : "Waiting for the next step.";
  renderStatusBreakdown($("execution-status-breakdown"), model.counts);
  $("metric-elapsed").textContent = formatDuration(model.elapsedMs);
  $("metric-current-step").textContent = active ? `#${active.step}` : complete ? "Complete" : "Waiting";
  $("metric-tool-calls").textContent = `${model.toolCallsCompleted}/${model.toolCallsStarted}`;
  $("metric-files").textContent = `${model.changedFiles} · ${model.fileEdits} edits`;
  $("metric-failed").textContent = String(model.counts.failed);
  $("execution-summary-text").textContent = model.summary;
  $("execution-files-count").textContent = `${model.changedFiles} files`;
  $("execution-activity-count").textContent = `${model.toolCallsCompleted} complete`;
  $("execution-step-count").textContent = `${model.completed}/${model.total} complete`;

  const viewAllBtn = $("btn-view-all-changes");
  if (viewAllBtn) {
    viewAllBtn.classList.toggle("hidden", model.changedFiles === 0);
  }

  renderExecutionList($("execution-files-list"), model.recentFiles, "No successful file edits recorded yet.", (file) => {
    const row = document.createElement("li");
    row.className = "execution-list-row clickable";
    row.title = file.hasDiff === false ? "Open change (diff unavailable)" : "Open change";
    const path = document.createElement("code");
    path.textContent = file.path;
    const meta = document.createElement("span");
    meta.className = "execution-list-meta";
    const op = document.createElement("span");
    op.textContent = `${file.operation} · ${file.count}×`;
    meta.append(op);
    if (typeof file.additions === "number" || typeof file.deletions === "number") {
      const add = document.createElement("span");
      add.className = "diff-additions";
      add.textContent = `+${file.additions ?? 0}`;
      const del = document.createElement("span");
      del.className = "diff-deletions";
      del.textContent = `−${file.deletions ?? 0}`;
      meta.append(add, del);
    }
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn-copy-path";
    copyBtn.title = "Copy path";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void copyPathChip(file.path);
    });
    row.append(path, meta, copyBtn);
    row.addEventListener("click", () => void openDiffViewer({ path: file.path }));
    return row;
  });
  const changedPaths = new Set((plan.execution?.files || []).map((f) => f.path));
  renderExecutionList($("execution-activity-list"), model.recentActivity, "Waiting for tool activity…", (activity) => {
    const row = document.createElement("li");
    const canOpen = Boolean(activity.path && changedPaths.has(activity.path));
    row.className = `execution-list-row activity-${activity.status}${canOpen ? " clickable" : ""}`;
    if (canOpen) row.title = "Open change";
    const label = document.createElement("span");
    label.textContent = activity.summary || `${activity.toolName}${activity.path ? ` ${activity.path}` : ""}`;
    const meta = document.createElement("span");
    meta.textContent = activity.status === "running" ? "running" : activity.status === "error" ? "error" : "done";
    row.append(label, meta);
    if (canOpen) {
      row.addEventListener("click", () => void openDiffViewer({ path: activity.path }));
    }
    return row;
  });
  renderExecutionList($("execution-steps-list"), plan.steps || [], "No plan steps available.", (step) => {
    const expanded = state.executionExpandedId === step.id;
    const row = document.createElement("li");
    row.className = `execution-step ${step.status}${expanded ? " expanded" : ""}${step.status === "failed" ? " needs-attention" : ""}`;
    row.tabIndex = 0;
    row.setAttribute("aria-expanded", expanded ? "true" : "false");

    const head = document.createElement("button");
    head.type = "button";
    head.className = "execution-step-head";
    const number = document.createElement("span");
    number.className = "execution-step-number";
    number.textContent = String(step.step);
    const title = document.createElement("span");
    title.className = "execution-step-title";
    title.textContent = step.title || "Untitled step";
    const status = document.createElement("span");
    status.className = "execution-step-status";
    status.textContent = step.status;
    head.append(number, title, status);
    head.addEventListener("click", () => {
      state.executionExpandedId = expanded ? null : step.id;
      renderExecutionDashboard(state.plan);
    });
    row.append(head);

    if (expanded) {
      const body = document.createElement("div");
      body.className = "execution-step-body";
      const detailText = (step.detail || step.notes || "").trim();
      if (detailText) {
        const detail = document.createElement("p");
        detail.className = "execution-step-detail";
        detail.textContent = detailText;
        body.append(detail);
      } else {
        const empty = document.createElement("p");
        empty.className = "execution-step-detail muted";
        empty.textContent = "No detail notes for this step.";
        body.append(empty);
      }
      const files = Array.isArray(step.files) ? step.files : [];
      if (files.length) {
        const fileList = document.createElement("ul");
        fileList.className = "execution-step-files";
        for (const f of files) {
          const item = document.createElement("li");
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "execution-path-btn";
          btn.title = "Copy path";
          btn.textContent = f;
          btn.addEventListener("click", () => copyPathChip(f));
          item.append(btn);
          fileList.append(item);
        }
        body.append(fileList);
      }
      row.append(body);
    }
    return row;
  });

  // Auto-expand failed / active step once per execution session
  if (!state.executionDidAutoExpand && !state.executionExpandedId) {
    const focus =
      (plan.steps || []).find((s) => s.status === "failed") ||
      (plan.steps || []).find((s) => s.id === plan.activeStepId) ||
      (plan.steps || []).find((s) => s.status === "active");
    if (focus) {
      state.executionExpandedId = focus.id;
      state.executionDidAutoExpand = true;
      requestAnimationFrame(() => {
        if (isExecutionDashboard(state.plan)) renderExecutionDashboard(state.plan);
      });
    }
  }
}

async function copyPathChip(path) {
  const value = String(path || "").trim();
  if (!value) return;
  try {
    await copyTextToClipboard(value);
    showToast(`Copied ${value}`, "ok");
  } catch (e) {
    showErr(e);
  }
}

function syncDiffLayoutButtons() {
  for (const btn of document.querySelectorAll("[data-diff-layout]")) {
    btn.classList.toggle("active", btn.getAttribute("data-diff-layout") === state.diffLayout);
  }
}

/**
 * @param {{ path?: string, all?: boolean }} opts
 */
async function openDiffViewer(opts = {}) {
  const dlg = $("diff-dialog");
  const body = $("diff-dialog-body");
  const copyBtn = $("diff-copy-path");
  if (!dlg || !body) return;

  state.diffAll = Boolean(opts.all);
  state.diffPath = opts.all ? null : (opts.path || null);
  syncDiffLayoutButtons();

  body.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "diff-empty";
  loading.textContent = "Loading changes…";
  body.append(loading);

  if (copyBtn) {
    copyBtn.classList.toggle("hidden", state.diffAll || !state.diffPath);
  }

  if (!dlg.open) dlg.showModal();

  try {
    const changes = await fetchChanges(state.diffAll ? undefined : state.diffPath || undefined);
    const title = state.diffAll
      ? `All changes (${changes.length})`
      : state.diffPath || "File change";
    renderDiffView(body, { changes, layout: state.diffLayout, title });
  } catch (e) {
    body.replaceChildren();
    const err = document.createElement("p");
    err.className = "diff-unavailable";
    err.textContent = e instanceof Error ? e.message : String(e);
    body.append(err);
  }
}

async function refreshOpenDiffViewer() {
  const dlg = $("diff-dialog");
  if (!dlg?.open) return;
  if (state.diffAll) await openDiffViewer({ all: true });
  else if (state.diffPath) await openDiffViewer({ path: state.diffPath });
}

function renderStatusBreakdown(container, counts) {
  container.replaceChildren();
  for (const status of ["done", "active", "pending", "skipped", "failed"]) {
    if (!counts[status]) continue;
    const chip = document.createElement("span");
    chip.className = `status-chip ${status}`;
    chip.textContent = `${counts[status]} ${status}`;
    container.append(chip);
  }
}

function renderExecutionList(list, items, emptyText, createRow) {
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("li");
    empty.className = "execution-empty";
    empty.textContent = emptyText;
    list.append(empty);
    return;
  }
  for (const item of items) list.append(createRow(item));
}

function render() {
  const plan = state.plan;
  const modeEl = $("mode");
  modeEl.textContent = plan.mode || "off";
  modeEl.className = `badge mode-${plan.mode || "off"}`;
  $("cwd").textContent = plan.cwd || state.cwd || "";
  $("progress").textContent = progressText(plan);
  $("plan-title").value = plan.title || "";
  $("conn").className = `dot ${state.connected ? "online" : "offline"}`;

  // Drop stale active response if it was removed
  if (state.activeResponseId && !(plan.responses || []).some((r) => r.id === state.activeResponseId)) {
    clearActiveResponse();
  }

  const activeResponse = getActiveResponse();
  // Don't clobber the textarea while the user is typing
  if (activeResponse) {
    renderPlanMarkdown(activeResponse.markdown);
  } else if (state.editing) {
    renderPlanMarkdown(currentEditorMarkdown());
  } else {
    renderPlanMarkdown(planMarkdownSource(plan));
  }
  renderResponseTabs();
  updatePlanChrome();

  if (isExecutionDashboard(plan)) {
    renderExecutionDashboard(plan);
    return;
  }
  $("steps-editor").classList.remove("hidden");
  $("execution-dashboard").classList.add("hidden");

  const list = $("steps");
  list.innerHTML = "";
  const steps = plan.steps || [];
  const visibleSteps = filterVisibleSteps(steps);
  $("empty").classList.toggle("hidden", steps.length > 0);
  $("steps-filter-empty")?.classList.toggle(
    "hidden",
    !(steps.length > 0 && visibleSteps.length === 0),
  );

  updateStepsProgressRing(steps);
  syncStepsFilterChrome();

  // Drop stale multi-select ids
  for (const id of [...state.selectedIds]) {
    if (!steps.some((s) => s.id === id)) state.selectedIds.delete(id);
  }
  if (state.selectedId && !steps.some((s) => s.id === state.selectedId)) {
    state.selectedId = steps[0]?.id ?? null;
  }
  if (state.selectedId) state.selectedIds.add(state.selectedId);

  for (const step of visibleSteps) {
    const selected = state.selectedIds.has(step.id);
    const li = document.createElement("li");
    li.className = `step ${step.status}${selected ? " selected" : ""}`;
    li.dataset.id = step.id;
    li.draggable = true;
    li.innerHTML = `
      <span class="grip" title="Drag to reorder" aria-hidden="true">⠿</span>
      <span class="num">${step.step}</span>
      <span class="stitle"></span>
      <span class="st">${step.status}</span>
    `;
    li.querySelector(".stitle").textContent = step.title;
    li.addEventListener("click", (ev) => selectStep(step.id, ev));
    li.addEventListener("dragstart", (ev) => onStepDragStart(ev, step.id));
    li.addEventListener("dragend", onStepDragEnd);
    li.addEventListener("dragover", (ev) => onStepDragOver(ev, step.id));
    li.addEventListener("dragleave", () => clearStepDropIndicators());
    li.addEventListener("drop", (ev) => onStepDrop(ev, step.id));
    list.appendChild(li);
  }

  updateStepsBulkBar();

  const sel = steps.find((s) => s.id === state.selectedId) || null;
  if (!sel) {
    $("detail").classList.add("hidden");
    $("detail-empty").classList.remove("hidden");
  } else {
    $("detail").classList.remove("hidden");
    $("detail-empty").classList.add("hidden");
    $("detail-title").value = sel.title || "";
    $("detail-body").value = sel.detail || sel.notes || "";
    $("detail-status").value = sel.status || "pending";
    renderDetailFiles(sel);
  }
}

function renderDetailFiles(step) {
  const box = $("detail-files");
  if (!box) return;
  box.replaceChildren();
  const files = Array.isArray(step.files) ? step.files : [];
  for (const path of files) {
    const chip = document.createElement("span");
    chip.className = "file-chip";
    const code = document.createElement("code");
    code.textContent = path;
    code.title = path;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "file-chip-remove";
    rm.title = "Remove";
    rm.setAttribute("aria-label", `Remove ${path}`);
    rm.textContent = "×";
    rm.addEventListener("click", () => {
      mutateLocal(() => {
        step.files = (step.files || []).filter((f) => f !== path);
        if (!step.files.length) delete step.files;
      });
    });
    chip.append(code, rm);
    box.append(chip);
  }
}

function addDetailFile(path) {
  const s = selected();
  const cleaned = String(path || "").trim();
  if (!s || !cleaned) return;
  mutateLocal(() => {
    const files = Array.isArray(s.files) ? [...s.files] : [];
    if (!files.includes(cleaned)) files.push(cleaned);
    s.files = files;
  });
}

async function executePlan(fromStepId) {
  if (state.dirty) await applyEdits();
  const body = fromStepId ? { fromStepId } : {};
  await api("/api/execute", body);
  showToast(fromStepId ? "Execute from step requested" : "Execute requested", "ok");
}

function updateStepsBulkBar() {
  const bar = $("steps-bulk");
  const countEl = $("steps-bulk-count");
  if (!bar || !countEl) return;
  const n = state.selectedIds.size;
  const show = state.tab === "steps" && !isExecutionDashboard() && n > 0;
  bar.classList.toggle("hidden", !show);
  countEl.textContent = n === 1 ? "1 selected" : `${n} selected`;
}

function filterVisibleSteps(steps) {
  const q = (state.stepsSearch || "").trim().toLowerCase();
  const status = state.stepsStatusFilter || "all";
  return (steps || []).filter((s) => {
    if (status !== "all" && s.status !== status) return false;
    if (!q) return true;
    const hay = `${s.title || ""} ${s.detail || ""} ${s.notes || ""}`.toLowerCase();
    return hay.includes(q);
  });
}

function updateStepsProgressRing(steps) {
  const ring = $("steps-progress");
  const pctEl = $("steps-progress-pct");
  if (!ring || !pctEl) return;
  const total = steps?.length || 0;
  const done = (steps || []).filter((s) => s.status === "done" || s.status === "skipped").length;
  const percent = total ? Math.round((done / total) * 100) : 0;
  ring.style.setProperty("--progress", `${percent}%`);
  ring.setAttribute("aria-valuenow", String(percent));
  ring.title = total ? `${done}/${total} complete` : "No steps";
  pctEl.textContent = `${percent}%`;
}

function syncStepsFilterChrome() {
  const search = $("steps-search");
  if (search && search !== document.activeElement && search.value !== state.stepsSearch) {
    search.value = state.stepsSearch;
  }
  for (const btn of document.querySelectorAll("[data-status-filter]")) {
    btn.classList.toggle("active", btn.getAttribute("data-status-filter") === state.stepsStatusFilter);
  }
}

/**
 * @param {string} id
 * @param {MouseEvent|null} [ev]
 */
function selectStep(id, ev = null) {
  const steps = state.plan.steps || [];
  if (!steps.some((s) => s.id === id)) return;

  const multi = ev && (ev.metaKey || ev.ctrlKey);
  const range = ev && ev.shiftKey && state.selectedId;

  if (range) {
    const ids = steps.map((s) => s.id);
    const a = ids.indexOf(state.selectedId);
    const b = ids.indexOf(id);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      if (!(ev.metaKey || ev.ctrlKey)) state.selectedIds.clear();
      for (let i = lo; i <= hi; i++) state.selectedIds.add(ids[i]);
      state.selectedId = id;
    }
  } else if (multi) {
    if (state.selectedIds.has(id) && state.selectedIds.size > 1) {
      state.selectedIds.delete(id);
      state.selectedId = state.selectedIds.values().next().value ?? null;
    } else {
      state.selectedIds.add(id);
      state.selectedId = id;
    }
  } else {
    state.selectedIds = new Set([id]);
    state.selectedId = id;
  }
  render();
}

function clearStepDropIndicators() {
  for (const el of document.querySelectorAll(".step.drop-before, .step.drop-after")) {
    el.classList.remove("drop-before", "drop-after");
  }
}

function onStepDragStart(ev, id) {
  if (isExecutionDashboard()) {
    ev.preventDefault();
    return;
  }
  state.dragStepId = id;
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", id);
  }
  const li = ev.currentTarget;
  if (li instanceof HTMLElement) li.classList.add("dragging");
  // Ensure dragged row is part of selection
  if (!state.selectedIds.has(id)) {
    state.selectedIds = new Set([id]);
    state.selectedId = id;
  }
}

function onStepDragEnd() {
  state.dragStepId = null;
  clearStepDropIndicators();
  for (const el of document.querySelectorAll(".step.dragging")) el.classList.remove("dragging");
}

function onStepDragOver(ev, overId) {
  if (!state.dragStepId || state.dragStepId === overId) return;
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
  clearStepDropIndicators();
  const li = ev.currentTarget;
  if (!(li instanceof HTMLElement)) return;
  const rect = li.getBoundingClientRect();
  const before = ev.clientY < rect.top + rect.height / 2;
  li.classList.add(before ? "drop-before" : "drop-after");
}

function onStepDrop(ev, targetId) {
  ev.preventDefault();
  const dragId = state.dragStepId || ev.dataTransfer?.getData("text/plain");
  clearStepDropIndicators();
  if (!dragId || dragId === targetId || isExecutionDashboard()) return;

  const li = ev.currentTarget;
  const rect = li instanceof HTMLElement ? li.getBoundingClientRect() : null;
  const before = rect ? ev.clientY < rect.top + rect.height / 2 : true;

  mutateLocal((p) => {
    const steps = [...(p.steps || [])];
    const from = steps.findIndex((s) => s.id === dragId);
    let to = steps.findIndex((s) => s.id === targetId);
    if (from < 0 || to < 0) return;
    const [item] = steps.splice(from, 1);
    if (from < to) to -= 1;
    const insertAt = before ? to : to + 1;
    steps.splice(insertAt, 0, item);
    p.steps = steps;
    // Keep markdown step order roughly aligned on next apply via ensure — leave md dirty via steps only
  });
  state.dragStepId = null;
}

function selectedStepIds() {
  if (state.selectedIds.size) return [...state.selectedIds];
  return state.selectedId ? [state.selectedId] : [];
}

function bulkSetStatus(status) {
  const ids = new Set(selectedStepIds());
  if (!ids.size) return;
  mutateLocal((p) => {
    for (const s of p.steps || []) {
      if (ids.has(s.id)) s.status = status;
    }
    // Reflect status markers in markdown when present
    if ((p.markdown || "").trim()) {
      p.markdown = syncMarkdownCheckboxes(p.markdown, p.steps);
    }
  });
}

function bulkRemoveSelected() {
  const ids = new Set(selectedStepIds());
  if (!ids.size) return;
  mutateLocal((p) => {
    p.steps = (p.steps || []).filter((s) => !ids.has(s.id));
    state.selectedIds.clear();
    state.selectedId = p.steps[0]?.id ?? null;
    if (state.selectedId) state.selectedIds.add(state.selectedId);
  });
}

function moveStepSelection(delta) {
  const steps = filterVisibleSteps(state.plan.steps || []);
  if (!steps.length) return;
  const ids = steps.map((s) => s.id);
  let idx = ids.indexOf(state.selectedId);
  if (idx < 0) idx = delta > 0 ? -1 : 0;
  idx = Math.max(0, Math.min(ids.length - 1, idx + delta));
  state.selectedIds = new Set([ids[idx]]);
  state.selectedId = ids[idx];
  render();
  const li = $("steps")?.querySelector(`.step[data-id="${ids[idx]}"]`);
  li?.scrollIntoView({ block: "nearest" });
}

function selected() {
  return (state.plan.steps || []).find((s) => s.id === state.selectedId);
}

function mutateLocal(fn) {
  if (isExecutionDashboard()) return;
  fn(state.plan);
  state.plan.updatedAt = Date.now();
  state.plan.steps.forEach((s, i) => {
    s.step = i + 1;
  });
  setDirty(true);
  render();
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || res.statusText);
  }
  return res.json().catch(() => ({}));
}

/**
 * Upload an image Blob/File to the companion asset store.
 * @param {Blob} blob
 * @returns {Promise<{ url: string, path: string, name: string }>}
 */
async function uploadAsset(blob) {
  const type = blob.type || "application/octet-stream";
  const res = await fetch("/api/assets", {
    method: "POST",
    headers: { "content-type": type },
    body: blob,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || res.statusText);
  }
  return res.json();
}

async function insertUploadedImage(blob, alt = "screenshot") {
  enterPlanEdit(state.planView === "preview" ? "edit" : state.planView);
  const ta = $("plan-editor");
  if (!ta) return;
  $("activity").textContent = "Uploading image…";
  try {
    const meta = await uploadAsset(blob);
    // Prefer workspace-relative path so the agent can read the file
    const src = meta.path || meta.url;
    insertImage(ta, src, alt);
    $("activity").textContent = "Image attached";
  } catch (e) {
    showErr(e);
  }
}

async function applyEdits() {
  // Pull latest draft from the textarea if editing
  if (state.editing) {
    const ta = $("plan-editor");
    if (ta) state.editingDraft = ta.value;
    if (state.editingDraft !== null) {
      state.plan.markdown = state.editingDraft;
      const synced = syncStepsFromMarkdown(state.editingDraft, state.plan.steps || []);
      if (synced.title) state.plan.title = synced.title;
      state.plan.steps = synced.steps;
      if (state.selectedId && !state.plan.steps.some((s) => s.id === state.selectedId)) {
        state.selectedId = state.plan.steps[0]?.id ?? null;
      }
    }
  }

  // Preserve the authored document. Only step-only plans need a synthesized
  // document, otherwise editing the checklist would discard plan context.
  state.plan.markdown = ensurePlanMarkdown(state.plan);
  state.plan.updatedAt = Date.now();
  state.plan.steps.forEach((s, i) => {
    s.step = i + 1;
  });

  await api("/api/replace", { state: state.plan });
  setDirty(false);
  if (state.editing) {
    state.editingDraft = state.plan.markdown;
    const ta = $("plan-editor");
    if (ta && ta !== document.activeElement) ta.value = state.editingDraft;
  }
  showToast("Edits applied to pi", "ok");
  render();
}

function onPlanEditorInput() {
  const ta = $("plan-editor");
  if (!ta || !state.editing) return;
  state.editingDraft = ta.value;
  setDirty(true);
  // Live preview in split / when preview pane visible
  if (state.planView === "split" || state.planView === "preview") {
    renderPlanMarkdown(state.editingDraft);
  }
  scheduleFindRefresh();
}

function isTypingTarget(el) {
  if (!el || !(el instanceof Element)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

function wire() {
  bindOutlineScrollSpy();

  $("tab-plan").onclick = () => {
    clearActiveResponse();
    setTab("plan");
    render();
  };
  $("tab-steps").onclick = () => {
    clearActiveResponse();
    setTab("steps");
    closeFind();
    render();
  };

  $("plan-find-input")?.addEventListener("input", () => runFind());
  $("plan-find-input")?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      findNext(ev.shiftKey ? -1 : 1);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      closeFind();
    }
  });
  $("plan-find-next")?.addEventListener("click", () => findNext(1));
  $("plan-find-prev")?.addEventListener("click", () => findNext(-1));
  $("plan-find-close")?.addEventListener("click", () => closeFind());

  $("btn-export")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleExportMenu();
  });
  $("export-menu-panel")?.addEventListener("click", (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest("[data-export]") : null;
    if (!btn) return;
    void runExportAction(btn.getAttribute("data-export"));
  });
  document.addEventListener("click", (ev) => {
    const menu = $("export-menu");
    if (!menu || menu.classList.contains("hidden")) return;
    if (ev.target instanceof Node && menu.contains(ev.target)) return;
    closeExportMenu();
  });

  $("btn-add").onclick = () => {
    setTab("steps");
    const id = crypto.randomUUID();
    mutateLocal((p) => {
      p.steps.push({ id, step: 0, title: "New step", status: "pending" });
      state.selectedId = id;
    });
  };

  $("btn-apply").onclick = () => applyEdits().catch(showErr);

  $("btn-edit-plan").onclick = () => enterPlanEdit("edit");
  $("btn-done-edit").onclick = () => exitPlanEdit({ applyIfDirty: true }).catch(showErr);

  for (const btn of document.querySelectorAll("[data-plan-view]")) {
    btn.addEventListener("click", () => {
      const v = btn.getAttribute("data-plan-view");
      if (!state.editing) enterPlanEdit(v);
      else setPlanView(v);
    });
  }

  bindToolbar(
    $("md-toolbar"),
    () => $("plan-editor"),
    {
      onImage: () => $("plan-image-input")?.click(),
    },
  );

  $("plan-image-input")?.addEventListener("change", async () => {
    const input = $("plan-image-input");
    const file = input?.files?.[0];
    if (input) input.value = "";
    if (!file) return;
    await insertUploadedImage(file, file.name?.replace(/\.[^.]+$/, "") || "image");
  });

  const editor = $("plan-editor");
  editor?.addEventListener("input", onPlanEditorInput);

  // Paste images
  editor?.addEventListener("paste", (ev) => {
    const items = ev.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type && item.type.startsWith("image/")) {
        ev.preventDefault();
        const file = item.getAsFile();
        if (file) void insertUploadedImage(file, "screenshot");
        return;
      }
    }
  });

  // Drag / drop images onto plan view
  const planBody = $("plan-editor-body");
  const overlay = $("plan-drop-overlay");
  let dragDepth = 0;

  const hasImageFiles = (dt) => {
    if (!dt) return false;
    if (dt.types && [...dt.types].includes("Files")) {
      const files = dt.files ? [...dt.files] : [];
      if (files.length) return files.some((f) => f.type.startsWith("image/"));
      // During dragover, files may be empty — assume possible image if Files type present
      return true;
    }
    return false;
  };

  planBody?.addEventListener("dragenter", (ev) => {
    if (!hasImageFiles(ev.dataTransfer)) return;
    ev.preventDefault();
    dragDepth++;
    overlay?.classList.remove("hidden");
  });
  planBody?.addEventListener("dragleave", (ev) => {
    if (!hasImageFiles(ev.dataTransfer)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay?.classList.add("hidden");
  });
  planBody?.addEventListener("dragover", (ev) => {
    if (!hasImageFiles(ev.dataTransfer)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
  });
  planBody?.addEventListener("drop", (ev) => {
    dragDepth = 0;
    overlay?.classList.add("hidden");
    const files = [...(ev.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    ev.preventDefault();
    void insertUploadedImage(files[0], files[0].name?.replace(/\.[^.]+$/, "") || "screenshot");
  });

  // Double-click preview to edit
  $("plan-md")?.addEventListener("dblclick", () => {
    if (state.tab !== "plan") return;
    enterPlanEdit(state.editing ? state.planView : "edit");
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", (ev) => {
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && ev.key.toLowerCase() === "f") {
      // Plan-tab find overlay (preview + editor)
      if (state.tab === "plan" || !isTypingTarget(ev.target)) {
        ev.preventDefault();
        let seed = "";
        const ta = $("plan-editor");
        if (ta && document.activeElement === ta && ta.selectionStart !== ta.selectionEnd) {
          seed = ta.value.slice(ta.selectionStart, ta.selectionEnd);
        } else if (typeof window.getSelection === "function") {
          const sel = window.getSelection()?.toString()?.trim();
          if (sel) seed = sel.slice(0, 200);
        }
        openFind(seed);
        return;
      }
    }
    if (mod && ev.key.toLowerCase() === "g" && state.findOpen && state.tab === "plan") {
      ev.preventDefault();
      findNext(ev.shiftKey ? -1 : 1);
      return;
    }
    if (mod && ev.key.toLowerCase() === "s") {
      ev.preventDefault();
      if (state.dirty) applyEdits().catch(showErr);
      return;
    }
    if ((ev.key === "?" || (mod && ev.key === "/")) && !isTypingTarget(ev.target)) {
      ev.preventDefault();
      openShortcutsHelp();
      return;
    }
    if (ev.key === "Escape" && !$("export-menu-panel")?.classList.contains("hidden")) {
      ev.preventDefault();
      closeExportMenu();
      return;
    }
    if (ev.key === "Escape" && state.findOpen) {
      ev.preventDefault();
      closeFind();
      return;
    }
    if (ev.key === "Escape" && state.editing && state.tab === "plan") {
      // Esc: leave edit mode without applying (keep dirty draft in plan.markdown only if already dirty via input — draft stays in editingDraft until discarded)
      if (!state.dirty) {
        ev.preventDefault();
        void exitPlanEdit({ applyIfDirty: false });
      } else {
        // Keep dirty local edits but return to preview of the draft
        ev.preventDefault();
        state.editing = false;
        // Persist draft into plan.markdown locally so preview shows it; still dirty
        if (state.editingDraft !== null) {
          state.plan.markdown = state.editingDraft;
          const synced = syncStepsFromMarkdown(state.editingDraft, state.plan.steps || []);
          if (synced.title) state.plan.title = synced.title;
          state.plan.steps = synced.steps;
        }
        state.editingDraft = null;
        state.planView = "preview";
        updatePlanChrome();
        render();
      }
      return;
    }
    if (!mod && !ev.altKey && (ev.key === "e" || ev.key === "E") && !isTypingTarget(ev.target)) {
      if (state.tab === "plan" && !state.editing) {
        ev.preventDefault();
        enterPlanEdit("edit");
      }
    }
    // Steps list navigation when not typing (list also has its own keydown)
    if (
      state.tab === "steps" &&
      !isExecutionDashboard() &&
      !isTypingTarget(ev.target) &&
      !mod &&
      !ev.altKey
    ) {
      if (ev.key === "j" || ev.key === "ArrowDown") {
        ev.preventDefault();
        moveStepSelection(1);
        $("steps")?.focus();
      } else if (ev.key === "k" || ev.key === "ArrowUp") {
        ev.preventDefault();
        moveStepSelection(-1);
        $("steps")?.focus();
      } else if (ev.key === "d") {
        ev.preventDefault();
        bulkSetStatus("done");
      } else if (ev.key === "s") {
        ev.preventDefault();
        bulkSetStatus("skipped");
      } else if (ev.key === "r") {
        ev.preventDefault();
        bulkSetStatus("pending");
      }
    }
  });

  $("btn-execute").onclick = async () => {
    try {
      await executePlan();
    } catch (e) {
      showErr(e);
    }
  };

  $("btn-execute-from")?.addEventListener("click", async () => {
    const s = selected();
    if (!s) return;
    try {
      await executePlan(s.id);
    } catch (e) {
      showErr(e);
    }
  });

  $("detail-files-input")?.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    const input = $("detail-files-input");
    addDetailFile(input?.value || "");
    if (input) input.value = "";
  });

  $("btn-view-all-changes")?.addEventListener("click", () => {
    void openDiffViewer({ all: true });
  });

  $("diff-dialog-close")?.addEventListener("click", () => {
    $("diff-dialog")?.close();
  });

  $("diff-copy-path")?.addEventListener("click", () => {
    if (state.diffPath) void copyPathChip(state.diffPath);
  });

  for (const btn of document.querySelectorAll("[data-diff-layout]")) {
    btn.addEventListener("click", () => {
      const layout = btn.getAttribute("data-diff-layout");
      if (layout !== "unified" && layout !== "split") return;
      state.diffLayout = layout;
      setDiffLayout(layout);
      syncDiffLayoutButtons();
      void refreshOpenDiffViewer();
    });
  }
  syncDiffLayoutButtons();

  $("diff-dialog")?.addEventListener("click", (ev) => {
    const dlg = $("diff-dialog");
    if (!dlg || ev.target !== dlg) return;
    dlg.close();
  });

  $("btn-refine").onclick = () => {
    $("refine-text").value = "";
    $("refine-dialog").showModal();
  };

  $("refine-dialog").addEventListener("close", async () => {
    if ($("refine-dialog").returnValue !== "ok") return;
    const text = $("refine-text").value.trim();
    if (!text) return;
    try {
      await api("/api/refine", { text });
      showToast("Refinement sent", "ok");
    } catch (e) {
      showErr(e);
    }
  });
  $("refine-ok").onclick = () => {
    $("refine-dialog").returnValue = "ok";
  };

  $("conflict-keep")?.addEventListener("click", () => {
    $("conflict-dialog").returnValue = "keep";
  });
  $("conflict-take")?.addEventListener("click", () => {
    $("conflict-dialog").returnValue = "take";
  });

  $("plan-title").addEventListener("input", () => {
    mutateLocal((p) => {
      p.title = $("plan-title").value;
    });
  });

  $("detail-title").addEventListener("input", () => {
    const s = selected();
    if (!s) return;
    mutateLocal(() => {
      s.title = $("detail-title").value;
    });
  });
  $("detail-body").addEventListener("input", () => {
    const s = selected();
    if (!s) return;
    mutateLocal(() => {
      s.detail = $("detail-body").value;
    });
  });
  $("detail-status").addEventListener("change", () => {
    const s = selected();
    if (!s) return;
    mutateLocal(() => {
      s.status = $("detail-status").value;
    });
  });

  $("btn-done").onclick = () => bulkSetStatus("done");
  $("btn-skip").onclick = () => bulkSetStatus("skipped");
  $("btn-remove").onclick = () => bulkRemoveSelected();

  $("bulk-done")?.addEventListener("click", () => bulkSetStatus("done"));
  $("bulk-skip")?.addEventListener("click", () => bulkSetStatus("skipped"));
  $("bulk-reset")?.addEventListener("click", () => bulkSetStatus("pending"));
  $("bulk-remove")?.addEventListener("click", () => bulkRemoveSelected());

  $("steps-search")?.addEventListener("input", () => {
    state.stepsSearch = $("steps-search").value || "";
    render();
    // Keep focus/caret in the search field after re-render
    const el = $("steps-search");
    if (el) {
      const end = el.value.length;
      el.focus();
      try {
        el.setSelectionRange(end, end);
      } catch {
        /* ignore */
      }
    }
  });
  $("steps-filters")?.addEventListener("click", (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest("[data-status-filter]") : null;
    if (!btn) return;
    state.stepsStatusFilter = btn.getAttribute("data-status-filter") || "all";
    render();
  });

  $("steps")?.addEventListener("keydown", (ev) => {
    if (state.tab !== "steps" || isExecutionDashboard()) return;
    if (ev.key === "j" || ev.key === "ArrowDown") {
      ev.preventDefault();
      moveStepSelection(1);
    } else if (ev.key === "k" || ev.key === "ArrowUp") {
      ev.preventDefault();
      moveStepSelection(-1);
    } else if (ev.key === "d" || ev.key === "D") {
      ev.preventDefault();
      bulkSetStatus("done");
    } else if (ev.key === "s" || ev.key === "S") {
      ev.preventDefault();
      bulkSetStatus("skipped");
    } else if (ev.key === "r" || ev.key === "R") {
      ev.preventDefault();
      bulkSetStatus("pending");
    } else if (ev.key === "Delete" || ev.key === "Backspace") {
      ev.preventDefault();
      bulkRemoveSelected();
    } else if (ev.key === "a" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      state.selectedIds = new Set((state.plan.steps || []).map((s) => s.id));
      if (!state.selectedId) state.selectedId = (state.plan.steps || [])[0]?.id ?? null;
      render();
    }
  });
}

function showErr(e) {
  const msg = `Error: ${e?.message || e}`;
  showToast(msg, "err", 4200);
}

function connectEvents() {
  const es = new EventSource("/api/events");
  es.addEventListener("state", (ev) => {
    try {
      const plan = JSON.parse(ev.data);
      void resolveIncomingPlan(plan);
    } catch {
      /* ignore */
    }
  });
  es.addEventListener("activity", (ev) => {
    try {
      const a = JSON.parse(ev.data);
      const bit = a.summary || a.toolName || "tool";
      $("activity").textContent =
        a.phase === "end" ? (a.isError ? `✗ ${bit}` : `✓ ${bit}`) : `… ${bit}`;
    } catch {
      /* ignore */
    }
  });
  es.addEventListener("conn", (ev) => {
    try {
      const c = JSON.parse(ev.data);
      state.connected = !!c.connected;
      if (c.cwd) state.cwd = c.cwd;
      render();
    } catch {
      /* ignore */
    }
  });
  es.addEventListener("status", (ev) => {
    try {
      const s = JSON.parse(ev.data);
      if (s.message) $("activity").textContent = s.message;
      else if (s.agentIdle) $("activity").textContent = "Agent idle";
      else $("activity").textContent = "Agent running…";
    } catch {
      /* ignore */
    }
  });
  es.onerror = () => {
    state.connected = false;
    render();
  };
}

wire();
setTab(restoreTab());
{
  const savedResponseId = restoreActiveResponseId();
  if (savedResponseId) state.activeResponseId = savedResponseId;
}
connectEvents();
render();
setInterval(() => {
  if (state.tab === "steps" && isExecutionDashboard()) renderExecutionDashboard(state.plan);
}, 1000);
