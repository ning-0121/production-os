import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchBottlenecks, runForecasts } from "../../services/api";
import { useToast } from "../Toast";

export function ForecastSection() {
  const { toast } = useToast();
  const { data: bottlenecks, loading } = useAsync(() => fetchBottlenecks(14), []);
  const [running, setRunning] = React.useState(false);

  async function handleRunForecast() {
    setRunning(true);
    try {
      const result = await runForecasts();
      toast(`预测完成：${result.capacity_risks} 产能风险，${result.late_orders} 预计延期，${result.bottleneck_days} 瓶颈天`, "info");
    } catch {
      toast("预测运行失败", "error");
    } finally {
      setRunning(false);
    }
  }

  const items = (bottlenecks ?? []).slice(0, 8);

  return (
    <div className="card todaySection">
      <div className="cardHeader">
        <div>
          <h2>未来 14 天预警</h2>
          <div className="hint">AI 瓶颈预测</div>
        </div>
        <button className="btn" onClick={handleRunForecast} disabled={running} style={{ fontSize: 11, padding: "3px 8px" }}>
          {running ? "计算中..." : "运行预测"}
        </button>
      </div>
      <div className="todayList">
        {loading && <div className="loadingCenter" style={{ padding: 16 }}>加载中...</div>}
        {!loading && items.length === 0 && <div className="emptyState" style={{ padding: 16 }}>未来 14 天暂无瓶颈预警</div>}
        {items.map((b: Record<string, unknown>, i: number) => {
          const ctx = (b.context ?? {}) as Record<string, unknown>;
          return (
            <div key={i} className="todayOrderRow todayRisk--warning">
              <div className="todayOrderLeft">
                <span className="todayOrderId">{String(ctx.factory_name ?? "—")}</span>
                <span className="todayOrderMeta">{String(b.forecast_date ?? "")} | {String(ctx.scheduled_orders ?? 0)} 个并发订单</span>
              </div>
              <div className="todayOrderRight">
                <span className="todayOrderDays todayRisk--warning">负载 {String(ctx.load_pct ?? 0)}%</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
