/**
 * Retrospective Insights — pure, deterministic plain-language management cards.
 *
 * No LLM. Reads the aggregate output and emits human-readable insight cards a
 * GM can act on Monday morning. Each card: { severity, icon, text }.
 *
 * Deterministic = same data → same insights, every run. (LLM polish can layer
 * on top later, but the facts come from here.)
 */

const ROOT_CAUSE_LABEL = {
  material_delay: "物料延迟", equipment_failure: "设备故障", labor_shortage: "人员短缺",
  quality_issue: "质量问题", planning_error: "计划错误", supplier_issue: "供应商问题",
  customer_change: "客户变更", data_error: "数据错误", external_factor: "外部因素",
  no_action_needed: "无需处理", other: "其他",
};
const CATEGORY_LABEL = {
  production_delay: "生产延期", quality: "质量", material: "物料",
  shipment: "出货", capacity: "产能", general: "一般",
};

function rcLabel(rc) {
  if (!rc) return "未分类";
  if (rc.startsWith("category:")) return CATEGORY_LABEL[rc.slice(9)] ?? rc.slice(9);
  return ROOT_CAUSE_LABEL[rc] ?? rc;
}

/**
 * @param {object} agg   output of aggregate()
 * @returns {Array<{ severity: "ok"|"warn"|"critical", icon: string, text: string }>}
 */
export function generateInsights(agg) {
  const cards = [];
  const s = agg?.summary ?? {};
  const windowDays = agg?.window?.days ?? 7;
  const windowLabel = windowDays >= 30 ? "本月" : "本周";

  if ((s.total_tasks ?? 0) === 0) {
    return [{ severity: "ok", icon: "✓", text: `${windowLabel}没有需要处理的任务，生产平稳。` }];
  }

  // 1. Top factory concentration
  const factories = agg.factories ?? [];
  const totalFactoryIssues = factories.reduce((sum, f) => sum + (f.total ?? 0), 0);
  if (factories.length > 0 && totalFactoryIssues > 0) {
    const top = factories[0];
    const share = Math.round((top.total / totalFactoryIssues) * 100);
    if (share >= 30) {
      cards.push({
        severity: share >= 50 ? "critical" : "warn", icon: "🏭",
        text: `${top.factory_name} ${windowLabel}产生了 ${share}% 的问题（${top.total} 项），其中质量 ${top.quality}、返工 ${top.rework}、延期 ${top.delay}。`,
      });
    }
  }

  // 2. Root cause trend (biggest riser)
  const risers = (agg.root_causes ?? []).filter((r) => r.trend === "up" && r.prev_count > 0)
    .map((r) => ({ ...r, change: Math.round(((r.count - r.prev_count) / r.prev_count) * 100) }))
    .sort((a, b) => b.change - a.change);
  if (risers.length > 0) {
    const r = risers[0];
    cards.push({
      severity: r.change >= 50 ? "critical" : "warn", icon: "📈",
      text: `${rcLabel(r.root_cause)}类问题较上一周期上升 ${r.change}%（${r.prev_count} → ${r.count}），需要重点关注。`,
    });
  }

  // 3. Top root cause overall
  const topRc = (agg.root_causes ?? [])[0];
  if (topRc && topRc.count > 0) {
    cards.push({
      severity: "warn", icon: "🔍",
      text: `${windowLabel}最主要的问题根因是「${rcLabel(topRc.root_cause)}」，占 ${topRc.pct}%（${topRc.count} 项），平均解决耗时 ${fmtMins(topRc.avg_resolution_minutes)}。`,
    });
  }

  // 4. Overloaded / late owners
  const overloaded = (agg.owners ?? []).filter((o) => o.overloaded || o.overdue >= 3);
  if (overloaded.length > 0) {
    const o = overloaded[0];
    cards.push({
      severity: o.overdue >= 5 ? "critical" : "warn", icon: "👤",
      text: `${o.owner} 有 ${o.overdue} 个逾期任务（共分配 ${o.assigned} 个），可能负荷过重，建议分流。`,
    });
  }

  // 5. AI effectiveness verdict
  const ai = agg.ai_effectiveness ?? {};
  if ((ai.auto_generated ?? 0) > 0) {
    const rate = ai.completion_rate ?? 0;
    const fp = ai.false_positive_rate ?? 0;
    if (fp >= 30) {
      cards.push({
        severity: "warn", icon: "🤖",
        text: `AI 自动生成 ${ai.auto_generated} 个任务，但误报率 ${fp}%${ai.top_false_positive_sources?.[0] ? `（主要来自 ${ai.top_false_positive_sources[0].source}）` : ""}，建议调整检测阈值。`,
      });
    } else {
      cards.push({
        severity: rate >= 60 ? "ok" : "warn", icon: "🤖",
        text: `AI 自动生成的 ${ai.auto_generated} 个任务完成率 ${rate}%，误报率 ${fp}%，自动化${rate >= 60 ? "运转良好" : "有待提升"}。`,
      });
    }
  }

  // 6. Resolution speed
  if ((s.resolved_tasks ?? 0) > 0) {
    cards.push({
      severity: "ok", icon: "⏱",
      text: `${windowLabel}解决 ${s.resolved_tasks} 个任务（解决率 ${s.resolved_pct}%），平均耗时 ${fmtMins(s.avg_resolution_minutes)}，中位数 ${fmtMins(s.median_resolution_minutes)}。`,
    });
  }

  // 7. Outstanding risk
  if ((s.overdue_tasks ?? 0) > 0) {
    cards.push({
      severity: s.overdue_pct >= 30 ? "critical" : "warn", icon: "⚠️",
      text: `仍有 ${s.overdue_tasks} 个任务逾期未解决（占 ${s.overdue_pct}%），升级 ${s.escalation_count} 次。`,
    });
  }

  // 8. Repeat issues
  if ((s.repeat_issue_count ?? 0) > 0) {
    cards.push({
      severity: "warn", icon: "🔁",
      text: `有 ${s.repeat_issue_count} 个对象反复出问题，可能存在系统性根因，建议专项排查。`,
    });
  }

  return cards;
}

function fmtMins(m) {
  const n = Number(m) || 0;
  if (n < 60) return `${n} 分钟`;
  const h = Math.round(n / 60 * 10) / 10;
  if (h < 24) return `${h} 小时`;
  return `${Math.round(h / 24 * 10) / 10} 天`;
}
