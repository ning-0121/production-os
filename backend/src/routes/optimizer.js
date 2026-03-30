import { Router } from "express";
import { randomUUID } from "crypto";
import { addDays } from "date-fns";
import { supabase } from "../supabase.js";
import { optimizeSchedule } from "../scheduler/optimizer.js";
import { auditLog } from "../governance/audit.js";

const router = Router();

// ── Locked statuses: optimizer cannot touch these ───────
const LOCKED_STATUSES = new Set(["in_progress", "completed", "cancelled"]);
// Statuses safe for optimizer to overwrite
const OPTIMIZABLE_STATUSES = new Set(["planned"]);

// ── In-memory idempotency cache (TTL 5 min) ────────────
const idempotencyCache = new Map();
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

function cleanIdempotencyCache() {
  const now = Date.now();
  for (const [key, entry] of idempotencyCache) {
    if (now - entry.timestamp > IDEMPOTENCY_TTL_MS) idempotencyCache.delete(key);
  }
}

/**
 * POST /api/optimizer/run
 *
 * Body:
 *   orders?:      Array of {id, product_type, quantity, due_date, priority?}
 *   factory_ids?: Array of factory UUIDs (default: all active)
 *   options?:     {
 *     horizon_days?: number,
 *     dry_run?: boolean,         // default true — set false to persist
 *     run_id?: string,           // optional idempotency key
 *     force_update?: boolean,    // if true, re-optimize "confirmed" orders too
 *   }
 *
 * Persistence summary (when dry_run=false):
 *   persisted: {
 *     run_id:  string,
 *     created: number,   // planned → confirmed (first time)
 *     updated: number,   // confirmed → re-confirmed (force_update)
 *     skipped: number,   // already locked (in_progress/completed) or idempotent
 *     failed:  number,   // DB write error
 *     details: Array<{ order_id, action, error? }>
 *   }
 */
router.post("/run", async (req, res) => {
  try {
    const { options = {} } = req.body;
    const horizonDays = Number(options.horizon_days ?? 30);
    const dryRun = options.dry_run !== false;
    const forceUpdate = options.force_update === true;
    const runId = options.run_id ?? randomUUID();

    // ── Idempotency check ───────────────────────────────
    cleanIdempotencyCache();
    if (options.run_id && idempotencyCache.has(options.run_id)) {
      const cached = idempotencyCache.get(options.run_id);
      return res.json({ ...cached.result, idempotent_hit: true });
    }

    // ── 1. Load orders ──────────────────────────────────
    let orders = req.body.orders;
    let preFilterSummary = null;

    if (!orders || orders.length === 0) {
      // Load from DB — only planned orders (optimizer's input set)
      const targetStatuses = forceUpdate ? ["planned", "confirmed"] : ["planned"];
      const { data: allocs, error } = await supabase
        .from("production_allocations")
        .select("id, factory_id, product_type, quantity, start_at, end_at, status, priority, order_external_id, assumptions")
        .in("status", targetStatuses)
        .order("priority", { ascending: false });

      if (error) return res.status(500).json({ error: error.message });

      // Pre-filter: skip orders that were already optimized by this same run_id
      const raw = allocs ?? [];
      const filtered = [];
      let skippedIdempotent = 0;

      for (const a of raw) {
        const prevRunId = a.assumptions?.optimizer_run_id;
        if (prevRunId === runId) {
          skippedIdempotent++;
          continue;
        }
        filtered.push(a);
      }

      orders = filtered.map((a) => ({
        id: a.id,
        product_type: a.product_type,
        quantity: Number(a.quantity),
        due_date: a.end_at,
        priority: a.priority ?? 0,
        order_external_id: a.order_external_id,
        _current_status: a.status,
      }));

      if (skippedIdempotent > 0) {
        preFilterSummary = { skipped_idempotent: skippedIdempotent };
      }
    }

    if (orders.length === 0) {
      return res.json({
        allocations: [],
        warnings: [],
        unassigned: [],
        summary: {
          total_orders: 0, assigned: 0, unassigned: 0, feasible: 0,
          infeasible: 0, splits: 0, warnings_count: 0, avg_confidence: 0, factory_load: {},
        },
        ...(preFilterSummary ? { pre_filter: preFilterSummary } : {}),
      });
    }

    // ── 2. Load factories ───────────────────────────────
    let factoryQuery = supabase
      .from("factories")
      .select("*, factory_capabilities(*)")
      .eq("status", "active");

    if (req.body.factory_ids?.length > 0) {
      factoryQuery = factoryQuery.in("id", req.body.factory_ids);
    }

    const { data: rawFactories, error: facErr } = await factoryQuery;
    if (facErr) return res.status(500).json({ error: facErr.message });

    // ── 3. Compute existing load ────────────────────────
    const windowEnd = addDays(new Date(), horizonDays).toISOString();
    const { data: existingAllocs } = await supabase
      .from("production_allocations")
      .select("factory_id, quantity, product_type, start_at, end_at")
      .in("status", ["confirmed", "in_progress"])
      .lte("start_at", windowEnd);

    const loadByFactory = {};
    for (const ea of existingAllocs ?? []) {
      if (!loadByFactory[ea.factory_id]) loadByFactory[ea.factory_id] = 0;
      const fac = rawFactories.find((f) => f.id === ea.factory_id);
      if (fac) {
        const cap = (fac.factory_capabilities ?? []).find((c) => c.product_type === ea.product_type);
        if (cap) {
          loadByFactory[ea.factory_id] += (Number(cap.setup_minutes) || 0) + Number(ea.quantity) * (Number(cap.minutes_per_unit) || 0);
        }
      }
    }

    // ── 4. Build factory inputs ─────────────────────────
    const factories = rawFactories.map((f) => {
      const dailyMinutes = 8 * 60;
      const capacityWindow = dailyMinutes * horizonDays;
      const allocated = loadByFactory[f.id] ?? 0;
      return {
        id: f.id,
        name: f.name,
        capabilities: (f.factory_capabilities ?? []).map((c) => ({
          id: c.id,
          product_type: c.product_type,
          setup_minutes: Number(c.setup_minutes),
          minutes_per_unit: Number(c.minutes_per_unit),
          base_capacity_units_per_day: Number(c.base_capacity_units_per_day),
          cost_per_unit: c.cost_per_unit != null ? Number(c.cost_per_unit) : null,
          quality_score: c.quality_score != null ? Number(c.quality_score) : null,
        })),
        capacity: { daily_capacity_minutes: dailyMinutes },
        load: {
          allocated_minutes_next_30d: allocated,
          utilization_pct: Math.min(100, (allocated / Math.max(1, capacityWindow)) * 100),
        },
      };
    });

    // ── 5. Run optimizer ────────────────────────────────
    const result = optimizeSchedule({ orders, factories, options });

    auditLog({
      action: dryRun ? "optimizer.preview" : "optimizer.confirm",
      category: "optimizer",
      result_status: "success",
      req,
      run_id: runId,
      detail: {
        dry_run: dryRun,
        orders_count: orders.length,
        factories_count: factories.length,
        assigned: result.summary.assigned,
        unassigned: result.summary.unassigned,
        warnings: result.summary.warnings_count,
      },
    });

    // ── 6. Persist with safeguards ──────────────────────
    if (!dryRun && result.allocations.length > 0) {
      result.persisted = await persistAllocations(result.allocations, runId, forceUpdate);

      auditLog({
        action: "optimizer.persist",
        category: "optimizer",
        result_status: result.persisted.failed > 0 ? "partial" : "success",
        req,
        run_id: runId,
        detail: {
          created: result.persisted.created,
          updated: result.persisted.updated,
          skipped: result.persisted.skipped,
          failed: result.persisted.failed,
        },
      });
    }

    if (preFilterSummary) {
      result.pre_filter = preFilterSummary;
    }

    idempotencyCache.set(runId, { result, timestamp: Date.now() });

    res.json(result);
  } catch (err) {
    auditLog({ action: "optimizer.run", category: "optimizer", result_status: "failed", req, error_code: "unhandled_error", detail: { error: err.message } });
    console.error("Optimizer error:", err);
    res.status(500).json({ error: err.message ?? "Optimizer failed" });
  }
});

/**
 * GET /api/optimizer/preview
 */
router.get("/preview", async (_req, res) => {
  const { data: planned, error: e1 } = await supabase
    .from("production_allocations")
    .select("id, product_type, quantity, end_at, priority")
    .eq("status", "planned");

  const { data: factories, error: e2 } = await supabase
    .from("factories")
    .select("id, name, factory_capabilities(product_type)")
    .eq("status", "active");

  if (e1 || e2) return res.status(500).json({ error: (e1 ?? e2).message });

  const productTypes = new Set((planned ?? []).map((p) => p.product_type));
  const capableFactories = (factories ?? []).filter((f) =>
    (f.factory_capabilities ?? []).some((c) => productTypes.has(c.product_type)),
  );

  res.json({
    pending_orders: (planned ?? []).length,
    total_quantity: (planned ?? []).reduce((s, p) => s + Number(p.quantity), 0),
    product_types: [...productTypes],
    available_factories: capableFactories.length,
    total_factories: (factories ?? []).length,
  });
});

// ── Hardened persistence ────────────────────────────────

async function persistAllocations(allocations, runId, forceUpdate) {
  const summary = {
    run_id: runId,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  // 1. Batch-load current state of all target order IDs
  const orderIds = [...new Set(allocations.map((a) => a.order_id))];
  const { data: currentRows, error: loadErr } = await supabase
    .from("production_allocations")
    .select("id, status, assumptions")
    .in("id", orderIds);

  if (loadErr) {
    summary.failed = allocations.length;
    summary.details = allocations.map((a) => ({
      order_id: a.order_id,
      action: "failed",
      error: `Batch load failed: ${loadErr.message}`,
    }));
    return summary;
  }

  const currentById = {};
  for (const row of currentRows ?? []) {
    currentById[row.id] = row;
  }

  // 2. Process each allocation
  for (const alloc of allocations) {
    const current = currentById[alloc.order_id];

    // ── Guard: row doesn't exist ────────────────────────
    if (!current) {
      summary.skipped++;
      summary.details.push({
        order_id: alloc.order_id,
        action: "skipped",
        reason: "order_not_found",
      });
      continue;
    }

    // ── Guard: already locked (in_progress / completed / cancelled)
    if (LOCKED_STATUSES.has(current.status)) {
      summary.skipped++;
      summary.details.push({
        order_id: alloc.order_id,
        action: "skipped",
        reason: `locked_status_${current.status}`,
      });
      continue;
    }

    // ── Guard: already optimized by this same run_id ────
    if (current.assumptions?.optimizer_run_id === runId) {
      summary.skipped++;
      summary.details.push({
        order_id: alloc.order_id,
        action: "skipped",
        reason: "idempotent_duplicate",
      });
      continue;
    }

    // ── Determine action ────────────────────────────────
    const isPlanned = current.status === "planned";
    const isConfirmed = current.status === "confirmed";

    if (isConfirmed && !forceUpdate) {
      // Already confirmed by a previous run — don't touch unless force_update
      summary.skipped++;
      summary.details.push({
        order_id: alloc.order_id,
        action: "skipped",
        reason: "already_confirmed",
      });
      continue;
    }

    // ── Write with optimistic lock ──────────────────────
    // The .eq("status", ...) acts as a compare-and-swap:
    // if another request changed the status between our read and this write, the
    // update matches zero rows and returns null — we detect and report it.
    const acceptableStatuses = isConfirmed ? ["confirmed"] : ["planned"];

    const { data, error } = await supabase
      .from("production_allocations")
      .update({
        factory_id: alloc.factory_id,
        start_at: alloc.planned_start_date,
        end_at: alloc.planned_end_date,
        status: "confirmed",
        assumptions: {
          scheduled_by: "optimizer",
          optimizer_run_id: runId,
          optimizer_ran_at: new Date().toISOString(),
          confidence_score: alloc.confidence_score,
          reason: alloc.reason,
          previous_status: current.status,
        },
        score_breakdown: alloc.score_breakdown,
      })
      .eq("id", alloc.order_id)
      .in("status", acceptableStatuses)  // optimistic lock
      .select("id, factory_id, status, start_at, end_at")
      .maybeSingle();

    if (error) {
      summary.failed++;
      summary.details.push({
        order_id: alloc.order_id,
        action: "failed",
        error: error.message,
      });
      continue;
    }

    if (!data) {
      // Optimistic lock failed — status changed between read and write
      summary.skipped++;
      summary.details.push({
        order_id: alloc.order_id,
        action: "skipped",
        reason: "concurrent_modification",
      });
      continue;
    }

    // Success
    if (isConfirmed) {
      summary.updated++;
      summary.details.push({
        order_id: alloc.order_id,
        action: "updated",
        factory_id: alloc.factory_id,
      });
    } else {
      summary.created++;
      summary.details.push({
        order_id: alloc.order_id,
        action: "created",
        factory_id: alloc.factory_id,
      });
    }
  }

  return summary;
}

export default router;
