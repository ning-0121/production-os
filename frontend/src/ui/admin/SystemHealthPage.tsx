/**
 * System Health — V7.5 operational observability + recoverability.
 *
 * Read view: 8 subsystem cards (green / yellow / red) with the key metrics the
 * hardening brief calls out. Action view: failure-recovery tools, each defaulting
 * to DRY RUN so an operator previews impact before applying. Every apply is
 * audit-logged server-side.
 *
 * This page adds NO business behavior — it observes and repairs existing engines.
 */

import React from "react";
import {
  fetchSystemHealth, runRecovery,
  type SystemHealth, type HealthSection, type HealthStatus,
  type RecoveryTool, type RecoveryResult,
} from "../../services/api";
import { useAsync } from "../../hooks/useAsync";
import { useToast } from "../Toast";
import { PageSkeleton } from "../Skeleton";
import "./admin.css";

const STATUS_LABEL: Record<HealthStatus, string> = { green: "正常", yellow: "注意", red: "异常" };

const RECOVERY_TOOLS: { tool: RecoveryTool; label: string; desc: string }[] = [
  { tool: "rebuild-runtime", label: "重建运行时", desc: "按各产线当前状态重算运行风险等级" },
  { tool: "replay-runtime-events", label: "重放运行时事件", desc: "按 replay_seq 重放事件，推导产线状态" },
  { tool: "recalculate-risks", label: "重算风险", desc: "对所有产线重新分类风险（只读校验）" },
  { tool: "regenerate-tasks", label: "重新生成任务", desc: "从持久化风险源补建任务（幂等）" },
  { tool: "recompute-learning", label: "重算学习", desc: "重算有界的决策学习调整量" },
  { tool: "rebuild-decision-intel", label: "重建决策智能", desc: "重新聚合决策智能快照（按需派生）" },
];

export function SystemHealthPage() {
  const { data, loading, error, refetch } = useAsync(() => fetchSystemHealth(), []);

  if (loading && !data) return <PageSkeleton />;

  return (
    <div className="adminPage">
      <div className="cardHeader" style={{ marginBottom: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>系统健康</h1>
          <div className="hint">数据库 · 实时 · 定时任务 · 通知 · 运行时 · 决策引擎 · 数据网关 · 车间</div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {data && <OverallPill status={data.overall} />}
          <button className="btn" onClick={refetch}>↻ 刷新</button>
        </div>
      </div>

      {error && <div className="adminError">加载失败：{error}</div>}

      {data && (
        <>
          <div className="adminMetaRow">
            <span className="hint">快照时间：{new Date(data.generated_at).toLocaleString()}</span>
            <span className="adminPendingTasks">待办任务：<strong>{data.pending_tasks}</strong></span>
          </div>

          <div className="adminGrid">
            {data.sections.map((s) => <HealthCard key={s.key} section={s} />)}
          </div>

          <RecoveryPanel onDone={refetch} />
        </>
      )}
    </div>
  );
}

function OverallPill({ status }: { status: HealthStatus }) {
  return <span className={`adminOverall adminOverall--${status}`}>● 总体 {STATUS_LABEL[status]}</span>;
}

function HealthCard({ section }: { section: HealthSection }) {
  return (
    <div className={`adminCard adminCard--${section.status}`}>
      <div className="adminCardTop">
        <span className="adminCardLabel">{section.label}</span>
        <span className={`adminDot adminDot--${section.status}`} title={STATUS_LABEL[section.status]} />
      </div>
      <div className="adminMetrics">
        {Object.entries(section.metrics).map(([k, v]) => (
          <div key={k} className="adminMetric">
            <span className="adminMetricKey">{metricLabel(k)}</span>
            <span className="adminMetricVal">{formatVal(v)}</span>
          </div>
        ))}
      </div>
      {section.note && <div className="adminNote">{section.note}</div>}
    </div>
  );
}

function RecoveryPanel({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = React.useState<RecoveryTool | null>(null);
  const [results, setResults] = React.useState<Record<string, RecoveryResult>>({});

  async function run(tool: RecoveryTool, dryRun: boolean) {
    if (!dryRun) {
      const ok = window.confirm(`确定要执行「${RECOVERY_TOOLS.find((t) => t.tool === tool)?.label}」（实际写入）吗？此操作会记录审计日志。`);
      if (!ok) return;
    }
    setBusy(tool);
    try {
      const res = await runRecovery(tool, dryRun);
      setResults((prev) => ({ ...prev, [tool]: res }));
      toast(`${dryRun ? "预演" : "执行"}完成：${tool}`, res.ok ? "success" : "error");
      if (!dryRun) onDone();
    } catch (err) {
      toast(err instanceof Error ? err.message : "执行失败", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="adminRecovery">
      <div className="cardHeader" style={{ marginBottom: 8 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>故障恢复工具</h2>
          <div className="hint">默认「预演（dry run）」——先看影响，再实际执行。所有实际执行均记录审计日志。</div>
        </div>
      </div>
      <div className="adminToolGrid">
        {RECOVERY_TOOLS.map(({ tool, label, desc }) => (
          <div key={tool} className="adminTool">
            <div className="adminToolHead">
              <span className="adminToolLabel">{label}</span>
            </div>
            <div className="adminToolDesc">{desc}</div>
            <div className="adminToolActions">
              <button className="btn" disabled={busy === tool} onClick={() => run(tool, true)}>
                {busy === tool ? "..." : "预演"}
              </button>
              <button className="btn primary" disabled={busy === tool} onClick={() => run(tool, false)}>执行</button>
            </div>
            {results[tool] && (
              <pre className="adminToolResult">{JSON.stringify(stripMeta(results[tool]), null, 2)}</pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────

function stripMeta(r: RecoveryResult) {
  const { tool, ok, ...rest } = r;
  void tool; void ok;
  return rest;
}

function metricLabel(k: string): string {
  const m: Record<string, string> = {
    reachable: "可达", configured: "已配置",
    last_run: "上次运行", last_status: "上次状态", failed_jobs_24h: "24h 失败任务",
    last_notification: "上次通知", failed_deliveries: "投递失败",
    runtime_lines: "产线数", lines_down: "停机产线", pending_propagation: "待传播事件", active_events_24h: "24h 活跃事件",
    evaluations_7d: "7天评估数", last_learning_recompute: "上次学习重算",
    last_import: "上次导入", failed_imports_24h: "24h 失败导入",
    open_work_orders: "在产工单", blocked_work_orders: "受阻工单",
  };
  return m[k] ?? k;
}

function formatVal(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "boolean") return v ? "✓" : "✗";
  if (typeof v === "string" && /\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toLocaleString();
  return String(v);
}
