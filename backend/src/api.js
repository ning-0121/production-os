import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { recommendFactories } from "./scheduler/recommend.js";
import { checkRisk } from "./scheduler/risk.js";
import { supabase } from "./supabase.js";
import { can, resolveAction, resolveRole } from "./governance/policy.js";
import { auditLog } from "./governance/audit.js";
import { authMiddleware } from "./middleware/auth.js";
import { errorHandler } from "./middleware/errorHandler.js";
import factoriesRouter from "./routes/factories.js";
import allocationsRouter from "./routes/allocations.js";
import geofencesRouter from "./routes/geofences.js";
import risksRouter from "./routes/risks.js";
import performanceRouter from "./routes/performance.js";
import optimizerRouter from "./routes/optimizer.js";
import pilotRouter from "./routes/pilot.js";
import importRouter from "./routes/import.js";
import batchRouter from "./routes/batch.js";
import dashboardRouter from "./routes/dashboard.js";
import linesRouter from "./routes/lines.js";
import dailyReportsRouter from "./routes/daily-reports.js";
import exceptionsRouter from "./routes/exceptions.js";
import commandRouter from "./routes/command.js";
import exceptionsV2Router from "./routes/exceptions-v2.js";
import agentsRouter from "./routes/agents.js";
import todayRouter from "./routes/today.js";
import { computeCorrections } from "./scheduler/correction.js";
import { asyncHandler } from "./middleware/asyncHandler.js";

// supabase.js validates SUPABASE_URL + SUPABASE_SERVICE_KEY at import time

const app = express();

// ── Global middleware ───────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ── Rate limiting ───────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "请求过于频繁，请稍后再试", code: "RATE_LIMIT" },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "写入操作过于频繁，请稍后再试", code: "WRITE_RATE_LIMIT" },
});

app.use("/api", globalLimiter);
app.use("/api", (req, res, next) => {
  if (req.method === "POST" || req.method === "PATCH" || req.method === "DELETE") {
    return writeLimiter(req, res, next);
  }
  next();
});

// ── Authentication ──────────────────────────────────────
app.use("/api", authMiddleware);

// ── Pilot mode ───────────────────────────────────────────
const PILOT_MODE = process.env.PILOT_MODE === "true";
if (PILOT_MODE) console.log("⚡ PILOT MODE active");

// ── Policy enforcement middleware ────────────────────────
// Replaces the old allowlist. Uses the central policy engine.

app.use("/api", (req, res, next) => {
  if (!PILOT_MODE) return next();

  // Resolve who is making the request
  const identity = resolveRole(req);

  // Resolve what they're trying to do
  const action = resolveAction(req.method, req.path, req.body);

  // Attach to request for downstream use
  req.pilotIdentity = identity;
  req.pilotAction = action;

  // Unknown action on a write → block
  if (!action && req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    console.log(`[PILOT] Blocked unknown: ${req.method} ${req.path} (${identity.role})`);
    return res.status(403).json({
      error: "Pilot mode: unrecognized write operation blocked.",
      pilot_mode: true, method: req.method, path: req.path,
    });
  }

  // Check policy
  const decision = can(identity.role, action, { pilot_mode: true });

  if (!decision.allowed) {
    auditLog({
      action: action ?? "unknown",
      category: "system",
      result_status: "blocked",
      req,
      error_code: "policy_denied",
      detail: { reason: decision.reason, method: req.method, path: req.path, role: identity.role },
    });
    return res.status(403).json({
      error: decision.reason,
      pilot_mode: true,
      action,
      role: identity.role,
    });
  }

  next();
});

// Attach identity to all requests (even when not in pilot mode)
app.use("/api", (req, _res, next) => {
  if (!req.pilotIdentity) {
    req.pilotIdentity = resolveRole(req);
    req.pilotAction = resolveAction(req.method, req.path, req.body);

    // Log role-fallback events for visibility
    if (req.pilotIdentity.auth_method === "default" && req.method !== "GET" && req.method !== "OPTIONS") {
      auditLog({
        action: "role.fallback",
        category: "system",
        result_status: "success",
        req,
        error_code: "no_role_header",
        detail: { method: req.method, path: req.path, defaulted_to: req.pilotIdentity.role },
      });
    }
  }
  next();
});

// ── Routes ───────────────────────────────────────────────
app.use("/api/factories", factoriesRouter);
app.use("/api/allocations", allocationsRouter);
app.use("/api/geofences", geofencesRouter);
app.use("/api/risks", risksRouter);
app.use("/api/performance", performanceRouter);
app.use("/api/optimizer", optimizerRouter);
app.use("/api/pilot", pilotRouter);
app.use("/api/import", importRouter);
app.use("/api/batch", batchRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/lines", linesRouter);
app.use("/api/daily-reports", dailyReportsRouter);
app.use("/api/exceptions", exceptionsRouter);
app.use("/api/command", commandRouter);
app.use("/api/exceptions/v2", exceptionsV2Router);
app.use("/api/agents", agentsRouter);
app.use("/api/today", todayRouter);

// ── Correction engine ───────────────────────────────────
app.post("/api/corrections/compute", asyncHandler(async (_req, res) => {
  const result = await computeCorrections(supabase);
  res.json(result);
}));

// ── Health check ─────────────────────────────────────────
app.get("/api/health", async (_req, res) => {
  const checks = { api: true, supabase: false, pilot_mode: PILOT_MODE, timestamp: new Date().toISOString() };
  try {
    const { error } = await supabase.from("factories").select("id").limit(1);
    checks.supabase = !error;
    if (error) checks.supabase_error = error.message;
  } catch (err) {
    checks.supabase_error = err.message;
  }
  res.json(checks);
});

// ── Scheduler endpoints (compute-only, no DB) ───────────
app.post("/api/recommend", (req, res) => {
  const { order, factories, options } = req.body;
  if (!order || !factories) return res.status(400).json({ error: "order and factories are required" });
  res.json(recommendFactories(order, factories, options));
});

app.post("/api/risk", (req, res) => {
  const { order, allocation, options } = req.body;
  if (!order || !allocation) return res.status(400).json({ error: "order and allocation are required" });
  res.json(checkRisk(order, allocation, options));
});

// ── Global error handler (must be last) ──────────────────
app.use(errorHandler);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend on http://localhost:${PORT}`));
