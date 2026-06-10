/**
 * Decision Intelligence Insights — pure, deterministic plain-language cards.
 *
 * No LLM. Reads the aggregate output and emits management-readable insights:
 * is the AI trusted, which options work, which recommendations get rejected,
 * is the engine learning. Same data → same insights.
 */

const OPTION_LABEL = {
  keep_current: "维持现状", overtime: "加班", reassign_factory: "转厂",
  reassign_line: "转线", split_order: "拆单", delay_customer: "客户协商延期",
  expedite_material: "加急催料", substitute_material: "替代物料",
  partial_start: "部分开工", add_qc_check: "增加终检", create_rework_plan: "返工",
};
const DECISION_TYPE_LABEL = {
  delay_resolution: "生产延期", material_shortage_resolution: "物料短缺",
  qc_rework_resolution: "质量返工", vip_insertion: "紧急插单", line_disruption_resolution: "产线中断",
};
const ol = (t) => OPTION_LABEL[t] ?? t;
const dl = (t) => DECISION_TYPE_LABEL[t] ?? t;

/**
 * @param {object} agg  output of aggregate()
 * @returns {Array<{severity:"ok"|"warn"|"critical", icon:string, text:string}>}
 */
export function generateInsights(agg) {
  const cards = [];
  const s = agg?.summary ?? {};
  const windowLabel = (agg?.window?.days ?? 7) >= 30 ? "本月" : "本周";

  if ((s.decisions_evaluated ?? 0) === 0 && (s.total_selected ?? 0) === 0) {
    return [{ severity: "ok", icon: "🧭", text: `${windowLabel}还没有产生决策记录。当生产风险出现并使用决策引擎后，这里会显示分析。` }];
  }

  // 1. Trust verdict (acceptance rate)
  const acc = s.recommendation_acceptance_rate ?? 0;
  if ((s.total_selected ?? 0) > 0) {
    cards.push({
      severity: acc >= 60 ? "ok" : acc >= 40 ? "warn" : "critical",
      icon: "🤝",
      text: `${windowLabel}推荐采纳率 ${acc}%${trendWord(s.acceptance_trend)} — AI 推荐${acc >= 60 ? "被广泛信任" : acc >= 40 ? "信任度一般" : "经常被否决，建议复核推荐逻辑"}。`,
    });
  }

  // 2. Acceptance improvement
  if (s.acceptance_trend === "up" && s.prev_acceptance_rate > 0) {
    cards.push({ severity: "ok", icon: "📈", text: `推荐采纳率从上期 ${s.prev_acceptance_rate}% 提升到 ${acc}%，AI 与现场判断越来越一致。` });
  } else if (s.acceptance_trend === "down" && s.prev_acceptance_rate > 0) {
    cards.push({ severity: "warn", icon: "📉", text: `推荐采纳率从 ${s.prev_acceptance_rate}% 下降到 ${acc}%，需要检查推荐是否脱离现场实际。` });
  }

  // 3. Apply success
  if ((s.decisions_applied ?? 0) > 0) {
    cards.push({
      severity: s.apply_success_rate >= 70 ? "ok" : "warn", icon: "✅",
      text: `已执行决策成功率 ${s.apply_success_rate}%（${s.decisions_applied} 个已应用），失败率 ${s.failed_rate}%。`,
    });
  }

  // 4. Best-performing option
  const topSuccess = (agg.options ?? []).filter((o) => o.selected >= 3).sort((a, b) => b.success_rate - a.success_rate)[0];
  if (topSuccess) {
    cards.push({
      severity: "ok", icon: "🏆",
      text: `「${ol(topSuccess.option_type)}」被选 ${topSuccess.selected} 次，成功率 ${topSuccess.success_rate}%，是当前最可靠的处置方式。`,
    });
  }

  // 5. Frequently overridden recommendation
  const topOverride = (agg.overrides ?? []).filter((o) => o.recommended >= 3 && o.override_rate >= 40)[0];
  if (topOverride) {
    cards.push({
      severity: "warn", icon: "🔄",
      text: `「${ol(topOverride.option_type)}」常被推荐但 ${topOverride.override_rate}% 被现场改选，推荐逻辑可能需要调整。`,
    });
  }

  // 6. Learning movement
  const topPos = (agg.learning?.top_positive ?? [])[0];
  if (topPos && topPos.adjustment > 0) {
    cards.push({
      severity: "ok", icon: "🧠",
      text: `「${ol(topPos.option_type)}」在「${dl(topPos.decision_type)}」场景获得正向学习调整 +${topPos.adjustment}（样本 ${topPos.sample_size}），系统正在强化这个有效选项。`,
    });
  }
  const topNeg = (agg.learning?.top_negative ?? [])[0];
  if (topNeg && topNeg.adjustment < 0) {
    cards.push({
      severity: "warn", icon: "🧠",
      text: `「${ol(topNeg.option_type)}」在「${dl(topNeg.decision_type)}」场景表现不佳，学习调整 ${topNeg.adjustment}，系统正在降低其推荐权重。`,
    });
  }

  // 7. Feedback coverage
  const fb = agg.feedback ?? {};
  if ((fb.no_feedback ?? 0) > 0 && (fb.total_feedback ?? 0) === 0) {
    cards.push({ severity: "warn", icon: "💬", text: `有 ${fb.no_feedback} 个决策尚无反馈。鼓励现场对决策打「有用 / 无用」，能让学习更快更准。` });
  } else if ((fb.total_feedback ?? 0) > 0) {
    cards.push({
      severity: fb.helpful_rate >= 60 ? "ok" : "warn", icon: "💬",
      text: `收到 ${fb.total_feedback} 条反馈，正向 ${fb.helpful_rate}%（有用 ${fb.helpful}、无用 ${fb.not_helpful}、推荐错误 ${fb.wrong_recommendation}）。`,
    });
  }

  return cards;
}

function trendWord(trend) {
  if (trend === "up") return "（↑ 上升）";
  if (trend === "down") return "（↓ 下降）";
  return "";
}
