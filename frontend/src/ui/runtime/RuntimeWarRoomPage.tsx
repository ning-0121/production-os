/**
 * RuntimeWarRoomPage — V5-B visual cockpit for the AI Factory Operating Brain.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ KPI strip                                               │
 *   ├──────────┬─────────────────────────┬────────────────────┤
 *   │ Filters  │  Timeline | Graph | Replay (tabbed)          │  AI Cmd Feed
 *   │ Factory  │                                              │  (right rail)
 *   │ list     │                                              │  + Detail drawer
 *   └──────────┴─────────────────────────┴────────────────────┘
 *
 * Each tab is wrapped in a PageBoundary so a bad payload in one tab cannot
 * crash the others.
 */

import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchFactories } from "../../services/api";
import { useAppStore } from "../../stores/appStore";
import { PageBoundary } from "../ErrorBoundary";

import { RuntimeKpiStrip } from "./RuntimeKpiStrip";
import { RuntimeTimeline } from "./RuntimeTimeline";
import { ConstraintGraph } from "./ConstraintGraph";
import { RuntimeReplayPanel } from "./RuntimeReplayPanel";
import { AICommandFeed } from "./AICommandFeed";
import { RuntimeDetailDrawer } from "./RuntimeDetailDrawer";

import "./runtime.css";

export function RuntimeWarRoomPage() {
  const subTab = useAppStore((s) => s.runtimeSubTab);
  const setSubTab = useAppStore((s) => s.setRuntimeSubTab);
  const factoryFilter = useAppStore((s) => s.runtimeFactoryFilter);
  const setFactoryFilter = useAppStore((s) => s.setRuntimeFactoryFilter);
  const refreshKey = useAppStore((s) => s.refreshKey);
  const triggerRefresh = useAppStore((s) => s.triggerRefresh);

  const { data: factories } = useAsync(() => fetchFactories(), []);

  return (
    <div className="rtWarRoom">
      <PageBoundary name="运行时 KPI">
        <RuntimeKpiStrip refreshKey={refreshKey} />
      </PageBoundary>

      <div className="rtWarRoomBody">
        {/* Left rail: filters + factory list */}
        <aside className="rtLeftRail card">
          <div className="cardHeader">
            <h3 style={{ margin: 0 }}>筛选</h3>
            <button className="btn" onClick={triggerRefresh} title="刷新所有面板">↻</button>
          </div>
          <div className="rtFilterSection">
            <button
              className={`rtFactoryItem ${factoryFilter === "" ? "rtFactoryItem--active" : ""}`}
              onClick={() => setFactoryFilter("")}
            >
              全部工厂
            </button>
            {Array.isArray(factories) && factories.map((f) => (
              <button
                key={f.id}
                className={`rtFactoryItem ${factoryFilter === f.id ? "rtFactoryItem--active" : ""}`}
                onClick={() => setFactoryFilter(f.id)}
              >
                {f.name}
              </button>
            ))}
          </div>
          <div className="hint" style={{ padding: "8px 12px" }}>
            选择工厂以聚焦 Timeline / Replay 数据
          </div>
        </aside>

        {/* Center: tabbed visualization */}
        <main className="rtCenter">
          <div className="rtTabs">
            <button
              className={`rtTab ${subTab === "timeline" ? "rtTab--active" : ""}`}
              onClick={() => setSubTab("timeline")}
            >
              排产时间线
            </button>
            <button
              className={`rtTab ${subTab === "graph" ? "rtTab--active" : ""}`}
              onClick={() => setSubTab("graph")}
            >
              约束传播图
            </button>
            <button
              className={`rtTab ${subTab === "replay" ? "rtTab--active" : ""}`}
              onClick={() => setSubTab("replay")}
            >
              事件回放
            </button>
          </div>
          <div className="rtTabBody card">
            {subTab === "timeline" && (
              <PageBoundary name="排产时间线">
                <RuntimeTimeline refreshKey={refreshKey} />
              </PageBoundary>
            )}
            {subTab === "graph" && (
              <PageBoundary name="约束传播图">
                <ConstraintGraph refreshKey={refreshKey} />
              </PageBoundary>
            )}
            {subTab === "replay" && (
              <PageBoundary name="事件回放">
                <RuntimeReplayPanel refreshKey={refreshKey} />
              </PageBoundary>
            )}
          </div>
        </main>

        {/* Right rail: AI command feed + detail drawer */}
        <aside className="rtRightRail">
          <PageBoundary name="AI 指挥流">
            <AICommandFeed refreshKey={refreshKey} />
          </PageBoundary>
          <PageBoundary name="详情">
            <RuntimeDetailDrawer />
          </PageBoundary>
        </aside>
      </div>
    </div>
  );
}
