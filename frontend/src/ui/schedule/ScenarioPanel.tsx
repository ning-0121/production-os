import React from "react";
import { fetchScenarios, applyScenario } from "../../services/api";
import type { Scenario } from "../../services/api";
import { useToast } from "../Toast";

type Props = {
  allocationId: string | null;
  onApplied: () => void;
};

const RISK_COLORS: Record<string, string> = {
  SAFE: "#22c55e",
  MEDIUM: "#facc15",
  HIGH: "#fb7185",
};

export function ScenarioPanel({ allocationId, onApplied }: Props) {
  const { toast } = useToast();
  const [scenarios, setScenarios] = React.useState<Scenario[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [applying, setApplying] = React.useState<string | null>(null);

  async function loadScenarios() {
    if (!allocationId) return;
    setLoading(true);
    try {
      const res = await fetchScenarios(allocationId);
      setScenarios(res.scenarios ?? []);
    } catch {
      toast("方案生成失败", "error");
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    if (allocationId) loadScenarios();
    else setScenarios([]);
  }, [allocationId]);

  async function handleApply(scenario: Scenario) {
    setApplying(scenario.id);
    try {
      await applyScenario(allocationId!, scenario.id);
      toast(`已执行：${scenario.scenario_label}`, "success");
      onApplied();
    } catch {
      toast("执行失败", "error");
    } finally {
      setApplying(null);
    }
  }

  if (!allocationId) {
    return (
      <div className="scenarioPanel">
        <div className="scenarioPanelHeader">
          <span className="aiPanelBadge">AI</span>
          <span>多方案对比</span>
        </div>
        <div className="emptyState" style={{ padding: 20 }}>选择一个订单查看方案</div>
      </div>
    );
  }

  return (
    <div className="scenarioPanel">
      <div className="scenarioPanelHeader">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="aiPanelBadge">AI</span>
          <span style={{ fontWeight: 600 }}>多方案对比</span>
        </div>
        <button className="btn" onClick={loadScenarios} disabled={loading} style={{ fontSize: 11, padding: "3px 8px" }}>
          {loading ? "生成中..." : "重新生成"}
        </button>
      </div>

      <div className="scenarioList">
        {loading && <div className="loadingCenter" style={{ padding: 20 }}>AI 正在分析方案...</div>}

        {!loading && scenarios.length === 0 && (
          <div className="emptyState" style={{ padding: 16 }}>暂无方案</div>
        )}

        {scenarios.map((s, i) => {
          const isExpanded = expanded === s.id;
          const isApplying = applying === s.id;
          const isBest = i === 0;

          return (
            <div
              key={s.id}
              className={`scenarioCard ${isBest ? "scenarioCard--best" : ""} ${isExpanded ? "scenarioCard--expanded" : ""}`}
            >
              <div className="scenarioCardHeader" onClick={() => setExpanded(isExpanded ? null : s.id)}>
                <div className="scenarioCardLeft">
                  {isBest && <span className="scenarioBestTag">推荐</span>}
                  <span className="scenarioLabel">{s.scenario_label}</span>
                  <span className="scenarioScore">{s.recommendation_score}分</span>
                </div>
                <div className="scenarioCardRight">
                  <span className="scenarioRisk" style={{ color: RISK_COLORS[s.risk_level] ?? "#fff" }}>
                    {s.risk_level === "SAFE" ? "安全" : s.risk_level === "MEDIUM" ? "有风险" : s.risk_level === "HIGH" ? "高风险" : s.risk_level}
                  </span>
                  <span className="scenarioToggle">{isExpanded ? "▼" : "▶"}</span>
                </div>
              </div>

              {isExpanded && (
                <div className="scenarioDetail">
                  <div className="scenarioDetailRow">
                    <span>工厂</span>
                    <span>{s.target_factory_name ?? "—"}</span>
                  </div>
                  <div className="scenarioDetailRow">
                    <span>完工时间</span>
                    <span>{s.expected_finish_date ?? "—"}</span>
                  </div>
                  <div className="scenarioDetailRow">
                    <span>缓冲天数</span>
                    <span>{s.buffer_days > 0 ? `提前${s.buffer_days}天` : s.buffer_days < 0 ? `延期${Math.abs(s.buffer_days)}天` : "刚好"}</span>
                  </div>
                  <div className="scenarioDetailRow">
                    <span>成本变化</span>
                    <span>{s.cost_change_pct > 0 ? `+${s.cost_change_pct}%` : s.cost_change_pct < 0 ? `${s.cost_change_pct}%` : "无变化"}</span>
                  </div>
                  <div className="scenarioDetailRow">
                    <span>影响</span>
                    <span>{s.impact_summary}</span>
                  </div>
                  {s.recommendation_reason && (
                    <div className="scenarioReason">{s.recommendation_reason}</div>
                  )}

                  {s.status === "pending" && s.scenario_type !== "hold" && (
                    <button
                      className="btn primary scenarioApplyBtn"
                      onClick={() => handleApply(s)}
                      disabled={!!applying}
                    >
                      {isApplying ? "执行中..." : "执行此方案"}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
