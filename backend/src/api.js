import express from "express";
import cors from "cors";
import { recommendFactories } from "./scheduler/recommend.js";
import { checkRisk } from "./scheduler/risk.js";
import { supabase } from "./supabase.js";
import factoriesRouter from "./routes/factories.js";
import allocationsRouter from "./routes/allocations.js";
import geofencesRouter from "./routes/geofences.js";
import risksRouter from "./routes/risks.js";
import performanceRouter from "./routes/performance.js";
import optimizerRouter from "./routes/optimizer.js";
import pilotRouter from "./routes/pilot.js";

const app = express();
app.use(cors());
app.use(express.json());

// ── Pilot mode ───────────────────────────────────────────
const PILOT_MODE = process.env.PILOT_MODE === "true";

if (PILOT_MODE) {
  console.log("⚡ PILOT MODE active — restricted route policy in effect");
}

// Route-level allowlist: which POST/PATCH/DELETE routes are safe in pilot mode.
// Everything not listed here is blocked when PILOT_MODE=true.
const PILOT_ALLOWED_WRITES = new Set([
  // Audit logging — always writable (that's the whole point)
  "POST /api/pilot/audit",
  // Read-only POST endpoints that don't modify production data
  "POST /api/optimizer/run",      // body checked below for dry_run
  "POST /api/risks/scan",        // analysis only, writes to risk_alerts (acceptable)
  "POST /api/recommend",         // compute-only, no DB
  "POST /api/risk",              // compute-only, no DB
  "POST /api/geofences/generate-tasks", // creates visit tasks (low risk)
]);

function pilotGuard(req, res, next) {
  if (!PILOT_MODE) return next();

  // All reads pass
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();

  // Check route-level allowlist
  const routeKey = `${req.method} ${req.path}`;
  if (PILOT_ALLOWED_WRITES.has(routeKey)) {
    // Special check: optimizer run must be dry_run
    if (routeKey === "POST /api/optimizer/run" && req.body?.options?.dry_run === false) {
      console.log(`[PILOT] Blocked optimizer confirm: ${req.method} ${req.path}`);
      return res.status(403).json({
        error: "Pilot mode: optimizer confirm (dry_run=false) is disabled.",
        pilot_mode: true,
      });
    }
    return next();
  }

  // Check role-based override: admin can bypass in pilot mode
  const role = req.headers["x-pilot-role"];
  if (role === "admin") {
    console.log(`[PILOT] Admin override: ${req.method} ${req.path}`);
    return next();
  }

  console.log(`[PILOT] Blocked: ${req.method} ${req.path}`);
  return res.status(403).json({
    error: "Pilot mode: this write operation is not allowed.",
    pilot_mode: true,
    method: req.method,
    path: req.path,
    hint: "Set x-pilot-role: admin header to override, or wait for pilot mode to be disabled.",
  });
}

app.use("/api", pilotGuard);

// ── Routes ───────────────────────────────────────────────
app.use("/api/factories", factoriesRouter);
app.use("/api/allocations", allocationsRouter);
app.use("/api/geofences", geofencesRouter);
app.use("/api/risks", risksRouter);
app.use("/api/performance", performanceRouter);
app.use("/api/optimizer", optimizerRouter);
app.use("/api/pilot", pilotRouter);

// ── Health check ─────────────────────────────────────────
app.get("/api/health", async (_req, res) => {
  const checks = {
    api: true,
    supabase: false,
    pilot_mode: PILOT_MODE,
    timestamp: new Date().toISOString(),
  };
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
  if (!order || !factories) {
    return res.status(400).json({ error: "order and factories are required" });
  }
  const result = recommendFactories(order, factories, options);
  res.json(result);
});

app.post("/api/risk", (req, res) => {
  const { order, allocation, options } = req.body;
  if (!order || !allocation) {
    return res.status(400).json({ error: "order and allocation are required" });
  }
  const result = checkRisk(order, allocation, options);
  res.json(result);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
