/* Pure view-model helpers for the execution dashboard. */

const terminalStatuses = new Set(["done", "skipped"]);

export function executionDashboardModel(plan, now = Date.now()) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const counts = { pending: 0, active: 0, done: 0, skipped: 0, failed: 0 };
  for (const step of steps) {
    if (Object.hasOwn(counts, step.status)) counts[step.status] += 1;
  }

  const total = steps.length;
  const completed = counts.done + counts.skipped;
  const percent = total ? Math.round((completed / total) * 100) : 0;
  const execution = plan?.execution || null;
  const activities = Array.isArray(execution?.activities) ? execution.activities : [];
  const files = Array.isArray(execution?.files) ? execution.files : [];
  const activeStep = steps.find((step) => step.id === plan?.activeStepId) || steps.find((step) => step.status === "active") || null;
  const runningActivity = activities
    .filter((activity) => activity.status === "running")
    .sort((a, b) => b.startedAt - a.startedAt)[0] || null;
  const recentActivity = [...activities]
    .sort((a, b) => (b.endedAt || b.startedAt) - (a.endedAt || a.startedAt))
    .slice(0, 8);
  const recentFiles = [...files].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);

  return {
    counts,
    total,
    completed,
    percent,
    activeStep,
    runningActivity,
    recentActivity,
    recentFiles,
    elapsedMs: execution?.startedAt ? Math.max(0, now - execution.startedAt) : null,
    toolCallsStarted: execution?.toolCallsStarted || 0,
    toolCallsCompleted: execution?.toolCallsCompleted || 0,
    toolCallsFailed: execution?.toolCallsFailed || 0,
    changedFiles: files.length,
    fileEdits: files.reduce((totalEdits, file) => totalEdits + (file.count || 0), 0),
    summary: executionSummary(steps, counts, activeStep),
  };
}

export function formatDuration(milliseconds) {
  if (milliseconds === null || milliseconds === undefined) return "—";
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function executionSummary(steps, counts, activeStep) {
  if (!steps.length) return "No plan steps have been defined.";
  const completed = steps.filter((step) => terminalStatuses.has(step.status));
  const clauses = [];
  if (completed.length) {
    const names = completed.slice(-2).map((step) => step.title || `Step ${step.step}`).join(" · ");
    clauses.push(`Completed ${completed.length} of ${steps.length} steps${names ? `: ${names}` : ""}.`);
  } else {
    clauses.push(`Execution has started with ${steps.length} planned steps.`);
  }
  if (activeStep) clauses.push(`Working on step ${activeStep.step}: ${activeStep.title || "Untitled step"}.`);
  else if (counts.failed) clauses.push(`${counts.failed} ${counts.failed === 1 ? "step needs" : "steps need"} attention.`);
  else if (completed.length === steps.length) clauses.push("All planned work is complete.");
  else clauses.push(`${counts.pending} ${counts.pending === 1 ? "step remains" : "steps remain"}.`);
  return clauses.join(" ");
}
