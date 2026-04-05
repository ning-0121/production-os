import React from "react";
import { DndContext, PointerSensor, useDroppable, useDraggable, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { useAsync } from "../../hooks/useAsync";
import { useRealtimeRefetch } from "../../hooks/useRealtime";
import { fetchAllocations, updateAllocation, deleteAllocation, smartRecommend, smartSchedule, fetchRiskAlerts } from "../../services/api";
import { request } from "../../services/client";
import { useToast } from "../Toast";
import { CreateOrderDrawer } from "../orders/CreateOrderDrawer";
import { ImportDrawer } from "../orders/ImportDrawer";
import type { Allocation, AllocationStatus, Recommendation, RiskAlert, RiskLevel } from "../../types";
import "../orders/orders.css";
import "./board.css";

// ── Allowed drag transitions ────────────────────────────
const ALLOWED_DRAG_TARGETS: Record<AllocationStatus, AllocationStatus[]> = {
  planned: [],
  confirmed: ["in_progress"],
  in_progress: ["completed"],
  completed: [],
  cancelled: [],
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
  const [showCreate, setShowCreate] = React.useState(false);
  const [showImport, setShowImport] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [batchLoading, setBatchLoading] = React.useState(false);
  const { toast } = useToast();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  // Real-time updates
  useRealtimeRefetch("production_allocations", refetch);

  // ── Search & Filter State ─────────────────────────────
  const [search, setSearch] = React.useState("");
  const [filterRisk, setFilterRisk] = React.useState<RiskLevel | "">("");
  const [filterFactory, setFilterFactory] = React.useState("");

  // Build risk map
  const riskMap = React.useMemo(() => {
    const map: Record<string, RiskAlert> = {};
    for (const alert of riskAlerts ?? []) {
      map[alert.allocation_id] = alert;
    }
    return map;
  }, [riskAlerts]);

  // Build factory list for filter
  const factoryList = React.useMemo(() => {
    const names = new Set<string>();
    for (const a of allocations ?? []) {
      if (a.factories?.name) names.add(a.factories.name);
    }
    return [...names].sort();
  }, [allocations]);

  // Apply local overrides + filters
  const orders = React.useMemo(() => {
    if (!allocations) return [];
    let list = allocations.map((a) => ({
      ...a,
      status: localOverrides[a.id] ?? a.status,
    }));

    // Search
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((o) =>
        o.id.toLowerCase().includes(q) ||
        (o.order_id ?? "").toLowerCase().includes(q) ||
        (o.factories?.name ?? "").toLowerCase().includes(q)
      );
    }

    // Filter by risk
    if (filterRisk) {
      list = list.filter((o) => {
        const rl = riskMap[o.id]?.risk_level;
        return rl === filterRisk;
      });
    }

    // Filter by factory
    if (filterFactory) {
      list = list.filter((o) => o.factories?.name === filterFactory);
    }

    return list;
  }, [allocations, localOverrides, search, filterRisk, filterFactory, riskMap]);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  async function batchAction(action: string) {
    if (selected.size === 0) return;
    setBatchLoading(true);
    try {
      const result = await request<{ success: number; failed: number }>(
        "/batch/allocations",
        { method: "POST", body: JSON.stringify({ ids: [...selected], action }) },
      );
      toast(`操作完成：成功 ${result.success}，失败 ${result.failed}`, result.failed > 0 ? "warning" : "success");
      clearSelection();
      refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : "批量操作失败", "error");
    } finally {
      setBatchLoading(false);
    }
  }

  async function onDragEnd(ev: DragEndEvent) {
    const allocationId = ev.active.id as string;
    const newStatus = ev.over?.id as AllocationStatus | undefined;
    if (!newStatus) return;

    const order = orders.find((o) => o.id === allocationId);
    if (!order) return;

    const allowed = ALLOWED_DRAG_TARGETS[order.status] ?? [];
    if (!allowed.includes(newStatus)) {
      if (newStatus === "confirmed") {
        toast("不能手动拖入已排产列 — 请使用智能排单", "warning");
      }
      return;
    }

    setLocalOverrides((prev) => ({ ...prev, [allocationId]: newStatus }));

    try {
      await updateAllocation(allocationId, { status: newStatus });
      setLocalOverrides((prev) => { const next = { ...prev }; delete next[allocationId]; return next; });
      refetch();
    } catch {
      setLocalOverrides((prev) => { const next = { ...prev }; delete next[allocationId]; return next; });
    }
  }

  function onScheduleComplete() {
    setScheduleTarget(null);
    refetch();
  }

  if (loading) return <div className="card"><div className="loadingCenter">加载中...</div></div>;
  if (error) return <div className="card"><div style={{ padding: 24, color: "var(--danger)" }}>加载失败: {error}</div></div>;

  return (
    <div className="card">
      <div className="cardHeader">
        <div>
          <h2>排单看板</h2>
          <div className="hint">拖拽调整状态 | 待排产订单使用智能排单</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn" onClick={() => setShowImport(true)}>导入</button>
          <button className="btn primary" onClick={() => setShowCreate(true)}>+ 新建订单</button>
        </div>
      </div>

      {/* Search & Filter Bar */}
      <div className="filterBar">
        <input
          className="filterSearch"
          placeholder="搜索产品类型、订单号、工厂名..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="filterSelect"
          value={filterRisk}
          onChange={(e) => setFilterRisk(e.target.value as RiskLevel | "")}
        >
          <option value="">全部风险</option>
          <option value="HIGH">高风险</option>
          <option value="MEDIUM">中风险</option>
          <option value="SAFE">安全</option>
        </select>
        <select
          className="filterSelect"
          value={filterFactory}
          onChange={(e) => setFilterFactory(e.target.value)}
        >
          <option value="">全部工厂</option>
          {factoryList.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <span className="pill">{orders.length} 订单</span>
      </div>

      {/* Batch Action Bar */}
      {selected.size > 0 && (
        <div className="batchBar">
          <span className="batchCount">{selected.size}</span> 已选择
          <button className="batchBtn" onClick={() => void batchAction("confirm")} disabled={batchLoading}>批量排单</button>
          <button className="batchBtn" onClick={() => void batchAction("start")} disabled={batchLoading}>批量开工</button>
          <button className="batchBtn batchBtnDanger" onClick={() => void batchAction("delete")} disabled={batchLoading}>批量删除</button>
          <button className="batchBtn" onClick={clearSelection}>取消选择</button>
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
              selected={selected}
              onToggleSelect={toggleSelect}
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
          onError={(msg) => toast(msg, "error")}
        />
      )}

      {showCreate && (
        <CreateOrderDrawer
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); refetch(); }}
        />
      )}

      {showImport && (
        <ImportDrawer
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); refetch(); }}
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
  selected,
  onToggleSelect,
  onSmartSchedule,
}: {
  status: AllocationStatus;
  label: string;
  orders: Allocation[];
  riskMap: Record<string, RiskAlert>;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
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
        {orders.length === 0 && (
          <div className="emptyState" style={{ padding: "20px 10px", fontSize: 12 }}>暂无订单</div>
        )}
        {orders.map((o) => (
          <OrderCard
            key={o.id}
            order={o}
            riskLevel={riskMap[o.id]?.risk_level ?? null}
            bufferDays={riskMap[o.id]?.buffer_days ?? null}
            isSelected={selected.has(o.id)}
            onToggleSelect={onToggleSelect}
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
  isSelected,
  onToggleSelect,
  onSmartSchedule,
}: {
  order: Allocation;
  riskLevel: RiskLevel | null;
  bufferDays: number | null;
  isSelected: boolean;
  onToggleSelect: (id: string) => void;
  onSmartSchedule: (a: Allocation) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: order.id });
  const style: React.CSSProperties = {
    transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
    opacity: isDragging ? 0.6 : 1,
    position: "relative",
  };

  const isPlanned = order.status === "planned";
  const riskClass =
    riskLevel === "HIGH" ? "boardCardRiskHigh" :
    riskLevel === "MEDIUM" ? "boardCardRiskMedium" :
    riskLevel === "SAFE" ? "boardCardRiskSafe" : "";

  return (
    <div ref={setNodeRef} className={`boardCard ${riskClass} ${isSelected ? "boardCardSelected" : ""}`} style={style} {...listeners} {...attributes}>
      <div
        className={`boardCardCheck ${isSelected ? "checked" : ""}`}
        onClick={(e) => { e.stopPropagation(); onToggleSelect(order.id); }}
      >
        {isSelected && "ok"}
      </div>
      <div className="boardCardTop">
        <span className="boardCardPt">{order.order_id ?? order.id.slice(0, 8)}</span>
        <span className="boardCardQty">x{order.allocated_qty}</span>
      </div>
      <div className="boardCardFactory">{order.factories?.name ?? "未分配"}</div>
      <div className="boardCardDue">
        交期 {order.planned_end_date?.slice(0, 10)}
        {riskLevel && bufferDays !== null && (
          <span className={`boardCardRiskBadge boardCardRiskBadge${riskLevel}`}>
            {riskLevel === "HIGH"
              ? bufferDays < 0 ? `超期${Math.abs(bufferDays)}天` : `剩${bufferDays}天`
              : riskLevel === "MEDIUM"
              ? `缓冲${bufferDays}天`
              : `安全${bufferDays}天`}
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
          智能排单
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
      .then((data) => { if (!cancelled) { setRecs(data); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setRecError(err instanceof Error ? err.message : String(err)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [allocation.id]);

  async function confirmSchedule(factoryId: string) {
    setScheduling(factoryId);
    try {
      await smartSchedule(allocation.id, factoryId);
      onScheduled();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      setScheduling(null);
    }
  }

  return (
    <div className="drawerOverlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawerHeader">
          <div>
            <h3>智能排单</h3>
            <div className="drawerSub">
              {allocation.order_id ?? allocation.id.slice(0, 8)} x{allocation.allocated_qty}
              {" | "}交期 {allocation.planned_end_date?.slice(0, 10)}
            </div>
          </div>
          <button className="drawerClose" onClick={onClose}>x</button>
        </div>

        <div className="drawerBody">
          {loading && <div className="drawerMsg">正在分析工厂...</div>}
          {recError && <div className="drawerMsg drawerErr">分析失败: {recError}</div>}

          {recs && recs.length === 0 && (
            <div className="drawerMsg">未找到可用工厂</div>
          )}

          {recs && recs.map((rec) => (
            <div
              key={rec.factory_id}
              className={`recCard ${!rec.feasible ? "recCardInfeasible" : ""}`}
            >
              <div className="recTop">
                <div className="recName">{rec.factory_name}</div>
                <div className="recScore">
                  评分: <strong>{(rec.score * 100).toFixed(0)}</strong>
                </div>
              </div>
              <div className="recMeta">
                <span className={`pill ${rec.feasible ? "" : "pillDanger"}`}>
                  {rec.feasible ? "可行" : "不可行"}
                </span>
                <span className="pill">
                  利用率: {Math.round(rec.load.utilization_pct)}%
                </span>
                <span className="pill">
                  {Math.round(rec.timing.total_minutes / 60)}h 生产
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
                {scheduling === rec.factory_id ? "排单中..." : "确认排单"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
