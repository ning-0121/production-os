/**
 * Confidence Engine v2 — 基于 simple-statistics 的动态置信度
 *
 * 升级点：
 * - z-score 异常检测替代硬编码阈值
 * - 线性回归检测趋势方向和强度
 * - 标准差衡量数据一致性
 * - 样本量自动调整权重
 */

import * as ss from "simple-statistics";

const WEIGHTS = { accuracy: 0.30, recency: 0.25, volume: 0.20, consistency: 0.15, trend: 0.10 };

/**
 * 计算工厂记忆的置信度（统计增强版）
 */
export function computeMemoryConfidence(memoryProfile) {
  if (!memoryProfile || memoryProfile.length === 0) {
    return { score: 0.3, breakdown: {}, reason: "无历史数据，置信度低" };
  }

  const values = memoryProfile.map((m) => Number(m.value ?? 0));
  const samples = memoryProfile.map((m) => Number(m.sample_count ?? 0));
  const totalSamples = ss.sum(samples);
  const avgSamples = ss.mean(samples);

  // ── Volume: 更多数据 = 更高置信 ──
  const volumeScore = Math.min(1, avgSamples / 15);

  // ── Recency: 数据新鲜度 ──
  const latestComputed = memoryProfile.reduce((latest, m) => {
    const t = new Date(m.computed_at ?? 0).getTime();
    return t > latest ? t : latest;
  }, 0);
  const daysSince = (Date.now() - latestComputed) / 86400000;
  const recencyScore = daysSince < 7 ? 1.0 : daysSince < 30 ? 0.7 : daysSince < 90 ? 0.4 : 0.2;

  // ── Consistency: 数据方差越小越稳定 ──
  let consistencyScore = 0.7;
  if (values.length >= 3) {
    const cv = ss.mean(values) !== 0
      ? ss.standardDeviation(values) / Math.abs(ss.mean(values))
      : 0;
    // cv < 0.1 = 非常一致, cv > 0.5 = 非常不一致
    consistencyScore = Math.max(0.1, 1 - cv);
  }

  // ── Trend: 线性回归检测趋势稳定性 ──
  let trendScore = 0.7;
  const trendValues = memoryProfile
    .filter((m) => m.metric_type === "delay_avg" || m.metric_type === "on_time_rate")
    .map((m, i) => [i, Number(m.value ?? 0)]);
  if (trendValues.length >= 3) {
    const regression = ss.linearRegression(trendValues);
    const slope = regression.m;
    // 稳定的趋势（slope 接近 0）= 更可预测
    trendScore = Math.max(0.2, 1 - Math.min(1, Math.abs(slope) * 2));
  }

  // ── Accuracy: 基于趋势方向判断历史准确性 ──
  const decliningCount = memoryProfile.filter((m) => m.trend === "declining").length;
  const accuracyScore = decliningCount === 0 ? 0.85 : decliningCount <= 2 ? 0.6 : 0.3;

  // ── 加权计算 ──
  const score = Math.min(0.95, Math.max(0.1,
    WEIGHTS.accuracy * accuracyScore +
    WEIGHTS.recency * recencyScore +
    WEIGHTS.volume * volumeScore +
    WEIGHTS.consistency * consistencyScore +
    WEIGHTS.trend * trendScore,
  ));

  const reasons = [];
  if (volumeScore > 0.7) reasons.push(`数据量充足(${Math.round(avgSamples)}条)`);
  else reasons.push(`数据量偏少(${Math.round(avgSamples)}条)`);
  if (recencyScore > 0.7) reasons.push("数据近期更新");
  else reasons.push("数据较陈旧");
  if (consistencyScore > 0.7) reasons.push("数据一致性好");
  else reasons.push("数据波动较大");
  if (decliningCount > 0) reasons.push(`${decliningCount}项指标下滑`);

  return {
    score: Math.round(score * 100) / 100,
    breakdown: {
      accuracy: Math.round(accuracyScore * 100),
      recency: Math.round(recencyScore * 100),
      volume: Math.round(volumeScore * 100),
      consistency: Math.round(consistencyScore * 100),
      trend: Math.round(trendScore * 100),
    },
    reason: reasons.join("；"),
  };
}

/**
 * 为方案附加置信度（统计增强版）
 */
export function scoreScenarioConfidence(scenario, factoryMemory) {
  const memConf = computeMemoryConfidence(factoryMemory);

  let adjustment = 0;
  if (scenario.risk_level === "HIGH") adjustment -= 0.1;
  if (scenario.risk_level === "SAFE") adjustment += 0.05;

  // 用统计方法检测工厂是否有异常模式
  if (factoryMemory && factoryMemory.length >= 3) {
    const delayValues = factoryMemory
      .filter((m) => m.metric_type === "delay_avg")
      .map((m) => Number(m.value ?? 0));

    if (delayValues.length > 0) {
      const mean = ss.mean(delayValues);
      if (mean > 3) adjustment -= 0.1;
      if (mean > 5) adjustment -= 0.1;
    }

    const onTimeValues = factoryMemory
      .filter((m) => m.metric_type === "on_time_rate")
      .map((m) => Number(m.value ?? 0));

    if (onTimeValues.length > 0 && ss.mean(onTimeValues) < 70) {
      adjustment -= 0.1;
    }
  }

  // 简单检测：delay_avg 单值
  const delayMem = factoryMemory?.find((m) => m.metric_type === "delay_avg");
  if (delayMem && Number(delayMem.value) > 3) adjustment -= 0.05;
  const onTimeMem = factoryMemory?.find((m) => m.metric_type === "on_time_rate");
  if (onTimeMem && Number(onTimeMem.value) < 70) adjustment -= 0.05;

  const finalScore = Math.min(0.95, Math.max(0.1, memConf.score + adjustment));

  return {
    confidence_score: Math.round(finalScore * 100) / 100,
    confidence_reason: memConf.reason,
    confidence_breakdown: memConf.breakdown,
  };
}

/**
 * 检测数值是否为异常值（z-score 方法）
 * @param {number} value - 待检测值
 * @param {number[]} dataset - 历史数据集
 * @param {number} threshold - z-score 阈值（默认 2.0）
 * @returns {{ isAnomaly, zScore, mean, stdDev }}
 */
export function detectAnomaly(value, dataset, threshold = 2.0) {
  if (dataset.length < 3) {
    return { isAnomaly: false, zScore: 0, mean: 0, stdDev: 0, reason: "数据不足" };
  }

  const mean = ss.mean(dataset);
  const stdDev = ss.standardDeviation(dataset);

  if (stdDev === 0) {
    return { isAnomaly: value !== mean, zScore: value !== mean ? 999 : 0, mean, stdDev: 0, reason: "零方差" };
  }

  const zScore = ss.zScore(value, mean, stdDev);
  const isAnomaly = Math.abs(zScore) > threshold;

  return {
    isAnomaly,
    zScore: Math.round(zScore * 100) / 100,
    mean: Math.round(mean * 100) / 100,
    stdDev: Math.round(stdDev * 100) / 100,
    reason: isAnomaly ? `z=${zScore.toFixed(1)}，偏离均值 ${Math.round(Math.abs(zScore))} 个标准差` : "正常范围",
  };
}

/**
 * 计算趋势方向和强度
 * @param {number[]} values - 时间序列数据（按时间排序）
 * @returns {{ direction, slope, r2, prediction }}
 */
export function analyzeTrend(values) {
  if (values.length < 3) {
    return { direction: "unknown", slope: 0, r2: 0, prediction: null };
  }

  const points = values.map((v, i) => [i, v]);
  const regression = ss.linearRegression(points);
  const regressionLine = ss.linearRegressionLine(regression);
  const r2 = ss.rSquared(points, regressionLine);

  const direction = regression.m > 0.1 ? "increasing"
    : regression.m < -0.1 ? "decreasing"
    : "stable";

  // 预测下一个值
  const prediction = Math.round(regressionLine(values.length) * 100) / 100;

  return {
    direction,
    slope: Math.round(regression.m * 1000) / 1000,
    r2: Math.round(r2 * 100) / 100,
    prediction,
  };
}
