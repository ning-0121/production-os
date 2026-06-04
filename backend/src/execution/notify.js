/**
 * Notification layer — minimal, adapter-ready.
 *
 * buildNotification() is PURE: (kind, task, extra) → notification payload with
 * a dedup_key. This is the testable core.
 *
 * notify() is the only I/O: it inserts the payload, swallowing the unique
 * constraint violation so cron re-runs never duplicate notifications.
 *
 * Channels: in_app is implemented. email / wechat / whatsapp are stubs that
 * mark delivery_status='skipped' until an adapter is configured — the schema
 * and dispatch path are ready, the integration is not required now.
 */

const DEFAULT_QUEUE = "production_manager";   // where unowned tasks are routed
const DUE_SOON_HOURS = 6;

/**
 * Build a notification payload (pure). Returns null if there is no sensible
 * recipient (e.g. due-soon on an unowned task).
 *
 * @param {string} kind
 * @param {object} task     decision_tasks row
 * @param {object} [extra]  { escalation_level, notify_role, actor }
 * @returns {object|null}
 */
export function buildNotification(kind, task, extra = {}) {
  if (!task) return null;
  const orderLabel = task.subject_id ? ` · ${String(task.subject_id).slice(0, 12)}` : "";

  switch (kind) {
    case "task_created":
      return base({
        recipient: task.owner ?? DEFAULT_QUEUE,
        kind,
        title: `新任务待处理：${task.title}`,
        body: task.description ?? `${categoryLabel(task.category)} · ${sevLabel(task.severity)}`,
        task,
        dedup_key: "created",
      });

    case "task_due_soon": {
      if (!task.owner) return null;          // no one to nudge
      return base({
        recipient: task.owner,
        kind,
        title: `任务即将到期：${task.title}`,
        body: `截止 ${fmt(task.due_at)}，请尽快处理`,
        task,
        dedup_key: "due_soon",
      });
    }

    case "task_overdue_escalated": {
      const level = Number(extra.escalation_level ?? task.escalation_level ?? 1);
      const role = extra.notify_role ?? task.escalated_to ?? DEFAULT_QUEUE;
      return base({
        recipient: role,
        kind,
        title: `任务升级 L${level}：${task.title}${orderLabel}`,
        body: `逾期未解决，已升级至 ${role}`,
        task,
        dedup_key: `esc:L${level}`,
      });
    }

    case "task_resolved":
      return base({
        recipient: task.owner ?? task.created_by ?? DEFAULT_QUEUE,
        kind,
        title: `任务已解决：${task.title}`,
        body: task.resolution_note ?? "已标记解决",
        task,
        dedup_key: "resolved",
      });

    case "task_reassigned":
      return base({
        recipient: extra.new_owner ?? task.owner ?? DEFAULT_QUEUE,
        kind,
        title: `任务转派给你：${task.title}`,
        body: task.description ?? "",
        task,
        dedup_key: `reassign:${extra.new_owner ?? task.owner ?? ""}`,
      });

    default:
      return null;
  }
}

function base({ recipient, kind, title, body, task, dedup_key }) {
  return {
    recipient,
    kind,
    channel: "in_app",
    title,
    body: body ?? null,
    task_id: task.id,
    severity: task.severity ?? null,
    dedup_key,
    metadata: { category: task.category, source_type: task.source_type },
  };
}

/**
 * Persist a notification (I/O). Idempotent — duplicate (task_id, kind,
 * dedup_key) is silently ignored. Returns { inserted: boolean }.
 */
export async function notify(supabase, payload) {
  if (!payload) return { inserted: false };

  // in_app is delivered immediately; other channels are stubbed as skipped.
  const channelReady = payload.channel === "in_app";
  const row = {
    ...payload,
    delivery_status: channelReady ? "delivered" : "skipped",
    delivered_at: channelReady ? new Date().toISOString() : null,
    delivery_error: channelReady ? null : "channel adapter not configured",
  };

  const { error } = await supabase.from("notification_events").insert(row);
  if (error) {
    if (error.code === "23505") return { inserted: false };  // dedup hit — fine
    console.error("[notify] insert failed:", error.message);
    return { inserted: false, error: error.message };
  }
  return { inserted: true };
}

/** Convenience: build + notify in one call. */
export async function notifyForTask(supabase, kind, task, extra = {}) {
  const payload = buildNotification(kind, task, extra);
  return notify(supabase, payload);
}

/**
 * Find tasks due within DUE_SOON_HOURS and notify their owners. Pure-ish:
 * the query is I/O but each notification is idempotent. Returns count notified.
 */
export async function sweepDueSoon(supabase, opts = {}) {
  const now = opts.now ?? new Date();
  const horizon = new Date(now.getTime() + DUE_SOON_HOURS * 3600 * 1000).toISOString();
  const { data: tasks, error } = await supabase
    .from("decision_tasks")
    .select("*")
    .not("status", "in", "(resolved,dismissed)")
    .not("owner", "is", null)
    .not("due_at", "is", null)
    .gte("due_at", now.toISOString())     // not yet overdue
    .lte("due_at", horizon);              // but due within the window
  if (error) { console.error("[sweepDueSoon]", error.message); return { notified: 0 }; }

  let notified = 0;
  for (const t of tasks ?? []) {
    const r = await notifyForTask(supabase, "task_due_soon", t);
    if (r.inserted) notified++;
  }
  return { notified };
}

// ── Labels ──
function categoryLabel(c) {
  return ({ production_delay: "生产延期", quality: "质量", material: "物料", shipment: "出货", capacity: "产能", general: "一般" })[c] ?? c;
}
function sevLabel(s) { return ({ ok: "正常", warn: "关注", critical: "紧急" })[s] ?? s; }
function fmt(d) { return d ? new Date(d).toLocaleString("zh-CN") : "—"; }

export const NOTIFY_DEFAULTS = { DEFAULT_QUEUE, DUE_SOON_HOURS };
