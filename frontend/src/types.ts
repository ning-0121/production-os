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

// ── V2: Daily Production Reports ────────────────────────
export type DailyProductionReport = {
  id: string;
  date: string;
  factory_id: string;
  line_id: string | null;
  allocation_id: string | null;
  order_id: string | null;
  planned_output: number;
  actual_output: number;
  cumulative_output: number | null;
  stage: string;
  is_abnormal: boolean;
  abnormal_reason: string | null;
  note: string | null;
  reporter: string | null;
  created_at: string;
};

export type OrderCorrection = {
  id: string;
  allocation_id: string;
  date: string;
  planned_cumulative: number;
  actual_cumulative: number;
  deviation_pct: number;
  estimated_end_date: string;
  risk_status: "on_track" | "falling_behind" | "critical";
  recommendations: Array<{ type: string; message: string; action?: string }>;
  created_at: string;
};

export type ExceptionItem = {
  type: "delayed" | "at_risk" | "overloaded" | "underperforming" | "unreported" | "unschedulable";
  severity: "high" | "medium" | "low";
  order_id?: string;
  factory_name?: string;
  line_name?: string;
  message: string;
  data?: Record<string, unknown>;
};

export type CommandOverview = {
  kpi: {
    active_orders: number;
    today_output: number;
    on_time_pct: number;
    abnormal_count: number;
    total_lines: number;
    reported_factories: number;
  };
  top_exceptions: ExceptionItem[];
  factory_report_status: Array<{ factory_id: string; name: string; reported: boolean }>;
  recent_trend: Array<{ date: string; output: number }>;
};

export type DailyReportSummary = {
  total_output: number;
  orders_reported: number;
  abnormal_count: number;
  factories_reported: number;
};

// ── V3: AI Agent Types ────────────────────────────────────

export type AIAction = {
  id: string;
  agent: string;
  action_type: string;
  target_type: string;
  target_id: string;
  summary: string;
  urgency: "critical" | "high" | "medium" | "low";
  impact: string;
  confidence: number;
  params: Record<string, unknown>;
};

export type ExceptionV2Response = {
  timestamp: string;
  order_exceptions: Array<ExceptionItem & { allocation_id?: string; factory_id?: string }>;
  factory_exceptions: Array<{ type: string; severity: string; factory_id: string; factory_name: string; message: string; data?: Record<string, unknown> }>;
  resource_exceptions: Array<{ type: string; severity: string; line_id?: string; line_name?: string; factory_id?: string; factory_name?: string; message: string; data?: Record<string, unknown> }>;
  incident_exceptions: Array<{ type: string; severity: string; factory_id?: string; order_id?: string; message: string; data?: Record<string, unknown> }>;
  ai_actions: AIAction[];
};

export type RiskyOrder = {
  allocation_id: string;
  order_id: string | null;
  factory_name: string;
  product_type: string;
  qty: number;
  due_date: string;
  days_left: number;
  status: string;
  risk: "overdue" | "critical" | "warning";
};

export type TodayBriefing = {
  timestamp: string;
  kpi: {
    active_orders: number;
    today_output: number;
    on_time_pct: number;
    abnormal_count: number;
    total_lines: number;
    reported_factories: number;
    total_factories: number;
    unscheduled_count: number;
  };
  risky_orders: RiskyOrder[];
  risky_factories: Array<{ factory_id: string; name: string; delay_score: number | null; quality_score: number | null; active_orders: number }>;
  available_lines: Array<{ line_id: string; name: string; factory_name: string; factory_id: string; scheduled_orders: number; front_capacity: number; back_capacity: number; load_level: string }>;
  missing_reports: Array<{ factory_id: string; name: string }>;
  unscheduled_orders: Array<{ allocation_id: string; order_id: string | null; product_type: string; qty: number; due_date: string; factory_name: string }>;
  trend: Array<{ date: string; output: number }>;
  ai_suggestions: AIAction[];
  anomaly_alerts: AnomalyAlert[];
  anomaly_stats: {
    groups_scanned: number;
    groups_with_stats: number;
    reports_scanned: number;
    anomalies_found: number;
    threshold_z: number;
    min_samples: number;
    after_review_filter: number;
    suppressed_by_review: number;
  };
};

// ── V4: Anomaly alerts (statistical detector) ─────────────

export type AnomalyType = "output_low" | "output_high" | "persistent_dip";

export type AnomalyReviewReason =
  | "confirmed_real_issue"
  | "data_entry_error"
  | "material_issue"
  | "factory_execution_issue"
  | "customer_change"
  | "ignored";

export type AnomalySuggestedAction =
  | "watchlist_and_recalc"
  | "mark_suspicious_review"
  | "create_incident_or_escalate";

export type AnomalyAlert = {
  id: string;
  type: AnomalyType;
  severity: "critical" | "high" | "medium" | "low";
  key: string;
  factory_id: string | null;
  allocation_id: string | null;
  order_id: string | null;
  date: string;
  actual_output: number;
  rolling_mean: number;
  rolling_std: number;
  z_score: number | null;
  sample_size: number;
  routing: { action_type: string; suggested_action: AnomalySuggestedAction; target_type: string };
  // Enriched on the server
  factory_name: string | null;
  product_type: string | null;
  suggested_action: AnomalySuggestedAction | null;
  action_summary: string | null;
  action_impact: string | null;
  // Only present for persistent_dip
  window_days?: number;
  recent_outputs?: number[];
};

// ── V5-A/B: Runtime War Room ──────────────────────────────

export type RuntimeStatus = "idle" | "running" | "blocked" | "rework" | "changeover" | "down";
export type RuntimeRisk = "green" | "amber" | "red";
export type RuntimeSeverity = "critical" | "high" | "medium" | "low" | "info";

export type RuntimeLine = {
  id: string;
  line_id: string;
  factory_id: string;
  current_order_id: string | null;
  current_allocation_id: string | null;
  current_operation: string | null;
  runtime_status: RuntimeStatus;
  current_efficiency: number;
  actual_output_today: number;
  expected_output_today: number;
  overload_pct: number;
  runtime_risk: RuntimeRisk;
  planned_end_at: string | null;
  version: number;
  updated_at: string;
};

export type RuntimeEvent = {
  id: string;
  replay_seq: number;
  event_type: string;
  severity: RuntimeSeverity;
  source: string;
  source_ref: string | null;
  factory_id: string | null;
  line_id: string | null;
  allocation_id: string | null;
  order_id: string | null;
  affected_entities: Array<{
    node_id: string;
    node_type: string;
    ref_id: string;
    ref_label?: string | null;
    impact: number;
    depth: number;
    estimated_delay_days: number;
    path?: string[];
    edge_path?: string[];
    reasoning?: string;
  }>;
  propagation_status: "pending" | "in_progress" | "completed" | "skipped" | "failed";
  payload: Record<string, unknown>;
  reasoning: string | null;
  confidence: number | null;
  correlation_id: string | null;
  caused_by_event_id: string | null;
  occurred_at: string;
  ingested_at: string;
};

export type ConstraintNode = {
  id: string;
  node_type: string;
  ref_id: string;
  ref_label: string | null;
  attrs: Record<string, unknown>;
};

export type ConstraintEdge = {
  id: string;
  from_node: string;
  to_node: string;
  edge_type: string;
  weight: number;
  attrs: Record<string, unknown>;
};

export type RuntimeKpi = {
  active_lines: number;
  overloaded_lines: number;
  blocked_lines: number;
  high_risk_lines: number;
  runtime_events_24h: number;
  critical_events_24h: number;
  pending_propagations: number;
  timestamp: string;
};

export type TimelineGroup = {
  id: string;
  content: string;
  factory_id: string;
  factory_name: string;
  runtime_status: RuntimeStatus;
  runtime_risk: RuntimeRisk;
  overload_pct: number;
  current_efficiency: number;
};

export type TimelineItem = {
  id: string;
  group: string;
  start: string;
  end: string;
  order_id: string | null;
  product_type: string | null;
  qty: number;
  progress: number;
  status: string;
  is_locked: boolean;
  risk: "ok" | "running" | "high" | "critical";
  deviation_pct: number;
  content: string;
};

export type TimelineResponse = {
  window: { from: string; to: string };
  counts: { groups: number; items: number };
  groups: TimelineGroup[];
  items: TimelineItem[];
};

export type RuntimeCommandAction = {
  type: "simulate" | "incident" | "reschedule" | "execute" | "dismiss" | string;
  label: string;
  endpoint: string | null;
  method: "POST" | "GET" | null;
  payload?: Record<string, unknown>;
};

export type RuntimeCommand = {
  id: string;
  kind: "event" | "action";
  severity: RuntimeSeverity;
  title: string;
  summary: string;
  affected: Array<Record<string, unknown>>;
  source: string;
  source_event_id: string | null;
  factory_id: string | null;
  line_id: string | null;
  allocation_id: string | null;
  order_id: string | null;
  payload: Record<string, unknown>;
  confidence: number | null;
  occurred_at: string;
  propagation_status: string;
  actions: RuntimeCommandAction[];
};

export type RuntimeGraphResponse = {
  size: { nodes: number; edges: number };
  nodes: ConstraintNode[];
  edges: ConstraintEdge[];
};

// ── Risk Engine — canonical assessment (single source of truth) ───
export type RiskLevelCanonical = "ok" | "warn" | "critical";
export type RiskColor = "green" | "amber" | "red";

export type RiskSignal = {
  kind: string;
  value: unknown;
  weight: number;
  direction: "raises" | "lowers" | "neutral";
  reason: string;
};

export type RiskAssessment = {
  subject: { type: "order" | "allocation" | "line" | "factory" | "customer"; id: string };
  level: RiskLevelCanonical;
  score: number;
  color: RiskColor;
  signals: RiskSignal[];
  top_reasons: string[];
  computed_at: string;
};

// ── V6: Execution Engine (decision tasks) ────────────────
export type TaskStatus = "open" | "acknowledged" | "in_progress" | "blocked" | "resolved" | "dismissed";
export type TaskCategory = "production_delay" | "quality" | "material" | "shipment" | "capacity" | "general";
export type TaskAction = "claim" | "start" | "block" | "unblock" | "resolve" | "dismiss" | "reopen" | "reassign";

export type DecisionTask = {
  id: string;
  title: string;
  description: string | null;
  category: TaskCategory;
  severity: "ok" | "warn" | "critical";
  subject_type: string | null;
  subject_id: string | null;
  source_type: string;
  source_ref: string | null;
  status: TaskStatus;
  owner: string | null;
  owner_role: string | null;
  due_at: string | null;
  escalation_level: number;
  last_escalated_at: string | null;
  escalated_to: string | null;
  ai_suggested_owner: string | null;
  ai_suggested_due_at: string | null;
  ai_recommended_action: string | null;
  ai_confidence: number | null;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  blocked_reason: string | null;
  dismissed_reason: string | null;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type TaskEvent = {
  id: string;
  task_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor: string | null;
  actor_role: string | null;
  detail: Record<string, unknown>;
  note: string | null;
  occurred_at: string;
};

export type TaskRetrospective = {
  id: string;
  task_id: string;
  root_cause: string | null;
  what_happened: string | null;
  what_we_did: string | null;
  prevention: string | null;
  resolution_time_minutes: number | null;
  was_escalated: boolean;
  max_escalation_level: number;
  was_false_positive: boolean | null;
  authored_by: string | null;
  created_at: string;
};

export type TaskSummary = {
  total: number;
  open: number;
  unowned: number;
  overdue: number;
  escalated: number;
  critical: number;
  by_status: Record<string, number>;
};

// ── V6: Notifications ─────────────────────────────────────
export type NotificationKind = "task_created" | "task_due_soon" | "task_overdue_escalated" | "task_resolved" | "task_reassigned";

export type NotificationEvent = {
  id: string;
  recipient: string;
  kind: NotificationKind;
  channel: string;
  title: string;
  body: string | null;
  task_id: string | null;
  severity: "ok" | "warn" | "critical" | null;
  metadata: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
};

// ── V6: Retrospective Intelligence ───────────────────────
export type RetroSummary = {
  total_tasks: number; open_tasks: number; overdue_tasks: number;
  resolved_tasks: number; dismissed_tasks: number;
  resolved_pct: number; overdue_pct: number;
  avg_resolution_minutes: number; median_resolution_minutes: number;
  escalation_count: number; escalation_rate: number;
  repeat_issue_count: number;
  ai_generated_count: number; ai_completion_rate: number; false_positive_rate: number;
  by_status: Record<string, number>; by_severity: Record<string, number>; by_category: Record<string, number>;
  prev_total_tasks: number; total_trend: "up" | "down" | "flat";
};
export type RetroRootCause = { root_cause: string; count: number; pct: number; avg_resolution_minutes: number; trend: "up" | "down" | "flat"; prev_count: number };
export type RetroFactory = { factory_id: string; factory_name: string; quality: number; rework: number; delay: number; critical: number; total: number };
export type RetroLine = { line_id: string; line_name: string; critical: number; issues: number };
export type RetroOwner = { owner: string; assigned: number; overdue: number; resolved: number; escalations: number; avg_response_minutes: number; overloaded: boolean };
export type RetroAi = {
  auto_generated: number; completed: number; dismissed: number; escalated: number;
  completion_rate: number; useful_rate: number; false_positive_rate: number;
  top_false_positive_sources: Array<{ source: string; count: number }>;
  ai_action_log_count: number;
};
export type RetroTrendDay = { date: string; total: number; critical: number; overdue: number; quality: number };
export type RetroInsight = { severity: "ok" | "warn" | "critical"; icon: string; text: string };

export type RetrospectiveData = {
  window: { days: number; from: string; to: string };
  summary: RetroSummary;
  root_causes: RetroRootCause[];
  factories: RetroFactory[];
  lines: RetroLine[];
  owners: RetroOwner[];
  ai_effectiveness: RetroAi;
  trends: { days: RetroTrendDay[] };
  insights: RetroInsight[];
  cron_health: { runs: number; failed_runs: number; last_run_at: string | null; last_status: string | null };
};

// ── V6-A: Decision Engine ────────────────────────────────
export type DecisionType =
  | "delay_resolution" | "material_shortage_resolution" | "qc_rework_resolution"
  | "vip_insertion" | "line_disruption_resolution";

export type DecisionActionType =
  | "create_task" | "reschedule" | "create_incident" | "notify_owner"
  | "update_watchlist" | "request_approval" | "mark_customer_delay"
  | "create_purchase_followup" | "create_qc_followup";

export type DecisionAction = { action_type: DecisionActionType; payload: Record<string, unknown> };

export type DecisionOption = {
  id: string;
  option_type: string;
  title: string;
  description: string;
  impact: {
    delay_days_delta: number; cost_delta: number; margin_delta: number;
    risk_delta: number; affected_orders: string[]; affected_lines: string[];
    customer_impact: "low" | "medium" | "high";
  };
  feasibility_score: number; risk_score: number; cost_score: number;
  confidence_score: number; total_score: number;
  base_score?: number;
  learning?: { delta: number; reason: string | null; sample_size: number } | null;
  required_actions: DecisionAction[];
  reasoning: string[];
};

export type DecisionAssessment = {
  id: string | null;
  subject: { type: string | null; id: string | null };
  decision_type: DecisionType;
  urgency: "low" | "medium" | "high" | "critical";
  current_state: {
    summary: string; risk_score: number; expected_delay_days: number;
    affected_orders: string[]; affected_lines: string[]; affected_factories: string[];
    estimated_margin_impact: number;
  };
  options: DecisionOption[];
  recommended_option_id: string | null;
  recommendation_reason: string;
  confidence_score: number;
  if_no_action: {
    expected_delay_days: number; affected_orders: string[]; margin_loss: number;
    customer_risk: "low" | "medium" | "high"; escalation_risk: "low" | "medium" | "high";
  };
  computed_at: string;
};

export type DecisionApplyResult = {
  ok: boolean;
  status: "applied" | "partial" | "failed" | "dismissed" | "approval_requested";
  actions_taken: Array<{ action_type: string; status: string; ref_id?: string; error?: string }>;
  log?: Record<string, unknown>;
};

// ── V6: Decision Intelligence ────────────────────────────
export type DecisionIntelSummary = {
  decisions_evaluated: number; decisions_applied: number; total_selected: number;
  recommendation_acceptance_rate: number; override_rate: number;
  apply_success_rate: number; failed_rate: number; dismissed_count: number;
  avg_confidence: number; prev_decisions_evaluated: number;
  acceptance_trend: "up" | "down" | "flat"; prev_acceptance_rate: number;
};
export type DecisionIntelOption = {
  option_type: string; selected: number; applied: number; failed: number; dismissed: number;
  helpful: number; not_helpful: number; success_rate: number; feedback_score: number;
};
export type DecisionIntelOverride = { option_type: string; recommended: number; overridden: number; override_rate: number };
export type DecisionIntelLearningRow = { decision_type: string; option_type: string; adjustment: number; sample_size: number; effectiveness: number; reason: string | null };
export type DecisionIntelFeedback = {
  helpful: number; not_helpful: number; wrong_recommendation: number; missing_option: number;
  inaccurate_impact: number; total_feedback: number; no_feedback: number; helpful_rate: number;
};
export type DecisionIntelTrendDay = { date: string; evaluated: number; applied: number; accepted: number; overridden: number; decided: number; acceptance_rate: number; override_rate: number };
export type DecisionIntelInsight = { severity: "ok" | "warn" | "critical"; icon: string; text: string };

export type DecisionIntelligence = {
  window: { days: number; from: string; to: string };
  summary: DecisionIntelSummary;
  options: DecisionIntelOption[];
  overrides: DecisionIntelOverride[];
  learning: { all: DecisionIntelLearningRow[]; top_positive: DecisionIntelLearningRow[]; top_negative: DecisionIntelLearningRow[]; learned_count: number };
  feedback: DecisionIntelFeedback;
  trends: { days: DecisionIntelTrendDay[] };
  insights: DecisionIntelInsight[];
};

// ── V7: Shopfloor ────────────────────────────────────────
export type WorkOrderStatus = "pending" | "in_progress" | "paused" | "completed" | "blocked";
export type WorkOrderAction = "start" | "pause" | "resume" | "complete" | "block";
export type BlockReason = "material_shortage" | "machine_issue" | "labor_shortage" | "quality_issue" | "waiting_instruction" | "other";

export type ShopfloorWorkOrder = {
  id: string;
  order_id: string | null;
  allocation_id: string | null;
  factory_id: string | null;
  line_id: string | null;
  operation: string | null;
  planned_qty: number;
  completed_qty: number;
  defect_qty: number;
  status: WorkOrderStatus;
  assigned_to: string | null;
  planned_start_at: string | null;
  planned_end_at: string | null;
  actual_start_at: string | null;
  actual_end_at: string | null;
  block_reason: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  // joined by API
  progress_pct?: number;
  legal_actions?: WorkOrderAction[];
};

export type ShopfloorSummary = {
  work_orders: number;
  planned_qty: number;
  completed_qty: number;
  completion_pct: number;
  defect_qty: number;
  downtime_minutes: number;
  blocked_orders: number;
  in_progress_orders: number;
  completed_orders: number;
};
