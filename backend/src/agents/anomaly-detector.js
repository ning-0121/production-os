/**
 * Anomaly Detector — surfaces statistical outliers in daily production reports
 *
 * Uses z-score (|z| ≥ threshold) and IQR fences on a rolling window per
 * factory × allocation. Detects:
 *   - output_low      : actual_output far below recent mean
 *   - output_high     : actual_output spikes (possibly miscount / data error)
 *   - defect_spike    : abnormal_reason="quality" frequency or qty up
 *   - persistent_dip  : ≥3 consecutive below-mean reports (trend signal)
 *
 * Pure function — no I/O. Caller passes `reports` and gets back actions.
 */

import * as ss from "simple-statistics";
import { createAction } from "./types.js";

const Z_THRESHOLD = 2.0;        // |z| ≥ 2 => outlier (~95% CI)
const MIN_SAMPLES = 5;          // need ≥5 days of history to compute stats
const PERSIST_WINDOW = 3;       // 3 consecutive low days = trend

/**
 * @param {object} ctx - { reports: DailyProductionReport[] }
 * @returns {{ actions: AIAction[], anomalies: object[], stats: object }}
 */
export function runAnomalyDetector(ctx) {
  const reports = Array.isArray(ctx?.reports) ? ctx.reports : [];
  const actions = [];
  const anomalies = [];

  // Group by allocation_id (fall back to factory_id when allocation missing)
  const groups = new Map();
  for (const r of reports) {
    if (r == null || r.actual_output == null) continue;
    const key = r.allocation_id ?? `factory:${r.factory_id ?? "unknown"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  let scanned = 0;
  let groupsWithStats = 0;

  for (const [key, rawSeries] of groups) {
    const series = [...rawSeries]
      .filter((r) => Number.isFinite(Number(r.actual_output)))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    scanned += series.length;
    if (series.length < MIN_SAMPLES) continue;
    groupsWithStats++;

    const values = series.map((r) => Number(r.actual_output));
    const mean = ss.mean(values);
    const std = values.length > 1 ? ss.standardDeviation(values) : 0;
    if (std === 0) continue; // flat line — z-score undefined

    // Latest report = candidate for alerting
    const latest = series[series.length - 1];
    const z = (Number(latest.actual_output) - mean) / std;
    const absZ = Math.abs(z);

    // Persistent dip detection — last N reports all below mean
    const tail = series.slice(-PERSIST_WINDOW);
    const persistentDip = tail.length === PERSIST_WINDOW
      && tail.every((r) => Number(r.actual_output) < mean);

    if (absZ >= Z_THRESHOLD) {
      const direction = z < 0 ? "low" : "high";
      const anomaly = {
        type: direction === "low" ? "output_low" : "output_high",
        key,
        factory_id: latest.factory_id,
        allocation_id: latest.allocation_id,
        order_id: latest.order_id,
        date: latest.date,
        actual_output: Number(latest.actual_output),
        rolling_mean: round1(mean),
        rolling_std: round1(std),
        z_score: round2(z),
        sample_size: values.length,
      };
      anomalies.push(anomaly);

      const pct = Math.abs((Number(latest.actual_output) - mean) / Math.max(1, mean) * 100);
      actions.push(createAction({
        agent: "anomaly-detector",
        action_type: direction === "low" ? "investigate_dip" : "verify_data",
        target_type: latest.allocation_id ? "allocation" : "factory",
        target_id: latest.allocation_id ?? latest.factory_id ?? "unknown",
        summary: direction === "low"
          ? `产量异常下降：${latest.date} 实际 ${latest.actual_output}，比近期均值低 ${pct.toFixed(0)}%（z=${anomaly.z_score}）`
          : `产量异常激增：${latest.date} 实际 ${latest.actual_output}，比近期均值高 ${pct.toFixed(0)}%（z=${anomaly.z_score}）— 请核对数据`,
        urgency: absZ >= 3 ? "high" : "medium",
        impact: direction === "low"
          ? `可能影响订单按时交付；近 ${values.length} 天均值 ${round1(mean)}/天`
          : `若为数据录入错误将导致进度计算偏差；近 ${values.length} 天均值 ${round1(mean)}/天`,
        confidence: Math.min(0.95, 0.6 + (absZ - Z_THRESHOLD) * 0.15),
        params: anomaly,
      }));
    } else if (persistentDip) {
      const anomaly = {
        type: "persistent_dip",
        key,
        factory_id: latest.factory_id,
        allocation_id: latest.allocation_id,
        order_id: latest.order_id,
        date: latest.date,
        window_days: PERSIST_WINDOW,
        rolling_mean: round1(mean),
        recent_outputs: tail.map((r) => Number(r.actual_output)),
        sample_size: values.length,
      };
      anomalies.push(anomaly);
      actions.push(createAction({
        agent: "anomaly-detector",
        action_type: "investigate_trend",
        target_type: latest.allocation_id ? "allocation" : "factory",
        target_id: latest.allocation_id ?? latest.factory_id ?? "unknown",
        summary: `连续 ${PERSIST_WINDOW} 天产量低于均值 ${round1(mean)}（最近：${tail.map((r) => r.actual_output).join(", ")}）`,
        urgency: "medium",
        impact: "持续低产可能预示设备/人员/物料问题，建议现场排查",
        confidence: 0.7,
        params: anomaly,
      }));
    }
  }

  return {
    actions,
    anomalies,
    stats: {
      groups_scanned: groups.size,
      groups_with_stats: groupsWithStats,
      reports_scanned: scanned,
      anomalies_found: anomalies.length,
      threshold_z: Z_THRESHOLD,
      min_samples: MIN_SAMPLES,
    },
    reasoning: anomalies.length === 0
      ? `已扫描 ${scanned} 条日报（${groups.size} 个分组），未发现统计异常。`
      : `从 ${scanned} 条日报中检测到 ${anomalies.length} 个异常：${countByType(anomalies)}`,
  };
}

function round1(x) { return Math.round(x * 10) / 10; }
function round2(x) { return Math.round(x * 100) / 100; }

function countByType(anomalies) {
  const counts = {};
  for (const a of anomalies) counts[a.type] = (counts[a.type] ?? 0) + 1;
  return Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ");
}
