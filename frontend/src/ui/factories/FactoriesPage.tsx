import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchFactories, updateCapability } from "../../services/api";
import type { Factory, FactoryCapability } from "../../types";
import "./factories.css";

export function FactoriesPage() {
  const { data: factories, loading, error, refetch } = useAsync(() => fetchFactories(), []);
  const [editingId, setEditingId] = React.useState<string | null>(null);

  async function handleCapabilityUpdate(capId: string, field: string, value: number) {
    try {
      await updateCapability(capId, { [field]: value });
    } catch {
      // silent — will revert on next refetch
    }
    refetch();
  }

  if (loading) return <div className="card"><div style={{ padding: 24, color: "var(--muted)" }}>加载中…</div></div>;
  if (error) return <div className="card"><div style={{ padding: 24, color: "var(--danger)" }}>加载失败: {error}</div></div>;
  if (!factories) return null;

  return (
    <div className="card">
      <div className="cardHeader">
        <div>
          <h2>工厂列表</h2>
          <div className="hint">产能参数自动校准 — 每次订单完成后自动更新</div>
        </div>
        <span className="pill">{factories.length} 工厂</span>
      </div>

      <div className="ftable">
        <div className="fthead">
          <div className="ftcell ftname">名称</div>
          <div className="ftcell">地点</div>
          <div className="ftcell ftnum">日产能</div>
          <div className="ftcell ftnum">单件耗时(min)</div>
          <div className="ftcell ftnum">质量分</div>
          <div className="ftcell ftnum">单件成本</div>
          <div className="ftcell ftnum">状态</div>
          <div className="ftcell">产品类型</div>
        </div>

        {factories.map((f: Factory) => {
          const editing = editingId === f.id;
          const caps = f.factory_capabilities ?? [];
          const bestCap = caps[0];
          const dailyCapacity = bestCap?.base_capacity_units_per_day ?? 0;
          const minutesPerUnit = bestCap?.minutes_per_unit ?? 0;
          const qualityScore = bestCap?.quality_score ?? 0;
          const costPerUnit = bestCap?.cost_per_unit ?? 0;
          const calibration = getCalibrationInfo(bestCap);

          return (
            <React.Fragment key={f.id}>
              <div
                className={`ftrow ${editing ? "ftrowEdit" : ""}`}
                onClick={() => setEditingId(editing ? null : f.id)}
              >
                <div className="ftcell ftname">{f.name}</div>
                <div className="ftcell">{f.address ?? "—"}</div>
                <div className="ftcell ftnum">
                  {editing && bestCap ? (
                    <input
                      type="number"
                      className="ftinput"
                      defaultValue={dailyCapacity}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => void handleCapabilityUpdate(bestCap.id, "base_capacity_units_per_day", Number(e.target.value))}
                    />
                  ) : (
                    <span>
                      {dailyCapacity}
                      {calibration && <span className="ftCalibrated" title="Auto-calibrated">*</span>}
                    </span>
                  )}
                </div>
                <div className="ftcell ftnum">
                  {editing && bestCap ? (
                    <input
                      type="number"
                      step="0.1"
                      className="ftinput"
                      defaultValue={minutesPerUnit}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => void handleCapabilityUpdate(bestCap.id, "minutes_per_unit", Number(e.target.value))}
                    />
                  ) : minutesPerUnit}
                </div>
                <div className="ftcell ftnum">
                  {editing && bestCap ? (
                    <input
                      type="number"
                      className="ftinput"
                      defaultValue={qualityScore}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => void handleCapabilityUpdate(bestCap.id, "quality_score", Number(e.target.value))}
                    />
                  ) : (
                    <ScoreBar value={qualityScore} />
                  )}
                </div>
                <div className="ftcell ftnum">
                  {editing && bestCap ? (
                    <input
                      type="number"
                      step="0.01"
                      className="ftinput"
                      defaultValue={costPerUnit}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => void handleCapabilityUpdate(bestCap.id, "cost_per_unit", Number(e.target.value))}
                    />
                  ) : `¥${costPerUnit}`}
                </div>
                <div className="ftcell ftnum">
                  <span className="pill">{f.status}</span>
                </div>
                <div className="ftcell">
                  <div className="ftcaps">
                    {caps.map((c) => (
                      <span key={c.id} className="pill">{c.product_type}</span>
                    ))}
                  </div>
                </div>
              </div>
              {editing && calibration && (
                <CalibrationRow calibration={calibration} />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────

type CalibrationInfo = {
  last_calibrated_at: string;
  calibration_samples: number;
  avg_daily_output: number;
  avg_delay_days: number;
  avg_efficiency: number;
  on_time_rate: number;
};

function getCalibrationInfo(cap: FactoryCapability | undefined): CalibrationInfo | null {
  if (!cap?.features) return null;
  const f = cap.features as Record<string, unknown>;
  if (!f.last_calibrated_at) return null;
  return f as unknown as CalibrationInfo;
}

function CalibrationRow({ calibration }: { calibration: CalibrationInfo }) {
  const date = calibration.last_calibrated_at.slice(0, 10);
  const onTimePct = Math.round(calibration.on_time_rate * 100);
  const effPct = Math.round(calibration.avg_efficiency * 100);

  return (
    <div className="ftCalibrationRow">
      <div className="ftCalibrationLabel">Auto-calibration</div>
      <div className="ftCalibrationStats">
        <span className="pill ftCalibPill">
          {calibration.calibration_samples} samples
        </span>
        <span className="pill ftCalibPill">
          {calibration.avg_daily_output} units/day avg
        </span>
        <span className="pill ftCalibPill">
          {onTimePct}% on-time
        </span>
        <span className="pill ftCalibPill">
          {effPct}% efficiency
        </span>
        <span className="pill ftCalibPill">
          delay avg: {calibration.avg_delay_days > 0 ? "+" : ""}{calibration.avg_delay_days}d
        </span>
        <span className="ftCalibDate">
          Last: {date}
        </span>
      </div>
    </div>
  );
}

function ScoreBar({ value }: { value: number }) {
  const color = value >= 85 ? "var(--accent)" : value >= 70 ? "var(--accent2)" : "var(--danger)";
  return (
    <div className="scoreBar">
      <div className="scoreBarFill" style={{ width: `${value}%`, background: color }} />
      <span className="scoreBarLabel">{value}</span>
    </div>
  );
}
