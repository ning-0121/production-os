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
    product_type: z.string().min(1, "产品类型不能为空"),
    quantity: z.number().int().positive("数量必须大于0"),
    end_at: z.string().min(1, "交货日期不能为空"),
    start_at: z.string().optional(),
    factory_id: z.string().uuid().optional(),
    priority: z.number().int().min(0).max(10).optional(),
    status: z.enum(["planned", "confirmed", "in_progress", "completed", "cancelled"]).optional(),
    order_external_id: z.string().optional(),
    assumptions: z.record(z.unknown()).optional(),
  }),

  updateAllocation: z.object({
    status: z.enum(["planned", "confirmed", "in_progress", "completed", "cancelled"]).optional(),
    start_at: z.string().optional(),
    end_at: z.string().optional(),
    priority: z.number().int().min(0).max(10).optional(),
    factory_id: z.string().uuid().optional(),
    assumptions: z.record(z.unknown()).optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: "至少需要提供一个要更新的字段",
  }),

  updateFactory: z.object({
    name: z.string().min(1).optional(),
    status: z.enum(["active", "inactive", "maintenance"]).optional(),
    address: z.string().optional(),
    timezone: z.string().optional(),
    work_calendar: z.record(z.unknown()).optional(),
    ai_profile: z.record(z.unknown()).optional(),
    constraints: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: "至少需要提供一个要更新的字段",
  }),

  updateCapability: z.object({
    base_capacity_units_per_day: z.number().positive().optional(),
    minutes_per_unit: z.number().positive().optional(),
    quality_score: z.number().min(0).max(100).optional(),
    cost_per_unit: z.number().min(0).optional(),
    features: z.record(z.unknown()).optional(),
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
      product_type: z.string().min(1),
      quantity: z.number().int().positive(),
      end_at: z.string().min(1),
      start_at: z.string().optional(),
      priority: z.number().int().min(0).max(10).optional(),
      order_external_id: z.string().optional(),
    })).min(1, "至少需要一条订单").max(500, "单次最多导入500条"),
  }),
};
