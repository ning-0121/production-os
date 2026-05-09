-- Migration 008: V5-A Runtime Core
--
-- Splits scheduling into two brains:
--   1. STATIC PLANNING (existing tables: production_allocations, line_schedules)
--   2. DYNAMIC RUNTIME (this migration)
--
-- All tables here are RUNTIME state — append-only events, live line state,
-- and a constraint graph for cascading impact propagation. No business CRUD.

BEGIN;

-- gen_random_uuid() lives in pgcrypto. Supabase enables this by default but
-- self-hosted PG may not — be explicit so the migration is portable.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ════════════════════════════════════════════════════════════
-- 1) production_runtime_lines — LIVE state per production line
-- ════════════════════════════════════════════════════════════
-- Exactly one row per line_id (UNIQUE). Updated via optimistic concurrency
-- (version column) so concurrent runtime updates don't clobber each other.

CREATE TABLE IF NOT EXISTS public.production_runtime_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id uuid NOT NULL,                      -- references production_lines(id) but soft FK
  factory_id uuid,                            -- denormalized for fast filter

  -- What the line is doing right now
  current_order_id text,
  current_allocation_id uuid,
  current_operation text,                     -- generic: "cutting" | "sewing" | "qc" | ...

  runtime_status text NOT NULL DEFAULT 'idle' CHECK (runtime_status IN (
    'idle', 'running', 'blocked', 'rework', 'changeover', 'down'
  )),

  -- Live performance metrics
  current_efficiency numeric NOT NULL DEFAULT 1.0 CHECK (current_efficiency >= 0),
  actual_output_today integer NOT NULL DEFAULT 0,
  expected_output_today integer NOT NULL DEFAULT 0,
  overload_pct numeric NOT NULL DEFAULT 0,    -- > 100 = overloaded
  runtime_risk text NOT NULL DEFAULT 'green' CHECK (runtime_risk IN ('green', 'amber', 'red')),

  planned_end_at timestamptz,
  last_event_id uuid,                         -- back-reference to runtime_events.id

  -- Optimistic concurrency
  version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,

  CONSTRAINT uq_runtime_line UNIQUE (line_id)
);

CREATE INDEX IF NOT EXISTS idx_rt_lines_factory ON public.production_runtime_lines(factory_id);
CREATE INDEX IF NOT EXISTS idx_rt_lines_status ON public.production_runtime_lines(runtime_status);
CREATE INDEX IF NOT EXISTS idx_rt_lines_risk ON public.production_runtime_lines(runtime_risk);

-- ════════════════════════════════════════════════════════════
-- 2) runtime_events — append-only manufacturing event log
-- ════════════════════════════════════════════════════════════
-- Source of truth for the runtime brain. All state changes flow through events
-- so the system is replayable, auditable, and simulation-ready.

CREATE TABLE IF NOT EXISTS public.runtime_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Strict monotonic ordering — required for deterministic replay
  replay_seq bigserial UNIQUE NOT NULL,

  event_type text NOT NULL CHECK (event_type IN (
    -- Disturbance events
    'material_delayed', 'line_slowdown', 'rework_started', 'qc_failure',
    'factory_shutdown', 'labor_shortage', 'shipment_risk',
    -- Operational events
    'vip_inserted', 'overtime_started', 'allocation_completed', 'line_status_changed',
    -- Scheduler events
    'reschedule_applied', 'rollback_applied', 'simulation_run'
  )),

  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN (
    'critical', 'high', 'medium', 'low', 'info'
  )),

  -- Source attribution (who/what created this event)
  source text NOT NULL DEFAULT 'system' CHECK (source IN (
    'human', 'sensor', 'agent', 'scheduler', 'system', 'external_api'
  )),
  source_ref text,                            -- operator id, sensor id, agent name

  -- Targets — denormalized for fast filtering
  factory_id uuid,
  line_id uuid,
  allocation_id uuid,
  order_id text,

  -- For events affecting multiple entities, the propagation engine writes the
  -- full impact set here. Schema: [{type, ref_id, impact, depth, ...}]
  affected_entities jsonb NOT NULL DEFAULT '[]',

  propagation_status text NOT NULL DEFAULT 'pending' CHECK (propagation_status IN (
    'pending', 'in_progress', 'completed', 'skipped', 'failed'
  )),
  propagation_run_id uuid,                    -- groups events from same propagation pass

  -- Event-specific payload (delay days, qty, reason, etc.)
  payload jsonb NOT NULL DEFAULT '{}',

  -- Why this event was created — required for explainable AI
  reasoning text,
  confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),

  -- Causality
  correlation_id uuid,                        -- shared across related events
  caused_by_event_id uuid,                    -- direct parent in propagation tree

  occurred_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  request_id text                             -- HTTP request that produced this event
);

CREATE INDEX IF NOT EXISTS idx_rt_events_type ON public.runtime_events(event_type);
CREATE INDEX IF NOT EXISTS idx_rt_events_severity ON public.runtime_events(severity);
CREATE INDEX IF NOT EXISTS idx_rt_events_factory ON public.runtime_events(factory_id);
CREATE INDEX IF NOT EXISTS idx_rt_events_line ON public.runtime_events(line_id);
CREATE INDEX IF NOT EXISTS idx_rt_events_allocation ON public.runtime_events(allocation_id);
CREATE INDEX IF NOT EXISTS idx_rt_events_correlation ON public.runtime_events(correlation_id);
CREATE INDEX IF NOT EXISTS idx_rt_events_occurred_at ON public.runtime_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_rt_events_propagation_status ON public.runtime_events(propagation_status);

-- ════════════════════════════════════════════════════════════
-- 3) constraint_nodes — manufacturing dependency graph nodes
-- ════════════════════════════════════════════════════════════
-- Generic node abstraction so the same engine works across apparel /
-- furniture / electronics. Industry-specific node attributes live in attrs jsonb.

CREATE TABLE IF NOT EXISTS public.constraint_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_type text NOT NULL CHECK (node_type IN (
    'material', 'order', 'allocation', 'line', 'factory', 'rework', 'shipment', 'qc_block'
  )),
  ref_id text NOT NULL,                       -- id of the underlying entity in its own table
  ref_label text,                             -- human-readable label cached for fast display
  attrs jsonb NOT NULL DEFAULT '{}',          -- type-specific (qty, capacity, due_date, ...)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_constraint_node UNIQUE (node_type, ref_id)
);

CREATE INDEX IF NOT EXISTS idx_constraint_nodes_type ON public.constraint_nodes(node_type);
CREATE INDEX IF NOT EXISTS idx_constraint_nodes_ref ON public.constraint_nodes(ref_id);

-- ════════════════════════════════════════════════════════════
-- 4) constraint_edges — directed dependency edges with weight
-- ════════════════════════════════════════════════════════════
-- Edge weight ∈ (0, 1] expresses how strongly an upstream impact propagates
-- to the downstream node. Weight 1.0 = full propagation; lower = damped.

CREATE TABLE IF NOT EXISTS public.constraint_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_node uuid NOT NULL REFERENCES public.constraint_nodes(id) ON DELETE CASCADE,
  to_node uuid NOT NULL REFERENCES public.constraint_nodes(id) ON DELETE CASCADE,
  edge_type text NOT NULL CHECK (edge_type IN (
    'requires',       -- to_node requires from_node (material → order)
    'blocks',         -- from_node blocks to_node (rework → capacity)
    'supplies',       -- from_node supplies to_node (factory → line)
    'assigned_to',    -- from_node assigned to to_node (allocation → line)
    'downstream_of',  -- from_node is downstream of to_node (order → order)
    'replaces'        -- from_node replaces to_node (substitute material)
  )),
  weight numeric NOT NULL DEFAULT 1.0 CHECK (weight > 0 AND weight <= 1),
  attrs jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_constraint_edge UNIQUE (from_node, to_node, edge_type),
  CONSTRAINT no_self_edge CHECK (from_node <> to_node)
);

CREATE INDEX IF NOT EXISTS idx_constraint_edges_from ON public.constraint_edges(from_node);
CREATE INDEX IF NOT EXISTS idx_constraint_edges_to ON public.constraint_edges(to_node);
CREATE INDEX IF NOT EXISTS idx_constraint_edges_type ON public.constraint_edges(edge_type);

-- ════════════════════════════════════════════════════════════
-- 5) runtime_snapshots — for rollback / simulation baselines
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.runtime_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  taken_at timestamptz NOT NULL DEFAULT now(),
  taken_by text,
  reason text,                                -- "pre_reschedule" | "manual" | "scheduled"
  -- Snapshot blob: { lines: [...], events_seq_max: bigint, graph_version: text }
  payload jsonb NOT NULL,
  -- Tag for retrieval; e.g. "pre-vip-2026-05-05"
  label text
);

CREATE INDEX IF NOT EXISTS idx_runtime_snapshots_taken_at ON public.runtime_snapshots(taken_at);
CREATE INDEX IF NOT EXISTS idx_runtime_snapshots_label ON public.runtime_snapshots(label);

COMMIT;
