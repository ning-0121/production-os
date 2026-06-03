import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchWatchlist } from "../../services/api";
import { RiskPill, legacyAssessment } from "../shared/RiskPill";

export function WatchlistSection() {
  const { data: items, loading } = useAsync(() => fetchWatchlist(), []);
  const active = (items ?? []).filter((w) => w.status === "active");

  if (!loading && active.length === 0) return null;

  return (
    <div className="card todaySection">
      <div className="cardHeader">
        <h2>监控列表</h2>
        <span className="hint">{active.length} 项待处理</span>
      </div>
      <div className="todayList">
        {loading && <div className="loadingCenter" style={{ padding: 16 }}>加载中...</div>}
        {active.map((w) => {
          // Urgency → canonical level: imminent escalation = critical, else warn.
          const isUrgent = w.escalation_deadline && new Date(w.escalation_deadline) < new Date(Date.now() + 6 * 3600000);
          const assessment = legacyAssessment(
            isUrgent ? "critical" : "warn",
            w.entity_type === "order" ? "order" : "factory",
            w.entity_id,
          );
          return (
            <div key={w.id} className="todayOrderRow">
              <div className="todayOrderLeft">
                <span className="todayOrderId">{w.entity_type === "order" ? "订单" : "工厂"} {w.entity_id.slice(0, 8)}</span>
                <span className="todayOrderMeta">{w.reason}</span>
              </div>
              <div className="todayOrderRiskCol">
                <RiskPill assessment={assessment} compact />
              </div>
              {w.escalation_deadline && (
                <div className="todayOrderRight">
                  <span className={`todayOrderDays todayOrderDays--${assessment?.level ?? "ok"}`}>
                    {isUrgent ? "即将升级" : new Date(w.escalation_deadline).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", hour: "numeric" })}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
