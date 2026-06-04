/**
 * NotificationBell — floating in-app inbox.
 *
 * Polls the unread count, shows a badge, and opens a dropdown listing recent
 * notifications. Clicking a notification marks it read and navigates to the
 * linked task (Task Center). "全部已读" clears the badge.
 *
 * Pilot note: the backend filters by the authenticated identity (operator +
 * role). For the single-operator pilot we also include the default
 * "production_manager" queue so auto-generated (unowned) task notices show up.
 */

import React from "react";
import {
  fetchNotifications, markNotificationRead, markAllNotificationsRead,
} from "../../services/api";
import { useAppStore } from "../../stores/appStore";
import type { NotificationEvent, NotificationKind } from "../../types";
import "./notifications.css";

const POLL_MS = 30_000;
const DEFAULT_QUEUE = "production_manager";

const KIND_ICON: Record<NotificationKind, string> = {
  task_created: "＋",
  task_due_soon: "⏰",
  task_overdue_escalated: "↑",
  task_resolved: "✓",
  task_reassigned: "→",
};

export function NotificationBell() {
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<NotificationEvent[]>([]);
  const [unread, setUnread] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const setRuntimeSelectedAllocationId = useAppStore((s) => s.setRuntimeSelectedAllocationId);

  const load = React.useCallback(async () => {
    try {
      const r = await fetchNotifications({ recipients: DEFAULT_QUEUE, limit: 30 });
      setItems(Array.isArray(r.notifications) ? r.notifications : []);
      setUnread(r.unread ?? 0);
    } catch {
      // silent — the bell must never crash the app shell
    }
  }, []);

  // Poll unread on an interval; full load when the panel opens.
  React.useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  React.useEffect(() => {
    if (open) { setLoading(true); load().finally(() => setLoading(false)); }
  }, [open, load]);

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;
    const h = () => setOpen(false);
    const t = setTimeout(() => document.addEventListener("click", h), 0);
    return () => { clearTimeout(t); document.removeEventListener("click", h); };
  }, [open]);

  async function handleClick(n: NotificationEvent) {
    if (!n.read_at) {
      try { await markNotificationRead(n.id); } catch { /* ignore */ }
      setItems((prev) => prev.map((x) => x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x));
      setUnread((u) => Math.max(0, u - 1));
    }
    // Navigate to Task Center (the task_id links the user to the work item)
    if (n.task_id) {
      setActiveModule("tasks");
      // The Task Center reads its own list; deep-linking the drawer is a future
      // enhancement. For now we land the user on the right module.
    }
    setOpen(false);
  }

  async function handleReadAll(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await markAllNotificationsRead(DEFAULT_QUEUE);
      setItems((prev) => prev.map((x) => ({ ...x, read_at: x.read_at ?? new Date().toISOString() })));
      setUnread(0);
    } catch { /* ignore */ }
  }

  return (
    <div className="notifBellWrap" onClick={(e) => e.stopPropagation()}>
      <button className="notifBellBtn" onClick={() => setOpen((v) => !v)} title="通知" aria-label="通知">
        <span className="notifBellIcon">🔔</span>
        {unread > 0 && <span className="notifBadge">{unread > 99 ? "99+" : unread}</span>}
      </button>

      {open && (
        <div className="notifPanel">
          <div className="notifPanelHead">
            <strong>通知</strong>
            {unread > 0 && <button className="notifReadAll" onClick={handleReadAll}>全部已读</button>}
          </div>
          <div className="notifList">
            {loading && items.length === 0 && <div className="notifEmpty">加载中...</div>}
            {!loading && items.length === 0 && <div className="notifEmpty">暂无通知</div>}
            {items.map((n) => (
              <button
                key={n.id}
                className={`notifItem ${n.read_at ? "" : "notifItem--unread"} notifItem--${n.severity ?? "ok"}`}
                onClick={() => handleClick(n)}
              >
                <span className="notifItemIcon">{KIND_ICON[n.kind] ?? "•"}</span>
                <span className="notifItemBody">
                  <span className="notifItemTitle">{n.title}</span>
                  {n.body && <span className="notifItemText">{n.body}</span>}
                  <span className="notifItemTime">{new Date(n.created_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })}</span>
                </span>
                {!n.read_at && <span className="notifItemDot" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
