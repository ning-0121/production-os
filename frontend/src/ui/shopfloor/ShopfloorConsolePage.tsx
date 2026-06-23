/**
 * Shopfloor Console / 车间执行台 — mobile-first execution UI for team leaders.
 *
 * NOT for office managers. Big buttons, few fields, fast input, Chinese labels.
 * Reports flow straight into the AI brain (runtime events → lines → tasks).
 * Live: re-fetches when shopfloor_work_orders change via Supabase Realtime.
 */

import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { useRealtimeRefetch } from "../../hooks/useRealtime";
import {
  fetchWorkOrders, fetchShopfloorSummary,
  transitionWorkOrder, reportOutput, reportBlocked,
} from "../../services/api";
import { useToast } from "../Toast";
import { PageSkeleton } from "../Skeleton";
import type { ShopfloorWorkOrder, WorkOrderAction, BlockReason } from "../../types";
import "./shopfloor.css";

const STATUS_LABEL: Record<string, string> = {
  pending: "待开工", in_progress: "生产中", paused: "暂停", completed: "已完成", blocked: "受阻",
};
const ACTION_LABEL: Record<WorkOrderAction, string> = {
  start: "开工", pause: "暂停", resume: "恢复", complete: "完工", block: "报阻塞",
};
const BLOCK_REASONS: Array<{ value: BlockReason; label: string }> = [
  { value: "material_shortage", label: "缺料" },
  { value: "machine_issue", label: "设备故障" },
  { value: "labor_shortage", label: "缺人" },
  { value: "quality_issue", label: "质量问题" },
  { value: "waiting_instruction", label: "等待指令" },
  { value: "other", label: "其他" },
];

export function ShopfloorConsolePage() {
  const { toast } = useToast();
  const [refreshKey, setRefreshKey] = React.useState(0);
  const refresh = React.useCallback(() => setRefreshKey((k) => k + 1), []);

  const { data: woData, loading, error } = useAsync(() => fetchWorkOrders({ today: true }), [refreshKey]);
  const { data: summary } = useAsync(() => fetchShopfloorSummary(), [refreshKey]);

  // Live: refetch when work orders change (Supabase Realtime).
  useRealtimeRefetch("shopfloor_work_orders", refresh);

  const [outputFor, setOutputFor] = React.useState<ShopfloorWorkOrder | null>(null);
  const [blockFor, setBlockFor] = React.useState<ShopfloorWorkOrder | null>(null);

  const workOrders = Array.isArray(woData?.work_orders) ? woData!.work_orders : [];

  if (loading && workOrders.length === 0) return <PageSkeleton />;

  async function doAction(wo: ShopfloorWorkOrder, action: WorkOrderAction) {
    if (action === "block") { setBlockFor(wo); return; }
    try {
      await transitionWorkOrder(wo.id, action);
      toast(`已${ACTION_LABEL[action]}`, "success");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "操作失败", "error");
    }
  }

  return (
    <div className="sfPage">
      <div className="sfHeader">
        <h1>车间执行台</h1>
        <button className="sfRefresh" onClick={refresh}>↻</button>
      </div>

      {/* Today summary */}
      {summary && (
        <div className="sfSummary">
          <SfStat label="计划" value={summary.planned_qty} />
          <SfStat label="完成" value={summary.completed_qty} accent />
          <SfStat label="完成率" value={`${summary.completion_pct}%`} tone={summary.completion_pct >= 80 ? "ok" : "warn"} />
          <SfStat label="不良" value={summary.defect_qty} tone={summary.defect_qty > 0 ? "warn" : undefined} />
          <SfStat label="停机(分)" value={summary.downtime_minutes} />
          <SfStat label="受阻" value={summary.blocked_orders} tone={summary.blocked_orders > 0 ? "danger" : undefined} />
        </div>
      )}

      {error && <div className="sfError">加载失败：{error}</div>}
      {!error && workOrders.length === 0 && (
        <div className="sfEmpty">今天没有分配给你的工单。</div>
      )}

      {/* Work order cards */}
      <div className="sfList">
        {workOrders.map((wo) => (
          <WorkOrderCard key={wo.id} wo={wo} onAction={doAction} onReportOutput={() => setOutputFor(wo)} />
        ))}
      </div>

      {outputFor && <OutputModal wo={outputFor} onClose={() => setOutputFor(null)} onDone={() => { setOutputFor(null); refresh(); }} />}
      {blockFor && <BlockedModal wo={blockFor} onClose={() => setBlockFor(null)} onDone={() => { setBlockFor(null); refresh(); }} />}
    </div>
  );
}

function WorkOrderCard({ wo, onAction, onReportOutput }: {
  wo: ShopfloorWorkOrder;
  onAction: (wo: ShopfloorWorkOrder, a: WorkOrderAction) => void;
  onReportOutput: () => void;
}) {
  const pct = wo.progress_pct ?? 0;
  const actions = wo.legal_actions ?? [];
  return (
    <div className={`sfCard sfCard--${wo.status}`}>
      <div className="sfCardTop">
        <span className="sfCardOrder">{wo.order_id ?? wo.id.slice(0, 8)}</span>
        <span className={`sfStatus sfStatus--${wo.status}`}>{STATUS_LABEL[wo.status]}</span>
      </div>
      <div className="sfCardMeta">{wo.operation ?? "工序"} · 产线 {wo.line_id?.slice(0, 6) ?? "—"}</div>
      <div className="sfProgress">
        <div className="sfProgressBar"><div className="sfProgressFill" style={{ width: `${pct}%` }} /></div>
        <span className="sfProgressText">{wo.completed_qty} / {wo.planned_qty}（{pct}%）</span>
      </div>
      {wo.block_reason && <div className="sfBlockReason">受阻：{BLOCK_REASONS.find((r) => r.value === wo.block_reason)?.label ?? wo.block_reason}</div>}

      <div className="sfActions">
        {/* Report output is the primary, always-available fast action while active */}
        {(wo.status === "in_progress" || wo.status === "pending" || wo.status === "paused") && (
          <button className="sfBtn sfBtn--primary" onClick={onReportOutput}>报产量</button>
        )}
        {actions.map((a) => (
          <button
            key={a}
            className={`sfBtn ${a === "complete" ? "sfBtn--ok" : a === "block" ? "sfBtn--danger" : ""}`}
            onClick={() => onAction(wo, a)}
          >
            {ACTION_LABEL[a]}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Output modal (few fields, big inputs) ───────────────
function OutputModal({ wo, onClose, onDone }: { wo: ShopfloorWorkOrder; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [output, setOutput] = React.useState("");
  const [defect, setDefect] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    const outQty = Number(output);
    if (!Number.isFinite(outQty) || outQty < 0) { toast("请输入产量", "error"); return; }
    setBusy(true);
    try {
      await reportOutput(wo.id, { output_qty: outQty, defect_qty: Number(defect) || 0, note: note || undefined });
      toast("报工成功", "success");
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : "报工失败", "error");
    } finally { setBusy(false); }
  }

  return (
    <Modal title={`报产量 · ${wo.order_id ?? wo.id.slice(0, 8)}`} onClose={onClose}>
      <BigField label="本次完成数量" value={output} onChange={setOutput} autoFocus />
      <BigField label="不良数量（可选）" value={defect} onChange={setDefect} />
      <label className="sfFieldLabel">备注（可选）
        <textarea className="sfTextarea" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
      </label>
      <button className="sfBtn sfBtn--primary sfBtn--full" disabled={busy} onClick={submit}>{busy ? "提交中..." : "提交报工"}</button>
    </Modal>
  );
}

// ── Blocked modal (big reason buttons) ──────────────────
function BlockedModal({ wo, onClose, onDone }: { wo: ShopfloorWorkOrder; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [reason, setReason] = React.useState<BlockReason | null>(null);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    if (!reason) { toast("请选择阻塞原因", "error"); return; }
    setBusy(true);
    try {
      const r = await reportBlocked(wo.id, { reason, note: note || undefined });
      toast(r.task ? "已上报，已生成处理任务" : "已上报阻塞", "success");
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : "上报失败", "error");
    } finally { setBusy(false); }
  }

  return (
    <Modal title={`报阻塞 · ${wo.order_id ?? wo.id.slice(0, 8)}`} onClose={onClose}>
      <div className="sfReasonGrid">
        {BLOCK_REASONS.map((r) => (
          <button key={r.value} className={`sfReasonBtn ${reason === r.value ? "sfReasonBtn--active" : ""}`} onClick={() => setReason(r.value)}>
            {r.label}
          </button>
        ))}
      </div>
      <label className="sfFieldLabel">补充说明（可选）
        <textarea className="sfTextarea" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
      </label>
      <button className="sfBtn sfBtn--danger sfBtn--full" disabled={busy} onClick={submit}>{busy ? "上报中..." : "上报阻塞"}</button>
    </Modal>
  );
}

// ── Shared bits ─────────────────────────────────────────
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="sfModalBackdrop" onClick={onClose}>
      <div className="sfModal" onClick={(e) => e.stopPropagation()}>
        <div className="sfModalHeader"><h3>{title}</h3><button className="sfModalClose" onClick={onClose}>×</button></div>
        {children}
      </div>
    </div>
  );
}
function BigField({ label, value, onChange, autoFocus }: { label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <label className="sfFieldLabel">{label}
      <input className="sfBigInput" type="number" inputMode="numeric" value={value} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
function SfStat({ label, value, tone, accent }: { label: string; value: React.ReactNode; tone?: "ok" | "warn" | "danger"; accent?: boolean }) {
  const cls = tone === "danger" ? "sfStat--danger" : tone === "warn" ? "sfStat--warn" : tone === "ok" ? "sfStat--ok" : "";
  return <div className={`sfStat ${cls}`}><div className="sfStatVal" style={accent ? { color: "var(--accent)" } : undefined}>{value}</div><div className="sfStatLabel">{label}</div></div>;
}
