/**
 * Request Validation Middleware (powered by Zod)
 *
 * Usage:
 *   import { validate, schemas } from "../middleware/validate.js";
 *   router.post("/", validate(schemas.createAllocation), handler);
 */

import { z } from "zod";

/**
 * Create validation middleware from a Zod schema.
 * Validates req.body and replaces it with the parsed (typed) result.
 */
export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errors = result.error.issues.map((i) => ({
        field: i.path.join("."),
        message: i.message,
      }));
      return res.status(400).json({
        error: "输入数据验证失败",
        code: "VALIDATION_ERROR",
        details: errors,
      });
    }
    req.body = result.data;
    next();
  };
}

// ── Reusable Schemas ───────────────────────────────────

export const schemas = {
  createAllocation: z.object({
    allocated_qty: z.number().int().positive("数量必须大于0"),
    planned_end_date: z.string().min(1, "交货日期不能为空"),
    planned_start_date: z.string().optional(),
    factory_id: z.string().uuid().optional(),
    status: z.enum(["planned", "confirmed", "in_progress", "completed", "cancelled"]).optional(),
    order_id: z.string().optional(),
    recommendation_score: z.number().optional(),
    is_locked: z.boolean().optional(),
  }),

  updateAllocation: z.object({
    status: z.enum(["planned", "confirmed", "in_progress", "completed", "cancelled"]).optional(),
    planned_start_date: z.string().optional(),
    planned_end_date: z.string().optional(),
    factory_id: z.string().uuid().optional(),
    allocated_qty: z.number().int().positive().optional(),
    order_id: z.string().optional(),
    recommendation_score: z.number().optional(),
    is_locked: z.boolean().optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: "至少需要提供一个要更新的字段",
  }),

  updateFactory: z.object({
    name: z.string().min(1).optional(),
    status: z.enum(["active", "inactive", "maintenance"]).optional(),
    location: z.string().optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    cooperation_score: z.number().optional(),
    quality_score: z.number().optional(),
    delay_score: z.number().optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: "至少需要提供一个要更新的字段",
  }),

  updateCapability: z.object({
    daily_capacity: z.number().positive().optional(),
    efficiency_rate: z.number().optional(),
    overtime_factor: z.number().optional(),
    product_type: z.string().optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: "至少需要提供一个要更新的字段",
  }),

  runOptimizer: z.object({
    orders: z.array(z.record(z.unknown())).optional(),
    factory_ids: z.array(z.string().uuid()).optional(),
    options: z.object({
      horizon_days: z.number().int().positive().optional(),
      dry_run: z.boolean().optional(),
      run_id: z.string().optional(),
      force_update: z.boolean().optional(),
    }).optional(),
  }),

  batchImportOrders: z.object({
    orders: z.array(z.object({
      quantity: z.number().int().positive(),
      end_date: z.string().min(1),
      start_date: z.string().optional(),
      order_id: z.string().optional(),
      order_external_id: z.string().optional(),
    })).min(1, "至少需要一条订单").max(500, "单次最多导入500条"),
  }),

  // ── Production Lines ─────────────────────────────────
  createLine: z.object({
    factory_id: z.string().uuid("工厂ID格式错误"),
    name: z.string().min(1, "产线名称不能为空"),
    front_capacity_per_day: z.number().positive().optional(),
    back_capacity_per_day: z.number().positive().optional(),
  }),

  updateLine: z.object({
    name: z.string().min(1).optional(),
    front_capacity_per_day: z.number().positive().optional(),
    back_capacity_per_day: z.number().positive().optional(),
    status: z.enum(["active", "inactive"]).optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: "至少需要提供一个要更新的字段",
  }),

  // ── Auto Schedule ────────────────────────────────────
  autoSchedule: z.object({
    line_id: z.string().uuid("产线ID格式错误"),
    allocation_id: z.string().uuid("订单ID格式错误"),
    front_days: z.number().int().positive("前道天数必须大于0"),
    dry_run: z.boolean().optional(),
  }),

  // ── Daily Reports ────────────────────────────────────
  submitReport: z.object({
    date: z.string().min(1, "日期不能为空"),
    factory_id: z.string().uuid("工厂ID格式错误"),
    line_id: z.string().uuid().nullable().optional(),
    allocation_id: z.string().uuid().nullable().optional(),
    order_id: z.string().nullable().optional(),
    planned_output: z.number().default(0),
    actual_output: z.number().min(0, "实际产出不能为负"),
    cumulative_output: z.number().default(0),
    stage: z.enum(["front", "back"]).default("front"),
    is_abnormal: z.boolean().default(false),
    abnormal_reason: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    reporter: z.string().nullable().optional(),
  }),

  batchReports: z.object({
    reports: z.array(z.object({
      date: z.string().min(1),
      factory_id: z.string().uuid(),
      line_id: z.string().uuid().nullable().optional(),
      allocation_id: z.string().uuid().nullable().optional(),
      order_id: z.string().nullable().optional(),
      planned_output: z.number().default(0),
      actual_output: z.number().min(0),
      cumulative_output: z.number().default(0),
      stage: z.string().default("front"),
      is_abnormal: z.boolean().default(false),
      abnormal_reason: z.string().nullable().optional(),
      note: z.string().nullable().optional(),
      reporter: z.string().nullable().optional(),
    })).min(1, "至少需要一条日报").max(200, "单次最多200条"),
  }),

  // ── Batch Operations ─────────────────────────────────
  batchAllocations: z.object({
    action: z.enum(["confirm", "delete", "cancel", "start"]),
    ids: z.array(z.string().uuid()).min(1, "至少选择一条记录").max(100, "单次最多100条"),
  }),

  // ── V4: Materials ────────────────────────────────────
  createMaterial: z.object({
    code: z.string().min(1, "物料编码不能为空").max(64),
    name: z.string().min(1, "物料名称不能为空").max(256),
    category: z.enum(["fabric", "trim", "packaging", "sample", "remnant"]),
    sub_category: z.string().optional(),
    unit: z.string().default("yard"),
    spec: z.record(z.unknown()).optional(),
    safety_stock_qty: z.number().min(0).optional(),
    lead_time_days: z.number().int().min(0).max(365).optional(),
  }),

  reserveMaterial: z.object({
    color_id: z.string().uuid().nullable().optional(),
    qty: z.number().positive("数量必须大于0"),
    warehouse: z.string().optional(),
  }),

  // ── V4: BOM ──────────────────────────────────────────
  createBOM: z.object({
    style_number: z.string().min(1, "款号不能为空"),
    product_type: z.string().min(1, "产品类型不能为空"),
    size_category: z.enum(["missy", "junior", "plus"]).default("missy"),
    lines: z.array(z.object({
      material_id: z.string().uuid(),
      color_id: z.string().uuid().nullable().optional(),
      size_group: z.string().default("all"),
      usage_qty: z.number().positive(),
      usage_unit: z.string().default("yard"),
      waste_pct: z.number().min(0).max(50).default(3),
      is_critical: z.boolean().default(true),
      notes: z.string().optional(),
    })).optional(),
  }),

  // ── V4: Procurement ──────────────────────────────────
  createSupplier: z.object({
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(256),
    category: z.enum(["fabric", "trim", "packaging", "logistics", "other"]).default("fabric"),
    contact_name: z.string().optional(),
    contact_phone: z.string().optional(),
    contact_email: z.string().email().optional().or(z.literal("")),
    payment_terms: z.string().optional(),
    lead_time_days: z.number().int().min(0).optional(),
  }),

  createPO: z.object({
    po_number: z.string().min(1).max(64),
    supplier_id: z.string().uuid(),
    order_id: z.string().uuid().nullable().optional(),
    expected_date: z.string().min(1, "预计到货日期不能为空"),
    notes: z.string().optional(),
    lines: z.array(z.object({
      material_id: z.string().uuid(),
      color_id: z.string().uuid().nullable().optional(),
      qty_ordered: z.number().positive(),
      unit_price: z.number().min(0),
    })).min(1, "至少需要一条采购明细"),
  }),

  receivePO: z.object({
    lines: z.array(z.object({
      line_id: z.string().uuid(),
      qty_received: z.number().min(0),
      qty_rejected: z.number().min(0).default(0),
    })).min(1),
  }),

  // ── V4: Quality ──────────────────────────────────────
  createInspection: z.object({
    order_id: z.string().uuid().nullable().optional(),
    factory_id: z.string().uuid().nullable().optional(),
    inspection_type: z.enum(["pp_sample", "shipping_sample", "inline", "final", "third_party"]),
    inspector: z.string().optional(),
    inspection_date: z.string().optional(),
    total_qty_inspected: z.number().int().min(0).default(0),
    total_defects: z.number().int().min(0).default(0),
    aql_level: z.string().default("2.5"),
    result: z.enum(["pending", "pass", "fail", "conditional"]).default("pending"),
    notes: z.string().optional(),
    defects: z.array(z.object({
      defect_code: z.string(),
      severity: z.enum(["critical", "major", "minor"]).default("minor"),
      qty: z.number().int().positive().default(1),
      location: z.string().optional(),
      photo_url: z.string().optional(),
      notes: z.string().optional(),
    })).optional(),
  }),

  createRework: z.object({
    order_id: z.string().uuid().nullable().optional(),
    inspection_id: z.string().uuid().nullable().optional(),
    factory_id: z.string().uuid().nullable().optional(),
    rework_qty: z.number().int().positive(),
    rework_reason: z.string().optional(),
    defect_codes: z.array(z.string()).optional(),
    estimated_days: z.number().int().min(0).optional(),
    cost: z.number().min(0).optional(),
    responsible_party: z.enum(["factory", "material", "design", "customer"]).default("factory"),
    impact_on_delivery: z.boolean().default(false),
    delay_days: z.number().int().min(0).default(0),
  }),

  updateRework: z.object({
    status: z.enum(["pending", "in_progress", "completed", "waived"]).optional(),
    actual_days: z.number().int().min(0).optional(),
    cost: z.number().min(0).optional(),
    delay_days: z.number().int().min(0).optional(),
  }).refine((d) => Object.keys(d).length > 0, { message: "至少需要一个字段" }),

  upsertFinancials: z.object({
    order_id: z.string().uuid(),
    revenue: z.number().min(0).optional(),
    fabric_cost: z.number().min(0).optional(),
    trim_cost: z.number().min(0).optional(),
    cmt_cost: z.number().min(0).optional(),
    rework_cost: z.number().min(0).optional(),
    freight_cost: z.number().min(0).optional(),
    duty_cost: z.number().min(0).optional(),
    compensation_cost: z.number().min(0).optional(),
    other_cost: z.number().min(0).optional(),
    gross_margin_pct: z.number().optional(),
    status: z.enum(["estimated", "actual", "closed"]).optional(),
  }),

  // ── V4: Orders V2 ────────────────────────────────────
  createOrderV2: z.object({
    order_number: z.string().min(1).max(64),
    customer_id: z.string().uuid().nullable().optional(),
    style_number: z.string().optional(),
    product_type: z.string().min(1, "产品类型不能为空"),
    total_qty: z.number().int().positive("数量必须大于0"),
    unit_price: z.number().min(0).optional(),
    currency: z.string().default("USD"),
    due_date: z.string().optional(),
    ship_date: z.string().optional(),
    season: z.string().optional(),
    priority: z.number().int().min(0).max(100).default(0),
  }),

  // ── V4: LLM Question ─────────────────────────────────
  llmQuestion: z.object({
    question: z.string().min(1, "问题不能为空").max(2000, "问题最长 2000 字符"),
  }),

  // ── V5-C: Import Gateway ─────────────────────────────
  importUpload: z.object({
    filename: z.string().min(1).max(255),
    file_size_bytes: z.number().int().nonnegative().optional(),
    file_hash: z.string().max(128).optional(),
    sheet_name: z.string().max(128).optional(),
    headers: z.array(z.string()).min(1).max(200),
    // Each row keyed by external header. Max 5000 rows per upload.
    rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
    // Optional hints
    suggested_import_type: z.enum(["daily_report", "hanging_line", "qc", "rework", "generic"]).optional(),
    factory_id: z.string().uuid().optional(),
  }),
  importConfirm: z.object({
    column_mappings: z.array(z.object({
      external_header: z.string(),
      internal_field: z.string().nullable(),
    })).min(1),
    save_as_template: z.boolean().optional(),
    template_name: z.string().max(128).optional(),
  }),
  importResolveMapping: z.object({
    resolved_internal_type: z.string().min(1).max(32),
    resolved_internal_id: z.string().min(1).max(128),
  }),

  // ── V4: Customer CRUD ────────────────────────────────
  createCustomer: z.object({
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    country: z.string().max(64).optional(),
    payment_terms: z.string().max(64).optional(),
    vip_level: z.enum(["platinum", "gold", "silver", "standard"]).default("standard"),
    credit_limit: z.number().nonnegative().optional(),
    payment_cycle_days: z.number().int().min(0).max(365).optional(),
    risk_level: z.enum(["low", "medium", "high"]).default("low"),
    notes: z.string().max(2000).optional(),
  }),
  updateCustomer: z.object({
    name: z.string().min(1).max(200).optional(),
    country: z.string().max(64).optional(),
    payment_terms: z.string().max(64).optional(),
    vip_level: z.enum(["platinum", "gold", "silver", "standard"]).optional(),
    credit_limit: z.number().nonnegative().optional(),
    payment_cycle_days: z.number().int().min(0).max(365).optional(),
    risk_level: z.enum(["low", "medium", "high"]).optional(),
    notes: z.string().max(2000).optional(),
  }).refine((d) => Object.keys(d).length > 0, "至少填写一个字段"),

  // ── Factory create ───────────────────────────────────
  createFactory: z.object({
    name: z.string().min(1).max(200),
    location: z.string().max(200).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    status: z.enum(["active", "inactive", "maintenance"]).default("active"),
    cooperation_score: z.number().min(0).max(100).optional(),
    quality_score: z.number().min(0).max(100).optional(),
    delay_score: z.number().min(0).max(100).optional(),
  }),

  // ── V5-A: Runtime Core ────────────────────────────────
  runtimeLineUpdate: z.object({
    factory_id: z.string().uuid().optional(),
    current_order_id: z.string().nullish(),
    current_allocation_id: z.string().uuid().nullish(),
    current_operation: z.string().max(64).nullish(),
    runtime_status: z.enum(["idle", "running", "blocked", "rework", "changeover", "down"]).optional(),
    current_efficiency: z.number().nonnegative().max(5).optional(),
    actual_output_today: z.number().int().nonnegative().optional(),
    expected_output_today: z.number().int().nonnegative().optional(),
    overload_pct: z.number().nonnegative().max(500).optional(),
    runtime_risk: z.enum(["green", "amber", "red"]).optional(),
    planned_end_at: z.string().datetime().nullish(),
    expected_version: z.number().int().nonnegative().optional(),
  }),

  runtimeEventCreate: z.object({
    event_type: z.enum([
      "material_delayed", "line_slowdown", "rework_started", "qc_failure",
      "factory_shutdown", "labor_shortage", "shipment_risk",
      "vip_inserted", "overtime_started", "allocation_completed", "line_status_changed",
      "reschedule_applied", "rollback_applied", "simulation_run",
    ]),
    severity: z.enum(["critical", "high", "medium", "low", "info"]).default("medium"),
    source: z.enum(["human", "sensor", "agent", "scheduler", "system", "external_api"]).default("human"),
    source_ref: z.string().max(128).optional(),
    factory_id: z.string().uuid().nullish(),
    line_id: z.string().uuid().nullish(),
    allocation_id: z.string().uuid().nullish(),
    order_id: z.string().nullish(),
    payload: z.record(z.string(), z.unknown()).default({}),
    reasoning: z.string().max(2000).optional(),
    confidence: z.number().min(0).max(1).optional(),
    correlation_id: z.string().uuid().optional(),
    caused_by_event_id: z.string().uuid().optional(),
    occurred_at: z.string().datetime().optional(),
  }),

  runtimePropagate: z.object({
    origin_node: z.object({
      // Generic manufacturing — free-form lowercase identifier so industries
      // (apparel/furniture/electronics) can introduce new node types without
      // a schema migration. Must be snake_case alnum, 1-32 chars.
      node_type: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, "node_type must be snake_case (a-z, 0-9, _), 1-32 chars"),
      ref_id: z.string().min(1),
    }),
    severity: z.enum(["critical", "high", "medium", "low", "info"]).default("medium"),
    estimated_delay_days: z.number().nonnegative().optional(),
    max_depth: z.number().int().min(1).max(20).optional(),
    decay: z.number().min(0).max(1).optional(),
    min_impact: z.number().min(0).max(1).optional(),
  }),

  runtimeReschedule: z.object({
    line_id: z.string().uuid(),
    conflict_type: z.enum(["overload", "blocked", "slowdown"]),
    delay_days: z.number().int().min(0).max(30).optional(),
    reason: z.string().max(500).optional(),
  }),

  runtimeInsert: z.object({
    allocation_id: z.string().uuid(),
    order_id: z.string().min(1),
    factory_id: z.string().uuid().optional(),
    qty: z.number().int().positive(),
    due_date: z.string(),
    priority: z.number().int().min(0).max(1000).optional(),
    urgency: z.enum(["critical", "high", "medium", "low"]).optional(),
    product_type: z.string().optional(),
  }),

  runtimeSimulate: z.object({
    events: z.array(z.object({
      event_type: z.string(),
      severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
      line_id: z.string().uuid().nullish(),
      allocation_id: z.string().uuid().nullish(),
      payload: z.record(z.string(), z.unknown()).optional(),
    })).min(1).max(100),
  }),

  runtimeRollback: z.object({
    snapshot_id: z.string().uuid(),
    apply: z.boolean().default(false),   // false = preview, true = apply
  }),

  runtimeReplay: z.object({
    since_seq: z.number().int().nonnegative().optional(),
    until_seq: z.number().int().nonnegative().optional(),
    factory_id: z.string().uuid().optional(),
  }),

  // ── V4: Anomaly review feedback ──────────────────────
  reviewAnomaly: z.object({
    review_reason: z.enum([
      "confirmed_real_issue",
      "data_entry_error",
      "material_issue",
      "factory_execution_issue",
      "customer_change",
      "ignored",
    ]),
    notes: z.string().max(2000).optional(),
    // Snapshot fields — caller passes what the detector returned, so we can
    // persist the verdict even if the underlying data later changes.
    snapshot: z.object({
      anomaly_type: z.enum(["output_low", "output_high", "persistent_dip"]),
      severity: z.enum(["critical", "high", "medium", "low"]).default("medium"),
      factory_id: z.string().uuid().nullish(),
      allocation_id: z.string().uuid().nullish(),
      order_id: z.string().nullish(),
      report_date: z.string().nullish(),
      z_score: z.number().nullish(),
      rolling_mean: z.number().nullish(),
      actual_output: z.number().nullish(),
    }),
    // Optional: if user chose "create incident", caller passes this back
    escalated_incident_id: z.string().uuid().nullish(),
  }),
};
