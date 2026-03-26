import React from "react";
import { GanttPage } from "./gantt/GanttPage";
import { GeofencePage } from "./geofence/GeofencePage";

type TabKey = "schedule" | "geofence";

export function App() {
  const [tab, setTab] = React.useState<TabKey>("schedule");

  return (
    <div className="container">
      <div className="topbar">
        <div className="brand">
          <div className="logo" />
          <div className="title">
            <strong>Production OS</strong>
            <span>Scheduling + visits (Gantt + Geofence)</span>
          </div>
        </div>

        <div className="tabs" role="tablist" aria-label="Views">
          <button
            className={`tab ${tab === "schedule" ? "active" : ""}`}
            onClick={() => setTab("schedule")}
            role="tab"
            aria-selected={tab === "schedule"}
          >
            Schedule
          </button>
          <button
            className={`tab ${tab === "geofence" ? "active" : ""}`}
            onClick={() => setTab("geofence")}
            role="tab"
            aria-selected={tab === "geofence"}
          >
            Geofence
          </button>
        </div>
      </div>

      {tab === "schedule" ? <GanttPage /> : <GeofencePage />}
    </div>
  );
}

