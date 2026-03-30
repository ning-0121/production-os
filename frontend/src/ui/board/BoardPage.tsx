import React from "react";
import { DndContext, PointerSensor, useDroppable, useDraggable, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { useAsync } from "../../hooks/useAsync";
import { fetchAllocations, updateAllocation, smartRecommend, smartSchedule, fetchRiskAlerts } from "../../services/api";
import type { Allocation, AllocationStatus, Recommendation, RiskAlert, RiskLevel } from "../../types";
import "./board.css";

// ── Allowed drag transitions ────────────────────────────
// "confirmed" is system-only — users must use Smart Schedule.
const ALLOWED_DRAG_TARGETS: Record<AllocationStatus, AllocationStatus[]> = {
  planned: [],                              // must use Smart Schedule
  confirmed: ["in_progress"],               // start production
  in_progress: ["completed"],               // mark done
  completed: [],                            // terminal
  cancelled: [],                            // terminal
};

const columns: { key: AllocationStatus; label: string }[] = [
  { key: "planned", label: "待排产" },
  { key: "confirmed", label: "已排产" },
  { key: "in_progress", label: "生产中" },
  { key: "completed", label: "已完成" },
];

export function BoardPage() {
  const { data: allocations, loading, error, refetch } = useAsync(() => fetchAllocations(), []);
  const { data: riskAlerts } = useAsync(() => fetchRiskAlerts(), []);
  const [localOverrides, setLocalOverrides] = React.useState<Record<string, AllocationStatus>>({});
  const [scheduleTarget, setScheduleTarget] = React.useState<Allocation | null>(null);
  const [toast, setToast] = React.useState<{ msg: string; type: "error" | "info" } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  // Build a map: allocation_id → risk_level
  const riskMap = React.useMemo(() => {
    const map: Record<string, RiskAlert> = {};
    for (const alert of riskAlerts ?? []) {
      map[alert.allocation_id] = alert;
    }
    return map;
  }, [riskAlerts]);

  const orders = React.useMemo(() => {
    if (!allocations) return [];
    return allocations.map((a) => ({
      ...a,
      status: localOverrides[a.id] ?? a.status,
    }));
  }, [allocations, localOverrides]);

  function showToast(msg: string, type: "error" | "info" = "error") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  async function onDragEnd(ev: DragEndEvent) {
    const allocationId = ev.active.id as string;
    const newStatus = ev.over?.id as AllocationStatus | undefined;
    if (!newStatus) return;

    const order = orders.find((o) => o.id === allocationId);
    if (!order) return;

    // Enforce: block drag into "confirmed" — must use Smart Schedule
    const allowed = ALLOWED_DRAG_TARGETS[order.status] ?? [];
    if (!allowed.includes(newStatus)) {
      if (newStatus === "confirmed") {
        showToast("Cannot drag to 已排产 — use Smart Schedule button instead");
      }
      return;
    }

    // Optimistic update
    setLocalOverrides((prev) => ({ ...prev, [allocationId]: newStatus }));

    try {
      await updateAllocation(allocationId, { status: newStatus });
      setLocalOverrides((prev) => {
        const next = { ...prev };
        delete next[allocationId];
        return next;
      });
      refetch();
    } catch {
      setLocalOverrides((prev) => {
        const next = { ...prev };
        delete next[allocationId];
        return next;
      });
    }
  }

  function onScheduleComplete() {
    setScheduleTarget(null);
    refetch();
  }

  if (loading) return <div className="card"><div style={{ padding: 24, color: "var(--muted)" }}>加载中…</div></div>;
  if (error) return <div className="card"><div style={{ padding: 24, color: "var(--danger)" }}>加载失败: {error}</div></div>;

  return (
    <div className="card">
      <div className="cardHeader">
        <div>
          <h2>排单看板</h2>
          <div className="hint">待排产订单需通过 Smart Schedule 排产，不可手动拖入已排产列</div>
        </div>
        <span className="pill">{orders.length} 订单</span>
      </div>

      {toast && (
        <div className={`boardToast ${toast.type === "error" ? "boardToastErr" : ""}`}>
          {toast.msg}
        </div>
      )}

      <DndContext sensors={sensors} onDragEnd={(ev) => void onDragEnd(ev)}>
        <div className="boardColumns">
          {columns.map((col) => (
            <Column
              key={col.key}
              status={col.key}
              label={col.label}
              orders={orders.filter((o) => o.status === col.key)}
              riskMap={riskMap}
              onSmartSchedule={setScheduleTarget}
            />
          ))}
        </div>
      </DndContext>

      {scheduleTarget && (
        <ScheduleDrawer
          allocation={scheduleTarget}
          onClose={() => setScheduleTarget(null)}
          onScheduled={onScheduleComplete}
          onError={(msg) => showToast(msg)}
        />
      )}
    </div>
  );
}

// ── Column ──────────────────────────────────────────────

function Column({
  status,
  label,
  orders,
  riskMap,
  onSmartSchedule,
}: {
  status: AllocationStatus;
  label: string;
  orders: Allocation[];
  riskMap: Record<string, RiskAlert>;
  onSmartSchedule: (a: Allocation) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const isLocked = status === "confirmed";
  return (
    <div
      ref={setNodeRef}
      className={`boardCol ${isOver ? (isLocked ? "boardColBlocked" : "boardColOver") : ""}`}
    >
      <div className="boardColHeader">
        <span className="boardColLabel">
          {label}
          {isLocked && <span className="boardColLock" title="System-driven only"> </span>}
        </span>
        <span className="boardColCount">{orders.length}</span>
      </div>
      <div className="boardColBody">
        {orders.map((o) => (
          <OrderCard
            key={o.id}
            order={o}
            riskLevel={riskMap[o.id]?.risk_level ?? null}
            bufferDays={riskMap[o.id]?.buffer_days ?? null}
            onSmartSchedule={onSmartSchedule}
          />
        ))}
      </div>
    </div>
  );
}

// ── OrderCard ───────────────────────────────────────────

function OrderCard({
  order,
  riskLevel,
  bufferDays,
  onSmartSchedule,
}: {
  order: Allocation;
  riskLevel: RiskLevel | null;
  bufferDays: number | null;
  onSmartSchedule: (a: Allocation) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: order.id });
  const style: React.CSSProperties = {
    transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
    opacity: isDragging ? 0.6 : 1,
  };

  const isPlanned = order.status === "planned";
  const riskClass =
    riskLevel === "HIGH" ? "boardCardRiskHigh" :
    riskLevel === "MEDIUM" ? "boardCardRiskMedium" :
    riskLevel === "SAFE" ? "boardCardRiskSafe" : "";

  return (
    <div ref={setNodeRef} className={`boardCard ${riskClass}`} style={style} {...listeners} {...attributes}>
      <div className="boardCardTop">
        <span className="boardCardPt">{order.product_type}</span>
        <span className="boardCardQty">x{order.quantity}</span>
      </div>
      <div className="boardCardFactory">{order.factories?.name ?? "Unassigned"}</div>
      <div className="boardCardDue">
        交期 {order.end_at?.slice(0, 10)}
        {riskLevel && bufferDays !== null && (
          <span className={`boardCardRiskBadge boardCardRiskBadge${riskLevel}`}>
            {riskLevel === "HIGH"
              ? bufferDays < 0 ? `Overdue ${Math.abs(bufferDays)}d` : `${bufferDays}d left`
              : riskLevel === "MEDIUM"
              ? `${bufferDays}d buffer`
              : `${bufferDays}d safe`}
          </span>
        )}
      </div>
      {isPlanned && (
        <button
          className="boardCardScheduleBtn"
          onClick={(e) => {
            e.stopPropagation();
            onSmartSchedule(order);
          }}
        >
          Smart Schedule
        </button>
      )}
    </div>
  );
}

// ── ScheduleDrawer ──────────────────────────────────────

function ScheduleDrawer({
  allocation,
  onClose,
  onScheduled,
  onError,
}: {
  allocation: Allocation;
  onClose: () => void;
  onScheduled: () => void;
  onError: (msg: string) => void;
}) {
  const [recs, setRecs] = React.useState<Recommendation[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [scheduling, setScheduling] = React.useState<string | null>(null);
  const [recError, setRecError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRecError(null);
    smartRecommend(allocation.id)
      .then((data) => {
        if (!cancelled) {
          setRecs(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setRecError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [allocation.id]);

  async function confirmSchedule(factoryId: string) {
    setScheduling(factoryId);
    try {
      await smartSchedule(allocation.id, factoryId);
      onScheduled();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onError(msg);
      setScheduling(null);
    }
  }

  return (
    <div className="drawerOverlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawerHeader">
          <div>
            <h3>Smart Schedule</h3>
            <div className="drawerSub">
              {allocation.product_type} x{allocation.quantity}
              {" | "}交期 {allocation.end_at?.slice(0, 10)}
            </div>
          </div>
          <button className="drawerClose" onClick={onClose}>x</button>
        </div>

        <div className="drawerBody">
          {loading && <div className="drawerMsg">Analyzing factories…</div>}
          {recError && <div className="drawerMsg drawerErr">Error: {recError}</div>}

          {recs && recs.length === 0 && (
            <div className="drawerMsg">No capable factories found.</div>
          )}

          {recs && recs.map((rec) => (
            <div
              key={rec.factory_id}
              className={`recCard ${!rec.feasible ? "recCardInfeasible" : ""}`}
            >
              <div className="recTop">
                <div className="recName">{rec.factory_name}</div>
                <div className="recScore">
                  Score: <strong>{(rec.score * 100).toFixed(0)}</strong>
                </div>
              </div>
              <div className="recMeta">
                <span className={`pill ${rec.feasible ? "" : "pillDanger"}`}>
                  {rec.feasible ? "Feasible" : "Infeasible"}
                </span>
                <span className="pill">
                  Util: {Math.round(rec.load.utilization_pct)}%
                </span>
                <span className="pill">
                  {Math.round(rec.timing.total_minutes / 60)}h production
                </span>
              </div>
              <div className="recBreakdown">
                {Object.entries(rec.score_breakdown).map(([k, v]) => (
                  <div key={k} className="recBreakdownItem">
                    <span className="recBreakdownLabel">{k}</span>
                    <div className="recBreakdownBar">
                      <div
                        className="recBreakdownFill"
                        style={{ width: `${Math.round(v * 100)}%` }}
                      />
                    </div>
                    <span className="recBreakdownVal">{(v * 100).toFixed(0)}</span>
                  </div>
                ))}
              </div>
              <button
                className="btn primary recConfirmBtn"
                disabled={scheduling !== null}
                onClick={() => void confirmSchedule(rec.factory_id)}
              >
                {scheduling === rec.factory_id ? "Scheduling…" : "Confirm"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
