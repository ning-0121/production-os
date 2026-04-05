import React from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { useAsync } from "../../hooks/useAsync";
import { fetchTodayBriefing } from "../../services/api";
import type { TodayBriefing, AIAction, RiskyOrder } from "../../types";
import "./today.css";

export function TodayPage() {
  const { data, loading, error } = useAsync(() => fetchTodayBriefing(), []);

  if (loading) return <div className="card"><div className="loadingCenter">加载中...</div></div>;
  if (error) return <div className="card"><div style={{ padding: 24, color: "var(--danger)" }}>加载失败: {error}</div></div>;
  if (!data) return null;

  const { kpi, risky_orders, risky_factories, missing_reports, unscheduled_orders, ai_suggestions, trend } = data;

  return (
    <div className="todayPage">
      {/* KPI Row */}
      <div className="todayKpiRow">
        <KpiCard label="在产订单" value={kpi.active_orders} accent />
        <KpiCard label="今日产出" value={kpi.today_output.toLocaleString()} />
        <KpiCard
          label="准时率"
          value={`${kpi.on_time_pct}%`}
          color={kpi.on_time_pct >= 90 ? "#22c55e" : kpi.on_time_pct >= 70 ? "#facc15" : "#fb7185"}
        />
        <KpiCard label="异常" value={kpi.abnormal_count} color={kpi.abnormal_count === 0 ? "#22c55e" : "#fb7185"} />
        <KpiCard label="待排产" value={kpi.unscheduled_count} color={kpi.unscheduled_count === 0 ? "#22c55e" : "#facc15"} />
        <KpiCard label="未报工" value={missing_reports.length} color={missing_reports.length === 0 ? "#22c55e" : "#facc15"} />
      </div>

      {/* AI Suggestions — action first */}
      {ai_suggestions.length > 0 && (
        <div className="card todaySection">
          <div className="cardHeader">
            <div>
              <h2>AI 行动建议</h2>
              <div className="hint">系统分析生成 — 点击执行或忽略</div>
            </div>
            <span className="todayAiBadge">AI Agent</span>
          </div>
          <div className="todayAiList">
            {ai_suggestions.map((action) => (
              <AIActionCard key={action.id} action={action} />
            ))}
          </div>
        </div>
      )}

      {/* Two-column: Risky Orders + Risky Factories */}
      <div className="todayGrid">
        {/* Risky Orders */}
        <div className="card todaySection">
          <div className="cardHeader">
            <h2>风险订单</h2>
            <span className="hint">{risky_orders.length} 个</span>
          </div>
          <div className="todayList">
            {risky_orders.length === 0 && <div className="emptyState">当前无风险订单</div>}
            {risky_orders.map((order) => (
              <RiskyOrderRow key={order.allocation_id} order={order} />
            ))}
          </div>
        </div>

        {/* Risky Factories + Missing Reports */}
        <div className="todayRightCol">
          <div className="card todaySection">
            <div className="cardHeader">
              <h2>风险工厂</h2>
              <span className="hint">{risky_factories.length} 个</span>
            </div>
            <div className="todayList">
              {risky_factories.length === 0 && <div className="emptyState">所有工厂正常</div>}
              {risky_factories.map((f) => (
                <div key={f.factory_id} className="todayFactoryRow">
                  <span className="todayFactoryName">{f.name}</span>
                  <div className="todayFactoryScores">
                    <span className={`todayScore ${(f.delay_score ?? 100) < 70 ? "todayScore--bad" : ""}`}>
                      延期 {f.delay_score ?? "—"}
                    </span>
                    <span className={`todayScore ${(f.quality_score ?? 100) < 70 ? "todayScore--bad" : ""}`}>
                      质量 {f.quality_score ?? "—"}
                    </span>
                    <span className="todayScore">{f.active_orders}单</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {missing_reports.length > 0 && (
            <div className="card todaySection">
              <div className="cardHeader">
                <h2>未报工厂</h2>
                <span className="hint">{missing_reports.length} 个</span>
              </div>
              <div className="todayList">
                {missing_reports.map((f) => (
                  <div key={f.factory_id} className="todayMissRow">
                    <span className="todayMissDot" />
                    <span>{f.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Trend Chart */}
      <div className="card todaySection">
        <div className="cardHeader">
          <h2>近7天产出趋势</h2>
        </div>
        <div style={{ padding: "8px 0" }}>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={trend} margin={{ top: 12, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
              <XAxis dataKey="date" tick={{ fill: "rgba(255,255,255,.5)", fontSize: 11 }} tickFormatter={(v: string) => v.slice(5)} />
              <YAxis tick={{ fill: "rgba(255,255,255,.5)", fontSize: 11 }} allowDecimals={false} />
              <Tooltip contentStyle={{ background: "#1a2233", border: "1px solid rgba(255,255,255,.1)", borderRadius: 8, fontSize: 12 }} />
              <Line type="monotone" dataKey="output" name="产出" stroke="var(--accent)" strokeWidth={2} dot={{ r: 3, fill: "var(--accent)" }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

// ── Sub Components ────────────────────────────────────────

function KpiCard({ label, value, color, accent }: { label: string; value: string | number; color?: string; accent?: boolean }) {
  return (
    <div className="todayKpiCard">
      <div className="todayKpiLabel">{label}</div>
      <div className="todayKpiValue" style={{ color: color ?? (accent ? "var(--accent)" : undefined) }}>{value}</div>
    </div>
  );
}

function AIActionCard({ action }: { action: AIAction }) {
  const urgencyClass = `todayAiCard--${action.urgency}`;
  return (
    <div className={`todayAiCard ${urgencyClass}`}>
      <div className="todayAiCardTop">
        <span className={`todayAiUrgency todayAiUrgency--${action.urgency}`}>
          {action.urgency === "critical" ? "紧急" : action.urgency === "high" ? "重要" : action.urgency === "medium" ? "建议" : "提示"}
        </span>
        <span className="todayAiConfidence">{Math.round(action.confidence * 100)}%</span>
      </div>
      <div className="todayAiSummary">{action.summary}</div>
      <div className="todayAiImpact">{action.impact}</div>
    </div>
  );
}

function RiskyOrderRow({ order }: { order: RiskyOrder }) {
  const riskClass = order.risk === "overdue" ? "todayRisk--overdue"
    : order.risk === "critical" ? "todayRisk--critical"
    : "todayRisk--warning";

  return (
    <div className={`todayOrderRow ${riskClass}`}>
      <div className="todayOrderLeft">
        <span className="todayOrderId">{order.order_id ?? order.allocation_id.slice(0, 8)}</span>
        <span className="todayOrderMeta">{order.factory_name} | {order.qty}件</span>
      </div>
      <div className="todayOrderRight">
        <span className={`todayOrderDays ${riskClass}`}>
          {order.days_left < 0 ? `逾期${Math.abs(order.days_left)}天` : `剩${order.days_left}天`}
        </span>
      </div>
    </div>
  );
}
