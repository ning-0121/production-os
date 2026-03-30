// ── Database row types (matching Supabase schema) ────────

export type Factory = {
  id: string;
  code: string;
  name: string;
  status: "active" | "inactive" | "maintenance";
  address: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  timezone: string;
  work_calendar: Record<string, unknown>;
  ai_profile: Record<string, unknown>;
  constraints: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // joined
  factory_capabilities: FactoryCapability[];
};

export type FactoryCapability = {
  id: string;
  factory_id: string;
  product_type: string;
  process_type: string;
  base_capacity_units_per_day: number;
  setup_minutes: number;
  minutes_per_unit: number;
  cost_per_unit: number | null;
  quality_score: number | null;
  features: Record<string, unknown>;
};

export type AllocationStatus = "planned" | "confirmed" | "in_progress" | "completed" | "cancelled";

export type Allocation = {
  id: string;
  factory_id: string;
  capability_id: string | null;
  order_external_id: string | null;
  product_type: string;
  quantity: number;
  start_at: string;
  end_at: string;
  status: AllocationStatus;
  priority: number;
  assumptions: Record<string, unknown>;
  score_breakdown: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // joined
  factories: { id: string; name: string; code: string } | null;
};

export type GeoFence = {
  id: string;
  factory_id: string;
  name: string;
  fence_type: "radius" | "polygon";
  center: { lat: number; lng: number } | null;
  radius_meters: number | null;
  is_active: boolean;
  notification_prefs: Record<string, unknown>;
  metadata: Record<string, unknown>;
  // joined
  factories: { id: string; name: string; code: string } | null;
};

export type VisitTask = {
  id: string;
  factory_id: string;
  title: string;
  description: string | null;
  task_type: string;
  status: "open" | "in_progress" | "done" | "blocked" | "cancelled";
  priority: number;
  due_at: string | null;
  assigned_to: string | null;
  allocation_id: string | null;
  metadata: Record<string, unknown>;
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
    product_type: string;
    quantity: number;
    factory_id: string;
    factories: { id: string; name: string; code: string } | null;
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
  order_external_id: string | null;
  factory_id: string;
  factory_name: string;
  product_type: string;
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
  unassigned: Array<{ id: string; product_type: string; quantity: number; reason: string }>;
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
