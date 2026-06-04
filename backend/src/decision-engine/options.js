/**
 * Decision Option Generators — pure, deterministic, no I/O.
 *
 * Given a normalized `context` (built by io.js from the existing engines),
 * each generator returns candidate DecisionOption[] for one decision_type.
 * Impacts (delay/cost/margin/risk deltas) are computed from simple, explicit,
 * explainable cost models — NOT an LLM. Same context → same options, always.
 *
 * Every option carries `required_actions` (DecisionAction[]) describing what
 * applying it would do — but generating an option NEVER executes anything.
 *
 * Sign conventions:
 *   delay_days_delta  : change vs do-nothing. NEGATIVE = reduces delay (good).
 *   cost_delta        : extra cost in currency units. POSITIVE = costs money.
 *   margin_delta      : change to order margin. NEGATIVE = erodes margin.
 *   risk_delta        : change to risk 0..100. NEGATIVE = reduces risk (good).
 */

// ── Cost model constants (deterministic, documented estimates) ──
const OVERTIME_COST_PER_DELAY_DAY = 850;   // ~one line, one shift of OT
const REASSIGN_BASE_COST = 1200;           // transfer/setup at a new factory
const SPLIT_BASE_COST = 900;               // dual setup + coordination
const EXPEDITE_MATERIAL_COST = 1500;       // air freight / rush premium
const SUBSTITUTE_MATERIAL_MARGIN_HIT = 0.04; // ~4% margin hit from substitute
const QC_EXTRA_CHECK_COST = 300;
const REWORK_COST_PER_UNIT = 2.5;

/**
 * @param {string} decisionType
 * @param {object} ctx  normalized context (see io.js)
 * @returns {DecisionOption[]}
 */
export function generateOptions(decisionType, ctx) {
  switch (decisionType) {
    case "delay_resolution": return delayOptions(ctx);
    case "material_shortage_resolution": return materialOptions(ctx);
    case "qc_rework_resolution": return qcOptions(ctx);
    case "vip_insertion": return vipOptions(ctx);
    case "line_disruption_resolution": return disruptionOptions(ctx);
    default: return [keepCurrent(ctx)];
  }
}

// ── keep_current — the do-nothing baseline (drives if_no_action) ──
function keepCurrent(ctx) {
  const delay = num(ctx.expected_delay_days);
  return option({
    option_type: "keep_current",
    title: "维持现状",
    description: "不采取行动，按当前进度执行。",
    impact: {
      delay_days_delta: 0,
      cost_delta: 0,
      margin_delta: -marginLoss(ctx, delay),
      risk_delta: 0,
      affected_orders: [],
      affected_lines: [],
      customer_impact: delay >= 3 ? "high" : delay > 0 ? "medium" : "low",
    },
    required_actions: [{ action_type: "update_watchlist", payload: { reason: "decision_keep_current", subject: ctx.subject } }],
    reasoning: [
      delay > 0 ? `预计延期 ${delay} 天` : "当前无明显延期",
      `毛利损失约 ¥${Math.round(marginLoss(ctx, delay))}`,
      "不消耗额外成本，但风险不变",
    ],
  });
}

// ── 1. Production delay ─────────────────────────────────
function delayOptions(ctx) {
  const delay = Math.max(0, num(ctx.expected_delay_days));
  const opts = [keepCurrent(ctx)];

  // Overtime — reduces most of the delay, modest cost
  if (delay > 0) {
    const reduced = Math.max(0, Math.round(delay * 0.25));   // OT removes ~75%
    const cost = Math.round(OVERTIME_COST_PER_DELAY_DAY * (delay - reduced));
    opts.push(option({
      option_type: "overtime",
      title: "安排加班",
      description: `通过加班压缩工期，将延期从 ${delay} 天降到约 ${reduced} 天。`,
      impact: {
        delay_days_delta: reduced - delay,
        cost_delta: cost,
        margin_delta: -cost - marginLoss(ctx, reduced),
        risk_delta: -35,
        affected_orders: [],
        affected_lines: ctx.subject?.type === "line" ? [ctx.subject.id] : [],
        customer_impact: reduced > 0 ? "medium" : "low",
      },
      required_actions: [
        { action_type: "create_task", payload: { category: "production_delay", title: `加班赶工：${subjLabel(ctx)}`, severity: ctx.urgency === "critical" ? "critical" : "warn" } },
        { action_type: "notify_owner", payload: { reason: "overtime_scheduled" } },
      ],
      reasoning: [`加班约消除 ${delay - reduced} 天延期`, `预计成本 ¥${cost}`, "对其他订单无影响", "实施简单、见效快"],
    }));
  }

  // Reassign to an alternative factory — can fully fix delay, higher cost + collateral
  const altFactory = (ctx.alternative_factories ?? [])[0];
  if (delay > 0 && altFactory) {
    const cost = REASSIGN_BASE_COST + Math.round(num(ctx.qty) * 0.3);
    const collateral = altFactory.affected_orders ?? [];
    opts.push(option({
      option_type: "reassign_factory",
      title: `转厂至 ${altFactory.name ?? altFactory.id}`,
      description: `将订单转移到产能可用的 ${altFactory.name ?? "备选工厂"}，可消除延期。`,
      impact: {
        delay_days_delta: -delay,
        cost_delta: cost,
        margin_delta: -cost,
        risk_delta: -50,
        affected_orders: collateral,
        affected_lines: [],
        customer_impact: "low",
      },
      required_actions: [
        { action_type: "reschedule", payload: { target_factory_id: altFactory.id, reason: "delay_reassign" } },
        { action_type: "create_task", payload: { category: "production_delay", title: `确认转厂：${subjLabel(ctx)} → ${altFactory.name ?? altFactory.id}`, severity: "warn" } },
        { action_type: "request_approval", payload: { reason: "factory_reassignment", cost } },
      ],
      reasoning: [`转厂可完全消除 ${delay} 天延期`, `预计成本 ¥${cost}`, collateral.length ? `影响 ${collateral.length} 个其他订单` : "无明显连带影响", `备选工厂评分 ${altFactory.score ?? "良好"}`],
    }));
  }

  // Split order — partial parallelism, moderate everything, higher complexity
  if (delay > 1 && num(ctx.qty) >= 200) {
    const reduced = Math.max(0, Math.round(delay * 0.3));
    opts.push(option({
      option_type: "split_order",
      title: "拆单并行生产",
      description: `将订单拆分到多条产线/工厂并行，把延期降到约 ${reduced} 天。`,
      impact: {
        delay_days_delta: reduced - delay,
        cost_delta: SPLIT_BASE_COST,
        margin_delta: -SPLIT_BASE_COST,
        risk_delta: -30,
        affected_orders: [],
        affected_lines: ctx.alternative_lines?.map((l) => l.id) ?? [],
        customer_impact: "low",
      },
      required_actions: [
        { action_type: "reschedule", payload: { strategy: "split", reason: "delay_split" } },
        { action_type: "create_task", payload: { category: "production_delay", title: `拆单执行：${subjLabel(ctx)}`, severity: "warn" } },
      ],
      reasoning: [`拆单可消除约 ${delay - reduced} 天延期`, `预计成本 ¥${SPLIT_BASE_COST}`, "操作复杂度较高，需协调多产线", "适合大批量订单"],
    }));
  }

  // Negotiate delay with customer — no production cost, customer risk + margin penalty
  if (delay > 0) {
    opts.push(option({
      option_type: "delay_customer",
      title: "与客户协商延期",
      description: "主动与客户沟通延期交付，争取宽限期。",
      impact: {
        delay_days_delta: 0,
        cost_delta: 0,
        margin_delta: -marginLoss(ctx, delay) * 0.5,
        risk_delta: -10,
        affected_orders: [],
        affected_lines: [],
        customer_impact: "high",
      },
      required_actions: [
        { action_type: "mark_customer_delay", payload: { delay_days: delay } },
        { action_type: "create_task", payload: { category: "shipment", title: `客户延期沟通：${subjLabel(ctx)}`, severity: "warn" } },
      ],
      reasoning: ["无生产成本", "客户关系风险较高", "适合无法压缩工期时的兜底", `仍延期 ${delay} 天`],
    }));
  }

  return opts;
}

// ── 2. Material shortage ────────────────────────────────
function materialOptions(ctx) {
  const etaDays = Math.max(0, num(ctx.material_eta_days));
  const opts = [keepCurrent(ctx)];

  // expedite material
  opts.push(option({
    option_type: "expedite_material",
    title: "加急催料",
    description: "通过空运/加急将物料提前到货，尽快开工。",
    impact: {
      delay_days_delta: -Math.max(0, etaDays - 1),
      cost_delta: EXPEDITE_MATERIAL_COST,
      margin_delta: -EXPEDITE_MATERIAL_COST,
      risk_delta: -45,
      affected_orders: [], affected_lines: [],
      customer_impact: "low",
    },
    required_actions: [
      { action_type: "create_purchase_followup", payload: { reason: "expedite", subject: ctx.subject } },
      { action_type: "create_task", payload: { category: "material", title: `加急催料：${subjLabel(ctx)}`, severity: "warn" } },
    ],
    reasoning: [`可提前约 ${Math.max(0, etaDays - 1)} 天到货`, `加急成本 ¥${EXPEDITE_MATERIAL_COST}`, "见效快，适合关键物料"],
  }));

  // substitute material
  if (ctx.has_substitute) {
    opts.push(option({
      option_type: "substitute_material",
      title: "替代物料",
      description: "使用已批准的替代物料，立即开工。",
      impact: {
        delay_days_delta: -etaDays,
        cost_delta: 0,
        margin_delta: -Math.round(num(ctx.order_revenue) * SUBSTITUTE_MATERIAL_MARGIN_HIT),
        risk_delta: -30,
        affected_orders: [], affected_lines: [],
        customer_impact: "medium",
      },
      required_actions: [
        { action_type: "create_task", payload: { category: "material", title: `替代物料确认：${subjLabel(ctx)}`, severity: "warn" } },
        { action_type: "request_approval", payload: { reason: "material_substitution" } },
      ],
      reasoning: ["立即消除物料等待", "需客户/QC 批准替代", `毛利约降 ${Math.round(SUBSTITUTE_MATERIAL_MARGIN_HIT * 100)}%`],
    }));
  }

  // partial start with available material
  if (ctx.partial_available) {
    const reduced = Math.max(0, Math.round(etaDays * 0.5));
    opts.push(option({
      option_type: "partial_start",
      title: "部分先开工",
      description: "用现有物料先开工部分工序，物料到齐后续接。",
      impact: {
        delay_days_delta: reduced - etaDays,
        cost_delta: 0,
        margin_delta: 0,
        risk_delta: -20,
        affected_orders: [], affected_lines: [],
        customer_impact: "low",
      },
      required_actions: [
        { action_type: "create_task", payload: { category: "material", title: `部分开工安排：${subjLabel(ctx)}`, severity: "warn" } },
      ],
      reasoning: [`抢回约 ${etaDays - reduced} 天`, "零额外成本", "需现场协调工序顺序"],
    }));
  }

  return opts;
}

// ── 3. QC / rework ──────────────────────────────────────
function qcOptions(ctx) {
  const qty = num(ctx.rework_qty || ctx.qty);
  const opts = [keepCurrent(ctx)];

  // full rework
  opts.push(option({
    option_type: "create_rework_plan",
    title: "整批返工",
    description: "对整批产品返工，确保质量合格后出货。",
    impact: {
      delay_days_delta: 3,
      cost_delta: Math.round(qty * REWORK_COST_PER_UNIT),
      margin_delta: -Math.round(qty * REWORK_COST_PER_UNIT),
      risk_delta: -55,
      affected_orders: [], affected_lines: [],
      customer_impact: "low",
    },
    required_actions: [
      { action_type: "create_qc_followup", payload: { scope: "full", qty } },
      { action_type: "create_task", payload: { category: "quality", title: `整批返工：${subjLabel(ctx)}`, severity: "critical" } },
    ],
    reasoning: ["彻底消除质量风险", `返工成本约 ¥${Math.round(qty * REWORK_COST_PER_UNIT)}`, "占用产能、延期约 3 天"],
  }));

  // partial rework
  opts.push(option({
    option_type: "create_rework_plan",
    title: "部分返工",
    description: "仅返工不良品，合格品正常出货。",
    impact: {
      delay_days_delta: 1,
      cost_delta: Math.round(qty * REWORK_COST_PER_UNIT * num(ctx.defect_rate_pct, 10) / 100),
      margin_delta: -Math.round(qty * REWORK_COST_PER_UNIT * num(ctx.defect_rate_pct, 10) / 100),
      risk_delta: -35,
      affected_orders: [], affected_lines: [],
      customer_impact: "medium",
    },
    required_actions: [
      { action_type: "create_qc_followup", payload: { scope: "partial" } },
      { action_type: "create_task", payload: { category: "quality", title: `部分返工：${subjLabel(ctx)}`, severity: "warn" } },
    ],
    reasoning: [`仅返工不良品（约 ${num(ctx.defect_rate_pct, 10)}%）`, "成本与延期更低", "残留少量质量风险"],
  }));

  // add final inspection
  opts.push(option({
    option_type: "add_qc_check",
    title: "增加终检",
    description: "增加一道终检拦截不良品，降低客诉风险。",
    impact: {
      delay_days_delta: 1,
      cost_delta: QC_EXTRA_CHECK_COST,
      margin_delta: -QC_EXTRA_CHECK_COST,
      risk_delta: -25,
      affected_orders: [], affected_lines: [],
      customer_impact: "low",
    },
    required_actions: [
      { action_type: "create_qc_followup", payload: { scope: "final_check" } },
    ],
    reasoning: ["拦截不良品流出", `成本仅 ¥${QC_EXTRA_CHECK_COST}`, "不解决根因，仅控制风险"],
  }));

  return opts;
}

// ── 4. VIP insertion ────────────────────────────────────
function vipOptions(ctx) {
  const opts = [keepCurrent(ctx)];
  const altLine = (ctx.alternative_lines ?? [])[0];

  opts.push(option({
    option_type: "reassign_line",
    title: "插入到空闲产线",
    description: `将紧急订单插入到负载较低的${altLine ? ` ${altLine.name ?? altLine.id}` : "产线"}，最小化对现有排程的冲击。`,
    impact: {
      delay_days_delta: 0,
      cost_delta: 200,
      margin_delta: -200,
      risk_delta: -40,
      affected_orders: altLine?.affected_orders ?? [],
      affected_lines: altLine ? [altLine.id] : [],
      customer_impact: "low",
    },
    required_actions: [
      { action_type: "reschedule", payload: { strategy: "vip_insert", target_line_id: altLine?.id, reason: "vip_insertion" } },
      { action_type: "create_task", payload: { category: "capacity", title: `VIP 插单确认：${subjLabel(ctx)}`, severity: "high" } },
    ],
    reasoning: ["插入空闲产线冲击最小", "成本低", altLine ? `目标产线 ${altLine.name ?? altLine.id}` : "需指定产线"],
  }));

  opts.push(option({
    option_type: "overtime",
    title: "加班插单",
    description: "通过加班吸收紧急订单，不挤占现有排程。",
    impact: {
      delay_days_delta: 0,
      cost_delta: OVERTIME_COST_PER_DELAY_DAY,
      margin_delta: -OVERTIME_COST_PER_DELAY_DAY,
      risk_delta: -30,
      affected_orders: [], affected_lines: [],
      customer_impact: "low",
    },
    required_actions: [
      { action_type: "create_task", payload: { category: "capacity", title: `加班插单：${subjLabel(ctx)}`, severity: "high" } },
    ],
    reasoning: ["不挤占现有订单", `成本约 ¥${OVERTIME_COST_PER_DELAY_DAY}`, "依赖人力可用性"],
  }));

  return opts;
}

// ── 5. Factory / line disruption ────────────────────────
function disruptionOptions(ctx) {
  const opts = [keepCurrent(ctx)];
  const altFactory = (ctx.alternative_factories ?? [])[0];
  const altLine = (ctx.alternative_lines ?? [])[0];

  if (altLine) {
    opts.push(option({
      option_type: "reassign_line",
      title: `转移到 ${altLine.name ?? altLine.id}`,
      description: "将受影响订单转移到同厂其他可用产线。",
      impact: {
        delay_days_delta: -Math.max(0, num(ctx.expected_delay_days)),
        cost_delta: 300,
        margin_delta: -300,
        risk_delta: -45,
        affected_orders: altLine.affected_orders ?? [],
        affected_lines: [altLine.id],
        customer_impact: "low",
      },
      required_actions: [
        { action_type: "reschedule", payload: { target_line_id: altLine.id, reason: "disruption_line_move" } },
        { action_type: "create_task", payload: { category: "production_delay", title: `转线执行：${subjLabel(ctx)}`, severity: "high" } },
      ],
      reasoning: ["同厂转线最快恢复", "成本低", `目标产线 ${altLine.name ?? altLine.id}`],
    }));
  }
  if (altFactory) {
    const cost = REASSIGN_BASE_COST + Math.round(num(ctx.qty) * 0.3);
    opts.push(option({
      option_type: "reassign_factory",
      title: `转厂至 ${altFactory.name ?? altFactory.id}`,
      description: "工厂级中断时，将订单整体转移到备选工厂。",
      impact: {
        delay_days_delta: -Math.max(0, num(ctx.expected_delay_days)),
        cost_delta: cost,
        margin_delta: -cost,
        risk_delta: -55,
        affected_orders: altFactory.affected_orders ?? [],
        affected_lines: [],
        customer_impact: "low",
      },
      required_actions: [
        { action_type: "reschedule", payload: { target_factory_id: altFactory.id, reason: "disruption_factory_move" } },
        { action_type: "create_incident", payload: { incident_type: "factory_shutdown", severity: ctx.urgency } },
        { action_type: "request_approval", payload: { reason: "factory_reassignment", cost } },
      ],
      reasoning: ["工厂中断的彻底解法", `成本 ¥${cost}`, "需审批 + 建事件跟踪"],
    }));
  }
  // Always offer create_incident as a containment option
  opts.push(option({
    option_type: "keep_current",
    title: "建事件并持续跟踪",
    description: "暂不转移，建立生产事件持续跟踪直至恢复。",
    impact: {
      delay_days_delta: 0, cost_delta: 0,
      margin_delta: -marginLoss(ctx, num(ctx.expected_delay_days)),
      risk_delta: -5, affected_orders: [], affected_lines: [], customer_impact: "medium",
    },
    required_actions: [
      { action_type: "create_incident", payload: { incident_type: "line_blocked", severity: ctx.urgency } },
      { action_type: "update_watchlist", payload: { reason: "disruption_monitor" } },
    ],
    reasoning: ["保留现状但加强监控", "无成本", "适合短时中断"],
  }));

  return opts;
}

// ── Helpers ─────────────────────────────────────────────

let _seq = 0;
function option(o) {
  // Deterministic id from option_type + a per-call counter is NOT stable across
  // runs; instead derive a stable id from option_type + title.
  const id = `opt_${o.option_type}_${slug(o.title)}`;
  return {
    id,
    option_type: o.option_type,
    title: o.title,
    description: o.description,
    impact: {
      delay_days_delta: num(o.impact.delay_days_delta),
      cost_delta: num(o.impact.cost_delta),
      margin_delta: num(o.impact.margin_delta),
      risk_delta: num(o.impact.risk_delta),
      affected_orders: o.impact.affected_orders ?? [],
      affected_lines: o.impact.affected_lines ?? [],
      customer_impact: o.impact.customer_impact ?? "low",
    },
    required_actions: o.required_actions ?? [],
    reasoning: o.reasoning ?? [],
    // scores filled in by scoring.js
    feasibility_score: 0, risk_score: 0, cost_score: 0, confidence_score: 0, total_score: 0,
  };
}

function marginLoss(ctx, delayDays) {
  const revenue = num(ctx.order_revenue);
  const marginPct = num(ctx.gross_margin_pct, 15) / 100;
  // Each delay day risks ~3% of order margin (late penalty / expedite / goodwill)
  const dailyFraction = 0.03;
  return Math.round(revenue * marginPct * Math.min(1, delayDays * dailyFraction));
}

function subjLabel(ctx) {
  return `${ctx.subject?.type ?? "订单"} ${String(ctx.subject?.id ?? "").slice(0, 10)}`;
}
function num(x, fallback = 0) { const n = Number(x); return Number.isFinite(n) ? n : fallback; }
function slug(s) { return String(s).replace(/[^a-z0-9一-龥]+/gi, "_").slice(0, 24); }
