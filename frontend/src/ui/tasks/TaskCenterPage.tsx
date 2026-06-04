/**
 * Task Center — V6 Execution Engine UI.
 *
 * The accountability cockpit: every risk that became a task, who owns it, when
 * it's due, whether it's escalated, and the one-click actions to move it
 * forward. This is where "we saw a risk" becomes "someone is on it".
 *
 * Sections:
 *   - KPI strip (open / unowned / overdue / escalated / critical)
 *   - Filter bar (status, severity, escalated-only, mine)
 *   - Task list with owner, deadline, escalation level, RiskPill, actions
 *   - Detail drawer: timeline of events + resolve/dismiss + retrospective
 */

import React from "react";
import { useAsync } from "../../hooks/useAsync";
import {
  fetchTasks, fetchTaskSummary, fetchTaskDetail,
  transitionTask, setTaskDeadline, addTaskRetrospective,
  autoGenerateTasks, sweepEscalations,
} from "../../services/api";
import { RiskPill, legacyAssessment } from "../shared/RiskPill";
import { DecisionPanel } from "../shared/DecisionPanel";
import { useToast } from "../Toast";
import { PageSkeleton } from "../Skeleton";
import type { DecisionTask, TaskStatus, TaskAction } from "../../types";
import "./tasks.css";

const DECISIONABLE_CATEGORIES = new Set(["production_delay", "material", "quality", "capacity", "shipment"]);

const STATUS_LABEL: Record<TaskStatus, string> = {
  open: "待认领", acknowledged: "已认领", in_progress: "处理中",
  blocked: "受阻", resolved: "已解决", dismissed: "已忽略",
};
const CATEGORY_LABEL: Record<string, string> = {
  production_delay: "生产延期", quality: "质量", material: "物料",
  shipment: "出货", capacity: "产能", general: "一般",
};
const ACTION_LABEL: Record<TaskAction, string> = {
  claim: "认领", start: "开始处理", block: "标记受阻", unblock: "解除受阻",
  resolve: "解决", dismiss: "忽略", reopen: "重新打开", reassign: "转派",
};

export function TaskCenterPage() {
  const { toast } = useToast();
  const [filter, setFilter] = React.useState<{ status?: string; severity?: string; escalated?: boolean }>({});
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [openId, setOpenId] = React.useState<string | null>(null);

  const { data: summary } = useAsync(() => fetchTaskSummary(), [refreshKey]);
  const { data, loading, error } = useAsync(
    () => fetchTasks({ ...filter, limit: 200 }),
    [filter.status, filter.severity, filter.escalated, refreshKey],
  );

  const tasks = Array.isArray(data?.tasks) ? data!.tasks : [];
  const refresh = () => setRefreshKey((k) => k + 1);
  const [working, setWorking] = React.useState(false);

  async function handleAutoGenerate() {
    setWorking(true);
    try {
      const r = await autoGenerateTasks();
      toast(r.created > 0 ? `自动生成 ${r.created} 个任务（跳过 ${r.skipped} 个已存在）` : "无新风险需要建任务", "success");
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "自动生成失败", "error");
    } finally { setWorking(false); }
  }

  async function handleSweep() {
    setWorking(true);
    try {
      const r = await sweepEscalations();
      toast(r.escalated > 0 ? `${r.escalated} 个任务已升级` : "无任务需要升级", "success");
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "升级扫描失败", "error");
    } finally { setWorking(false); }
  }

  if (loading && tasks.length === 0) return <PageSkeleton />;

  return (
    <div className="taskPage">
      <div className="cardHeader" style={{ marginBottom: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>任务中心</h1>
          <div className="hint">风险 → 责任人 → 截止 → 升级 → 复盘。每个风险都有人负责。</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn primary" onClick={handleAutoGenerate} disabled={working} title="扫描运行时事件/事件/进度偏差/验货不合格，自动开任务">
            {working ? "处理中..." : "⚡ 自动生成任务"}
          </button>
          <button className="btn" onClick={handleSweep} disabled={working} title="检查逾期任务并升级">升级扫描</button>
          <button className="btn" onClick={refresh}>↻ 刷新</button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="taskKpiStrip">
        <KpiTile label="进行中" value={summary?.open ?? 0} accent />
        <KpiTile label="无人认领" value={summary?.unowned ?? 0} tone={(summary?.unowned ?? 0) > 0 ? "danger" : "ok"} />
        <KpiTile label="已逾期" value={summary?.overdue ?? 0} tone={(summary?.overdue ?? 0) > 0 ? "danger" : "ok"} />
        <KpiTile label="已升级" value={summary?.escalated ?? 0} tone={(summary?.escalated ?? 0) > 0 ? "warn" : "ok"} />
        <KpiTile label="紧急" value={summary?.critical ?? 0} tone={(summary?.critical ?? 0) > 0 ? "danger" : "ok"} />
      </div>

      {/* Filters */}
      <div className="taskFilters">
        <FilterChip label="全部进行中" active={!filter.status && !filter.escalated} onClick={() => setFilter({})} />
        <FilterChip label="无人认领" active={filter.status === "open"} onClick={() => setFilter({ status: "open" })} />
        <FilterChip label="处理中" active={filter.status === "in_progress"} onClick={() => setFilter({ status: "in_progress" })} />
        <FilterChip label="受阻" active={filter.status === "blocked"} onClick={() => setFilter({ status: "blocked" })} />
        <FilterChip label="已升级" active={!!filter.escalated} onClick={() => setFilter({ escalated: true })} />
        <FilterChip label="紧急" active={filter.severity === "critical"} onClick={() => setFilter({ severity: "critical" })} />
        <FilterChip label="已解决" active={filter.status === "resolved"} onClick={() => setFilter({ status: "resolved" })} />
      </div>

      {error && <div style={{ padding: 16, color: "var(--danger)" }}>加载失败：{error}</div>}
      {!error && tasks.length === 0 && (
        <div className="card emptyState" style={{ padding: 48, textAlign: "center" }}>
          当前没有符合条件的任务 — 系统平稳。
        </div>
      )}

      <div className="taskList">
        {tasks.map((t) => (
          <TaskRow key={t.id} task={t} onOpen={() => setOpenId(t.id)} />
        ))}
      </div>

      {openId && (
        <TaskDrawer
          taskId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => { refresh(); }}
        />
      )}
    </div>
  );
}

function TaskRow({ task, onOpen }: { task: DecisionTask; onOpen: () => void }) {
  const overdue = task.due_at && new Date(task.due_at).getTime() < Date.now()
    && !["resolved", "dismissed"].includes(task.status);
  return (
    <div className={`card taskRow taskRow--${task.severity}`} onClick={onOpen}>
      <div className="taskRowMain">
        <div className="taskRowTop">
          <RiskPill assessment={legacyAssessment(task.severity, "order", task.subject_id ?? task.id)} compact />
          <span className="taskCategory">{CATEGORY_LABEL[task.category] ?? task.category}</span>
          {task.escalation_level > 0 && (
            <span className="taskEscBadge" title={`已升级至 L${task.escalation_level}，通知 ${task.escalated_to ?? "—"}`}>
              ↑ L{task.escalation_level} {task.escalated_to ?? ""}
            </span>
          )}
          <span className={`taskStatusPill taskStatusPill--${task.status}`}>{STATUS_LABEL[task.status]}</span>
        </div>
        <div className="taskTitle">{task.title}</div>
        <div className="taskMeta">
          <span>负责人：{task.owner ?? <em style={{ color: "var(--danger)" }}>无人认领</em>}</span>
          {task.due_at && (
            <span className={overdue ? "taskOverdue" : ""}>
              截止：{new Date(task.due_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })}
              {overdue && " ⚠ 已逾期"}
            </span>
          )}
          {task.subject_id && <span>对象：{task.subject_type} {task.subject_id.slice(0, 10)}</span>}
        </div>
      </div>
      <div className="taskRowRight">
        <span className="taskOpenHint">查看 →</span>
      </div>
    </div>
  );
}

function TaskDrawer({ taskId, onClose, onChanged }: { taskId: string; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const [refreshKey, setRefreshKey] = React.useState(0);
  const { data, loading } = useAsync(() => fetchTaskDetail(taskId), [taskId, refreshKey]);
  const [busy, setBusy] = React.useState(false);

  const reload = () => { setRefreshKey((k) => k + 1); onChanged(); };

  async function doAction(action: TaskAction) {
    // Actions that need input
    let extra: Record<string, string> = {};
    if (action === "resolve") {
      const note = prompt("解决说明（必填）：");
      if (!note) return;
      extra.resolution_note = note;
    } else if (action === "block") {
      const reason = prompt("受阻原因（必填）：");
      if (!reason) return;
      extra.blocked_reason = reason;
    } else if (action === "dismiss") {
      const reason = prompt("忽略理由（必填）：");
      if (!reason) return;
      extra.dismissed_reason = reason;
    } else if (action === "claim" || action === "reassign") {
      const owner = prompt("负责人：", data?.task.owner ?? "");
      if (!owner) return;
      extra.owner = owner;
    }
    setBusy(true);
    try {
      await transitionTask(taskId, { action, ...extra });
      toast(`已${ACTION_LABEL[action]}`, "success");
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "操作失败", "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleSetDeadline() {
    const v = prompt("截止时间（YYYY-MM-DD HH:mm）：");
    if (!v) return;
    const iso = new Date(v.replace(" ", "T")).toISOString();
    setBusy(true);
    try {
      await setTaskDeadline(taskId, iso);
      toast("已设置截止时间", "success");
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "设置失败", "error");
    } finally { setBusy(false); }
  }

  return (
    <div className="taskDrawerBackdrop" onClick={onClose}>
      <div className="taskDrawerPanel" onClick={(e) => e.stopPropagation()}>
        {loading || !data ? (
          <div className="loadingCenter" style={{ padding: 40 }}>加载中...</div>
        ) : (
          <>
            <div className="cardHeader">
              <div>
                <h3 style={{ margin: 0 }}>{data.task.title}</h3>
                <div className="hint">{CATEGORY_LABEL[data.task.category]} · {STATUS_LABEL[data.task.status]}</div>
              </div>
              <button className="btn" onClick={onClose}>关闭 ×</button>
            </div>

            {data.task.description && <p className="taskDrawerDesc">{data.task.description}</p>}

            {/* Facts */}
            <div className="taskDrawerFacts">
              <Fact label="风险等级"><RiskPill assessment={legacyAssessment(data.task.severity, "order", data.task.id)} compact /></Fact>
              <Fact label="负责人">{data.task.owner ?? "无人认领"}</Fact>
              <Fact label="截止">
                {data.task.due_at ? new Date(data.task.due_at).toLocaleString() : "未设置"}
                <button className="taskLinkBtn" onClick={handleSetDeadline} disabled={busy}>设置</button>
              </Fact>
              {data.task.escalation_level > 0 && (
                <Fact label="升级">L{data.task.escalation_level} → {data.task.escalated_to}</Fact>
              )}
            </div>

            {/* AI suggestion */}
            {data.task.ai_recommended_action && (
              <div className="taskAiSuggest">
                <strong>AI 建议：</strong>{data.task.ai_recommended_action}
                {data.task.ai_confidence != null && <span className="hint"> （{Math.round(data.task.ai_confidence * 100)}%）</span>}
              </div>
            )}

            {/* Decision Engine — for actionable, still-open tasks tied to a subject */}
            {data.task.subject_id && DECISIONABLE_CATEGORIES.has(data.task.category)
              && !["resolved", "dismissed"].includes(data.task.status) && (
              <details className="taskDecisionWrap">
                <summary>生成决策方案 →</summary>
                <DecisionPanel
                  subject={{ type: data.task.subject_type ?? "order", id: data.task.subject_id }}
                  onApplied={reload}
                />
              </details>
            )}

            {/* Actions */}
            <div className="taskDrawerActions">
              {data.legal_actions.map((a) => (
                <button key={a} className={`btn ${a === "resolve" ? "primary" : ""}`} disabled={busy} onClick={() => doAction(a)}>
                  {ACTION_LABEL[a]}
                </button>
              ))}
            </div>

            {/* Resolution / block info */}
            {data.task.blocked_reason && <div className="taskDrawerNote taskDrawerNote--warn">受阻：{data.task.blocked_reason}</div>}
            {data.task.resolution_note && <div className="taskDrawerNote taskDrawerNote--ok">解决：{data.task.resolution_note}</div>}
            {data.task.dismissed_reason && <div className="taskDrawerNote">忽略：{data.task.dismissed_reason}</div>}

            {/* Retrospective (for closed tasks) */}
            {["resolved", "dismissed"].includes(data.task.status) && (
              <RetrospectiveSection taskId={taskId} existing={data.retrospective} onSaved={reload} />
            )}

            {/* Event timeline */}
            <div className="taskTimeline">
              <h4>处理记录</h4>
              {data.events.map((e) => (
                <div key={e.id} className="taskTimelineItem">
                  <span className="taskTimelineDot" />
                  <div className="taskTimelineBody">
                    <span className="taskTimelineType">{eventLabel(e.event_type)}</span>
                    {e.note && <span className="taskTimelineNote">{e.note}</span>}
                    <span className="taskTimelineMeta">{e.actor ?? "系统"} · {new Date(e.occurred_at).toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RetrospectiveSection({ taskId, existing, onSaved }: {
  taskId: string;
  existing: { root_cause: string | null; prevention: string | null } | null;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [rootCause, setRootCause] = React.useState(existing?.root_cause ?? "");
  const [prevention, setPrevention] = React.useState(existing?.prevention ?? "");
  const [saving, setSaving] = React.useState(false);

  if (existing && !open) {
    return (
      <div className="taskRetroSummary">
        <strong>复盘：</strong>{ROOT_CAUSE_LABEL[existing.root_cause ?? ""] ?? existing.root_cause ?? "—"}
        {existing.prevention && <div className="hint">预防：{existing.prevention}</div>}
        <button className="taskLinkBtn" onClick={() => setOpen(true)}>编辑</button>
      </div>
    );
  }

  if (!open) {
    return <button className="btn" style={{ marginTop: 8 }} onClick={() => setOpen(true)}>+ 记录复盘</button>;
  }

  async function save() {
    setSaving(true);
    try {
      await addTaskRetrospective(taskId, { root_cause: rootCause || undefined, prevention: prevention || undefined });
      toast("复盘已保存", "success");
      setOpen(false);
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : "保存失败", "error");
    } finally { setSaving(false); }
  }

  return (
    <div className="taskRetroForm">
      <h4>复盘</h4>
      <label>
        <span>根因</span>
        <select value={rootCause} onChange={(e) => setRootCause(e.target.value)}>
          <option value="">选择根因</option>
          {Object.entries(ROOT_CAUSE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <label>
        <span>如何预防再次发生</span>
        <textarea value={prevention} onChange={(e) => setPrevention(e.target.value)} rows={2} />
      </label>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn" onClick={() => setOpen(false)}>取消</button>
        <button className="btn primary" onClick={save} disabled={saving}>保存复盘</button>
      </div>
    </div>
  );
}

const ROOT_CAUSE_LABEL: Record<string, string> = {
  material_delay: "物料延迟", equipment_failure: "设备故障", labor_shortage: "人员短缺",
  quality_issue: "质量问题", planning_error: "计划错误", supplier_issue: "供应商问题",
  customer_change: "客户变更", data_error: "数据错误", external_factor: "外部因素",
  no_action_needed: "无需处理", other: "其他",
};

function eventLabel(type: string): string {
  const m: Record<string, string> = {
    created: "创建", claimed: "认领", started: "开始处理", blocked: "标记受阻",
    unblocked: "解除受阻", resolved: "解决", dismissed: "忽略", reopened: "重新打开",
    reassigned: "转派", deadline_set: "设置截止", deadline_changed: "修改截止",
    escalated: "升级", comment: "备注", ai_suggested: "AI 建议",
  };
  return m[type] ?? type;
}

function KpiTile({ label, value, tone, accent }: { label: string; value: number; tone?: "ok" | "warn" | "danger"; accent?: boolean }) {
  const cls = tone === "danger" ? "taskKpiTile--danger" : tone === "warn" ? "taskKpiTile--warn" : tone === "ok" ? "taskKpiTile--ok" : "";
  return (
    <div className={`taskKpiTile ${cls}`}>
      <div className="taskKpiLabel">{label}</div>
      <div className={`taskKpiValue ${accent ? "taskKpiValue--accent" : ""}`}>{value}</div>
    </div>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return <button className={`taskFilterChip ${active ? "taskFilterChip--active" : ""}`} onClick={onClick}>{label}</button>;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="taskFact">
      <div className="taskFactLabel">{label}</div>
      <div className="taskFactValue">{children}</div>
    </div>
  );
}
