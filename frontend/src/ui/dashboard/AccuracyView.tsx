import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { request } from "../../services/client";

type AccuracyRow = {
  factory_id: string;
  factory_name: string;
  completions: number;
  avg_daily_output: number;
  avg_delay_days: number;
  avg_efficiency: number;
  on_time_rate: number;
};

type AccuracyData = {
  factories: AccuracyRow[];
  total_completed: number;
};

export function AccuracyView() {
  const { data, loading, error } = useAsync(
    () => request<AccuracyData>("/dashboard/accuracy"),
    [],
  );

  if (loading) return <div className="loadingCenter">加载中...</div>;
  if (error) return <div style={{ padding: 24, color: "var(--danger)" }}>加载失败: {error}</div>;
  if (!data || data.factories.length === 0) {
    return <div className="emptyState">暂无完成订单数据，完成订单后系统将自动生成准确性分析</div>;
  }

  return (
    <div className="card">
      <div className="cardHeader">
        <div>
          <h2>计划 vs 实际</h2>
          <div className="hint">基于 {data.total_completed} 个已完成订单的工厂表现</div>
        </div>
      </div>
      <div className="accuracyTable">
        <table>
          <thead>
            <tr>
              <th>工厂</th>
              <th>完成订单</th>
              <th>日均产出</th>
              <th>平均延误(天)</th>
              <th>效率</th>
              <th>准时率</th>
            </tr>
          </thead>
          <tbody>
            {data.factories.map((f) => (
              <tr key={f.factory_id}>
                <td className="accName">{f.factory_name}</td>
                <td>{f.completions}</td>
                <td>{f.avg_daily_output}</td>
                <td>
                  <span style={{ color: f.avg_delay_days <= 0 ? "#22c55e" : f.avg_delay_days <= 2 ? "#facc15" : "#fb7185" }}>
                    {f.avg_delay_days > 0 ? `+${f.avg_delay_days}` : f.avg_delay_days}
                  </span>
                </td>
                <td>
                  <div className="accBar">
                    <div className="accBarFill" style={{ width: `${Math.min(100, f.avg_efficiency)}%`, background: f.avg_efficiency >= 90 ? "#22c55e" : f.avg_efficiency >= 70 ? "#facc15" : "#fb7185" }} />
                    <span className="accBarLabel">{f.avg_efficiency}%</span>
                  </div>
                </td>
                <td>
                  <div className="accBar">
                    <div className="accBarFill" style={{ width: `${f.on_time_rate}%`, background: f.on_time_rate >= 90 ? "#22c55e" : f.on_time_rate >= 70 ? "#facc15" : "#fb7185" }} />
                    <span className="accBarLabel">{f.on_time_rate}%</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
