import React from "react";
import { haversineMeters } from "./geo";
import { useAsync } from "../../hooks/useAsync";
import {
  fetchGeofences,
  fetchVisitTasks,
  generateVisitTasks,
  updateVisitTask,
} from "../../services/api";
import type { GeoFence, VisitTask } from "../../types";
import "./geofence.css";

// ── Notification helpers ────────────────────────────────

async function ensureNotificationPermission() {
  if (!("Notification" in window)) return "unsupported" as const;
  if (Notification.permission === "granted") return "granted" as const;
  if (Notification.permission === "denied") return "denied" as const;
  const p = await Notification.requestPermission();
  return p as "granted" | "denied";
}

function notify(title: string, body: string) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  new Notification(title, { body });
}

// ── Main Page ───────────────────────────────────────────

export function GeofencePage() {
  const { data: fences, loading, error } = useAsync(() => fetchGeofences(), []);
  const [pos, setPos] = React.useState<{ lat: number; lng: number } | null>(null);
  const [watching, setWatching] = React.useState(false);
  const [activeFactoryId, setActiveFactoryId] = React.useState<string | null>(null);
  const [generating, setGenerating] = React.useState(false);
  const [genCount, setGenCount] = React.useState<number | null>(null);
  const lastEnteredRef = React.useRef<string | null>(null);

  const activeFence = React.useMemo(
    () => (activeFactoryId && fences ? fences.find((f) => f.factory_id === activeFactoryId) ?? null : null),
    [activeFactoryId, fences],
  );

  // Geofence detection
  React.useEffect(() => {
    if (!pos || !fences) return;

    let entered: GeoFence | null = null;
    for (const f of fences) {
      if (!f.center || !f.radius_meters) continue;
      if (haversineMeters(pos, f.center) <= f.radius_meters) {
        entered = f;
        break;
      }
    }

    if (entered) {
      setActiveFactoryId(entered.factory_id);
      if (lastEnteredRef.current !== entered.factory_id) {
        lastEnteredRef.current = entered.factory_id;
        const name = entered.factories?.name ?? entered.name;
        notify("Entered factory", `${name} — generating tasks…`);
        // Auto-generate tasks on entry
        triggerTaskGeneration(entered.factory_id);
      }
    } else {
      setActiveFactoryId(null);
      lastEnteredRef.current = null;
      setGenCount(null);
    }
  }, [pos, fences]);

  async function triggerTaskGeneration(factoryId: string) {
    setGenerating(true);
    try {
      const result = await generateVisitTasks(factoryId);
      setGenCount(result.generated);
    } catch {
      // silent — tasks will still load from existing data
    }
    setGenerating(false);
  }

  async function start() {
    await ensureNotificationPermission();
    if (!("geolocation" in navigator)) {
      alert("Geolocation not supported.");
      return;
    }
    setWatching(true);
    navigator.geolocation.watchPosition(
      (p) => setPos({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (err) => { setWatching(false); alert(err.message); },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 },
    );
  }

  if (loading) return <div className="card"><div style={{ padding: 24, color: "var(--muted)" }}>加载中…</div></div>;
  if (error) return <div className="card"><div style={{ padding: 24, color: "var(--danger)" }}>加载失败: {error}</div></div>;

  return (
    <div className="geoPage">
      {/* Status bar */}
      <div className="card">
        <div className="cardHeader">
          <div>
            <h2>巡厂系统</h2>
            <div className="hint">进入工厂围栏后自动生成今日任务</div>
          </div>
          <button className="btn primary" onClick={() => void start()} disabled={watching}>
            {watching ? "Watching…" : "Start"}
          </button>
        </div>

        <div className="geoStatusBar">
          <div className="geoStatusItem">
            <span className="geoStatusLabel">Position</span>
            <span className="geoStatusValue">
              {pos ? `${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}` : "—"}
            </span>
          </div>
          <div className="geoStatusItem">
            <span className="geoStatusLabel">Status</span>
            <span className={`geoStatusValue ${activeFence ? "geoStatusActive" : ""}`}>
              {activeFence
                ? `Inside: ${activeFence.factories?.name ?? activeFence.name}`
                : "Outside all fences"}
            </span>
          </div>
          {generating && (
            <div className="geoStatusItem">
              <span className="geoStatusLabel">Tasks</span>
              <span className="geoStatusValue">Generating…</span>
            </div>
          )}
          {genCount !== null && !generating && (
            <div className="geoStatusItem">
              <span className="geoStatusLabel">Generated</span>
              <span className="geoStatusValue">{genCount} new tasks</span>
            </div>
          )}
        </div>
      </div>

      {/* Action list */}
      {activeFactoryId ? (
        <ActionChecklist
          factoryId={activeFactoryId}
          factoryName={activeFence?.factories?.name ?? "Factory"}
        />
      ) : (
        <div className="card" style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>
          {watching
            ? "Approaching factory… tasks will appear when you enter the geofence."
            : "Start location watch to begin."}
        </div>
      )}
    </div>
  );
}

// ── Action Checklist ────────────────────────────────────

function ActionChecklist({ factoryId, factoryName }: { factoryId: string; factoryName: string }) {
  const { data: tasks, loading, refetch } = useAsync(() => fetchVisitTasks(factoryId), [factoryId]);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  if (loading) return <div className="card" style={{ padding: 24, color: "var(--muted)" }}>加载任务…</div>;

  const open = (tasks ?? []).filter((t) => t.status === "open" || t.status === "in_progress");
  const done = (tasks ?? []).filter((t) => t.status === "done");

  return (
    <div className="card">
      <div className="cardHeader">
        <div>
          <h2>Today's Required Actions</h2>
          <div className="hint">{factoryName} — {open.length} pending</div>
        </div>
        <span className="pill">{open.length}/{(tasks ?? []).length}</span>
      </div>

      <div className="actionList">
        {open.length === 0 && (
          <div className="actionEmpty">All tasks completed. Good job!</div>
        )}

        {open
          .sort((a, b) => b.priority - a.priority)
          .map((task) => (
            <ActionCard
              key={task.id}
              task={task}
              expanded={expandedId === task.id}
              onToggle={() => setExpandedId(expandedId === task.id ? null : task.id)}
              onUpdate={refetch}
            />
          ))}

        {done.length > 0 && (
          <CompletedSection tasks={done} />
        )}
      </div>
    </div>
  );
}

// ── Action Card ─────────────────────────────────────────

function ActionCard({
  task,
  expanded,
  onToggle,
  onUpdate,
}: {
  task: VisitTask;
  expanded: boolean;
  onToggle: () => void;
  onUpdate: () => void;
}) {
  const [saving, setSaving] = React.useState(false);
  const [noteText, setNoteText] = React.useState(
    (task.metadata as Record<string, unknown>)?.notes as string ?? "",
  );
  const meta = task.metadata as Record<string, unknown>;
  const riskLevel = meta?.risk_level as string | undefined;
  const reason = meta?.reason as string | undefined;

  const priorityClass =
    task.priority >= 3 ? "actionPrioHigh" :
    task.priority >= 2 ? "actionPrioMed" : "actionPrioLow";

  const typeLabel =
    task.task_type === "risk_inspection" ? "Risk Inspection" :
    task.task_type === "readiness_check" ? "Readiness Check" :
    task.task_type === "delivery_check" ? "Delivery Check" :
    task.task_type;

  async function markChecked() {
    setSaving(true);
    try {
      await updateVisitTask(task.id, {
        status: "done",
        checked_at: new Date().toISOString(),
      });
      onUpdate();
    } catch { /* silent */ }
    setSaving(false);
  }

  async function saveNote() {
    setSaving(true);
    try {
      await updateVisitTask(task.id, { notes: noteText });
    } catch { /* silent */ }
    setSaving(false);
  }

  async function handlePhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // For now, store as base64 data URI in metadata
    // (In production, upload to Supabase Storage and store URL)
    const reader = new FileReader();
    reader.onload = async () => {
      setSaving(true);
      try {
        await updateVisitTask(task.id, {
          photo_url: reader.result as string,
        });
        onUpdate();
      } catch { /* silent */ }
      setSaving(false);
    };
    reader.readAsDataURL(file);
  }

  const hasPhoto = !!(meta?.photo_url);

  return (
    <div className={`actionCard ${priorityClass}`}>
      <div className="actionCardMain" onClick={onToggle}>
        <div className="actionCardLeft">
          <div className={`actionCheck ${saving ? "actionCheckSaving" : ""}`} onClick={(e) => {
            e.stopPropagation();
            void markChecked();
          }}>
            {saving ? "…" : ""}
          </div>
          <div className="actionCardInfo">
            <div className="actionCardTitle">{task.title}</div>
            <div className="actionCardMeta">
              <span className={`actionTypeBadge actionType_${task.task_type}`}>{typeLabel}</span>
              {riskLevel === "HIGH" && <span className="actionRiskBadge">HIGH RISK</span>}
              {reason === "due_soon" && <span className="actionDueBadge">DUE SOON</span>}
              {hasPhoto && <span className="actionPhotoBadge">has photo</span>}
            </div>
          </div>
        </div>
        <div className="actionCardRight">
          <span className="actionPrioBadge">{task.priority >= 3 ? "P0" : task.priority >= 2 ? "P1" : "P2"}</span>
          <span className="actionChevron">{expanded ? "▲" : "▼"}</span>
        </div>
      </div>

      {expanded && (
        <div className="actionExpanded">
          {task.description && (
            <div className="actionDesc">{task.description}</div>
          )}

          {/* Note input */}
          <div className="actionField">
            <label className="actionFieldLabel">Notes</label>
            <textarea
              className="actionTextarea"
              rows={2}
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="Add observation notes…"
            />
            <button className="btn actionSaveBtn" onClick={() => void saveNote()} disabled={saving}>
              {saving ? "Saving…" : "Save Note"}
            </button>
          </div>

          {/* Photo upload */}
          <div className="actionField">
            <label className="actionFieldLabel">Photo Evidence</label>
            {hasPhoto && (
              <img
                className="actionPhoto"
                src={meta.photo_url as string}
                alt="Task photo"
              />
            )}
            <label className="btn actionPhotoBtn">
              {hasPhoto ? "Replace Photo" : "Upload Photo"}
              <input type="file" accept="image/*" capture="environment" onChange={handlePhoto} hidden />
            </label>
          </div>

          {/* Quick mark done */}
          <button className="btn primary actionDoneBtn" onClick={() => void markChecked()} disabled={saving}>
            {saving ? "Saving…" : "Mark Checked"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Completed section ───────────────────────────────────

function CompletedSection({ tasks }: { tasks: VisitTask[] }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="actionCompleted">
      <button className="actionCompletedToggle" onClick={() => setOpen(!open)}>
        <span>Completed ({tasks.length})</span>
        <span>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="actionCompletedList">
          {tasks.map((t) => {
            const meta = t.metadata as Record<string, unknown>;
            return (
              <div key={t.id} className="actionCompletedItem">
                <span className="actionCompletedCheck">done</span>
                <span className="actionCompletedTitle">{t.title}</span>
                {typeof meta?.checked_at === "string" && (
                  <span className="actionCompletedTime">
                    {meta.checked_at.slice(11, 16)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
