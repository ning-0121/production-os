/**
 * Confidence Engine — 动态置信度评分
 *
 * 基于历史准确率、数据新鲜度、样本量、方差计算置信度。
 */

const WEIGHTS = { accuracy: 0.35, recency: 0.25, volume: 0.25, variance: 0.15 };

/**
 * 计算工厂记忆的置信度
 * @param {Array} memoryProfile - from getMemoryProfile()
 * @returns {{ score, breakdown, reason }}
 */
export function computeMemoryConfidence(memoryProfile) {
  if (!memoryProfile || memoryProfile.length === 0) {
    return { score: 0.3, breakdown: {}, reason: "无历史数据，置信度低" };
  }

  const totalSamples = memoryProfile.reduce((s, m) => s + (m.sample_count ?? 0), 0);
  const avgSamples = totalSamples / memoryProfile.length;

  // Volume factor: more data = higher confidence
  const volumeScore = Math.min(1, avgSamples / 15);

  // Recency factor: check computed_at
  const latestComputed = memoryProfile.reduce((latest, m) => {
    const t = new Date(m.computed_at ?? 0).getTime();
    return t > latest ? t : latest;
  }, 0);
  const daysSinceComputed = (Date.now() - latestComputed) / (86400000);
  const recencyScore = daysSinceComputed < 7 ? 1.0 : daysSinceComputed < 30 ? 0.7 : daysSinceComputed < 90 ? 0.4 : 0.2;

  // Trend consistency: if all trends are stable, higher confidence
  const trends = memoryProfile.map((m) => m.trend);
  const decliningCount = trends.filter((t) => t === "declining").length;
  const accuracyScore = decliningCount === 0 ? 0.8 : decliningCount <= 2 ? 0.6 : 0.3;

  // Variance factor (lower is better for prediction)
  const varianceScore = 0.7; // TODO: compute from actual variance when data available

  const score = Math.min(0.95, Math.max(0.1,
    WEIGHTS.accuracy * accuracyScore +
    WEIGHTS.recency * recencyScore +
    WEIGHTS.volume * volumeScore +
    WEIGHTS.variance * varianceScore,
  ));

  const reasons = [];
  if (volumeScore > 0.7) reasons.push(`数据量充足(${Math.round(avgSamples)}条)`);
  else reasons.push(`数据量偏少(${Math.round(avgSamples)}条)`);
  if (recencyScore > 0.7) reasons.push("数据近期更新");
  else reasons.push("数据较陈旧");
  if (decliningCount > 0) reasons.push(`${decliningCount}项指标下滑`);

  return {
    score: Math.round(score * 100) / 100,
    breakdown: {
      accuracy: Math.round(accuracyScore * 100),
      recency: Math.round(recencyScore * 100),
      volume: Math.round(volumeScore * 100),
      variance: Math.round(varianceScore * 100),
    },
    reason: reasons.join("；"),
  };
}

/**
 * 为方案附加置信度
 */
export function scoreScenarioConfidence(scenario, factoryMemory) {
  const memConf = computeMemoryConfidence(factoryMemory);

  // Adjust based on scenario-specific factors
  let adjustment = 0;
  if (scenario.risk_level === "HIGH") adjustment -= 0.1;
  if (scenario.risk_level === "SAFE") adjustment += 0.05;

  // Check memory for bad patterns
  const delayMem = factoryMemory?.find((m) => m.metric_type === "delay_avg");
  if (delayMem && Number(delayMem.value) > 3) adjustment -= 0.1;
  const onTimeMem = factoryMemory?.find((m) => m.metric_type === "on_time_rate");
  if (onTimeMem && Number(onTimeMem.value) < 70) adjustment -= 0.1;

  const finalScore = Math.min(0.95, Math.max(0.1, memConf.score + adjustment));

  return {
    confidence_score: Math.round(finalScore * 100) / 100,
    confidence_reason: memConf.reason,
    confidence_breakdown: memConf.breakdown,
  };
}
