import React from "react";
import { haversineMeters } from "./geo";
import "./geofence.css";

type FactoryFence = {
  factoryId: string;
  factoryName: string;
  center: { lat: number; lng: number };
  radiusMeters: number;
};

type Task = {
  id: string;
  factoryId: string;
  title: string;
  status: "open" | "in_progress" | "done";
  priority: number;
};

const demoFences: FactoryFence[] = [
  {
    factoryId: "f1",
    factoryName: "Factory Shenzhen 01",
    center: { lat: 22.5431, lng: 114.0579 },
    radiusMeters: 300,
  },
  {
    factoryId: "f2",
    factoryName: "Factory Suzhou 02",
    center: { lat: 31.2989, lng: 120.5853 },
    radiusMeters: 350,
  },
];

const demoTasks: Task[] = [
  { id: "t1", factoryId: "f1", title: "Check safety signage", status: "open", priority: 2 },
  { id: "t2", factoryId: "f1", title: "Verify line 3 yield report", status: "in_progress", priority: 1 },
  { id: "t3", factoryId: "f2", title: "Inspect incoming materials", status: "open", priority: 3 },
];

async function ensureNotificationPermission() {
  if (!("Notification" in window)) return "unsupported" as const;
  if (Notification.permission === "granted") return "granted" as const;
  if (Notification.permission === "denied") return "denied" as const;
  const p = await Notification.requestPermission();
  return p as "granted" | "denied";
}

function notify(title: string, body: string) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  // eslint-disable-next-line no-new
  new Notification(title, { body });
}

export function GeofencePage() {
  const [pos, setPos] = React.useState<{ lat: number; lng: number } | null>(null);
  const [watching, setWatching] = React.useState(false);
  const [activeFactoryId, setActiveFactoryId] = React.useState<string | null>(null);
  const lastEnteredRef = React.useRef<string | null>(null);

  const activeFence = React.useMemo(
    () => (activeFactoryId ? demoFences.find((f) => f.factoryId === activeFactoryId) ?? null : null),
    [activeFactoryId],
  );

  React.useEffect(() => {
    if (!pos) return;

    let entered: FactoryFence | null = null;
    for (const f of demoFences) {
      const d = haversineMeters(pos, f.center);
      if (d <= f.radiusMeters) {
        entered = f;
        break;
      }
    }

    if (entered) {
      setActiveFactoryId(entered.factoryId);
      if (lastEnteredRef.current !== entered.factoryId) {
        lastEnteredRef.current = entered.factoryId;
        notify("Entered factory geofence", `${entered.factoryName} (${Math.round(entered.radiusMeters)}m radius)`);
      }
    } else {
      setActiveFactoryId(null);
      lastEnteredRef.current = null;
    }
  }, [pos]);

  async function start() {
    await ensureNotificationPermission();
    if (!("geolocation" in navigator)) {
      alert("Geolocation not supported in this browser.");
      return;
    }
    setWatching(true);
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setPos({ lat: p.coords.latitude, lng: p.coords.longitude });
      },
      (err) => {
        setWatching(false);
        alert(err.message);
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }

  return (
    <div className="card">
      <div className="cardHeader">
        <div>
          <h2>Geofence</h2>
          <div className="hint">Mobile-friendly: enter factory radius → notify + show tasks.</div>
        </div>
        <button className="btn primary" onClick={() => void start()} disabled={watching}>
          {watching ? "Watching…" : "Start location watch"}
        </button>
      </div>

      <div className="geoBody">
        <div className="geoPanel">
          <div className="geoTitle">Current position</div>
          <div className="geoValue">
            {pos ? (
              <>
                <div>
                  <span className="geoLabel">Lat</span> {pos.lat.toFixed(5)}
                </div>
                <div>
                  <span className="geoLabel">Lng</span> {pos.lng.toFixed(5)}
                </div>
              </>
            ) : (
              <div style={{ color: "var(--muted)" }}>No location yet. Tap “Start”.</div>
            )}
          </div>

          <div className="geoTitle" style={{ marginTop: 12 }}>
            Geofence status
          </div>
          <div className="geoValue">
            {activeFence ? (
              <div className="pill">Inside: {activeFence.factoryName}</div>
            ) : (
              <div style={{ color: "var(--muted)" }}>Outside all demo fences.</div>
            )}
          </div>
        </div>

        <div className="geoPanel">
          <div className="geoTitle">Tasks</div>
          {activeFactoryId ? (
            <TaskList tasks={demoTasks.filter((t) => t.factoryId === activeFactoryId)} />
          ) : (
            <div style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.45 }}>
              Enter a factory radius to see tasks. In production this list should come from Supabase table
              <code style={{ marginLeft: 6 }}>`factory_visit_tasks`</code>.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TaskList({ tasks }: { tasks: Task[] }) {
  const sorted = [...tasks].sort((a, b) => b.priority - a.priority);
  return (
    <div className="taskList">
      {sorted.map((t) => (
        <div key={t.id} className="task">
          <div className="taskMain">
            <div className="taskTitle">{t.title}</div>
            <div className="taskMeta">
              <span className="pill">priority {t.priority}</span>
              <span className="pill">{t.status}</span>
            </div>
          </div>
          <button className="btn" onClick={() => alert("Next: open task detail / mark done.")}>
            Open
          </button>
        </div>
      ))}
    </div>
  );
}

