import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchDailyReports, fetchOrderCorrections } from "../../services/api";
import type { Allocation, LineSchedule, OrderCorrection } from "../../types";

type Props = {
  allocation: Allocation;
  frontSchedule?: LineSchedule | null;
  backSchedule?: LineSchedule | null;
  onClose: () => void;
};

export function OrderDetailDrawer({ allocation, frontSchedule, backSchedule, onClose }: Props) {
  const { data: reports } = useAsync(
    () => fetchDailyReports({ factory_id: allocation.factory_id }),
    [allocation.id],
  );
  const { data: corrections } = useAsync(
    () => fetchOrderCorrections(allocation.id),
    [allocation.id],
  );

  // Filter reports for this allocation
  const orderReports = React.useMemo(() => {
    if (!reports) return [];
    return reports.filter(
      (r) => r.allocation_id === allocation.id || r.order_id === allocation.order_id,
    );
  }, [reports, allocation]);

  // Compute progress
  const totalQty = allocation.allocated_qty || 1;
  const actualOutput = orderReports.reduce((sum, r) => sum + r.actual_output, 0);
  const progressPct = Math.min(100, Math.round((actualOutput / totalQty) * 100));

  // Abnormal reports
  const abnormals = orderReports.filter((r) => r.is_abnormal);

  // Latest correction with AI recommendations
  const latestCorrection: OrderCorrection | null = corrections && corrections.length > 0
    ? (corrections as unknown as OrderCorrection[]).sort(
        (a, b) => b.date.localeCompare(a.date),
      )[0]
    : null;

  const deviationPct = latestCorrection?.deviation_pct ?? 0;
  const deviationClass = Math.abs(deviationPct) <= 5
    ? "drawerDeviation--good"
    : Math.abs(deviationPct) <= 15
      ? "drawerDeviation--warn"
      : "drawerDeviation--bad";

  const progressColor = progressPct >= 80
    ? "#22c55e"
    : progressPct >= 50
      ? "#facc15"
      : "var(--danger)";

  return (
    <div className="orderDrawer" onClick={(e) => e.stopPropagation()}>
      <div className="orderDrawerHeader">
        <div>
          <h3>{allocation.order_id ?? allocation.id.slice(0, 8)}</h3>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
            {allocation.factories?.name ?? "未分配"} | {allocation.allocated_qty} 件
          </div>
        </div>
        <button className="orderDrawerClose" onClick={onClose}>x</button>
      </div>

      {/* Progress */}
      <div className="drawerSection">
        <div className="drawerSectionTitle">生产进度</div>
        <div className="drawerProgress">
          <div
            className="drawerProgressFill"
            style={{ width: `${progressPct}%`, background: progressColor }}
          />
        </div>
        <div className="drawerProgressLabel">
          <span>实际 {actualOutput} / 计划 {totalQty}</span>
          <span>{progressPct}%</span>
        </div>
      </div>

      {/* Plan vs Actual */}
      <div className="drawerSection">
        <div className="drawerSectionTitle">计划 vs 实际</div>
        <div className="kv">
          <div>计划开始</div>
          <div>{allocation.planned_start_date}</div>
          <div>计划结束</div>
          <div>{allocation.planned_end_date}</div>
          {frontSchedule && (
            <>
              <div>前道</div>
              <div>{frontSchedule.start_date} ~ {frontSchedule.end_date}</div>
            </>
          )}
          {backSchedule && (
            <>
              <div>后道</div>
              <div>{backSchedule.start_date} ~ {backSchedule.end_date}</div>
            </>
          )}
          <div>状态</div>
          <div>{STATUS_LABELS[allocation.status] ?? allocation.status}</div>
        </div>
      </div>

      {/* Deviation */}
      {latestCorrection && (
        <div className="drawerSection">
          <div className="drawerSectionTitle">偏差分析</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span className={`drawerDeviation ${deviationClass}`}>
              {deviationPct > 0 ? "+" : ""}{deviationPct.toFixed(1)}%
            </span>
            <span style={{ fontSize: 12, color: "var(--muted)" }}>
              预计完成: {latestCorrection.estimated_end_date}
            </span>
          </div>
        </div>
      )}

      {/* Abnormal reasons */}
      {abnormals.length > 0 && (
        <div className="drawerSection">
          <div className="drawerSectionTitle">异常记录 ({abnormals.length})</div>
          {abnormals.slice(0, 5).map((r) => (
            <div key={r.id} className="drawerAbnormal">
              <strong>{r.date}</strong>: {r.abnormal_reason ?? "原因未填写"}
              {r.note && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{r.note}</div>}
            </div>
          ))}
        </div>
      )}

      {/* AI Recommendations */}
      {latestCorrection && latestCorrection.recommendations.length > 0 && (
        <div className="drawerSection">
          <div className="drawerSectionTitle">AI 建议</div>
          {latestCorrection.recommendations.map((rec, i) => (
            <div key={i} className="drawerRecommendation">
              {rec.message}
            </div>
          ))}
        </div>
      )}

      {/* Action Buttons */}
      <div className="drawerActions">
        <button className="btn primary">调整排期</button>
        <button className="btn">拆分订单</button>
        <button className="btn">协商交期</button>
      </div>
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  planned: "待排产",
  confirmed: "已排产",
  in_progress: "生产中",
  completed: "已完成",
  cancelled: "已取消",
};
