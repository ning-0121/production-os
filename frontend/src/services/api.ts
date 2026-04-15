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
  CommandOverview,
  DailyProductionReport,
  DailyReportSummary,
  ExceptionItem,
  ExceptionV2Response,
  Factory,
  GeoFence,
  OptimizerPreview,
  OptimizerResult,
  OrderCorrection,
  Recommendation,
  RiskAlert,
  RiskResult,
  RiskSummary,
  TodayBriefing,
  AIAction,
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

export function fetchProductionLines(factoryId?: string): Promise<import("../types").ProductionLine[]> {
  const qs = factoryId ? `?factory_id=${factoryId}` : "";
  return request(`/lines${qs}`);
}

export function createProductionLine(data: {
  factory_id: string;
  name: string;
  front_capacity_per_day?: number;
  back_capacity_per_day?: number;
}): Promise<import("../types").ProductionLine> {
  return request("/lines", { method: "POST", body: JSON.stringify(data) });
}

export function updateProductionLine(id: string, data: Partial<{
  name: string;
  front_capacity_per_day: number;
  back_capacity_per_day: number;
  status: string;
}>): Promise<import("../types").ProductionLine> {
  return request(`/lines/${id}`, { method: "PATCH", body: JSON.stringify(data) });
}

export function fetchLineSchedules(): Promise<import("../types").LineSchedule[]> {
  return request("/lines/schedules");
}

export type AutoScheduleSummary = {
  order_id: string;
  product_type: string;
  qty: number;
  line_name: string;
  front: { start: string; end: string; days: number };
  back: { start: string; end: string; days: number; capacity_per_day: number };
  risk: { level: "SAFE" | "MEDIUM" | "HIGH"; buffer_days: number; due_date: string | null };
};

export function autoScheduleLine(params: {
  line_id: string;
  allocation_id: string;
  front_days: number;
}): Promise<{
  scheduled: import("../types").LineSchedule[];
  summary: AutoScheduleSummary;
}> {
  return request("/lines/auto-schedule", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function dryRunAutoSchedule(params: {
  line_id: string;
  allocation_id: string;
  front_days: number;
}): Promise<{
  dry_run: true;
  summary: AutoScheduleSummary;
}> {
  return request("/lines/auto-schedule", {
    method: "POST",
    body: JSON.stringify({ ...params, dry_run: true }),
  });
}

export function batchScheduleLines(dryRun = true): Promise<{
  assignments: Array<{
    order_id: string;
    allocation_id: string;
    product_type: string;
    qty: number;
    due_date: string;
    line_id: string;
    line_name: string;
    front: { start: string; end: string; days: number };
    back: { start: string; end: string; days: number };
    delivery_ok: boolean;
    days_late: number;
    days_early: number;
  }>;
  warnings: Array<{ order_id?: string; type: string; message: string }>;
  summary: { total_orders: number; scheduled: number; unscheduled: number; on_time: number; at_risk: number; line_load: Record<string, { orders: number; qty: number }> };
  persisted?: boolean;
  dry_run?: boolean;
}> {
  return request("/lines/batch-schedule", {
    method: "POST",
    body: JSON.stringify({ dry_run: dryRun }),
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

// ── V2: Daily Reports ───────────────────────────────────

export function submitDailyReport(report: Omit<DailyProductionReport, "id" | "created_at">): Promise<DailyProductionReport> {
  return request("/daily-reports", { method: "POST", body: JSON.stringify(report) });
}

export function submitDailyReportsBatch(reports: Array<Omit<DailyProductionReport, "id" | "created_at">>): Promise<{ created: number; failed: number }> {
  return request("/daily-reports/batch", { method: "POST", body: JSON.stringify({ reports }) });
}

export function fetchDailyReports(params?: { date?: string; factory_id?: string }): Promise<DailyProductionReport[]> {
  const qs = new URLSearchParams();
  if (params?.date) qs.set("date", params.date);
  if (params?.factory_id) qs.set("factory_id", params.factory_id);
  const q = qs.toString();
  return request(`/daily-reports${q ? `?${q}` : ""}`);
}

export function fetchUnreportedFactories(date?: string): Promise<Array<{ id: string; name: string }>> {
  const d = date ?? new Date().toISOString().slice(0, 10);
  return request(`/daily-reports/unreported?date=${d}`);
}

export function fetchDailyReportSummary(date?: string): Promise<DailyReportSummary> {
  const d = date ?? new Date().toISOString().slice(0, 10);
  return request(`/daily-reports/summary?date=${d}`);
}

// ── V2: Corrections ─────────────────────────────────────

export function computeCorrections(): Promise<{ computed: number; warnings: number }> {
  return request("/corrections/compute", { method: "POST" });
}

export function fetchOrderCorrections(allocationId: string): Promise<OrderCorrection[]> {
  return request(`/daily-reports?allocation_id=${allocationId}`);
  // Note: corrections are queried through daily-reports or a separate endpoint
}

// ── V2: Exceptions ──────────────────────────────────────

export async function fetchExceptions(): Promise<ExceptionItem[]> {
  const res = await request<{ exceptions: ExceptionItem[] } | ExceptionItem[]>("/exceptions");
  if (Array.isArray(res)) return res;
  if (res && typeof res === "object" && "exceptions" in res && Array.isArray(res.exceptions)) return res.exceptions;
  return [];
}

// ── V2: Command Center ──────────────────────────────────

export function fetchCommandOverview(): Promise<CommandOverview> {
  return request("/command/overview");
}

// ── V3: Today Briefing ─────────────────────────────────

export function fetchTodayBriefing(): Promise<TodayBriefing> {
  return request("/today/briefing");
}

// ── V3: Exceptions V2 ──────────────────────────────────

export function fetchExceptionsV2(): Promise<ExceptionV2Response> {
  return request("/exceptions/v2");
}

// ── V3: AI Agents ──────────────────────────────────────

export function runRiskPrediction(): Promise<{ agent: string; actions: AIAction[]; reasoning: string }> {
  return request("/agents/risk-predict", { method: "POST" });
}

// ── V3: Schedule Drafts ────────────────────────────────

export function fetchDrafts(): Promise<Array<Record<string, unknown>>> {
  return request("/drafts");
}

export function createDraft(data: {
  allocation_id: string;
  line_id: string;
  front_start: string;
  front_end: string;
  front_days: number;
  back_start: string;
  back_end: string;
  back_days: number;
  risk_level: string;
  buffer_days: number;
}): Promise<Record<string, unknown>> {
  return request("/drafts", { method: "POST", body: JSON.stringify(data) });
}

export function confirmDraft(draftId: string): Promise<{ confirmed: boolean }> {
  return request(`/drafts/${draftId}/confirm`, { method: "POST" });
}

export function rejectDraft(draftId: string): Promise<Record<string, unknown>> {
  return request(`/drafts/${draftId}/reject`, { method: "POST" });
}

// ── V3: AI Action Execution ────────────────────────────

export function saveAIActions(actions: AIAction[]): Promise<{ saved: number }> {
  return request("/ai-actions", { method: "POST", body: JSON.stringify({ actions }) });
}

export function executeAIAction(id: string): Promise<{ executed: boolean; result: { success: boolean; message: string } }> {
  return request(`/ai-actions/${id}/execute`, { method: "POST" });
}

export function rejectAIAction(id: string): Promise<Record<string, unknown>> {
  return request(`/ai-actions/${id}/reject`, { method: "POST" });
}

// ── V3: Scenarios ──────────────────────────────────────

export type Scenario = {
  id: string;
  scenario_type: string;
  scenario_label: string;
  description?: string;
  target_factory_name: string | null;
  expected_finish_date: string | null;
  risk_level: string;
  buffer_days: number;
  cost_change_pct: number;
  impact_summary: string;
  impacted_orders: Array<{ order_id: string; impact_type: string; estimated_delay_days: number }>;
  recommendation_score: number;
  recommendation_reason: string;
  status: string;
};

export function fetchScenarios(allocationId: string): Promise<{ scenarios: Scenario[] }> {
  return request(`/orders/${allocationId}/scenarios`);
}

export function applyScenario(allocationId: string, scenarioId: string, reason?: string): Promise<{ applied: boolean }> {
  return request(`/orders/${allocationId}/scenarios/${scenarioId}/apply`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

// ── V3: Override Stats ─────────────────────────────────

export function fetchOverrideStats(period?: string): Promise<{
  adoption_rate_pct: number;
  total_overrides: number;
  total_decisions: number;
  most_overridden_scenario: { type: string; count: number } | null;
}> {
  return request(`/overrides/stats${period ? `?period=${period}` : ""}`);
}

// ── V3: Incidents ──────────────────────────────────────

export function fetchIncidents(): Promise<Array<Record<string, unknown>>> {
  return request("/incidents");
}

export function createIncident(data: {
  incident_type: string;
  severity: string;
  factory_id?: string;
  description: string;
  estimated_delay_days?: number;
}): Promise<Record<string, unknown>> {
  return request("/incidents", { method: "POST", body: JSON.stringify(data) });
}

export function resolveIncident(id: string, notes?: string): Promise<Record<string, unknown>> {
  return request(`/incidents/${id}/resolve`, { method: "POST", body: JSON.stringify({ notes }) });
}

// ── V3: Memory ─────────────────────────────────────────

export function fetchMemoryProfile(entityType: string, entityId: string): Promise<Array<{ metric_type: string; value: number; sample_count: number; trend: string }>> {
  return request(`/memory/${entityType}/${entityId}`);
}

export function refreshMemory(): Promise<{ refreshed: number }> {
  return request("/memory/refresh", { method: "POST" });
}

// ── V3: Forecasts ──────────────────────────────────────

export function fetchForecasts(type?: string): Promise<Array<Record<string, unknown>>> {
  return request(`/forecasts${type ? `?type=${type}` : ""}`);
}

export function runForecasts(): Promise<{ total: number; capacity_risks: number; late_orders: number; bottleneck_days: number }> {
  return request("/forecasts/run", { method: "POST" });
}

export function fetchBottlenecks(horizon?: number): Promise<Array<Record<string, unknown>>> {
  return request(`/forecasts/bottlenecks${horizon ? `?horizon=${horizon}` : ""}`);
}

// ── V3: Automation ─────────────────────────────────────

export function runAutomationScan(): Promise<{ scanned: number; triggered: number; actions: AIAction[] }> {
  return request("/automation/scan", { method: "POST" });
}

export function fetchAutomationLogs(): Promise<Array<Record<string, unknown>>> {
  return request("/automation/logs");
}

export function fetchWatchlist(): Promise<Array<{ id: string; entity_type: string; entity_id: string; reason: string; status: string; escalation_deadline: string | null }>> {
  return request("/automation/watchlist");
}

export function addToWatchlist(data: { entity_type: string; entity_id: string; reason: string; escalation_hours?: number }): Promise<Record<string, unknown>> {
  return request("/automation/watchlist", { method: "POST", body: JSON.stringify(data) });
}

// ── V4: Orders V2 ──────────────────────────────────────

export function fetchOrdersV2(params?: { status?: string; product_type?: string }): Promise<Array<Record<string, unknown>>> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.product_type) qs.set("product_type", params.product_type);
  const q = qs.toString();
  return request(`/orders-v2${q ? `?${q}` : ""}`);
}

export function createOrderV2(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  return request("/orders-v2", { method: "POST", body: JSON.stringify(data) });
}

// ── V4: Materials ──────────────────────────────────────

export function fetchMaterials(category?: string): Promise<Array<Record<string, unknown>>> {
  return request(`/materials${category ? `?category=${category}` : ""}`);
}

export function createMaterial(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  return request("/materials", { method: "POST", body: JSON.stringify(data) });
}

export function fetchMaterialInventory(materialId: string): Promise<Array<Record<string, unknown>>> {
  return request(`/materials/${materialId}/inventory`);
}

export function fetchBOM(styleNumber: string): Promise<Array<Record<string, unknown>>> {
  return request(`/materials/bom/${styleNumber}`);
}

export function createBOM(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  return request("/materials/bom", { method: "POST", body: JSON.stringify(data) });
}

export function checkMaterialReadiness(orderId: string): Promise<{ ready: boolean; critical_shortages: number; requirements: Array<Record<string, unknown>> }> {
  return request("/materials/readiness/check", { method: "POST", body: JSON.stringify({ order_id: orderId }) });
}

// ── V4: Procurement ────────────────────────────────────

export function fetchSuppliers(): Promise<Array<Record<string, unknown>>> {
  return request("/procurement/suppliers");
}

export function createSupplier(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  return request("/procurement/suppliers", { method: "POST", body: JSON.stringify(data) });
}

export function fetchPurchaseOrders(status?: string): Promise<Array<Record<string, unknown>>> {
  return request(`/procurement/purchase-orders${status ? `?status=${status}` : ""}`);
}

export function createPurchaseOrder(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  return request("/procurement/purchase-orders", { method: "POST", body: JSON.stringify(data) });
}

export function receivePurchaseOrder(poId: string, lines: Array<{ line_id: string; qty_received: number; qty_rejected?: number }>): Promise<Record<string, unknown>> {
  return request(`/procurement/purchase-orders/${poId}/receive`, { method: "PATCH", body: JSON.stringify({ lines }) });
}

export function fetchFabricInspections(): Promise<Array<Record<string, unknown>>> {
  return request("/procurement/inspections");
}

export function createFabricInspection(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  return request("/procurement/inspections", { method: "POST", body: JSON.stringify(data) });
}

// ── V4: Quality ────────────────────────────────────────

export function fetchQCInspections(params?: { order_id?: string; factory_id?: string; type?: string }): Promise<Array<Record<string, unknown>>> {
  const qs = new URLSearchParams();
  if (params?.order_id) qs.set("order_id", params.order_id);
  if (params?.factory_id) qs.set("factory_id", params.factory_id);
  if (params?.type) qs.set("type", params.type);
  const q = qs.toString();
  return request(`/quality/inspections${q ? `?${q}` : ""}`);
}

export function createQCInspection(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  return request("/quality/inspections", { method: "POST", body: JSON.stringify(data) });
}

export function fetchDefectLibrary(): Promise<Array<Record<string, unknown>>> {
  return request("/quality/defects/library");
}

export function fetchReworks(status?: string): Promise<Array<Record<string, unknown>>> {
  return request(`/quality/reworks${status ? `?status=${status}` : ""}`);
}

export function createRework(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  return request("/quality/reworks", { method: "POST", body: JSON.stringify(data) });
}

export function updateRework(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  return request(`/quality/reworks/${id}`, { method: "PATCH", body: JSON.stringify(data) });
}

export function fetchOrderFinancials(orderId: string): Promise<Record<string, unknown>> {
  return request(`/quality/financials/${orderId}`);
}

export function upsertOrderFinancials(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  return request("/quality/financials", { method: "POST", body: JSON.stringify(data) });
}

// ── V4: Profit Dashboard ───────────────────────────────

export type ProfitDashboard = {
  kpi: {
    total_revenue: number;
    total_cost: number;
    gross_profit: number;
    gross_margin_pct: number;
    rework_loss: number;
    freight_loss: number;
    low_margin_count: number;
    negative_count: number;
    total_orders: number;
  };
  orders: Array<{
    order_id: string;
    order_number: string;
    product_type: string;
    customer_name: string;
    customer_vip: string;
    revenue: number;
    fabric_cost: number;
    trim_cost: number;
    cmt_cost: number;
    rework_cost: number;
    freight_cost: number;
    duty_cost: number;
    compensation_cost: number;
    total_cost: number;
    gross_profit: number;
    margin_pct: number;
    risk_tag: string;
    status: string;
  }>;
  customers: Array<{
    name: string;
    revenue: number;
    cost: number;
    profit: number;
    margin_pct: number;
    orders: number;
    rework_cost: number;
  }>;
  factories: Array<{
    factory_id: string;
    name: string;
    quality_score: number;
    delay_score: number;
    rework_cost: number;
  }>;
  insights: AIAction[];
};

export function fetchProfitDashboard(): Promise<ProfitDashboard> {
  return request("/profit/dashboard");
}

// ── V4: Material Agent ─────────────────────────────────

// ── V4: LLM Agent ──────────────────────────────────────

export function askProductionAgent(question: string): Promise<{
  answer: string;
  tools_used: string[];
  tokens: number;
}> {
  return request("/agents/ask", { method: "POST", body: JSON.stringify({ question }) });
}

export function runMaterialCheck(): Promise<{ actions: AIAction[]; reasoning: string }> {
  return request("/agents/material-check", { method: "POST" });
}

export function runProgressCorrection(): Promise<{
  agent: string;
  actions: AIAction[];
  reasoning: string;
  stats: { on_track: number; falling_behind: number; critical: number; total: number };
}> {
  return request("/agents/correct", { method: "POST" });
}
