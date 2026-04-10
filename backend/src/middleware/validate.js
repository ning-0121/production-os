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
};
