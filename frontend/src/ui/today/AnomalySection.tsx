/**
 * AnomalySection — surfaces statistical anomalies on the Today page
 *
 * Each alert shows: type, affected order/allocation, severity, reason,
 * and a routed primary action driven by `suggested_action`.
 *
 * The user can also record a verdict (confirmed / data error / material /
 * factory exec / customer change / ignored). Review state is persisted via
 * `reviewAnomaly()` so the same anomaly is suppressed from future briefings.
 */

import React from "react";
import { useToast } from "../Toast";
import { reviewAnomaly } from "../../services/api";
import type { AnomalyAlert, AnomalyReviewReason, AnomalySuggestedAction } from "../../types";

const TYPE_LABEL: Record<AnomalyAlert["type"], string> = {
  output_low: "产量骤降",
  output_high: "数据可疑",
  persistent_dip: "持续低产",
};

const SEVERITY_LABEL: Record<AnomalyAlert["severity"], string> = {
  critical: "紧急",
  high: "重要",
  medium: "建议",
  low: "提示",
};

const ACTION_LABEL: Record<AnomalySuggestedAction, string> = {
  watchlist_and_recalc: "加入观察并重算风险",
  mark_suspicious_review: "标记为可疑日报，请求复核",
  create_incident_or_escalate: "升级为生产事件",
};

const REVIEW_OPTIONS: Array<{ value: AnomalyReviewReason; label: string; tone: "ok" | "warn" | "muted" }> = [
  { value: "confirmed_real_issue", label: "确认是真实问题", tone: "warn" },
  { value: "factory_execution_issue", label: "工厂执行问题", tone: "warn" },
  { value: "material_issue", label: "物料问题", tone: "warn" },
  { value: "customer_change", label: "客户变更导致", tone: "warn" },
  { value: "data_entry_error", label: "数据录入错误", tone: "muted" },
  { value: "ignored", label: "忽略（误报）", tone: "muted" },
];

export function AnomalySection({
  alerts,
  loading,
  error,
  onReviewed,
}: {
  alerts: AnomalyAlert[];
  loading?: boolean;
  error?: string | null;
  onReviewed?: (anomalyId: string, reason: AnomalyReviewReason) => void;
}) {
  if (loading) {
    return (
      <div className="card todaySection todayAnomalySection">
        <div className="cardHeader">
          <h2>统计异常告警</h2>
        </div>
        <div className="loadingCenter" style={{ padding: 24 }}>分析中...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card todaySection todayAnomalySection">
        <div className="cardHeader">
          <h2>统计异常告警</h2>
        </div>
        <div style={{ padding: 16, color: "var(--danger)" }}>加载失败: {error}</div>
      </div>
    );
  }

  return (
    <div className="card todaySection todayAnomalySection">
      <div className="cardHeader">
        <div>
          <h2>统计异常告警</h2>
          <div className="hint">基于 z-score 检测 — 已复核条目自动隐藏</div>
        </div>
        <span className="todayAiBadge">Anomaly Detector</span>
      </div>
      {alerts.length === 0 ? (
        <div className="emptyState">当前无统计异常 — 生产数据稳定</div>
      ) : (
        <div className="todayAnomalyList">
          {alerts.map((alert) => (
            <AnomalyCard key={alert.id} alert={alert} onReviewed={onReviewed} />
          ))}
        </div>
      )}
    </div>
  );
}

function AnomalyCard({
  alert,
  onReviewed,
}: {
  alert: AnomalyAlert;
  onReviewed?: (anomalyId: string, reason: AnomalyReviewReason) => void;
}) {
  const { toast } = useToast();
  const [submitting, setSubmitting] = React.useState<AnomalyReviewReason | null>(null);
  const [reviewed, setReviewed] = React.useState(false);
  const [showReview, setShowReview] = React.useState(false);

  const suggested = alert.suggested_action ?? alert.routing?.suggested_action ?? null;
  const target = alert.order_id ?? alert.allocation_id?.slice(0, 8) ?? alert.factory_name ?? "未知目标";

  async function submit(reason: AnomalyReviewReason) {
    setSubmitting(reason);
    try {
      await reviewAnomaly(alert.id, {
        review_reason: reason,
        snapshot: {
          anomaly_type: alert.type,
          severity: alert.severity,
          factory_id: alert.factory_id,
          allocation_id: alert.allocation_id,
          order_id: alert.order_id,
          report_date: alert.date,
          z_score: alert.z_score,
          rolling_mean: alert.rolling_mean,
          actual_output: alert.actual_output,
        },
      });
      toast(reason === "ignored" ? "已忽略" : "已记录复核结果", "success");
      setReviewed(true);
      onReviewed?.(alert.id, reason);
    } catch (err) {
      toast(`复核保存失败: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setSubmitting(null);
    }
  }

  if (reviewed) return null;

  return (
    <div className={`todayAnomalyCard todayAnomalyCard--${alert.severity}`}>
      <div className="todayAnomalyCardTop">
        <span className={`todayAiUrgency todayAiUrgency--${alert.severity}`}>
          {SEVERITY_LABEL[alert.severity]}
        </span>
        <span className={`todayAnomalyTypeBadge todayAnomalyTypeBadge--${alert.type}`}>
          {TYPE_LABEL[alert.type]}
        </span>
        {alert.z_score != null && (
          <span className="todayAnomalyZ">z = {alert.z_score.toFixed(2)}</span>
        )}
      </div>

      <div className="todayAnomalySummary">
        {alert.action_summary ?? buildFallbackSummary(alert)}
      </div>

      <div className="todayAnomalyMeta">
        <span>目标：{target}</span>
        {alert.factory_name && <span>工厂：{alert.factory_name}</span>}
        <span>样本：{alert.sample_size} 天</span>
      </div>

      {alert.action_impact && (
        <div className="todayAiImpact">{alert.action_impact}</div>
      )}

      {suggested && (
        <div className="todayAnomalySuggested">
          <strong>建议动作：</strong>{ACTION_LABEL[suggested]}
        </div>
      )}

      <div className="todayAiActions todayAnomalyActions">
        {!showReview ? (
          <button className="btn primary" onClick={() => setShowReview(true)}>
            记录复核
          </button>
        ) : (
          <div className="todayAnomalyReviewGrid">
            {REVIEW_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`btn todayAnomalyReviewBtn todayAnomalyReviewBtn--${opt.tone}`}
                disabled={submitting !== null}
                onClick={() => submit(opt.value)}
              >
                {submitting === opt.value ? "保存中..." : opt.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function buildFallbackSummary(alert: AnomalyAlert): string {
  if (alert.type === "output_low") {
    return `${alert.date} 产量 ${alert.actual_output}，远低于近期均值 ${alert.rolling_mean}`;
  }
  if (alert.type === "output_high") {
    return `${alert.date} 产量 ${alert.actual_output}，远高于近期均值 ${alert.rolling_mean} — 数据可疑`;
  }
  return `连续 ${alert.window_days ?? 3} 天产量低于均值 ${alert.rolling_mean}`;
}
