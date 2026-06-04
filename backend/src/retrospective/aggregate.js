/**
 * Retrospective Aggregation — pure, deterministic, zero-safe.
 *
 * Turns execution history into management metrics. Input is a bundle of raw
 * rows (loaded once, in parallel, by io.js). Output is stable arrays + numbers
 * with NO nulls — every metric defaults to 0 / [] so the frontend never crashes.
 *
 * Current vs previous window: the loader fetches 2×window of data; this module
 * splits it so we can compute week-over-week trends without a second query.
 */

const TERMINAL = new Set(["resolved", "dismissed"]);

/**
 * @param {object} bundle  { tasks, retrospectives, incidents, runtimeEvents,
 *                           qcInspections, reworks, corrections, factories,
 *                           lines, cronRuns, aiActionLogs }
 * @param {object} opts     { now: Date, windowDays: number }
 */
export function aggregate(bundle, opts = {}) {
  const now = opts.now ?? new Date();
  const windowDays = Number(opts.windowDays ?? 7);
  const winMs = windowDays * 86400000;
  const curStart = now.getTime() - winMs;
  const prevStart = now.getTime() - 2 * winMs;

  const allTasks = arr(bundle.tasks);
  const retroByTask = indexBy(arr(bundle.retrospectives), "task_id");

  const inWindow = (row, field = "created_at") => {
    const t = ts(row?.[field]);
    return t != null && t >= curStart && t <= now.getTime();
  };
  const inPrevWindow = (row, field = "created_at") => {
    const t = ts(row?.[field]);
    return t != null && t >= prevStart && t < curStart;
  };

  const tasks = allTasks.filter((t) => inWindow(t));
  const prevTasks = allTasks.filter((t) => inPrevWindow(t));

  return {
    window: { days: windowDays, from: new Date(curStart).toISOString(), to: now.toISOString() },
    summary: buildSummary(tasks, prevTasks, retroByTask, now),
    root_causes: buildRootCauses(tasks, prevTasks, retroByTask),
    factories: buildFactories(bundle, curStart, now.getTime()),
    lines: buildLines(bundle, curStart, now.getTime()),
    owners: buildOwners(tasks, now),
    ai_effectiveness: buildAiEffectiveness(tasks, retroByTask, bundle, curStart, now.getTime()),
    trends: buildTrends(allTasks, now, windowDays),
  };
}

// ── Summary ─────────────────────────────────────────────

function buildSummary(tasks, prevTasks, retroByTask, now) {
  const total = tasks.length;
  const open = tasks.filter((t) => !TERMINAL.has(t.status)).length;
  const resolved = tasks.filter((t) => t.status === "resolved").length;
  const dismissed = tasks.filter((t) => t.status === "dismissed").length;
  const overdue = tasks.filter((t) => isOverdue(t, now)).length;
  const escalated = tasks.filter((t) => num(t.escalation_level) > 0).length;
  const aiGenerated = tasks.filter(isAiGenerated);
  const aiResolved = aiGenerated.filter((t) => t.status === "resolved").length;

  const resTimes = tasks.map((t) => resolutionMinutes(t, retroByTask)).filter((m) => m != null);
  const fp = tasks.filter((t) => isFalsePositive(t, retroByTask)).length;

  return {
    total_tasks: total,
    open_tasks: open,
    overdue_tasks: overdue,
    resolved_tasks: resolved,
    dismissed_tasks: dismissed,
    resolved_pct: pct(resolved, total),
    overdue_pct: pct(overdue, total),
    avg_resolution_minutes: avg(resTimes),
    median_resolution_minutes: median(resTimes),
    escalation_count: escalated,
    escalation_rate: pct(escalated, total),
    repeat_issue_count: repeatIssueCount(tasks),
    ai_generated_count: aiGenerated.length,
    ai_completion_rate: pct(aiResolved, aiGenerated.length),
    false_positive_rate: pct(fp, total),
    by_status: countBy(tasks, "status"),
    by_severity: countBy(tasks, "severity"),
    by_category: countBy(tasks, "category"),
    prev_total_tasks: prevTasks.length,
    total_trend: trendDir(total, prevTasks.length),
  };
}

// ── Root causes ─────────────────────────────────────────

function buildRootCauses(tasks, prevTasks, retroByTask) {
  // Prefer explicit retrospective root_cause; fall back to task category.
  const curCounts = {};
  const curRes = {};
  for (const t of tasks) {
    const rc = retroByTask.get(t.id)?.root_cause ?? `category:${t.category}`;
    curCounts[rc] = (curCounts[rc] ?? 0) + 1;
    const m = resolutionMinutes(t, retroByTask);
    if (m != null) (curRes[rc] = curRes[rc] ?? []).push(m);
  }
  const prevCounts = {};
  for (const t of prevTasks) {
    const rc = retroByTask.get(t.id)?.root_cause ?? `category:${t.category}`;
    prevCounts[rc] = (prevCounts[rc] ?? 0) + 1;
  }
  const total = tasks.length;
  return Object.entries(curCounts)
    .map(([root_cause, count]) => ({
      root_cause,
      count,
      pct: pct(count, total),
      avg_resolution_minutes: avg(curRes[root_cause] ?? []),
      trend: trendDir(count, prevCounts[root_cause] ?? 0),
      prev_count: prevCounts[root_cause] ?? 0,
    }))
    .sort((a, b) => b.count - a.count);
}

// ── Factory problem map (from source tables w/ native factory_id) ──

function buildFactories(bundle, start, end) {
  const names = indexBy(arr(bundle.factories), "id");
  const map = new Map();
  const bump = (fid, key) => {
    if (!fid) return;
    const row = map.get(fid) ?? { factory_id: fid, factory_name: names.get(fid)?.name ?? fid.slice(0, 8), quality: 0, rework: 0, delay: 0, critical: 0, total: 0 };
    row[key]++; row.total++;
    map.set(fid, row);
  };

  for (const q of arr(bundle.qcInspections)) if (between(q.created_at, start, end) && q.result === "fail") bump(q.factory_id, "quality");
  for (const r of arr(bundle.reworks)) if (between(r.created_at, start, end)) bump(r.factory_id, "rework");
  for (const c of arr(bundle.corrections)) if (between(c.computed_at ?? c.created_at, start, end) && (c.risk_status === "critical" || c.risk_status === "falling_behind")) bump(c.factory_id, "delay");
  for (const e of arr(bundle.runtimeEvents)) {
    if (!between(e.occurred_at ?? e.created_at, start, end)) continue;
    if (e.severity === "critical") bump(e.factory_id, "critical");
    else if (["line_slowdown", "factory_shutdown", "material_delayed"].includes(e.event_type)) bump(e.factory_id, "delay");
  }
  for (const inc of arr(bundle.incidents)) {
    if (!between(inc.created_at, start, end)) continue;
    if (inc.severity === "critical") bump(inc.factory_id, "critical");
    else bump(inc.factory_id, "delay");
  }

  return [...map.values()].sort((a, b) => b.total - a.total);
}

function buildLines(bundle, start, end) {
  const names = indexBy(arr(bundle.lines), "id");
  const map = new Map();
  const bump = (lid, key) => {
    if (!lid) return;
    const row = map.get(lid) ?? { line_id: lid, line_name: names.get(lid)?.name ?? lid.slice(0, 8), critical: 0, issues: 0 };
    row[key]++;
    map.set(lid, row);
  };
  for (const e of arr(bundle.runtimeEvents)) {
    if (!between(e.occurred_at ?? e.created_at, start, end)) continue;
    if (!e.line_id) continue;
    bump(e.line_id, "issues");
    if (e.severity === "critical") bump(e.line_id, "critical");
  }
  return [...map.values()].sort((a, b) => b.issues - a.issues);
}

// ── Owner performance ───────────────────────────────────

function buildOwners(tasks, now) {
  const map = new Map();
  for (const t of tasks) {
    if (!t.owner) continue;
    const row = map.get(t.owner) ?? { owner: t.owner, assigned: 0, overdue: 0, resolved: 0, escalations: 0, _resTimes: [] };
    row.assigned++;
    if (isOverdue(t, now)) row.overdue++;
    if (t.status === "resolved") row.resolved++;
    if (num(t.escalation_level) > 0) row.escalations++;
    const rm = t.resolved_at && t.created_at ? (ts(t.resolved_at) - ts(t.created_at)) / 60000 : null;
    if (rm != null && rm >= 0) row._resTimes.push(rm);
    map.set(t.owner, row);
  }
  return [...map.values()]
    .map((r) => ({
      owner: r.owner,
      assigned: r.assigned,
      overdue: r.overdue,
      resolved: r.resolved,
      escalations: r.escalations,
      avg_response_minutes: avg(r._resTimes),
      overloaded: r.overdue >= 5 || r.assigned >= 15,   // simple workload warning
    }))
    .sort((a, b) => b.overdue - a.overdue || b.assigned - a.assigned);
}

// ── AI effectiveness ────────────────────────────────────

function buildAiEffectiveness(tasks, retroByTask, bundle, start, end) {
  const ai = tasks.filter(isAiGenerated);
  const completed = ai.filter((t) => t.status === "resolved").length;
  const dismissed = ai.filter((t) => t.status === "dismissed").length;
  const escalated = ai.filter((t) => num(t.escalation_level) > 0).length;
  const fp = ai.filter((t) => isFalsePositive(t, retroByTask)).length;

  // Top false-positive sources: dismissed AI tasks grouped by source_type
  const fpSources = {};
  for (const t of ai) {
    if (t.status === "dismissed" || isFalsePositive(t, retroByTask)) {
      fpSources[t.source_type] = (fpSources[t.source_type] ?? 0) + 1;
    }
  }
  const topFp = Object.entries(fpSources).map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count);

  // useful = resolved + still-open-but-acted (acknowledged/in_progress/blocked)
  const useful = ai.filter((t) => t.status === "resolved" || ["acknowledged", "in_progress", "blocked"].includes(t.status)).length;

  const aiLogs = arr(bundle.aiActionLogs).filter((l) => between(l.created_at, start, end));

  return {
    auto_generated: ai.length,
    completed,
    dismissed,
    escalated,
    completion_rate: pct(completed, ai.length),
    useful_rate: pct(useful, ai.length),
    false_positive_rate: pct(fp + dismissed, ai.length),
    top_false_positive_sources: topFp,
    ai_action_log_count: aiLogs.length,
  };
}

// ── Trends (daily buckets over the window) ──────────────

function buildTrends(allTasks, now, windowDays) {
  const days = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const dayStart = new Date(now.getTime() - i * 86400000);
    const key = dayStart.toISOString().slice(0, 10);
    days.push({ date: key, total: 0, critical: 0, overdue: 0, quality: 0 });
  }
  const idx = new Map(days.map((d, i) => [d.date, i]));
  for (const t of allTasks) {
    const key = (t.created_at ?? "").slice(0, 10);
    const i = idx.get(key);
    if (i == null) continue;
    days[i].total++;
    if (t.severity === "critical") days[i].critical++;
    if (isOverdue(t, now)) days[i].overdue++;
    if (t.category === "quality") days[i].quality++;
  }
  return { days };
}

// ── Helpers (all zero-safe) ─────────────────────────────

function arr(x) { return Array.isArray(x) ? x : []; }
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function ts(d) { if (!d) return null; const t = new Date(d).getTime(); return Number.isFinite(t) ? t : null; }
function between(d, start, end) { const t = ts(d); return t != null && t >= start && t <= end; }
function pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : 0; }
function avg(list) { return list.length ? Math.round(list.reduce((s, x) => s + x, 0) / list.length) : 0; }
function median(list) {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}
function countBy(rows, key) {
  const out = {};
  for (const r of rows) { const k = r?.[key] ?? "unknown"; out[k] = (out[k] ?? 0) + 1; }
  return out;
}
function indexBy(rows, key) {
  const m = new Map();
  for (const r of rows) if (r?.[key] != null) m.set(r[key], r);
  return m;
}
function isOverdue(t, now) {
  return !TERMINAL.has(t.status) && t.due_at != null && ts(t.due_at) < now.getTime();
}
function isAiGenerated(t) { return t.source_type && t.source_type !== "manual"; }
function isFalsePositive(t, retroByTask) {
  const r = retroByTask.get(t.id);
  if (r?.was_false_positive === true) return true;
  if (r?.root_cause === "data_error" || r?.root_cause === "no_action_needed") return true;
  return false;
}
function resolutionMinutes(t, retroByTask) {
  const r = retroByTask.get(t.id);
  if (r?.resolution_time_minutes != null) return num(r.resolution_time_minutes);
  if (t.resolved_at && t.created_at) {
    const m = (ts(t.resolved_at) - ts(t.created_at)) / 60000;
    return m >= 0 ? Math.round(m) : null;
  }
  return null;
}
function repeatIssueCount(tasks) {
  const counts = new Map();
  for (const t of tasks) {
    if (!t.subject_id) continue;
    const k = `${t.subject_type}:${t.subject_id}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let repeats = 0;
  for (const v of counts.values()) if (v >= 2) repeats++;
  return repeats;
}
function trendDir(cur, prev) {
  if (prev === 0) return cur > 0 ? "up" : "flat";
  const change = (cur - prev) / prev;
  if (change > 0.1) return "up";
  if (change < -0.1) return "down";
  return "flat";
}

export const _internals = { resolutionMinutes, isOverdue, isAiGenerated, repeatIssueCount, trendDir, pct, median };
