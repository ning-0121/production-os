-- Production-OS Supabase schema
-- Notes:
-- - Uses UUID primary keys for distributed scalability
-- - Includes JSONB fields to support future AI optimization features (feature vectors, constraints, learned params)
-- - Uses PostGIS for geofences (install via Supabase: enable extension postgis)

begin;

-- Extensions
create extension if not exists pgcrypto;
create extension if not exists postgis;

-- Common function for updated_at
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 1) factories
create table if not exists public.factories (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  status text not null default 'active' check (status in ('active','inactive','maintenance')),

  -- Address / contact (optional)
  address text,
  contact_name text,
  contact_phone text,

  -- Timezone & working calendar hooks
  timezone text not null default 'UTC',
  work_calendar jsonb not null default '{}'::jsonb,

  -- AI/optimization extensibility
  ai_profile jsonb not null default '{}'::jsonb,      -- learned parameters, embeddings refs, etc.
  constraints jsonb not null default '{}'::jsonb,     -- hard constraints (e.g. max overtime)
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_factories_status on public.factories(status);
create index if not exists idx_factories_timezone on public.factories(timezone);
create index if not exists idx_factories_metadata_gin on public.factories using gin(metadata);

drop trigger if exists trg_factories_updated_at on public.factories;
create trigger trg_factories_updated_at
before update on public.factories
for each row execute function public.set_updated_at();

-- 2) factory_capabilities
create table if not exists public.factory_capabilities (
  id uuid primary key default gen_random_uuid(),
  factory_id uuid not null references public.factories(id) on delete cascade,

  product_type text not null,
  process_type text not null default 'default',

  -- Capacity model: base units/day and optional per-unit minutes
  base_capacity_units_per_day numeric(14,4) not null default 0,
  setup_minutes numeric(14,4) not null default 0,
  minutes_per_unit numeric(14,4) not null default 0,

  -- Cost/quality metrics for scoring
  cost_per_unit numeric(14,4),
  quality_score numeric(6,3) check (quality_score is null or (quality_score >= 0 and quality_score <= 100)),

  -- AI features (e.g. vectorized capability features)
  features jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint uq_factory_capability unique(factory_id, product_type, process_type)
);

create index if not exists idx_factory_capabilities_factory_id on public.factory_capabilities(factory_id);
create index if not exists idx_factory_capabilities_product_type on public.factory_capabilities(product_type);
create index if not exists idx_factory_capabilities_features_gin on public.factory_capabilities using gin(features);

drop trigger if exists trg_factory_capabilities_updated_at on public.factory_capabilities;
create trigger trg_factory_capabilities_updated_at
before update on public.factory_capabilities
for each row execute function public.set_updated_at();

-- 3) production_allocations
-- Represents planned or committed production blocks allocated to factories.
create table if not exists public.production_allocations (
  id uuid primary key default gen_random_uuid(),
  factory_id uuid not null references public.factories(id) on delete restrict,
  capability_id uuid references public.factory_capabilities(id) on delete set null,

  order_external_id text, -- hook to your order system
  product_type text not null,
  quantity numeric(14,4) not null check (quantity > 0),

  -- Scheduling window
  start_at timestamptz not null,
  end_at timestamptz not null,

  status text not null default 'planned' check (status in ('planned','confirmed','in_progress','completed','cancelled')),

  -- For advanced scheduling / AI optimization
  priority int not null default 0,
  assumptions jsonb not null default '{}'::jsonb,
  score_breakdown jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint chk_alloc_time_range check (end_at > start_at)
);

create index if not exists idx_alloc_factory_time on public.production_allocations(factory_id, start_at, end_at);
create index if not exists idx_alloc_status on public.production_allocations(status);
create index if not exists idx_alloc_product_type on public.production_allocations(product_type);
create index if not exists idx_alloc_order_external_id on public.production_allocations(order_external_id);
create index if not exists idx_alloc_assumptions_gin on public.production_allocations using gin(assumptions);

drop trigger if exists trg_production_allocations_updated_at on public.production_allocations;
create trigger trg_production_allocations_updated_at
before update on public.production_allocations
for each row execute function public.set_updated_at();

-- 4) factory_performance_logs
-- Time-series logs of throughput, downtime, yield, etc.
create table if not exists public.factory_performance_logs (
  id uuid primary key default gen_random_uuid(),
  factory_id uuid not null references public.factories(id) on delete cascade,
  capability_id uuid references public.factory_capabilities(id) on delete set null,

  occurred_at timestamptz not null,
  metric_type text not null, -- e.g. 'throughput_units', 'downtime_minutes', 'yield_pct'
  metric_value numeric(18,6) not null,
  unit text,

  context jsonb not null default '{}'::jsonb, -- batch, shift, operator, root cause, etc.

  created_at timestamptz not null default now()
);

create index if not exists idx_perf_factory_time on public.factory_performance_logs(factory_id, occurred_at desc);
create index if not exists idx_perf_capability_time on public.factory_performance_logs(capability_id, occurred_at desc);
create index if not exists idx_perf_metric_type on public.factory_performance_logs(metric_type);
create index if not exists idx_perf_context_gin on public.factory_performance_logs using gin(context);

-- 5) factory_visit_tasks
-- Field tasks triggered by visits/inspections (including geofence-triggered tasks).
create table if not exists public.factory_visit_tasks (
  id uuid primary key default gen_random_uuid(),
  factory_id uuid not null references public.factories(id) on delete cascade,

  title text not null,
  description text,
  task_type text not null default 'general',
  status text not null default 'open' check (status in ('open','in_progress','done','blocked','cancelled')),
  priority int not null default 0,

  due_at timestamptz,
  assigned_to text, -- can be replaced with auth.users FK later

  -- Optional linkage to a planned allocation or issue
  allocation_id uuid references public.production_allocations(id) on delete set null,

  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tasks_factory_status on public.factory_visit_tasks(factory_id, status);
create index if not exists idx_tasks_due_at on public.factory_visit_tasks(due_at);
create index if not exists idx_tasks_priority on public.factory_visit_tasks(priority desc);
create index if not exists idx_tasks_metadata_gin on public.factory_visit_tasks using gin(metadata);

drop trigger if exists trg_factory_visit_tasks_updated_at on public.factory_visit_tasks;
create trigger trg_factory_visit_tasks_updated_at
before update on public.factory_visit_tasks
for each row execute function public.set_updated_at();

-- 6) factory_geo_fences
-- Geofences for a factory; supports radius geofence and polygon geofence (future).
create table if not exists public.factory_geo_fences (
  id uuid primary key default gen_random_uuid(),
  factory_id uuid not null references public.factories(id) on delete cascade,

  name text not null,
  fence_type text not null default 'radius' check (fence_type in ('radius','polygon')),

  -- Radius fence: center point + radius meters
  center geography(point, 4326),
  radius_meters numeric(14,4),

  -- Polygon fence: optional future support
  polygon geography(polygon, 4326),

  is_active boolean not null default true,

  -- Hook for notification behavior / future AI
  notification_prefs jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint chk_radius_fields check (
    (fence_type <> 'radius') or (center is not null and radius_meters is not null and radius_meters > 0)
  ),
  constraint chk_polygon_fields check (
    (fence_type <> 'polygon') or (polygon is not null)
  )
);

create index if not exists idx_geofences_factory_active on public.factory_geo_fences(factory_id, is_active);
create index if not exists idx_geofences_center_gist on public.factory_geo_fences using gist(center);
create index if not exists idx_geofences_polygon_gist on public.factory_geo_fences using gist(polygon);
create index if not exists idx_geofences_metadata_gin on public.factory_geo_fences using gin(metadata);

drop trigger if exists trg_factory_geo_fences_updated_at on public.factory_geo_fences;
create trigger trg_factory_geo_fences_updated_at
before update on public.factory_geo_fences
for each row execute function public.set_updated_at();

commit;

