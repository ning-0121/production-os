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

// ── CRUD routes ──────────────────────────────────────────
app.use("/api/factories", factoriesRouter);
app.use("/api/allocations", allocationsRouter);
app.use("/api/geofences", geofencesRouter);
app.use("/api/risks", risksRouter);
app.use("/api/performance", performanceRouter);
app.use("/api/optimizer", optimizerRouter);

// ── Health check ─────────────────────────────────────────
app.get("/api/health", async (_req, res) => {
  const checks = { api: true, supabase: false, timestamp: new Date().toISOString() };
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
