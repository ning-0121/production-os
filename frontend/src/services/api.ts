import type {
  Allocation,
  AllocationStatus,
  Factory,
  GeoFence,
  OptimizerPreview,
  OptimizerResult,
  Recommendation,
  RiskAlert,
  RiskResult,
  RiskSummary,
  VisitTask,
} from "../types";

// ── API Base URL ─────────────────────────────────────────
// In dev: Vite proxy forwards /api → localhost:3001 (no env var needed)
// In production: set VITE_API_URL to the deployed backend URL
//   e.g. VITE_API_URL=https://production-os-api.railway.app/api

const BASE = import.meta.env.VITE_API_URL ?? "/api";

// ── Connection health ───────────────────────────────────

export type ApiHealth = {
  reachable: boolean;
  latency_ms: number;
  error?: string;
};

let _lastHealth: ApiHealth | null = null;

export async function checkApiHealth(): Promise<ApiHealth> {
  const start = Date.now();
  try {
    const res = await fetch(`${BASE}/factories`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    const latency = Date.now() - start;
    // If we got HTML back, the API isn't actually reachable
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      _lastHealth = { reachable: false, latency_ms: latency, error: `Expected JSON, got ${contentType}. Is VITE_API_URL set?` };
      return _lastHealth;
    }
    _lastHealth = { reachable: res.ok, latency_ms: latency, error: res.ok ? undefined : `HTTP ${res.status}` };
    return _lastHealth;
  } catch (err) {
    _lastHealth = { reachable: false, latency_ms: Date.now() - start, error: err instanceof Error ? err.message : "Network error" };
    return _lastHealth;
  }
}

export function getLastHealth(): ApiHealth | null {
  return _lastHealth;
}

// ── Request wrapper ─────────────────────────────────────

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  // Guard: if response is HTML (Vercel rewrite), treat as API unreachable
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json") && res.status !== 204) {
    throw new Error("API returned HTML instead of JSON. Backend may be unreachable.");
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

// ── Factories ────────────────────────────────────────────

export function fetchFactories(): Promise<Factory[]> {
  return request("/factories");
}

export function fetchFactory(id: string): Promise<Factory> {
  return request(`/factories/${id}`);
}

export function updateFactory(id: string, data: Partial<Factory>): Promise<Factory> {
  return request(`/factories/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function updateCapability(
  id: string,
  data: Partial<{ base_capacity_units_per_day: number; quality_score: number; cost_per_unit: number }>,
): Promise<unknown> {
  return request(`/factories/capabilities/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

// ── Allocations ──────────────────────────────────────────

export function fetchAllocations(params?: {
  status?: AllocationStatus;
  factory_id?: string;
}): Promise<Allocation[]> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.factory_id) qs.set("factory_id", params.factory_id);
  const q = qs.toString();
  return request(`/allocations${q ? `?${q}` : ""}`);
}

export function createAllocation(data: {
  factory_id: string;
  product_type: string;
  quantity: number;
  start_at: string;
  end_at: string;
  status?: AllocationStatus;
  priority?: number;
  order_external_id?: string;
}): Promise<Allocation> {
  return request("/allocations", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateAllocation(
  id: string,
  data: Partial<Allocation>,
): Promise<Allocation> {
  return request(`/allocations/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function deleteAllocation(id: string): Promise<void> {
  return request(`/allocations/${id}`, { method: "DELETE" });
}

// ── Smart Scheduling ─────────────────────────────────────

export function smartRecommend(
  allocationId: string,
  options?: Record<string, unknown>,
): Promise<Recommendation[]> {
  return request(`/allocations/${allocationId}/recommend`, {
    method: "POST",
    body: JSON.stringify({ options }),
  });
}

export function smartSchedule(
  allocationId: string,
  factoryId: string,
): Promise<Allocation> {
  return request(`/allocations/${allocationId}/schedule`, {
    method: "POST",
    body: JSON.stringify({ factory_id: factoryId }),
  });
}

// ── Geofences & Tasks ────────────────────────────────────

export function fetchGeofences(): Promise<GeoFence[]> {
  return request("/geofences");
}

export function fetchVisitTasks(factoryId: string): Promise<VisitTask[]> {
  return request(`/geofences/tasks?factory_id=${encodeURIComponent(factoryId)}`);
}

export function generateVisitTasks(factoryId: string): Promise<{
  generated: number;
  tasks: VisitTask[];
  factory_id: string;
  orders_scanned: number;
}> {
  return request("/geofences/generate-tasks", {
    method: "POST",
    body: JSON.stringify({ factory_id: factoryId }),
  });
}

export function updateVisitTask(
  id: string,
  data: Record<string, unknown>,
): Promise<VisitTask> {
  return request(`/geofences/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

// ── Risk Alerts ──────────────────────────────────────────

export function fetchRiskAlerts(): Promise<RiskAlert[]> {
  return request("/risks");
}

export function fetchRiskSummary(): Promise<RiskSummary> {
  return request("/risks/summary");
}

export function runRiskScan(): Promise<{
  scanned: number;
  summary: { HIGH: number; MEDIUM: number; SAFE: number };
  alerts: RiskAlert[];
}> {
  return request("/risks/scan", { method: "POST" });
}

// ── Optimizer ────────────────────────────────────────────

export function runOptimizer(params?: {
  orders?: Array<{ id: string; product_type: string; quantity: number; due_date: string; priority?: number }>;
  factory_ids?: string[];
  options?: { horizon_days?: number; dry_run?: boolean };
}): Promise<OptimizerResult> {
  return request("/optimizer/run", {
    method: "POST",
    body: JSON.stringify(params ?? {}),
  });
}

export function fetchOptimizerPreview(): Promise<OptimizerPreview> {
  return request("/optimizer/preview");
}

// ── Scheduler (compute-only) ─────────────────────────────

export function recommend(
  order: { product_type: string; quantity: number; due_date: string },
  factories: unknown[],
  options?: Record<string, unknown>,
): Promise<Recommendation[]> {
  return request("/recommend", {
    method: "POST",
    body: JSON.stringify({ order, factories, options }),
  });
}

export function checkRisk(
  order: { due_date: string },
  allocation: { planned_end_date: string },
  options?: Record<string, unknown>,
): Promise<RiskResult> {
  return request("/risk", {
    method: "POST",
    body: JSON.stringify({ order, allocation, options }),
  });
}
