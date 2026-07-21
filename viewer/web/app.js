/* piview frontend — talks to local Go UI bridge via /api/* and event stream */

import { bindToolbar, insertImage } from "./editor.js";
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
  dirty: false,
  connected: false,
  cwd: "",
  tab: "plan",
  /** @type {"preview"|"edit"|"split"} */
  planView: "preview",
  /** Draft markdown while editing the plan document (may differ from plan.markdown). */
  editingDraft: null,
  editing: false,
};

const $ = (id) => document.getElementById(id);

function setDirty(v) {
  state.dirty = v;
  $("dirty").classList.toggle("hidden", !v);
  $("btn-apply").disabled = !v;
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
    return;
  }
  el.innerHTML = renderMarkdown(src);
}

function updatePlanChrome() {
  const isPlan = state.tab === "plan";
  const editing = isPlan && state.editing;
  $("btn-edit-plan")?.classList.toggle("hidden", !isPlan || editing);
  $("btn-done-edit")?.classList.toggle("hidden", !editing);
  $("btn-add")?.classList.toggle("hidden", isPlan);
  $("plan-editor-bar")?.classList.toggle("hidden", !editing);

  const view = state.editing ? state.planView : "preview";
  $("view-plan")?.setAttribute("data-plan-mode", view);

  for (const btn of document.querySelectorAll("[data-plan-view]")) {
    btn.classList.toggle("active", btn.getAttribute("data-plan-view") === state.planView);
  }

  const showEditor = editing && (view === "edit" || view === "split");
  const showPreview = !editing || view === "preview" || view === "split";
  $("plan-editor")?.classList.toggle("hidden", !showEditor);
  $("plan-md")?.classList.toggle("hidden", !showPreview);
  $("md-toolbar")?.classList.toggle("hidden", !showEditor);
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
  updatePlanChrome();
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

function render() {
  const plan = state.plan;
  const modeEl = $("mode");
  modeEl.textContent = plan.mode || "off";
  modeEl.className = `badge mode-${plan.mode || "off"}`;
  $("cwd").textContent = plan.cwd || state.cwd || "";
  $("progress").textContent = progressText(plan);
  $("plan-title").value = plan.title || "";
  $("conn").className = `dot ${state.connected ? "online" : "offline"}`;

  // Don't clobber the textarea while the user is typing
  if (state.editing) {
    renderPlanMarkdown(currentEditorMarkdown());
  } else {
    renderPlanMarkdown(planMarkdownSource(plan));
  }
  updatePlanChrome();

  const list = $("steps");
  list.innerHTML = "";
  const steps = plan.steps || [];
  $("empty").classList.toggle("hidden", steps.length > 0);

  for (const step of steps) {
    const li = document.createElement("li");
    li.className = `step ${step.status}${step.id === state.selectedId ? " selected" : ""}`;
    li.dataset.id = step.id;
    li.innerHTML = `
      <span class="num">${step.step}</span>
      <span class="stitle"></span>
      <span class="st">${step.status}</span>
    `;
    li.querySelector(".stitle").textContent = step.title;
    li.addEventListener("click", () => selectStep(step.id));
    list.appendChild(li);
  }

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
  }
}

function selectStep(id) {
  state.selectedId = id;
  render();
}

function selected() {
  return (state.plan.steps || []).find((s) => s.id === state.selectedId);
}

function mutateLocal(fn) {
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
  $("activity").textContent = "Edits applied to pi";
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
}

function isTypingTarget(el) {
  if (!el || !(el instanceof Element)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

function wire() {
  $("tab-plan").onclick = () => {
    setTab("plan");
  };
  $("tab-steps").onclick = () => {
    setTab("steps");
  };

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
    if (mod && ev.key.toLowerCase() === "s") {
      ev.preventDefault();
      if (state.dirty) applyEdits().catch(showErr);
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
  });

  $("btn-execute").onclick = async () => {
    try {
      if (state.dirty) await applyEdits();
      await api("/api/execute");
      $("activity").textContent = "Execute requested";
    } catch (e) {
      showErr(e);
    }
  };

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
      $("activity").textContent = "Refinement sent";
    } catch (e) {
      showErr(e);
    }
  });
  $("refine-ok").onclick = () => {
    $("refine-dialog").returnValue = "ok";
  };

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

  $("btn-done").onclick = () => {
    const s = selected();
    if (!s) return;
    mutateLocal(() => {
      s.status = "done";
    });
  };
  $("btn-skip").onclick = () => {
    const s = selected();
    if (!s) return;
    mutateLocal(() => {
      s.status = "skipped";
    });
  };
  $("btn-remove").onclick = () => {
    const id = state.selectedId;
    if (!id) return;
    mutateLocal((p) => {
      p.steps = p.steps.filter((s) => s.id !== id);
      state.selectedId = p.steps[0]?.id ?? null;
    });
  };
}

function showErr(e) {
  $("activity").textContent = `Error: ${e.message || e}`;
}

function connectEvents() {
  const es = new EventSource("/api/events");
  es.addEventListener("state", (ev) => {
    try {
      const plan = JSON.parse(ev.data);
      if (state.dirty || state.editing) {
        state.plan.cwd = plan.cwd || state.plan.cwd;
        state.plan.mode = plan.mode || state.plan.mode;
      } else {
        const prev = state.selectedId;
        state.plan = plan;
        if (!plan.steps?.some((s) => s.id === prev)) {
          state.selectedId = plan.steps?.[0]?.id ?? null;
        }
      }
      render();
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
setTab("plan");
connectEvents();
render();
