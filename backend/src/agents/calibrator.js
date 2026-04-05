/**
 * Learning/Recalibration Agent
 *
 * Monitors factory performance over time and suggests
 * capacity adjustments based on historical data.
 *
 * Uses existing: calibrate.js, scoring.js
 */

import { createAction } from "./types.js";

/**
 * Run calibration analysis across factories.
 * @param {object} context - { factories, performanceLogs }
 * @returns {{ actions: AIAction[], reasoning: string }}
 */
export function runCalibrator(context) {
  const { factories = [], performanceLogs = [] } = context;
  const actions = [];

  // Group performance logs by factory
  const logsByFactory = new Map();
  for (const log of performanceLogs) {
    if (!logsByFactory.has(log.factory_id)) logsByFactory.set(log.factory_id, []);
    logsByFactory.get(log.factory_id).push(log);
  }

  for (const factory of factories) {
    const logs = logsByFactory.get(factory.id) ?? [];
    if (logs.length < 3) continue; // need at least 3 data points

    // Analyze throughput logs
    const throughputLogs = logs.filter((l) => l.metric_type === "throughput_units");
    if (throughputLogs.length >= 3) {
      const avgThroughput = throughputLogs.reduce((s, l) => s + Number(l.metric_value), 0) / throughputLogs.length;
      const caps = factory.factory_capabilities ?? [];

      for (const cap of caps) {
        const dailyCapacity = Number(cap.daily_capacity ?? cap.base_capacity_units_per_day ?? 0);
        if (dailyCapacity <= 0) continue;

        const ratio = avgThroughput / dailyCapacity;

        if (ratio < 0.7) {
          actions.push(createAction({
            agent: "calibrator",
            action_type: "recalibrate",
            target_type: "factory",
            target_id: factory.id,
            summary: `${factory.name} 实际产出仅为标定产能的 ${Math.round(ratio * 100)}%，建议下调日产能至 ${Math.round(avgThroughput)}`,
            urgency: "medium",
            impact: `产能高估会导致排产计划系统性偏差`,
            confidence: Math.min(0.9, 0.5 + throughputLogs.length * 0.05),
            params: {
              factory_name: factory.name,
              current_capacity: dailyCapacity,
              suggested_capacity: Math.round(avgThroughput),
              data_points: throughputLogs.length,
              product_type: cap.product_type,
            },
          }));
        } else if (ratio > 1.2) {
          actions.push(createAction({
            agent: "calibrator",
            action_type: "recalibrate",
            target_type: "factory",
            target_id: factory.id,
            summary: `${factory.name} 实际产出超过标定 ${Math.round((ratio - 1) * 100)}%，建议上调日产能至 ${Math.round(avgThroughput)}`,
            urgency: "low",
            impact: `产能低估会导致排产偏保守，浪费可用产能`,
            confidence: Math.min(0.85, 0.5 + throughputLogs.length * 0.05),
            params: {
              factory_name: factory.name,
              current_capacity: dailyCapacity,
              suggested_capacity: Math.round(avgThroughput),
              data_points: throughputLogs.length,
            },
          }));
        }
      }
    }

    // Analyze delay patterns
    const delayLogs = logs.filter((l) => l.metric_type === "delay_days");
    if (delayLogs.length >= 3) {
      const avgDelay = delayLogs.reduce((s, l) => s + Number(l.metric_value), 0) / delayLogs.length;
      if (avgDelay > 3) {
        actions.push(createAction({
          agent: "calibrator",
          action_type: "alert",
          target_type: "factory",
          target_id: factory.id,
          summary: `${factory.name} 平均延期 ${avgDelay.toFixed(1)} 天，建议在排产时增加缓冲`,
          urgency: avgDelay > 7 ? "high" : "medium",
          impact: `不增加缓冲将持续导致交期延误`,
          confidence: 0.8,
          params: { factory_name: factory.name, avg_delay_days: avgDelay, data_points: delayLogs.length },
        }));
      }
    }
  }

  return {
    actions,
    reasoning: `分析了 ${factories.length} 个工厂的 ${performanceLogs.length} 条历史数据，生成 ${actions.length} 条校准建议`,
  };
}
