/**
 * Declarative manifest of every component migrations 008–014 are supposed to
 * create. The verifier walks this and confirms each piece exists in the live DB.
 *
 * Keep this in lockstep with supabase/migrations/008*…014*.sql. When a new
 * migration lands, add its block here so the audit covers it.
 *
 * Per migration:
 *   tables       — must exist
 *   columns      — { table: [{ name, notNull? }] }  (key columns, not exhaustive)
 *   indexes      — index names (checked via pg_indexes; WARN if not introspectable)
 *   triggers     — { table, name }
 *   constraints  — constraint names in information_schema.table_constraints
 *                  (UNIQUE/PK/CHECK/FK — NOT partial unique indexes, which live
 *                   in pg_indexes and are listed under `indexes`)
 */

export const MIGRATIONS = [
  {
    id: "008_runtime_core",
    tables: ["production_runtime_lines", "runtime_events", "constraint_nodes", "constraint_edges", "runtime_snapshots"],
    columns: {
      production_runtime_lines: [
        { name: "line_id", notNull: true }, { name: "factory_id" },
        { name: "runtime_status", notNull: true }, { name: "current_efficiency", notNull: true },
        { name: "runtime_risk", notNull: true }, { name: "version", notNull: true },
      ],
      runtime_events: [
        { name: "replay_seq", notNull: true }, { name: "event_type", notNull: true },
        { name: "severity", notNull: true }, { name: "source", notNull: true },
        { name: "propagation_status", notNull: true }, { name: "payload", notNull: true },
      ],
    },
    indexes: [
      "idx_rt_lines_factory", "idx_rt_lines_status", "idx_rt_lines_risk",
      "idx_rt_events_type", "idx_rt_events_severity", "idx_rt_events_factory",
      "idx_rt_events_line", "idx_rt_events_allocation", "idx_rt_events_correlation",
      "idx_rt_events_occurred_at", "idx_rt_events_propagation_status",
      "idx_constraint_nodes_type", "idx_constraint_nodes_ref",
      "idx_constraint_edges_from", "idx_constraint_edges_to", "idx_constraint_edges_type",
      "idx_runtime_snapshots_taken_at", "idx_runtime_snapshots_label",
    ],
    constraints: ["uq_runtime_line", "uq_constraint_node", "uq_constraint_edge"],
  },
  {
    id: "008b_runtime_core_fixes",
    tables: [],
    columns: {
      production_runtime_lines: [{ name: "factory_id", notNull: true }, { name: "created_at", notNull: true }],
      runtime_events: [{ name: "caused_by_event_id" }, { name: "correlation_id" }, { name: "order_id" }],
      runtime_snapshots: [{ name: "schema_version", notNull: true }, { name: "consumed_at" }, { name: "consumed_by" }],
    },
    indexes: [
      "idx_rt_events_caused_by", "idx_rt_events_order", "idx_rt_events_factory_occurred",
      "idx_rt_events_correlation_seq", "uq_runtime_snapshots_label", "idx_runtime_snapshots_consumed",
    ],
    triggers: [{ table: "production_runtime_lines", name: "trg_rt_lines_version_guard" }],
    constraints: [],
  },
  {
    id: "009_import_gateway",
    tables: ["import_templates", "import_runs", "import_rows", "unresolved_import_mappings", "import_field_mappings", "import_errors"],
    columns: {
      import_runs: [{ name: "status", notNull: true }, { name: "import_type", notNull: true }, { name: "summary", notNull: true }],
      import_rows: [{ name: "run_id", notNull: true }, { name: "status", notNull: true }],
    },
    indexes: [
      "idx_import_templates_type", "idx_import_templates_factory",
      "idx_import_runs_status", "idx_import_runs_type", "idx_import_runs_started",
      "idx_import_runs_file_hash", "idx_import_runs_factory",
      "idx_import_rows_run", "idx_import_rows_status",
      "idx_unresolved_status", "idx_unresolved_field",
      "idx_field_mappings_header", "idx_field_mappings_type",
      "idx_import_errors_run", "idx_import_errors_severity", "idx_import_errors_code",
    ],
    constraints: ["uq_unresolved", "uq_field_mapping"],
  },
  {
    id: "010_execution_engine",
    tables: ["escalation_policies", "decision_tasks", "task_events", "retrospectives", "task_watchers"],
    columns: {
      decision_tasks: [
        { name: "title", notNull: true }, { name: "severity", notNull: true },
        { name: "status", notNull: true }, { name: "source_type", notNull: true },
        { name: "source_ref" }, { name: "subject_type" }, { name: "subject_id" },
        { name: "escalation_level", notNull: true }, { name: "version", notNull: true },
      ],
    },
    indexes: [
      "uq_active_task_per_source",
      "idx_esc_policies_active", "idx_esc_policies_category",
      "idx_tasks_status", "idx_tasks_owner", "idx_tasks_severity", "idx_tasks_category",
      "idx_tasks_subject", "idx_tasks_due_at", "idx_tasks_esc_level", "idx_tasks_created",
      "idx_task_events_task", "idx_task_events_type", "idx_task_events_occurred",
      "idx_retro_root_cause", "idx_retro_created",
      "idx_task_watchers_task", "idx_task_watchers_watcher",
    ],
    triggers: [{ table: "decision_tasks", name: "trg_decision_tasks_version" }],
    constraints: ["chk_dismiss_reason"],
  },
  {
    id: "011_cron_and_notifications",
    tables: ["cron_runs", "notification_events"],
    columns: {
      cron_runs: [{ name: "job_name", notNull: true }, { name: "status", notNull: true }],
      notification_events: [{ name: "recipient", notNull: true }, { name: "kind", notNull: true }, { name: "dedup_key", notNull: true }],
    },
    indexes: [
      "idx_cron_runs_job", "idx_cron_runs_started", "idx_cron_runs_status",
      "uq_notification_dedup", "idx_notif_recipient", "idx_notif_unread", "idx_notif_task", "idx_notif_created",
    ],
    constraints: [],
  },
  {
    id: "012_decision_engine",
    tables: ["decision_assessments", "decision_logs", "decision_option_feedback"],
    columns: {
      decision_logs: [{ name: "decision_id", notNull: true }],
      decision_option_feedback: [{ name: "decision_id", notNull: true }],
    },
    indexes: [
      "idx_decisions_subject", "idx_decisions_type", "idx_decisions_urgency", "idx_decisions_computed",
      "idx_decision_logs_decision", "idx_decision_logs_option", "idx_decision_logs_status", "idx_decision_logs_selected_at",
      "idx_decision_feedback_decision", "idx_decision_feedback_type",
    ],
    constraints: [],
  },
  {
    id: "013_decision_learning",
    tables: ["decision_learning"],
    columns: {},
    indexes: ["idx_decision_learning_type", "idx_decision_learning_recomputed"],
    constraints: [],
  },
  {
    id: "014_shopfloor",
    tables: ["shopfloor_work_orders", "shopfloor_reports", "shopfloor_events"],
    columns: {
      shopfloor_work_orders: [{ name: "status", notNull: true }, { name: "version", notNull: true }],
      shopfloor_reports: [{ name: "work_order_id", notNull: true }],
      shopfloor_events: [{ name: "work_order_id", notNull: true }],
    },
    indexes: [
      "idx_swo_status", "idx_swo_assigned", "idx_swo_line", "idx_swo_factory", "idx_swo_order", "idx_swo_planned_start",
      "idx_sr_wo", "idx_sr_type", "idx_sr_reported_at",
      "idx_se_wo", "idx_se_type", "idx_se_created",
    ],
    triggers: [{ table: "shopfloor_work_orders", name: "trg_swo_version" }],
    constraints: [],
  },
];
