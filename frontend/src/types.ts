// ── Database row types (matching Supabase schema) ────────

export type Factory = {
  id: string;
  name: string;
  location: string | null;
  lat: number | null;
  lng: number | null;
  status: "active" | "inactive" | "maintenance";
  cooperation_score: number | null;
  quality_score: number | null;
  delay_score: number | null;
  created_at: string;
  // joined
  factory_capabilities: FactoryCapability[];
};

export type FactoryCapability = {
  id: string;
  factory_id: string;
  product_type: string;
  daily_capacity: number;
  efficiency_rate: number | null;
  overtime_factor: number | null;
  updated_at: string | null;
};

export type AllocationStatus = "planned" | "confirmed" | "in_progress" | "completed" | "cancelled";

export type Allocation = {
  id: string;
  order_id: string | null;
  factory_id: string;
  planned_start_date: string;
  planned_end_date: string;
  allocated_qty: number;
  status: AllocationStatus;
  recommendation_score: number | null;
  is_locked: boolean | null;
  created_at: string;
  // joined
  factories: { id: string; name: string } | null;
};

export type GeoFence = {
  id: string;
  factory_id: string;
  lat: number | null;
  lng: number | null;
  radius: number | null;
  // derived by backend for convenience
  center: { lat: number; lng: number } | null;
  // joined
  factories: { id: string; name: string } | null;
};

export type VisitTask = {
  id: string;
  factory_id: string;
  order_id: string | null;
  task_type: string;
  status: "open" | "in_progress" | "done" | "blocked" | "cancelled";
  priority: number;
  created_at: string;
};

// ── Risk alerts ─────────────────────────────────────────

export type RiskLevel = "SAFE" | "MEDIUM" | "HIGH";

export type RiskAlert = {
  id: string;
  allocation_id: string;
  risk_level: RiskLevel;
  buffer_days: number;
  message: string | null;
  created_at: string;
  // joined
  production_allocations?: {
    order_id: string | null;
    allocated_qty: number;
    factory_id: string;
    factories: { id: string; name: string } | null;
  } | null;
};

export type RiskSummary = {
  HIGH: number;
  MEDIUM: number;
  SAFE: number;
  total: number;
};

// ── Scheduler types ──────────────────────────────────────

export type Recommendation = {
  factory_id: string;
  factory_name: string;
  score: number;
  feasible: boolean;
  timing: { production_minutes: number; setup_minutes: number; total_minutes: number };
  load: { utilization_pct: number; allocated_minutes_window: number; capacity_minutes_window: number };
  score_breakdown: Record<string, number>;
  assumptions: Record<string, unknown>;
};

export type RiskResult = {
  level: "SAFE" | "MEDIUM" | "HIGH";
  buffer_days: number;
  message?: string;
};

// ── Optimizer types ─────────────────────────────────────

export type OptimizedAllocation = {
  order_id: string;
  factory_id: string;
  factory_name: string;
  allocated_qty: number;
  planned_start_date: string;
  planned_end_date: string;
  buffer_days: number;
  feasible: boolean;
  confidence_score: number;
  score_breakdown: Record<string, number>;
  timing: { production_minutes: number; setup_minutes: number; total_minutes: number };
  new_utilization_pct: number;
  reason: string;
  split_index?: number;
  split_total_qty?: number;
};

export type OptimizerWarning = {
  type: "unassigned" | "order_split" | "split_incomplete";
  order_id: string;
  message: string;
  suggestion: "source_new_factory" | "negotiate_delay" | "review_split" | "manual_review";
  details?: Record<string, unknown>;
};

export type OptimizerSummary = {
  total_orders: number;
  assigned: number;
  unassigned: number;
  feasible: number;
  infeasible: number;
  splits: number;
  warnings_count: number;
  avg_confidence: number;
  factory_load: Record<string, {
    factory_name: string;
    orders: number;
    total_minutes: number;
    utilization_pct: number;
  }>;
};

export type OptimizerResult = {
  allocations: OptimizedAllocation[];
  warnings: OptimizerWarning[];
  unassigned: Array<{ id: string; quantity: number; reason: string }>;
  summary: OptimizerSummary;
  persisted?: Array<{ order_id: string; persisted: boolean; error: string | null }>;
};

export type OptimizerPreview = {
  pending_orders: number;
  total_quantity: number;
  product_types: string[];
  available_factories: number;
  total_factories: number;
};

// ── Production Lines ────────────────────────────────────

export type ProductionLine = {
  id: string;
  factory_id: string;
  name: string;
  front_capacity_per_day: number;
  back_capacity_per_day: number;
  status: string;
  created_at: string;
  factories: { id: string; name: string } | null;
};

export type LineSchedule = {
  id: string;
  line_id: string;
  allocation_id: string;
  process: "front" | "back";
  start_date: string;
  end_date: string;
  status: string;
  seq: number;
  created_at: string;
  production_lines?: ProductionLine | null;
  production_allocations?: { id: string; order_id: string; allocated_qty: number; status: string } | null;
};
