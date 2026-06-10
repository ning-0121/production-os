/**
 * Decision Intelligence / 决策智能 — make the Decision Engine observable.
 *
 * One fetch drives all 7 sections. Answers: are AI recommendations trusted,
 * which options work, which recommendations get rejected, is the engine
 * learning. Deterministic, zero-safe; every section guards empty/loading/error.
 */

import React from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { useAsync } from "../../hooks/useAsync";
import { fetchDecisionIntelligence } from "../../services/api";
import { PageSkeleton } from "../Skeleton";
import { COLOR_HEX } from "../shared/riskColors";
import type {
  DecisionIntelligence, DecisionIntelOption, DecisionIntelOverride,
  DecisionIntelLearningRow, DecisionIntelInsight,
} from "../../types";
import "./decision-intel.css";

const OPTION_LABEL: Record<string, string> = {
  keep_current: "维持现状", overtime: "加班", reassign_factory: "转厂",
  reassign_line: "转线", split_order: "拆单", delay_customer: "客户协商延期",
  expedite_material: "加急催料", substitute_material: "替代物料",
  partial_start: "部分开工", add_qc_check: "增加终检", create_rework_plan: "返工",
};
const DT_LABEL: Record<string, string> = {
  delay_resolution: "生产延期", material_shortage_resolution: "物料短缺",
  qc_rework_resolution: "质量返工", vip_insertion: "紧急插单", line_disruption_resolution: "产线中断",
};
const ol = (t: string) => OPTION_LABEL[t] ?? t;
const TREND_ARROW = { up: "↑", down: "↓", flat: "→" };

export function DecisionIntelPage() {
  const [window, setWindow] = React.useState<"7d" | "30d">("7d");
  const { data, loading, error } = useAsync(() => fetchDecisionIntelligence(window), [window]);

  if (loading && !data) return <PageSkeleton />;
  if (error) return <div className="card"><div style={{ padding: 24, color: "var(--danger)" }}>加载失败：{error}</div></div>;
  if (!data) return null;

  return (
    <div className="diPage">
      <div className="cardHeader" style={{ marginBottom: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>决策智能</h1>
          <div className="hint">AI 推荐是否被信任、哪些处置最有效、哪些推荐常被否决、系统是否在学习</div>
        </div>
        <div className="diWindowToggle">
          <button className={`diWinBtn ${window === "7d" ? "diWinBtn--active" : ""}`} onClick={() => setWindow("7d")}>近 7 天</button>
          <button className={`diWinBtn ${window === "30d" ? "diWinBtn--active" : ""}`} onClick={() => setWindow("30d")}>近 30 天</button>
        </div>
      </div>

      <InsightCards insights={data.insights} />
      <KpiStrip data={data} />

      <div className="diGrid">
        <RecommendationPanel data={data} />
        <LearningPanel data={data} />
      </div>

      <div className="diGrid">
        <OptionRanking options={data.options} />
        <FeedbackPanel data={data} />
      </div>

      <TrendPanel days={data.trends.days} />
    </div>
  );
}

// ── 7. Insights ─────────────────────────────────────────
function InsightCards({ insights }: { insights: DecisionIntelInsight[] }) {
  const list = Array.isArray(insights) ? insights : [];
  if (list.length === 0) return null;
  return (
    <div className="diInsights">
      {list.map((c, i) => (
        <div key={i} className={`diInsight diInsight--${c.severity}`}>
          <span className="diInsightIcon">{c.icon}</span>
          <span>{c.text}</span>
        </div>
      ))}
    </div>
  );
}

// ── 1. KPI strip ────────────────────────────────────────
function KpiStrip({ data }: { data: DecisionIntelligence }) {
  const s = data.summary;
  return (
    <div className="diKpiStrip">
      <Kpi label="评估决策" value={s.decisions_evaluated} sub={`${TREND_ARROW[s.acceptance_trend]} 上期 ${s.prev_decisions_evaluated}`} accent />
      <Kpi label="已执行" value={s.decisions_applied} />
      <Kpi label="推荐采纳率" value={`${s.recommendation_acceptance_rate}%`} tone={s.recommendation_acceptance_rate >= 60 ? "ok" : s.recommendation_acceptance_rate >= 40 ? "warn" : "danger"} />
      <Kpi label="覆盖率" value={`${s.override_rate}%`} tone={s.override_rate > 50 ? "warn" : "ok"} />
      <Kpi label="执行成功率" value={`${s.apply_success_rate}%`} tone={s.apply_success_rate >= 70 ? "ok" : "warn"} />
      <Kpi label="失败率" value={`${s.failed_rate}%`} tone={s.failed_rate > 20 ? "danger" : "ok"} />
      <Kpi label="平均置信" value={`${Math.round(s.avg_confidence * 100)}%`} />
    </div>
  );
}
function Kpi({ label, value, sub, tone, accent }: { label: string; value: React.ReactNode; sub?: string; tone?: "ok" | "warn" | "danger"; accent?: boolean }) {
  const cls = tone === "danger" ? "diKpi--danger" : tone === "warn" ? "diKpi--warn" : tone === "ok" ? "diKpi--ok" : "";
  return (
    <div className={`diKpi ${cls}`}>
      <div className="diKpiLabel">{label}</div>
      <div className={`diKpiValue ${accent ? "diKpiValue--accent" : ""}`}>{value}</div>
      {sub && <div className="diKpiSub">{sub}</div>}
    </div>
  );
}

// ── 2. Recommendation performance ───────────────────────
function RecommendationPanel({ data }: { data: DecisionIntelligence }) {
  const s = data.summary;
  const overrides = (data.overrides ?? []).filter((o) => o.recommended >= 1).slice(0, 6);
  return (
    <div className="card diSection">
      <div className="cardHeader"><h3 style={{ margin: 0 }}>推荐表现</h3><span className="hint">AI 推荐 vs 实际选择</span></div>
      <div className="diAcceptBar">
        <div className="diAcceptFill diAcceptFill--accept" style={{ width: `${s.recommendation_acceptance_rate}%` }} title={`采纳 ${s.recommendation_acceptance_rate}%`} />
        <div className="diAcceptFill diAcceptFill--override" style={{ width: `${s.override_rate}%` }} title={`改选 ${s.override_rate}%`} />
      </div>
      <div className="diAcceptLegend">
        <span><span className="diDot diDot--accept" />采纳 {s.recommendation_acceptance_rate}%</span>
        <span><span className="diDot diDot--override" />改选 {s.override_rate}%</span>
      </div>
      <div className="diSubLabel">最常被改选的推荐</div>
      {overrides.length === 0 ? <div className="emptyState" style={{ padding: 16 }}>暂无数据</div> : (
        <div className="diOverrideList">
          {overrides.map((o: DecisionIntelOverride) => (
            <div key={o.option_type} className="diOverrideRow">
              <span>{ol(o.option_type)}</span>
              <span className="diOverrideMeta">
                推荐 {o.recommended} · <span style={{ color: o.override_rate >= 40 ? COLOR_HEX.amber.fg : "var(--muted)" }}>改选 {o.override_rate}%</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 3. Learning adjustments ─────────────────────────────
function LearningPanel({ data }: { data: DecisionIntelligence }) {
  const rows = (data.learning?.all ?? []).filter((r: DecisionIntelLearningRow) => r.adjustment !== 0).slice(0, 10);
  return (
    <div className="card diSection">
      <div className="cardHeader"><h3 style={{ margin: 0 }}>学习调整</h3><span className="hint">{data.learning?.learned_count ?? 0} 项已学习</span></div>
      {rows.length === 0 ? (
        <div className="emptyState" style={{ padding: 16 }}>样本积累中，暂无学习调整。决策被采纳并反馈后系统会自动学习。</div>
      ) : (
        <div className="diLearnList">
          {rows.map((r, i) => (
            <div key={i} className="diLearnRow">
              <div className="diLearnTop">
                <span className="diLearnOption">{ol(r.option_type)}</span>
                <span className="diLearnDt">{DT_LABEL[r.decision_type] ?? r.decision_type}</span>
                <span className={`diLearnDelta ${r.adjustment > 0 ? "diLearnDelta--up" : "diLearnDelta--down"}`}>
                  {r.adjustment > 0 ? `+${r.adjustment}` : r.adjustment}
                </span>
              </div>
              <div className="diLearnReason">{r.reason} · 样本 {r.sample_size}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 4. Option ranking ───────────────────────────────────
function OptionRanking({ options }: { options: DecisionIntelOption[] }) {
  const list = Array.isArray(options) ? options.slice(0, 8) : [];
  return (
    <div className="card diSection">
      <div className="cardHeader"><h3 style={{ margin: 0 }}>选项排名</h3><span className="hint">哪些处置最有效</span></div>
      {list.length === 0 ? <div className="emptyState" style={{ padding: 16 }}>暂无决策选择记录</div> : (
        <table className="diTable">
          <thead><tr><th>选项</th><th>被选</th><th>成功率</th><th>失败</th><th>好评</th></tr></thead>
          <tbody>
            {list.map((o) => (
              <tr key={o.option_type}>
                <td><strong>{ol(o.option_type)}</strong></td>
                <td>{o.selected}</td>
                <td><span style={{ color: o.success_rate >= 70 ? COLOR_HEX.green.fg : o.success_rate >= 40 ? COLOR_HEX.amber.fg : COLOR_HEX.red.fg }}>{o.success_rate}%</span></td>
                <td>{o.failed > 0 ? <span style={{ color: COLOR_HEX.red.fg }}>{o.failed}</span> : "—"}</td>
                <td>{o.helpful || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── 5. Feedback quality ─────────────────────────────────
function FeedbackPanel({ data }: { data: DecisionIntelligence }) {
  const f = data.feedback;
  return (
    <div className="card diSection">
      <div className="cardHeader"><h3 style={{ margin: 0 }}>反馈质量</h3><span className="hint">正向 {f.helpful_rate}%</span></div>
      <div className="diFbGrid">
        <FbStat label="有用" value={f.helpful} tone="ok" />
        <FbStat label="无用" value={f.not_helpful} tone={f.not_helpful > 0 ? "warn" : undefined} />
        <FbStat label="推荐错误" value={f.wrong_recommendation} tone={f.wrong_recommendation > 0 ? "danger" : undefined} />
        <FbStat label="未反馈" value={f.no_feedback} />
      </div>
      {f.total_feedback === 0 && (
        <div className="hint" style={{ marginTop: 8 }}>鼓励现场对决策打「有用 / 无用」，能让学习更快更准。</div>
      )}
    </div>
  );
}
function FbStat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" | "danger" }) {
  const color = tone === "danger" ? COLOR_HEX.red.fg : tone === "warn" ? COLOR_HEX.amber.fg : tone === "ok" ? COLOR_HEX.green.fg : "var(--text)";
  return <div className="diFbStat"><div className="diFbVal" style={{ color }}>{value}</div><div className="diFbLabel">{label}</div></div>;
}

// ── 6. Trends ───────────────────────────────────────────
function TrendPanel({ days }: { days: DecisionIntelligence["trends"]["days"] }) {
  const data = Array.isArray(days) ? days : [];
  return (
    <div className="card diSection">
      <div className="cardHeader"><h3 style={{ margin: 0 }}>决策趋势</h3><span className="hint">评估量 / 采纳率 / 改选率</span></div>
      <div style={{ padding: "8px 0" }}>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data} margin={{ top: 12, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
            <XAxis dataKey="date" tick={{ fill: "rgba(255,255,255,.5)", fontSize: 11 }} tickFormatter={(v: string) => v.slice(5)} />
            <YAxis tick={{ fill: "rgba(255,255,255,.5)", fontSize: 11 }} allowDecimals={false} />
            <Tooltip contentStyle={{ background: "#1a2233", border: "1px solid rgba(255,255,255,.1)", borderRadius: 8, fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="evaluated" name="评估量" stroke="#6ee7ff" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="acceptance_rate" name="采纳率%" stroke="#22c55e" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="override_rate" name="改选率%" stroke="#facc15" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
