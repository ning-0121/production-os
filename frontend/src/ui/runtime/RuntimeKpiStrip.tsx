/**
 * RuntimeKpiStrip — top-of-page tile row for the War Room.
 *
 * Defensive: tolerates partial KPI data; never crashes the page.
 */

import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchRuntimeKpi } from "../../services/api";

export function RuntimeKpiStrip({ refreshKey = 0 }: { refreshKey?: number }) {
  const { data, loading, error } = useAsync(() => fetchRuntimeKpi(), [refreshKey]);

  const k = data ?? null;

  return (
    <div className="rtKpiStrip">
      <KpiTile label="活跃产线" value={loading ? "—" : (k?.active_lines ?? 0)} accent />
      <KpiTile label="超载产线" value={loading ? "—" : (k?.overloaded_lines ?? 0)} tone={(k?.overloaded_lines ?? 0) > 0 ? "danger" : "ok"} />
      <KpiTile label="阻塞/停机" value={loading ? "—" : (k?.blocked_lines ?? 0)} tone={(k?.blocked_lines ?? 0) > 0 ? "danger" : "ok"} />
      <KpiTile label="高风险产线" value={loading ? "—" : (k?.high_risk_lines ?? 0)} tone={(k?.high_risk_lines ?? 0) > 0 ? "danger" : "ok"} />
      <KpiTile label="24h 事件" value={loading ? "—" : (k?.runtime_events_24h ?? 0)} />
      <KpiTile label="24h 紧急" value={loading ? "—" : (k?.critical_events_24h ?? 0)} tone={(k?.critical_events_24h ?? 0) > 0 ? "warn" : "ok"} />
      <KpiTile label="待传播" value={loading ? "—" : (k?.pending_propagations ?? 0)} tone={(k?.pending_propagations ?? 0) > 0 ? "warn" : "ok"} />
      {error && <div className="rtKpiError">KPI 加载失败</div>}
    </div>
  );
}

function KpiTile({
  label, value, tone, accent,
}: {
  label: string; value: number | string; tone?: "ok" | "warn" | "danger"; accent?: boolean;
}) {
  const cls = tone === "danger" ? "rtKpiTile--danger"
    : tone === "warn" ? "rtKpiTile--warn"
    : tone === "ok" ? "rtKpiTile--ok"
    : "";
  return (
    <div className={`rtKpiTile ${cls}`}>
      <div className="rtKpiTileLabel">{label}</div>
      <div className={`rtKpiTileValue ${accent ? "rtKpiTileValue--accent" : ""}`}>{value}</div>
    </div>
  );
}
