/**
 * Progress Correction Agent
 *
 * Analyzes daily report data to detect deviations from plan,
 * generates corrective actions and schedule adjustments.
 *
 * Uses existing: correction.js
 */

import { createAction } from "./types.js";
import { runAnomalyDetector } from "./anomaly-detector.js";

/**
 * Run progress correction analysis.
 *
 * Combines two signals:
 *   1. Plan deviation (from order_corrections.risk_status)
 *   2. Statistical anomaly (z-score on daily reports)
 *
 * Fusion rules:
 *   - Both deviation + anomaly on same allocation → boost confidence (agreement)
 *   - Anomaly only (allocation still nominally on_track) → emit "early warning"
 *   - output_high anomaly → flag possible data-quality issue (don't escalate plan)
 *
 * @param {object} context - { reports, allocations, corrections, anomalies?, anomalyResult? }
 * @returns {{ actions: AIAction[], reasoning: string, stats: object, anomalies: object[] }}
 */
export function runCorrector(context) {
  const { reports = [], allocations = [], corrections = [] } = context;
  const actions = [];
  const today = new Date().toISOString().slice(0, 10);

  // Statistical signal — caller can pre-compute and pass in, or we compute here
  const anomalyResult = context.anomalyResult
    ?? (context.anomalies ? { anomalies: context.anomalies } : runAnomalyDetector({ reports }));
  const anomalies = anomalyResult.anomalies ?? [];

  // Index anomalies by allocation_id for fast lookup during fusion
  const anomalyByAlloc = new Map();
  for (const a of anomalies) {
    if (!a.allocation_id) continue;
    if (!anomalyByAlloc.has(a.allocation_id)) anomalyByAlloc.set(a.allocation_id, []);
    anomalyByAlloc.get(a.allocation_id).push(a);
  }
  const allocsWithDeviationActions = new Set();

  // Build allocation lookup
  const allocMap = new Map();
  for (const a of allocations) allocMap.set(a.id, a);

  // Analyze corrections for active orders
  let onTrack = 0;
  let fallingBehind = 0;
  let critical = 0;

  for (const corr of corrections) {
    const alloc = allocMap.get(corr.allocation_id);
    if (!alloc || alloc.status === "completed" || alloc.status === "cancelled") continue;

    // Does a statistical anomaly corroborate this deviation?
    const matching = anomalyByAlloc.get(corr.allocation_id) ?? [];
    const dipAnomaly = matching.find((a) => a.type === "output_low" || a.type === "persistent_dip");
    const agreed = !!dipAnomaly;
    const confBoost = agreed ? 0.1 : 0;
    const agreedNote = agreed
      ? `（统计验证：${dipAnomaly.type === "output_low" ? `产量骤降 z=${dipAnomaly.z_score}` : `连续 ${dipAnomaly.window_days ?? 3} 天低产`}）`
      : "";

    if (corr.risk_status === "on_track") {
      onTrack++;
    } else if (corr.risk_status === "falling_behind") {
      fallingBehind++;
      allocsWithDeviationActions.add(corr.allocation_id);
      actions.push(createAction({
        agent: "corrector",
        action_type: "adjust_plan",
        target_type: "order",
        target_id: corr.allocation_id,
        summary: `订单 ${corr.order_id ?? corr.allocation_id.slice(0, 8)} 进度落后 ${Math.abs(corr.deviation_pct)}%，建议调整排期或加班${agreedNote}`,
        urgency: "high",
        impact: `按当前进度预计完成日期延至 ${corr.estimated_end_date}`,
        confidence: Math.min(0.98, 0.82 + confBoost),
        params: {
          allocation_id: corr.allocation_id,
          deviation_pct: corr.deviation_pct,
          estimated_end: corr.estimated_end_date,
          current_daily_rate: corr.actual_cumulative > 0
            ? Math.round(corr.actual_cumulative / Math.max(1, daysBetween(alloc.planned_start_date, today)))
            : 0,
          anomaly_corroborated: agreed,
          anomaly_id: dipAnomaly?.id ?? null,
        },
      }));
    } else if (corr.risk_status === "critical") {
      critical++;
      allocsWithDeviationActions.add(corr.allocation_id);
      actions.push(createAction({
        agent: "corrector",
        action_type: "reschedule",
        target_type: "order",
        target_id: corr.allocation_id,
        summary: `订单 ${corr.order_id ?? corr.allocation_id.slice(0, 8)} 严重偏离计划 (${corr.deviation_pct}%)，需立即介入${agreedNote}`,
        urgency: "critical",
        impact: `延期风险极高，建议拆单或转厂处理`,
        confidence: Math.min(0.99, 0.9 + confBoost),
        params: {
          allocation_id: corr.allocation_id,
          deviation_pct: corr.deviation_pct,
          estimated_end: corr.estimated_end_date,
          anomaly_corroborated: agreed,
          anomaly_id: dipAnomaly?.id ?? null,
        },
      }));
    }
  }

  // ── Anomaly-only fusion: emit early-warning + data-quality flags ─────
  let earlyWarnings = 0;
  let dataQualityFlags = 0;
  for (const a of anomalies) {
    const targetId = a.allocation_id ?? a.factory_id;
    if (!targetId) continue;

    if (a.type === "output_high") {
      // Data-quality concern — never escalates schedule
      dataQualityFlags++;
      actions.push(createAction({
        agent: "corrector",
        action_type: "verify_data",
        target_type: "report",
        target_id: targetId,
        summary: `日报数据可疑：${a.date} 产量 ${a.actual_output} 远高于近期均值 ${a.rolling_mean}（z=${a.z_score}）`,
        urgency: a.severity === "critical" ? "high" : "medium",
        impact: `若为录入错误将污染进度计算 — 建议复核日报后再决定是否更新风险状态`,
        confidence: 0.78,
        params: {
          anomaly_id: a.id,
          anomaly_type: a.type,
          suggested_action: "mark_suspicious_review",
          factory_id: a.factory_id,
          allocation_id: a.allocation_id,
          date: a.date,
          actual_output: a.actual_output,
          rolling_mean: a.rolling_mean,
          z_score: a.z_score,
        },
      }));
      continue;
    }

    // output_low / persistent_dip without a matching deviation = early warning
    if (!allocsWithDeviationActions.has(a.allocation_id)) {
      earlyWarnings++;
      actions.push(createAction({
        agent: "corrector",
        action_type: a.type === "persistent_dip" ? "investigate_trend" : "investigate_dip",
        target_type: a.allocation_id ? "allocation" : "factory",
        target_id: targetId,
        summary: a.type === "persistent_dip"
          ? `早期预警：连续 ${a.window_days ?? 3} 天产量低于均值 — 计划尚未触发偏差但趋势恶化`
          : `早期预警：${a.date} 产量骤降（z=${a.z_score}）— 计划尚未触发偏差，建议先观察`,
        urgency: a.type === "persistent_dip" ? "medium" : (a.severity === "critical" ? "high" : "medium"),
        impact: a.type === "persistent_dip"
          ? `持续低产若不干预将在 1-2 天内触发计划偏差 — 建议升级为生产事件`
          : `单日骤降可能是偶发，但需加入观察清单并重算风险`,
        confidence: 0.65,
        params: {
          anomaly_id: a.id,
          anomaly_type: a.type,
          suggested_action: a.routing?.suggested_action,
          factory_id: a.factory_id,
          allocation_id: a.allocation_id,
          date: a.date,
          actual_output: a.actual_output,
          rolling_mean: a.rolling_mean,
          z_score: a.z_score,
          early_warning: true,
        },
      }));
    }
  }

  // Check for orders with no reports at all
  const reportedAllocIds = new Set(reports.map((r) => r.allocation_id).filter(Boolean));
  for (const alloc of allocations) {
    if (alloc.status === "in_progress" && !reportedAllocIds.has(alloc.id)) {
      actions.push(createAction({
        agent: "corrector",
        action_type: "alert",
        target_type: "order",
        target_id: alloc.id,
        summary: `订单 ${alloc.order_id ?? alloc.id.slice(0, 8)} 处于生产中但无日报数据`,
        urgency: "medium",
        impact: `无法评估进度偏差，存在隐性延期风险`,
        confidence: 0.6,
        params: { allocation_id: alloc.id, order_id: alloc.order_id },
      }));
    }
  }

  // Abnormal report analysis
  const todayAbnormals = reports.filter((r) => r.is_abnormal && r.date === today);
  for (const report of todayAbnormals) {
    actions.push(createAction({
      agent: "corrector",
      action_type: "investigate",
      target_type: "order",
      target_id: report.allocation_id ?? report.order_id ?? "unknown",
      summary: `今日异常日报：${report.abnormal_reason ?? "原因未填写"}（产出 ${report.actual_output}）`,
      urgency: "high",
      impact: `异常可能导致后续排产计划连锁延期`,
      confidence: 0.75,
      params: {
        factory_id: report.factory_id,
        actual_output: report.actual_output,
        abnormal_reason: report.abnormal_reason,
      },
    }));
  }

  // Sort by urgency
  const urgencyOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  actions.sort((a, b) => (urgencyOrder[a.urgency] ?? 4) - (urgencyOrder[b.urgency] ?? 4));

  return {
    actions,
    anomalies,
    reasoning: `分析了 ${corrections.length} 条偏差记录、${reports.length} 条日报，发现 ${anomalies.length} 个统计异常，生成 ${actions.length} 条校正建议（早期预警 ${earlyWarnings}，数据可疑 ${dataQualityFlags}）`,
    stats: {
      on_track: onTrack,
      falling_behind: fallingBehind,
      critical,
      total: corrections.length,
      anomalies_found: anomalies.length,
      early_warnings: earlyWarnings,
      data_quality_flags: dataQualityFlags,
    },
  };
}

function daysBetween(dateA, dateB) {
  if (!dateA || !dateB) return 1;
  const a = new Date(dateA).getTime();
  const b = new Date(dateB).getTime();
  return Math.max(1, Math.ceil(Math.abs(b - a) / (1000 * 60 * 60 * 24)));
}
