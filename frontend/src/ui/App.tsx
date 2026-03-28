import React from "react";
import { BoardPage } from "./board/BoardPage";
import { GanttPage } from "./gantt/GanttPage";
import { FactoriesPage } from "./factories/FactoriesPage";
import { GeofencePage } from "./geofence/GeofencePage";
import { runRiskScan, checkHealth } from "../services/api";
import type { ApiHealth } from "../services/api";
import type { RiskLevel } from "../types";

type TabKey = "board" | "schedule" | "factories" | "geofence";

const tabs: { key: TabKey; label: string }[] = [
  { key: "board", label: "看板" },
  { key: "schedule", label: "甘特图" },
  { key: "factories", label: "工厂" },
  { key: "geofence", label: "巡厂" },
];

type RiskCounts = { HIGH: number; MEDIUM: number; SAFE: number; total: number };

export function App() {
  const [tab, setTab] = React.useState<TabKey>("board");
  const [risk, setRisk] = React.useState<RiskCounts | null>(null);
  const [riskError, setRiskError] = React.useState(false);
  const [apiHealth, setApiHealth] = React.useState<ApiHealth | null>(null);

  // Check API health first, then run risk scan
  React.useEffect(() => {
    checkHealth().then((health) => {
      setApiHealth(health);
      if (health.ok) {
        runRiskScan()
          .then((res) => setRisk({ ...res.summary, total: res.scanned }))
          .catch(() => setRiskError(true));
      }
    });
  }, []);

  return (
    <div className="container">
      <div className="topbar">
        <div className="brand">
          <div className="logo" />
          <div className="title">
            <strong>Production OS</strong>
            <span>排产管理 + 巡厂定位</span>
          </div>
        </div>

        <div className="tabs" role="tablist" aria-label="Views">
          {tabs.map((t) => (
            <button
              key={t.key}
              className={`tab ${tab === t.key ? "active" : ""}`}
              onClick={() => setTab(t.key)}
              role="tab"
              aria-selected={tab === t.key}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {apiHealth && !apiHealth.ok && (
        <div className="riskBanner riskBannerHigh">
          <div className="riskBannerLeft">
            <span className="riskBannerIcon">!</span>
            <span className="riskBannerText">
              Backend API unreachable ({apiHealth.base_url}). {apiHealth.error ?? "Set VITE_API_BASE_URL."}
            </span>
          </div>
        </div>
      )}

      {risk && (risk.HIGH > 0 || risk.MEDIUM > 0) && (
        <RiskBanner counts={risk} />
      )}
      {riskError && apiHealth?.ok && (
        <div className="riskBanner riskBannerSafe">
          <span className="riskBannerIcon">i</span>
          <span>Risk scan unavailable — check risk_alerts table.</span>
        </div>
      )}

      {tab === "board" && <BoardPage />}
      {tab === "schedule" && <GanttPage />}
      {tab === "factories" && <FactoriesPage />}
      {tab === "geofence" && <GeofencePage />}
    </div>
  );
}

function RiskBanner({ counts }: { counts: RiskCounts }) {
  const level: RiskLevel = counts.HIGH > 0 ? "HIGH" : counts.MEDIUM > 0 ? "MEDIUM" : "SAFE";
  const cls =
    level === "HIGH" ? "riskBannerHigh" :
    level === "MEDIUM" ? "riskBannerMedium" : "riskBannerSafe";

  return (
    <div className={`riskBanner ${cls}`}>
      <div className="riskBannerLeft">
        <span className="riskBannerIcon">
          {level === "HIGH" ? "!" : level === "MEDIUM" ? "~" : "ok"}
        </span>
        <span className="riskBannerText">
          {level === "HIGH"
            ? `${counts.HIGH} high-risk orders need immediate attention`
            : `${counts.MEDIUM} orders with delivery risk`}
        </span>
      </div>
      <div className="riskBannerCounts">
        {counts.HIGH > 0 && <span className="riskDot riskDotHigh">{counts.HIGH} HIGH</span>}
        {counts.MEDIUM > 0 && <span className="riskDot riskDotMedium">{counts.MEDIUM} MEDIUM</span>}
        <span className="riskDot riskDotSafe">{counts.SAFE} SAFE</span>
      </div>
    </div>
  );
}
