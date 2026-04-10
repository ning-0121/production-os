/**
 * Incidents API — 事故管理
 */

import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { auditLog } from "../governance/audit.js";

const router = Router();

// GET /api/incidents — 事故列表
router.get("/", asyncHandler(async (req, res) => {
  const status = req.query.status;
  let query = supabase
    .from("incidents")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  if (status && status !== "all") {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
}));

// POST /api/incidents — 创建事故（可从异常升级）
router.post("/", asyncHandler(async (req, res) => {
  const { incident_type, severity, factory_id, line_id, order_id, description, estimated_delay_days } = req.body;

  if (!incident_type || !description) {
    return res.status(400).json({ error: "incident_type and description are required" });
  }

  // Create incident
  const { data: incident, error: incErr } = await supabase
    .from("incidents")
    .insert({
      incident_type,
      severity: severity ?? "medium",
      factory_id: factory_id ?? null,
      line_id: line_id ?? null,
      order_id: order_id ?? null,
      description,
      estimated_delay_days: estimated_delay_days ?? 0,
      created_by: req.pilotIdentity?.operator ?? "anonymous",
      status: "open",
    })
    .select()
    .single();

  if (incErr) return res.status(400).json({ error: incErr.message });

  // Auto-analyze impacted orders
  if (factory_id) {
    const { data: affected } = await supabase
      .from("production_allocations")
      .select("id, order_id, allocated_qty, planned_end_date")
      .eq("factory_id", factory_id)
      .in("status", ["confirmed", "in_progress"]);

    if (affected && affected.length > 0) {
      const impacts = affected.map((a) => ({
        incident_id: incident.id,
        affected_order_id: a.order_id ?? a.id,
        allocation_id: a.id,
        impact_type: "delay",
        estimated_delay_days: estimated_delay_days ?? 0,
      }));

      await supabase.from("incident_impacts").insert(impacts);

      // Update incident with count
      await supabase
        .from("incidents")
        .update({ affected_order_count: affected.length })
        .eq("id", incident.id);
    }
  }

  auditLog({
    action: "incident.create",
    category: "incident",
    result_status: "success",
    req,
    detail: { incident_id: incident.id, type: incident_type, severity },
  });

  res.status(201).json(incident);
}));

// GET /api/incidents/:id/impacts — 影响分析
router.get("/:id/impacts", asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("incident_impacts")
    .select("*, production_allocations(id, order_id, allocated_qty, factory_id, planned_end_date, status)")
    .eq("incident_id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
}));

// POST /api/incidents/:id/resolve — 解决事故
router.post("/:id/resolve", asyncHandler(async (req, res) => {
  const resolver = req.pilotIdentity?.operator ?? "anonymous";
  const { data, error } = await supabase
    .from("incidents")
    .update({
      status: "resolved",
      resolved_by: resolver,
      resolved_at: new Date().toISOString(),
      resolution_notes: req.body.notes ?? null,
    })
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  auditLog({
    action: "incident.resolve",
    category: "incident",
    result_status: "success",
    req,
    detail: { incident_id: req.params.id, resolved_by: resolver },
  });

  res.json(data);
}));

export default router;
