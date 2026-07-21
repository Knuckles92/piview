/* piview frontend — talks to local Go UI bridge via /api/* and event stream */

import { renderMarkdown, synthesizePlanMarkdown, syncMarkdownCheckboxes } from "./markdown.js";

const state = {
  plan: { v: 1, mode: "off", steps: [], updatedAt: 0 },
  selectedId: null,
  dirty: false,
  connected: false,
  cwd: "",
  tab: "plan",
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

function renderPlanMarkdown() {
  const el = $("plan-md");
  const src = planMarkdownSource(state.plan);
  if (!src) {
    el.innerHTML = `<p class="empty">No plan yet. Ask pi for a plan in plan mode.</p>`;
    return;
  }
  el.innerHTML = renderMarkdown(src);
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
  $("btn-add").classList.toggle("hidden", isPlan);
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

  renderPlanMarkdown();

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
  // Clear stored markdown so the Plan tab synthesizes from edited steps
  state.plan.markdown = "";
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

async function applyEdits() {
  // Persist synthesized markdown with edited steps
  state.plan.markdown = synthesizePlanMarkdown(state.plan);
  await api("/api/replace", { state: state.plan });
  setDirty(false);
  $("activity").textContent = "Edits applied to pi";
  render();
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
      if (state.dirty) {
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
