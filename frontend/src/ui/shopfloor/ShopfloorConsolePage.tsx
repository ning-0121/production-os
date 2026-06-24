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
  fetchWorkOrders, fetchShopfloorSummary, fetchProductionLines,
  transitionWorkOrder, reportOutput, reportBlocked,
} from "../../services/api";
import { ApiError } from "../../services/client";
import { useToast } from "../Toast";
import { PageSkeleton } from "../Skeleton";
import type { ShopfloorWorkOrder, WorkOrderAction, BlockReason } from "../../types";
import "./shopfloor.css";

// BarcodeDetector is not in the TS DOM lib yet; probe at runtime.
const SCAN_SUPPORTED = typeof window !== "undefined" && "BarcodeDetector" in window;

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
  const { data: lines } = useAsync(() => fetchProductionLines(), []);

  const [outputFor, setOutputFor] = React.useState<ShopfloorWorkOrder | null>(null);
  const [blockFor, setBlockFor] = React.useState<ShopfloorWorkOrder | null>(null);
  const [scanning, setScanning] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [lineFilter, setLineFilter] = React.useState<string | null>(null);

  // Live refresh, but never WHILE a modal/scanner is open — a refetch mid-entry
  // re-renders the list under the operator and can drop focus. Defer to close.
  const modalOpen = !!(outputFor || blockFor || scanning);
  const modalOpenRef = React.useRef(modalOpen);
  modalOpenRef.current = modalOpen;
  const pendingRef = React.useRef(false);
  const onRealtime = React.useCallback(() => {
    if (modalOpenRef.current) { pendingRef.current = true; return; }
    refresh();
  }, [refresh]);
  useRealtimeRefetch("shopfloor_work_orders", onRealtime);
  React.useEffect(() => {
    if (!modalOpen && pendingRef.current) { pendingRef.current = false; refresh(); }
  }, [modalOpen, refresh]);

  const workOrders = Array.isArray(woData?.work_orders) ? woData!.work_orders : [];
  const lineName = React.useCallback(
    (id: string | null) => (lines ?? []).find((l) => l.id === id)?.name ?? (id ? id.slice(0, 6) : "—"),
    [lines],
  );
  const todayLineIds = [...new Set(workOrders.map((w) => w.line_id).filter(Boolean))] as string[];

  const q = search.trim().toLowerCase();
  const visibleOrders = workOrders.filter((w) => {
    if (lineFilter && w.line_id !== lineFilter) return false;
    if (q) {
      const hay = `${w.order_id ?? ""} ${w.operation ?? ""} ${w.id}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

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

      {/* Find-my-work-order toolbar: scan + search + line filter */}
      <div className="sfToolbar">
        <div className="sfSearchRow">
          {SCAN_SUPPORTED && (
            <button className="sfScanBtn" onClick={() => setScanning(true)} aria-label="扫码">📷 扫码</button>
          )}
          <input
            className="sfSearchInput" type="search" inputMode="search"
            placeholder="搜索订单号 / 工序…" value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && <button className="sfSearchClear" onClick={() => setSearch("")}>×</button>}
        </div>
        {todayLineIds.length > 1 && (
          <div className="sfLineChips">
            <button className={`sfLineChip ${!lineFilter ? "sfLineChip--active" : ""}`} onClick={() => setLineFilter(null)}>全部</button>
            {todayLineIds.map((id) => (
              <button key={id} className={`sfLineChip ${lineFilter === id ? "sfLineChip--active" : ""}`} onClick={() => setLineFilter(id)}>
                {lineName(id)}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <div className="sfError">加载失败：{error}</div>}
      {!error && workOrders.length === 0 && (
        <div className="sfEmpty">今天没有分配给你的工单。</div>
      )}
      {!error && workOrders.length > 0 && visibleOrders.length === 0 && (
        <div className="sfEmpty">没有匹配的工单。{(search || lineFilter) && <button className="sfLinkBtn" onClick={() => { setSearch(""); setLineFilter(null); }}>清除筛选</button>}</div>
      )}

      {/* Work order cards */}
      <div className="sfList">
        {visibleOrders.map((wo) => (
          <WorkOrderCard key={wo.id} wo={wo} onAction={doAction} onReportOutput={() => setOutputFor(wo)} />
        ))}
      </div>

      {scanning && <QrScanner onClose={() => setScanning(false)} onDetected={(code) => { setSearch(code); setScanning(false); }} />}
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
    if (busy) return;   // guard against double-tap before the button disables
    const outQty = Number(output);
    if (!Number.isFinite(outQty) || outQty <= 0) { toast("请输入有效产量（大于 0）", "error"); return; }
    setBusy(true);
    try {
      await reportOutput(wo.id, { output_qty: outQty, defect_qty: Number(defect) || 0, note: note || undefined });
      toast("报工成功", "success");
      onDone();
    } catch (e) {
      // 409 = another operator/channel updated this work order first. Keep the
      // modal open with the typed number so the operator can refresh & retry —
      // never show a false "success" that silently drops their count.
      if (e instanceof ApiError && e.status === 409) {
        toast("该工单已被更新，请关闭后重新打开再报工", "error");
      } else {
        toast(e instanceof Error ? e.message : "报工失败", "error");
      }
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

// ── QR / barcode scanner (operator phone camera) ────────
function QrScanner({ onClose, onDetected }: { onClose: () => void; onDetected: (code: string) => void }) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    // BarcodeDetector isn't in the TS DOM lib yet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Detector = (window as any).BarcodeDetector;
    const detector = Detector ? new Detector({ formats: ["qr_code", "code_128", "ean_13"] }) : null;

    async function tick() {
      if (stopped || !detector || !videoRef.current) return;
      try {
        const codes = await detector.detect(videoRef.current);
        const value = codes?.[0]?.rawValue;
        if (value) { onDetected(String(value).trim()); return; }
      } catch { /* frame not ready yet */ }
      raf = requestAnimationFrame(tick);
    }

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => {}); }
        tick();
      } catch {
        setErr("无法打开摄像头，请检查浏览器权限，或改用搜索框");
      }
    })();

    return () => { stopped = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
  }, [onDetected]);

  return (
    <div className="sfModalBackdrop" onClick={onClose}>
      <div className="sfScanModal" onClick={(e) => e.stopPropagation()}>
        <div className="sfModalHeader"><h3>扫码找工单</h3><button className="sfModalClose" onClick={onClose}>×</button></div>
        {err ? <div className="sfError">{err}</div> : (
          <>
            <video ref={videoRef} className="sfScanVideo" muted playsInline />
            <div className="sfScanHint">将工单二维码对准摄像头</div>
          </>
        )}
      </div>
    </div>
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
