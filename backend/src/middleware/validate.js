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
};
