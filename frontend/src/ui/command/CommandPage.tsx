import React from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { useAsync } from "../../hooks/useAsync";
import { fetchCommandOverview, fetchExceptions } from "../../services/api";
import type { CommandOverview, ExceptionItem } from "../../types";
import "./command.css";

export function CommandPage() {
  const { data, loading, error } = useAsync(
    () => fetchCommandOverview(),
    [],
  );
  const { data: exceptions } = useAsync(
    () => fetchExceptions(),
    [],
  );

  if (loading) {
    return <div className="card"><div className="loadingCenter">加载中...</div></div>;
  }
  if (error) {
    return <div className="card"><div style={{ padding: 24, color: "var(--danger)" }}>加载失败: {error}</div></div>;
  }
  if (!data) return null;

  const kpi = data.kpi ?? { active_orders: 0, today_output: 0, on_time_pct: 0, abnormal_count: 0 };
  const factoryStatus = Array.isArray(data.factory_report_status) ? data.factory_report_status : [];
  const trend = Array.isArray(data.recent_trend) ? data.recent_trend : [];
  const topExceptions = Array.isArray(exceptions) ? exceptions.slice(0, 5)
    : Array.isArray(data.top_exceptions) ? data.top_exceptions.slice(0, 5)
    : [];

  return (
    <div className="cmdContainer">
      {/* KPI Cards */}
      <div className="cmdKpiRow">
        <KpiCard label="在产订单" value={kpi.active_orders} accent />
        <KpiCard label="今日产出" value={(kpi.today_output ?? 0).toLocaleString()} />
        <KpiCard
          label="准时率%"
          value={`${kpi.on_time_pct ?? 0}%`}
          color={(kpi.on_time_pct ?? 0) >= 90 ? "#22c55e" : (kpi.on_time_pct ?? 0) >= 70 ? "#facc15" : "#fb7185"}
        />
        <KpiCard
          label="异常数"
          value={kpi.abnormal_count ?? 0}
          color={(kpi.abnormal_count ?? 0) === 0 ? "#22c55e" : "#fb7185"}
        />
      </div>

      {/* Exceptions + Factory Status */}
      <div className="cmdGrid">
        {/* Top Exceptions */}
        <div className="card">
          <div className="cardHeader">
            <h2>异常预警 TOP5</h2>
            <span className="hint">{topExceptions.length} 条</span>
          </div>
          <div className="cmdExceptionList">
            {topExceptions.length === 0 && (
              <div className="emptyState">暂无异常</div>
            )}
            {topExceptions.map((ex, i) => (
              <ExceptionRow key={i} item={ex} />
            ))}
          </div>
        </div>

        {/* Factory Report Status */}
        <div className="card">
          <div className="cardHeader">
            <h2>工厂报工状态</h2>
            <span className="hint">
              {factoryStatus.filter((f) => f.reported).length}/{factoryStatus.length} 已报
            </span>
          </div>
          <div className="cmdFactoryList">
            {factoryStatus.length === 0 && (
              <div className="emptyState">暂无工厂数据</div>
            )}
            {factoryStatus.map((f) => (
              <div key={f.factory_id} className="cmdFactoryStatus">
                <div className={`cmdFactoryDot ${f.reported ? "cmdFactoryDot--ok" : "cmdFactoryDot--miss"}`} />
                <span className="cmdFactoryName">{f.name}</span>
                <span className={`cmdFactoryLabel ${f.reported ? "cmdFactoryLabel--ok" : "cmdFactoryLabel--miss"}`}>
                  {f.reported ? "已报工" : "未报工"}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 7-day Output Trend */}
      <div className="card">
        <div className="cardHeader">
          <h2>近7天产出趋势</h2>
        </div>
        <div className="cmdTrendWrap">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={trend} margin={{ top: 16, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
              <XAxis
                dataKey="date"
                tick={{ fill: "rgba(255,255,255,.5)", fontSize: 11 }}
                tickFormatter={(v: string) => v.slice(5)}
              />
              <YAxis tick={{ fill: "rgba(255,255,255,.5)", fontSize: 11 }} allowDecimals={false} />
              <Tooltip
                contentStyle={{
                  background: "#1a2233",
                  border: "1px solid rgba(255,255,255,.1)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Line
                type="monotone"
                dataKey="output"
                name="产出"
                stroke="var(--accent)"
                strokeWidth={2}
                dot={{ r: 3, fill: "var(--accent)" }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

// ── KPI Card ─────────────────────────────────────────────

function KpiCard({ label, value, color, accent }: {
  label: string;
  value: string | number;
  color?: string;
  accent?: boolean;
}) {
  return (
    <div className="kpiCard">
      <div className="kpiLabel">{label}</div>
      <div
        className="kpiValue"
        style={{ color: color ?? (accent ? "var(--accent)" : undefined) }}
      >
        {value}
      </div>
    </div>
  );
}

// ── Exception Row ────────────────────────────────────────

function ExceptionRow({ item }: { item: ExceptionItem }) {
  const SEVERITY_LABELS: Record<string, string> = {
    high: "严重",
    medium: "警告",
    low: "提示",
  };
  const TYPE_LABELS: Record<string, string> = {
    delayed: "延期",
    at_risk: "风险",
    overloaded: "超载",
    underperforming: "低效",
    unreported: "缺报",
    unschedulable: "排产异常",
  };

  return (
    <div className={`cmdException cmdException--${item.severity}`}>
      <span className={`cmdExceptionType cmdExceptionType--${item.severity}`}>
        {SEVERITY_LABELS[item.severity] ?? item.severity}
      </span>
      <div className="cmdExceptionBody">
        <div className="cmdExceptionMsg">{item.message}</div>
        <div className="cmdExceptionMeta">
          {item.order_id && <span>{item.order_id}</span>}
          {item.factory_name && <span> | {item.factory_name}</span>}
          {item.line_name && <span> | {item.line_name}</span>}
          {!item.order_id && !item.factory_name && (
            <span>{TYPE_LABELS[item.type] ?? item.type}</span>
          )}
        </div>
      </div>
    </div>
  );
}
