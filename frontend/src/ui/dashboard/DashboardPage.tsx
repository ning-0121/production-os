import React from "react";
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import * as XLSX from "xlsx";
import { useAsync } from "../../hooks/useAsync";
import { request } from "../../services/client";
import { useToast } from "../Toast";
import { AccuracyView } from "./AccuracyView";
import { LEVEL_LABEL, LEVEL_COLOR, COLOR_HEX, legacyToLevel } from "../shared/riskColors";
import "./dashboard.css";

type DashboardStats = {
  kpi: {
    total_orders: number;
    total_quantity: number;
    in_production: number;
    completed: number;
    completion_rate: number;
    on_time_rate: number;
    avg_delay_days: number;
  };
  status_distribution: Record<string, number>;
  risk_distribution: { HIGH: number; MEDIUM: number; SAFE: number };
  factory_utilization: Array<{
    factory_id: string;
    name: string;
    daily_capacity: number;
    current_load: number;
    utilization_pct: number;
  }>;
  completion_trend: Array<{ date: string; count: number }>;
  product_breakdown: Array<{ product_type: string; quantity: number }>;
};

const STATUS_COLORS: Record<string, string> = {
  planned: "#6ee7ff",
  confirmed: "#a78bfa",
  in_progress: "#facc15",
  completed: "#22c55e",
  cancelled: "#64748b",
};

const STATUS_LABELS: Record<string, string> = {
  planned: "待排产",
  confirmed: "已排产",
  in_progress: "生产中",
  completed: "已完成",
  cancelled: "已取消",
};

export function DashboardPage() {
  const { data, loading, error } = useAsync(
    () => request<DashboardStats>("/dashboard/stats"),
    [],
  );
  const [showAccuracy, setShowAccuracy] = React.useState(false);
  const { toast } = useToast();

  function handleExport() {
    if (!data) return;
    try {
      const wb = XLSX.utils.book_new();

      // KPI sheet
      const kpiRows = [
        ["指标", "值"],
        ["总订单数", data.kpi.total_orders],
        ["总数量", data.kpi.total_quantity],
        ["在产数", data.kpi.in_production],
        ["已完成", data.kpi.completed],
        ["完成率", `${data.kpi.completion_rate}%`],
        ["准时率", `${data.kpi.on_time_rate}%`],
        ["平均延误(天)", data.kpi.avg_delay_days],
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(kpiRows), "KPI");

      // Factory utilization sheet
      const utilRows = [["工厂", "日产能", "当前负载", "利用率(%)"], ...data.factory_utilization.map((f) => [f.name, f.daily_capacity, f.current_load, f.utilization_pct])];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(utilRows), "工厂利用率");

      // Trend sheet
      const trendRows = [["日期", "完成数"], ...data.completion_trend.map((t) => [t.date, t.count])];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(trendRows), "完成趋势");

      XLSX.writeFile(wb, `production-report-${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast("报表已导出", "success");
    } catch {
      toast("导出失败", "error");
    }
  }

  if (loading) return <div className="card"><div className="loadingCenter">加载中...</div></div>;
  if (error) return <div className="card"><div style={{ padding: 24, color: "var(--danger)" }}>加载失败: {error}</div></div>;
  if (!data) return null;

  const statusData = Object.entries(data.status_distribution)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => ({ name: STATUS_LABELS[k] ?? k, value: v, fill: STATUS_COLORS[k] ?? "#888" }));

  // Risk distribution buckets come from the backend keyed by legacy enums
  // (HIGH/MEDIUM/SAFE). Translate to canonical level for label + color so the
  // pie matches risk display everywhere else.
  const riskData = Object.entries(data.risk_distribution)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => {
      const level = legacyToLevel(k) ?? "ok";
      return { name: LEVEL_LABEL[level], value: v, fill: COLOR_HEX[LEVEL_COLOR[level]].fg };
    });

  return (
    <div className="dashContainer">
      {/* KPI Cards */}
      <div className="kpiRow">
        <KpiCard label="总订单" value={data.kpi.total_orders} />
        <KpiCard label="总数量" value={data.kpi.total_quantity.toLocaleString()} />
        <KpiCard label="在产" value={data.kpi.in_production} accent />
        <KpiCard label="完成率" value={`${data.kpi.completion_rate}%`} color={data.kpi.completion_rate >= 80 ? "#22c55e" : "#facc15"} />
        <KpiCard label="准时率" value={`${data.kpi.on_time_rate}%`} color={data.kpi.on_time_rate >= 90 ? "#22c55e" : data.kpi.on_time_rate >= 70 ? "#facc15" : "#fb7185"} />
        <KpiCard label="平均延误" value={`${data.kpi.avg_delay_days}天`} color={data.kpi.avg_delay_days <= 1 ? "#22c55e" : "#fb7185"} />
      </div>

      {/* Action Bar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, justifyContent: "flex-end" }}>
        <button className="btn" onClick={() => setShowAccuracy(!showAccuracy)}>
          {showAccuracy ? "返回概览" : "计划vs实际"}
        </button>
        <button className="btn primary" onClick={handleExport}>导出报表</button>
      </div>

      {showAccuracy ? (
        <AccuracyView />
      ) : (
        <>
          {/* Charts Row 1: Utilization + Risk */}
          <div className="dashGrid">
            <div className="card">
              <div className="cardHeader">
                <h2>工厂产能利用率</h2>
              </div>
              <div className="chartWrap">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={data.factory_utilization} margin={{ top: 16, right: 16, bottom: 4, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
                    <XAxis dataKey="name" tick={{ fill: "rgba(255,255,255,.5)", fontSize: 11 }} />
                    <YAxis tick={{ fill: "rgba(255,255,255,.5)", fontSize: 11 }} domain={[0, 100]} unit="%" />
                    <Tooltip
                      contentStyle={{ background: "#1a2233", border: "1px solid rgba(255,255,255,.1)", borderRadius: 8, fontSize: 12 }}
                      labelStyle={{ color: "rgba(255,255,255,.7)" }}
                    />
                    <Bar dataKey="utilization_pct" name="利用率(%)" radius={[4, 4, 0, 0]}>
                      {data.factory_utilization.map((entry) => (
                        <Cell
                          key={entry.factory_id}
                          fill={entry.utilization_pct > 85 ? "#fb7185" : entry.utilization_pct > 60 ? "#facc15" : "#6ee7ff"}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="card">
              <div className="cardHeader">
                <h2>风险分布</h2>
              </div>
              <div className="chartWrap" style={{ display: "flex", gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <ResponsiveContainer width="100%" height={240}>
                    <PieChart>
                      <Pie
                        data={riskData}
                        cx="50%"
                        cy="50%"
                        innerRadius={55}
                        outerRadius={85}
                        dataKey="value"
                        label={({ name, value }) => `${name}: ${value}`}
                        labelLine={false}
                      >
                        {riskData.map((entry, i) => (
                          <Cell key={i} fill={entry.fill} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ flex: 1 }}>
                  <ResponsiveContainer width="100%" height={240}>
                    <PieChart>
                      <Pie
                        data={statusData}
                        cx="50%"
                        cy="50%"
                        innerRadius={55}
                        outerRadius={85}
                        dataKey="value"
                        label={({ name, value }) => `${name}: ${value}`}
                        labelLine={false}
                      >
                        {statusData.map((entry, i) => (
                          <Cell key={i} fill={entry.fill} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </div>

          {/* Charts Row 2: Trend */}
          <div className="card" style={{ marginTop: 12 }}>
            <div className="cardHeader">
              <h2>近30天完成趋势</h2>
            </div>
            <div className="chartWrap">
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={data.completion_trend} margin={{ top: 16, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "rgba(255,255,255,.5)", fontSize: 10 }}
                    tickFormatter={(v: string) => v.slice(5)}
                  />
                  <YAxis tick={{ fill: "rgba(255,255,255,.5)", fontSize: 11 }} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ background: "#1a2233", border: "1px solid rgba(255,255,255,.1)", borderRadius: 8, fontSize: 12 }}
                  />
                  <Line type="monotone" dataKey="count" name="完成数" stroke="#22c55e" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Product Breakdown */}
          {data.product_breakdown.length > 0 && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="cardHeader">
                <h2>订单分布</h2>
              </div>
              <div className="chartWrap">
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={data.product_breakdown.slice(0, 10)} layout="vertical" margin={{ top: 8, right: 16, bottom: 4, left: 80 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
                    <XAxis type="number" tick={{ fill: "rgba(255,255,255,.5)", fontSize: 11 }} />
                    <YAxis type="category" dataKey="product_type" tick={{ fill: "rgba(255,255,255,.5)", fontSize: 11 }} width={80} />
                    <Tooltip contentStyle={{ background: "#1a2233", border: "1px solid rgba(255,255,255,.1)", borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="quantity" name="数量" fill="#a78bfa" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── KPI Card ────────────────────────────────────────────

function KpiCard({ label, value, color, accent }: { label: string; value: string | number; color?: string; accent?: boolean }) {
  return (
    <div className="kpiCard">
      <div className="kpiLabel">{label}</div>
      <div className="kpiValue" style={{ color: color ?? (accent ? "var(--accent)" : undefined) }}>
        {value}
      </div>
    </div>
  );
}
