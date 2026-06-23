/**
 * Shopfloor Execution API — /api/shopfloor/*
 *
 * The floor-facing endpoints used by the mobile Supervisor Console. Reports
 * flow through the service into the AI brain (runtime events → lines → tasks).
 */

import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validate, schemas } from "../middleware/validate.js";
import { auditLog } from "../governance/audit.js";
import {
  createWorkOrder, listWorkOrders, transitionWorkOrder,
  reportOutput, reportDefect, reportBlocked, shopfloorSummary,
} from "../shopfloor/service.js";
import { legalActions, progressPct } from "../shopfloor/state-machine.js";

const router = Router();

// GET /api/shopfloor/work-orders?assigned_to=&status=&today=true
router.get("/work-orders", asyncHandler(async (req, res) => {
  const wos = await listWorkOrders(supabase, {
    assigned_to: req.query.assigned_to,
    status: req.query.status,
    line_id: req.query.line_id,
    factory_id: req.query.factory_id,
    today: req.query.today === "true",
    limit: req.query.limit,
  });
  res.json({
    count: wos.length,
    work_orders: wos.map((w) => ({ ...w, progress_pct: progressPct(w), legal_actions: legalActions(w.status) })),
  });
}));

// GET /api/shopfloor/summary
router.get("/summary", asyncHandler(async (req, res) => {
  const summary = await shopfloorSummary(supabase, {
    assigned_to: req.query.assigned_to,
    factory_id: req.query.factory_id,
    line_id: req.query.line_id,
    today: req.query.today !== "false",
  });
  res.json(summary);
}));

// POST /api/shopfloor/work-orders
router.post("/work-orders", validate(schemas.createWorkOrder), asyncHandler(async (req, res) => {
  const wo = await createWorkOrder(supabase, { ...req.body, created_by: req.pilotIdentity?.operator ?? "system" });
  auditLog({ action: "shopfloor.create_wo", category: "system", result_status: "success", req, detail: { id: wo.id } });
  res.status(201).json(wo);
}));

// PATCH /api/shopfloor/work-orders/:id/status
router.patch("/work-orders/:id/status", validate(schemas.workOrderTransition), asyncHandler(async (req, res) => {
  const { action, ...payload } = req.body;
  const result = await transitionWorkOrder(supabase, req.params.id, action, {
    ...payload, actor: req.pilotIdentity?.operator ?? "system", requestId: req.requestId,
  });
  if (!result.ok) {
    if (result.conflict) return res.status(409).json({ error: "version conflict" });
    return res.status(400).json({ error: result.error });
  }
  auditLog({ action: `shopfloor.${action}`, category: "system", result_status: "success", req, detail: { id: req.params.id, action } });
  res.json(result);
}));

// POST /api/shopfloor/work-orders/:id/report-output
router.post("/work-orders/:id/report-output", validate(schemas.reportOutput), asyncHandler(async (req, res) => {
  const result = await reportOutput(supabase, req.params.id, req.body, { actor: req.pilotIdentity?.operator ?? "system", requestId: req.requestId });
  if (!result.ok) {
    if (result.conflict) return res.status(409).json({ error: "version conflict", conflict: true });
    return res.status(400).json({ error: result.error });
  }
  auditLog({ action: "shopfloor.report_output", category: "system", result_status: "success", req, detail: { id: req.params.id, output: req.body.output_qty, events: result.events?.length ?? 0 } });
  res.json(result);
}));

// POST /api/shopfloor/work-orders/:id/report-defect
router.post("/work-orders/:id/report-defect", validate(schemas.reportDefect), asyncHandler(async (req, res) => {
  const result = await reportDefect(supabase, req.params.id, req.body, { actor: req.pilotIdentity?.operator ?? "system", requestId: req.requestId });
  if (!result.ok) return res.status(400).json({ error: result.error });
  auditLog({ action: "shopfloor.report_defect", category: "system", result_status: "success", req, detail: { id: req.params.id, defect: req.body.defect_qty } });
  res.json(result);
}));

// POST /api/shopfloor/work-orders/:id/report-blocked
router.post("/work-orders/:id/report-blocked", validate(schemas.reportBlocked), asyncHandler(async (req, res) => {
  const result = await reportBlocked(supabase, req.params.id, req.body, { actor: req.pilotIdentity?.operator ?? "system", requestId: req.requestId });
  if (!result.ok) return res.status(400).json({ error: result.error });
  auditLog({ action: "shopfloor.report_blocked", category: "system", result_status: "success", req, detail: { id: req.params.id, reason: req.body.reason, task: result.task?.id ?? null } });
  res.json(result);
}));

export default router;
