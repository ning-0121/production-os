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

const app = express();
app.use(cors());
app.use(express.json());

// ── Pilot mode (defense in depth) ────────────────────────
// Set PILOT_MODE=true to block all write operations server-side.
const PILOT_MODE = process.env.PILOT_MODE === "true";

if (PILOT_MODE) {
  console.log("⚡ PILOT MODE active — write endpoints will return 403");
}

// Middleware: block writes in pilot mode
function pilotGuard(req, res, next) {
  if (!PILOT_MODE) return next();

  // Allow all reads
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();

  // Allow dry-run optimizer (no persistence)
  if (req.path.includes("/optimizer/run") && req.body?.options?.dry_run !== false) return next();

  // Allow risk scan (read-only analysis)
  if (req.path.includes("/risks/scan")) return next();

  // Allow health check
  if (req.path.includes("/health")) return next();

  // Block all other writes
  console.log(`[PILOT] Blocked: ${req.method} ${req.path}`);
  return res.status(403).json({
    error: "Pilot mode: write operations are disabled.",
    pilot_mode: true,
    method: req.method,
    path: req.path,
  });
}

app.use("/api", pilotGuard);

// ── CRUD routes ──────────────────────────────────────────
app.use("/api/factories", factoriesRouter);
app.use("/api/allocations", allocationsRouter);
app.use("/api/geofences", geofencesRouter);
app.use("/api/risks", risksRouter);
app.use("/api/performance", performanceRouter);
app.use("/api/optimizer", optimizerRouter);

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
