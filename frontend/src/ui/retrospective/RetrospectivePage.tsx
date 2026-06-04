/**
 * Retrospective Dashboard / 复盘分析 — V6 management intelligence.
 *
 * One fetch (/api/retrospective/summary) drives all 7 sections. Deterministic,
 * zero-safe data; every section guards empty/loading/error.
 *
 * Audience: owner / GM / factory manager / ops lead. Monday-morning question:
 * what went wrong, who handled it, what's unresolved, what root causes to fix,
 * and is the AI automation actually helping.
 */

import React from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { useAsync } from "../../hooks/useAsync";
import { fetchRetrospective } from "../../services/api";
import { PageSkeleton } from "../Skeleton";
import { COLOR_HEX } from "../shared/riskColors";
import type {
  RetrospectiveData, RetroRootCause, RetroFactory, RetroOwner, RetroInsight,
} from "../../types";
import "./retrospective.css";

const ROOT_CAUSE_LABEL: Record<string, string> = {
  material_delay: "物料延迟", equipment_failure: "设备故障", labor_shortage: "人员短缺",
  quality_issue: "质量问题", planning_error: "计划错误", supplier_issue: "供应商问题",
  customer_change: "客户变更", data_error: "数据错误", external_factor: "外部因素",
  no_action_needed: "无需处理", other: "其他",
};
const CATEGORY_LABEL: Record<string, string> = {
  production_delay: "生产延期", quality: "质量", material: "物料", shipment: "出货", capacity: "产能", general: "一般",
};
function rcLabel(rc: string): string {
  if (rc?.startsWith("category:")) return CATEGORY_LABEL[rc.slice(9)] ?? rc.slice(9);
  return ROOT_CAUSE_LABEL[rc] ?? rc;
}
function fmtMins(m: number): string {
  const n = Number(m) || 0;
  if (n < 60) return `${n}分`;
  const h = Math.round(n / 6) / 10;
  if (h < 24) return `${h}时`;
  return `${Math.round(h / 2.4) / 10}天`;
}
const TREND_ARROW = { up: "↑", down: "↓", flat: "→" };

export function RetrospectivePage() {
  const [window, setWindow] = React.useState<"7d" | "30d">("7d");
  const { data, loading, error } = useAsync(() => fetchRetrospective(window), [window]);

  if (loading && !data) return <PageSkeleton />;
  if (error) return <div className="card"><div style={{ padding: 24, color: "var(--danger)" }}>加载失败：{error}</div></div>;
  if (!data) return null;

  return (
    <div className="retroPage">
      <div className="cardHeader" style={{ marginBottom: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>复盘分析</h1>
          <div className="hint">把执行历史变成管理洞察 — 上周哪里出问题、谁在处理、什么还没解决、AI 是否真的有用</div>
        </div>
        <div className="retroWindowToggle">
          <button className={`retroWinBtn ${window === "7d" ? "retroWinBtn--active" : ""}`} onClick={() => setWindow("7d")}>近 7 天</button>
          <button className={`retroWinBtn ${window === "30d" ? "retroWinBtn--active" : ""}`} onClick={() => setWindow("30d")}>近 30 天</button>
        </div>
      </div>

      {/* 7. Insight cards — top, the punchline first */}
      <InsightCards insights={data.insights} />

      {/* 1. KPI strip */}
      <KpiStrip data={data} />

      <div className="retroGrid">
        {/* 2. Root cause ranking */}
        <RootCausePanel rows={data.root_causes} />
        {/* 5. AI effectiveness */}
        <AiPanel data={data} />
      </div>

      <div className="retroGrid">
        {/* 3. Factory / line map */}
        <FactoryPanel factories={data.factories} lines={data.lines} />
        {/* 4. Owner performance */}
        <OwnerPanel owners={data.owners} />
      </div>

      {/* 6. Trend chart */}
      <TrendPanel days={data.trends.days} />
    </div>
  );
}

// ── 7. Insights ─────────────────────────────────────────
function InsightCards({ insights }: { insights: RetroInsight[] }) {
  const list = Array.isArray(insights) ? insights : [];
  if (list.length === 0) return null;
  return (
    <div className="retroInsights">
      {list.map((c, i) => (
        <div key={i} className={`retroInsight retroInsight--${c.severity}`}>
          <span className="retroInsightIcon">{c.icon}</span>
          <span className="retroInsightText">{c.text}</span>
        </div>
      ))}
    </div>
  );
}

// ── 1. KPI strip ────────────────────────────────────────
function KpiStrip({ data }: { data: RetrospectiveData }) {
  const s = data.summary;
  return (
    <div className="retroKpiStrip">
      <Kpi label="总任务" value={s.total_tasks} sub={`${TREND_ARROW[s.total_trend]} 上期 ${s.prev_total_tasks}`} accent />
      <Kpi label="解决率" value={`${s.resolved_pct}%`} sub={`${s.resolved_tasks} 已解决`} tone={s.resolved_pct >= 70 ? "ok" : "warn"} />
      <Kpi label="逾期率" value={`${s.overdue_pct}%`} sub={`${s.overdue_tasks} 逾期`} tone={s.overdue_pct > 20 ? "danger" : "ok"} />
      <Kpi label="平均解决" value={fmtMins(s.avg_resolution_minutes)} sub={`中位 ${fmtMins(s.median_resolution_minutes)}`} />
      <Kpi label="升级次数" value={s.escalation_count} sub={`${s.escalation_rate}%`} tone={s.escalation_count > 0 ? "warn" : "ok"} />
      <Kpi label="AI 生成" value={s.ai_generated_count} sub={`完成率 ${s.ai_completion_rate}%`} />
      <Kpi label="重复问题" value={s.repeat_issue_count} tone={s.repeat_issue_count > 0 ? "warn" : "ok"} />
    </div>
  );
}
function Kpi({ label, value, sub, tone, accent }: { label: string; value: React.ReactNode; sub?: string; tone?: "ok" | "warn" | "danger"; accent?: boolean }) {
  const cls = tone === "danger" ? "retroKpi--danger" : tone === "warn" ? "retroKpi--warn" : tone === "ok" ? "retroKpi--ok" : "";
  return (
    <div className={`retroKpi ${cls}`}>
      <div className="retroKpiLabel">{label}</div>
      <div className={`retroKpiValue ${accent ? "retroKpiValue--accent" : ""}`}>{value}</div>
      {sub && <div className="retroKpiSub">{sub}</div>}
    </div>
  );
}

// ── 2. Root cause ranking ───────────────────────────────
function RootCausePanel({ rows }: { rows: RetroRootCause[] }) {
  const list = Array.isArray(rows) ? rows.slice(0, 8) : [];
  const max = Math.max(1, ...list.map((r) => r.count));
  return (
    <div className="card retroSection">
      <div className="cardHeader"><h3 style={{ margin: 0 }}>根因排名</h3><span className="hint">最主要的问题来源</span></div>
      {list.length === 0 ? <div className="emptyState" style={{ padding: 24 }}>暂无数据</div> : (
        <div className="retroBars">
          {list.map((r) => (
            <div key={r.root_cause} className="retroBarRow">
              <span className="retroBarLabel">{rcLabel(r.root_cause)}</span>
              <div className="retroBarTrack">
                <div className="retroBarFill" style={{ width: `${(r.count / max) * 100}%` }} />
              </div>
              <span className="retroBarVal">
                {r.count}
                <span className={`retroTrend retroTrend--${r.trend}`}> {TREND_ARROW[r.trend]}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 5. AI effectiveness ─────────────────────────────────
function AiPanel({ data }: { data: RetrospectiveData }) {
  const ai = data.ai_effectiveness;
  const ch = data.cron_health;
  return (
    <div className="card retroSection">
      <div className="cardHeader"><h3 style={{ margin: 0 }}>AI 自动化效果</h3><span className="hint">自动化是否真的有用</span></div>
      <div className="retroAiGrid">
        <AiStat label="自动生成" value={ai.auto_generated} />
        <AiStat label="已完成" value={ai.completed} tone="ok" />
        <AiStat label="完成率" value={`${ai.completion_rate}%`} tone={ai.completion_rate >= 60 ? "ok" : "warn"} />
        <AiStat label="被忽略" value={ai.dismissed} tone={ai.dismissed > 0 ? "warn" : undefined} />
        <AiStat label="误报率" value={`${ai.false_positive_rate}%`} tone={ai.false_positive_rate >= 30 ? "danger" : "ok"} />
        <AiStat label="升级" value={ai.escalated} />
      </div>
      {ai.top_false_positive_sources.length > 0 && (
        <div className="retroFpSources">
          <span className="hint">误报主要来源：</span>
          {ai.top_false_positive_sources.slice(0, 4).map((s) => (
            <span key={s.source} className="retroFpChip">{s.source} ×{s.count}</span>
          ))}
        </div>
      )}
      <div className="retroCronHealth">
        自动化运行：{ch.runs} 次{ch.failed_runs > 0 && <span style={{ color: "var(--danger)" }}>（{ch.failed_runs} 次失败）</span>}
        {ch.last_run_at && <span className="hint"> · 最近 {new Date(ch.last_run_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })}</span>}
      </div>
    </div>
  );
}
function AiStat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "ok" | "warn" | "danger" }) {
  const color = tone === "danger" ? COLOR_HEX.red.fg : tone === "warn" ? COLOR_HEX.amber.fg : tone === "ok" ? COLOR_HEX.green.fg : "var(--text)";
  return (
    <div className="retroAiStat">
      <div className="retroAiStatVal" style={{ color }}>{value}</div>
      <div className="retroAiStatLabel">{label}</div>
    </div>
  );
}

// ── 3. Factory / line map ───────────────────────────────
function FactoryPanel({ factories, lines }: { factories: RetroFactory[]; lines: RetrospectiveData["lines"] }) {
  const fList = Array.isArray(factories) ? factories.slice(0, 6) : [];
  const lList = Array.isArray(lines) ? lines.slice(0, 5) : [];
  return (
    <div className="card retroSection">
      <div className="cardHeader"><h3 style={{ margin: 0 }}>工厂 / 产线问题地图</h3><span className="hint">问题集中在哪</span></div>
      {fList.length === 0 ? <div className="emptyState" style={{ padding: 24 }}>暂无工厂问题</div> : (
        <table className="retroTable">
          <thead><tr><th>工厂</th><th>质量</th><th>返工</th><th>延期</th><th>紧急</th><th>合计</th></tr></thead>
          <tbody>
            {fList.map((f) => (
              <tr key={f.factory_id}>
                <td><strong>{f.factory_name}</strong></td>
                <td>{f.quality || "—"}</td><td>{f.rework || "—"}</td>
                <td>{f.delay || "—"}</td>
                <td>{f.critical > 0 ? <span style={{ color: "var(--danger)" }}>{f.critical}</span> : "—"}</td>
                <td><strong>{f.total}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {lList.length > 0 && (
        <div className="retroLines">
          <div className="hint" style={{ marginBottom: 6 }}>产线问题排名</div>
          {lList.map((l) => (
            <div key={l.line_id} className="retroLineRow">
              <span>{l.line_name}</span>
              <span className="hint">{l.issues} 项{l.critical > 0 && <span style={{ color: "var(--danger)" }}> · {l.critical} 紧急</span>}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 4. Owner performance ────────────────────────────────
function OwnerPanel({ owners }: { owners: RetroOwner[] }) {
  const list = Array.isArray(owners) ? owners.slice(0, 8) : [];
  return (
    <div className="card retroSection">
      <div className="cardHeader"><h3 style={{ margin: 0 }}>责任人表现</h3><span className="hint">谁在处理、谁超负荷</span></div>
      {list.length === 0 ? <div className="emptyState" style={{ padding: 24 }}>暂无认领数据</div> : (
        <table className="retroTable">
          <thead><tr><th>责任人</th><th>分配</th><th>逾期</th><th>已解决</th><th>升级</th><th>平均响应</th></tr></thead>
          <tbody>
            {list.map((o) => (
              <tr key={o.owner} className={o.overloaded ? "retroOwnerOverload" : ""}>
                <td><strong>{o.owner}</strong>{o.overloaded && <span className="retroOverloadTag">超负荷</span>}</td>
                <td>{o.assigned}</td>
                <td>{o.overdue > 0 ? <span style={{ color: "var(--danger)" }}>{o.overdue}</span> : "—"}</td>
                <td>{o.resolved}</td>
                <td>{o.escalations || "—"}</td>
                <td>{o.avg_response_minutes > 0 ? fmtMins(o.avg_response_minutes) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── 6. Trend chart ──────────────────────────────────────
function TrendPanel({ days }: { days: RetrospectiveData["trends"]["days"] }) {
  const data = Array.isArray(days) ? days : [];
  return (
    <div className="card retroSection">
      <div className="cardHeader"><h3 style={{ margin: 0 }}>问题趋势</h3><span className="hint">问题量 / 紧急 / 逾期 / 质量</span></div>
      <div style={{ padding: "8px 0" }}>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data} margin={{ top: 12, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
            <XAxis dataKey="date" tick={{ fill: "rgba(255,255,255,.5)", fontSize: 11 }} tickFormatter={(v: string) => v.slice(5)} />
            <YAxis tick={{ fill: "rgba(255,255,255,.5)", fontSize: 11 }} allowDecimals={false} />
            <Tooltip contentStyle={{ background: "#1a2233", border: "1px solid rgba(255,255,255,.1)", borderRadius: 8, fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="total" name="问题量" stroke="#6ee7ff" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="critical" name="紧急" stroke="#fb7185" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="overdue" name="逾期" stroke="#facc15" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="quality" name="质量" stroke="#a78bfa" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
