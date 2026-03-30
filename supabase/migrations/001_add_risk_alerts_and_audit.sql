-- Migration: Add risk_alerts and pilot_audit_log tables
-- Run this in Supabase SQL Editor

-- 1) risk_alerts
create table if not exists public.risk_alerts (
  id uuid primary key default gen_random_uuid(),
  allocation_id uuid not null references public.production_allocations(id) on delete cascade,
  risk_level text not null check (risk_level in ('SAFE','MEDIUM','HIGH')),
  buffer_days int not null default 0,
  message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_risk_alerts_allocation on public.risk_alerts(allocation_id);
create index if not exists idx_risk_alerts_level on public.risk_alerts(risk_level);

-- 2) pilot_audit_log
create table if not exists public.pilot_audit_log (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  operator text not null default 'anonymous',
  role text not null default 'unknown',
  action text not null,
  category text not null default 'system',
  result_status text not null default 'success'
    check (result_status in ('success','blocked','failed','partial')),
  error_code text,
  request_id text,
  run_id text,
  blocked boolean not null default false,
  page text,
  detail jsonb not null default '{}'::jsonb,
  environment text not null default 'pilot',
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_occurred on public.pilot_audit_log(occurred_at desc);
create index if not exists idx_audit_operator on public.pilot_audit_log(operator);
create index if not exists idx_audit_category on public.pilot_audit_log(category);
create index if not exists idx_audit_blocked on public.pilot_audit_log(blocked);
create index if not exists idx_audit_result on public.pilot_audit_log(result_status);
create index if not exists idx_audit_error on public.pilot_audit_log(error_code) where error_code is not null;
