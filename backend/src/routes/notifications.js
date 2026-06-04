/**
 * Notifications API — /api/notifications/*
 *
 * In-app notification inbox. Recipients are operators OR roles. The frontend
 * passes the current user's identity (email + known roles) so a person sees
 * both their personal notifications and their role's.
 */

import { Router } from "express";
import { supabase } from "../supabase.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

const router = Router();

/**
 * Build the recipient filter list from query + the authenticated identity.
 * Always includes the operator; optionally include role + any extra recipients.
 */
function recipientsFor(req) {
  const set = new Set();
  const operator = req.pilotIdentity?.operator;
  const role = req.pilotIdentity?.role;
  if (operator) set.add(operator);
  if (role) set.add(role);
  // Explicit extra recipients (e.g. "production_manager" queue the user watches)
  const extra = req.query.recipients;
  if (typeof extra === "string") {
    for (const r of extra.split(",").map((s) => s.trim()).filter(Boolean)) set.add(r);
  }
  return [...set];
}

// GET /api/notifications — list (optionally unread only)
router.get("/", asyncHandler(async (req, res) => {
  const recipients = recipientsFor(req);
  if (recipients.length === 0) return res.json({ count: 0, unread: 0, notifications: [] });

  let q = supabase.from("notification_events").select("*")
    .in("recipient", recipients)
    .order("created_at", { ascending: false })
    .limit(Math.min(100, Number(req.query.limit ?? 50)));
  if (req.query.unread === "true") q = q.is("read_at", null);

  const { data, error } = await q;
  if (error) throw error;

  // Unread count (separate, cheap, head count)
  const { count: unread } = await supabase
    .from("notification_events")
    .select("id", { count: "exact", head: true })
    .in("recipient", recipients)
    .is("read_at", null);

  res.json({ count: data?.length ?? 0, unread: unread ?? 0, notifications: data ?? [] });
}));

// GET /api/notifications/unread-count — just the badge number
router.get("/unread-count", asyncHandler(async (req, res) => {
  const recipients = recipientsFor(req);
  if (recipients.length === 0) return res.json({ unread: 0 });
  const { count } = await supabase
    .from("notification_events")
    .select("id", { count: "exact", head: true })
    .in("recipient", recipients)
    .is("read_at", null);
  res.json({ unread: count ?? 0 });
}));

// POST /api/notifications/:id/read — mark one read
router.post("/:id/read", asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("notification_events")
    .update({ read_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .is("read_at", null)
    .select()
    .maybeSingle();
  if (error) throw error;
  res.json({ ok: true, notification: data });
}));

// POST /api/notifications/read-all — mark all the user's unread read
router.post("/read-all", asyncHandler(async (req, res) => {
  const recipients = recipientsFor(req);
  if (recipients.length === 0) return res.json({ ok: true, marked: 0 });
  const { data, error } = await supabase
    .from("notification_events")
    .update({ read_at: new Date().toISOString() })
    .in("recipient", recipients)
    .is("read_at", null)
    .select("id");
  if (error) throw error;
  res.json({ ok: true, marked: data?.length ?? 0 });
}));

export default router;
