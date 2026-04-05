/**
 * Domain API functions.
 *
 * Every function is a thin wrapper around client.request().
 * No URL logic, no error handling details — those live in client.ts.
 *
 * Re-exports client utilities that consumers need.
 */

import { request } from "./client";
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

// Re-export client utilities for consumers
export { checkHealth, runVerification } from "./client";
export type { ApiHealth, VerificationResult, EndpointCheck } from "./client";

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
  data: Partial<{ daily_capacity: number; efficiency_rate: number; overtime_factor: number; product_type: string }>,
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
  factory_id?: string;
  allocated_qty: number;
  planned_start_date: string;
  planned_end_date: string;
  status?: AllocationStatus;
  order_id?: string;
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

// ── Production Lines ────────────────────────────────────

export function fetchProductionLines(): Promise<import("../types").ProductionLine[]> {
  return request("/lines");
}

export function fetchLineSchedules(): Promise<import("../types").LineSchedule[]> {
  return request("/lines/schedules");
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
