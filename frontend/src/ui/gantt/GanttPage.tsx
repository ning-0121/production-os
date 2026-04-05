import React from "react";
import { addDays, format, startOfDay } from "date-fns";
import { DndContext, PointerSensor, useDraggable, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";

import "../orders/orders.css";
import "./Gantt.css";
import type { OrderBlock, TimelineWindow } from "./model";
import { dateToX, isoToDate, minutesInWindow } from "./time";
import { OrderDrawer } from "./OrderDrawer";
import { useAsync } from "../../hooks/useAsync";
import { useRealtimeRefetch } from "../../hooks/useRealtime";
import { fetchAllocations, fetchFactories, updateAllocation } from "../../services/api";
import type { Allocation, Factory } from "../../types";

type DraggableData = {
  type: "order";
  orderId: string;
};

function pxToMinutes(px: number, win: TimelineWindow, widthPx: number) {
  const total = minutesInWindow(win);
  return (px / Math.max(1, widthPx)) * total;
}

function allocationToBlock(a: Allocation): OrderBlock {
  return {
    id: a.id,
    factoryId: a.factory_id,
    productType: a.order_id ?? a.id.slice(0, 8),
    quantity: a.allocated_qty,
    startAt: a.planned_start_date,
    endAt: a.planned_end_date,
    status: a.status === "cancelled" ? "completed" : a.status,
  };
}

export function GanttPage() {
  const timeline: TimelineWindow = React.useMemo(() => {
    const s = startOfDay(new Date());
    const e = addDays(s, 14);
    return { start: s, end: e };
  }, []);

  const { data: rawFactories, loading: loadingF } = useAsync(() => fetchFactories(), []);
  const { data: rawAllocations, loading: loadingA, refetch } = useAsync(() => fetchAllocations(), []);

  // Real-time updates
  useRealtimeRefetch("production_allocations", refetch);

  const factories = React.useMemo(
    () => (rawFactories ?? []).map((f: Factory) => ({ id: f.id, name: f.name })),
    [rawFactories],
  );

  const [localOrders, setLocalOrders] = React.useState<OrderBlock[] | null>(null);

  // Sync from API data
  React.useEffect(() => {
    if (rawAllocations) {
      setLocalOrders(rawAllocations.map(allocationToBlock));
    }
  }, [rawAllocations]);

  // ── Filter ─────────────────────────────────────────────
  const [filterFactory, setFilterFactory] = React.useState("");

  const allOrders = localOrders ?? [];
  const orders = filterFactory
    ? allOrders.filter((o) => o.factoryId === filterFactory)
    : allOrders;

  const filteredFactories = filterFactory
    ? factories.filter((f) => f.id === filterFactory)
    : factories;

  const [selectedOrderId, setSelectedOrderId] = React.useState<string | null>(null);
  const selectedOrder = orders.find((o) => o.id === selectedOrderId) ?? null;

  const gridRef = React.useRef<HTMLDivElement | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  async function onDragEnd(ev: DragEndEvent) {
    const activeData = ev.active.data.current as DraggableData | undefined;
    if (!activeData || activeData.type !== "order") return;
    if (!gridRef.current) return;

    const deltaX = ev.delta.x;
    const rect = gridRef.current.getBoundingClientRect();
    const widthPx = rect.width;

    let newStart = "";
    let newEnd = "";

    setLocalOrders((prev) =>
      (prev ?? []).map((o) => {
        if (o.id !== activeData.orderId) return o;
        const start = isoToDate(o.startAt);
        const end = isoToDate(o.endAt);
        const minutesDelta = pxToMinutes(deltaX, timeline, widthPx);
        const ns = new Date(start.getTime() + minutesDelta * 60_000);
        const ne = new Date(end.getTime() + minutesDelta * 60_000);
        newStart = ns.toISOString();
        newEnd = ne.toISOString();
        return { ...o, startAt: newStart, endAt: newEnd };
      }),
    );

    // Persist to backend
    if (newStart && newEnd) {
      try {
        await updateAllocation(activeData.orderId, { planned_start_date: newStart, planned_end_date: newEnd } as Partial<Allocation>);
      } catch {
        refetch(); // revert on failure
      }
    }
  }

  const ticks = React.useMemo(() => {
    const days = 14;
    const out: Array<{ label: string; xPct: number }> = [];
    for (let i = 0; i <= days; i += 2) {
      const d = addDays(timeline.start, i);
      const x = (i / days) * 100;
      out.push({ label: format(d, "MMM d"), xPct: x });
    }
    return out;
  }, [timeline.start]);

  const loading = loadingF || loadingA;

  if (loading) return <div className="card"><div style={{ padding: 24, color: "var(--muted)" }}>加载中…</div></div>;

  return (
    <div className="grid2">
      <div className="card">
        <div className="cardHeader">
          <div>
            <h2>生产排期</h2>
            <div className="hint">拖拽订单块调整排期 | 点击查看详情</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select
              className="filterSelect"
              value={filterFactory}
              onChange={(e) => setFilterFactory(e.target.value)}
              style={{ fontSize: 12 }}
            >
              <option value="">全部工厂</option>
              {factories.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <span className="pill">{format(timeline.start, "MMM d")} → {format(timeline.end, "MMM d")}</span>
          </div>
        </div>

        <div className="ganttWrap">
          <div className="gantt">
            <div className="axis">
              <div className="axisLeft">
                <div className="big">工厂</div>
                <div className="small">{filteredFactories.length} 行</div>
              </div>
              <div className="axisRight" ref={gridRef}>
                {ticks.map((t) => (
                  <React.Fragment key={t.label}>
                    <div className="tick" style={{ left: `${t.xPct}%` }} />
                    <div className="tickLabel" style={{ left: `${t.xPct}%` }}>
                      {t.label}
                    </div>
                  </React.Fragment>
                ))}
              </div>
            </div>

            <DndContext
              sensors={sensors}
              onDragEnd={(ev) => void onDragEnd(ev)}
              modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
            >
              <div className="ganttGrid">
                {filteredFactories.map((f) => (
                  <FactoryRow
                    key={f.id}
                    factory={f}
                    orders={orders.filter((o) => o.factoryId === f.id)}
                    timeline={timeline}
                    onOpen={(id) => setSelectedOrderId(id)}
                  />
                ))}
              </div>
            </DndContext>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="cardHeader">
          <h2>排产概览</h2>
        </div>
        <div className="ganttSummary">
          <div className="ganttSummaryItem">
            <div className="ganttSummaryDot" style={{ background: "var(--accent)" }} />
            <span>{allOrders.filter((o) => o.status === "in_progress").length} 生产中</span>
          </div>
          <div className="ganttSummaryItem">
            <div className="ganttSummaryDot" style={{ background: "#a78bfa" }} />
            <span>{allOrders.filter((o) => o.status === "confirmed").length} 已排产</span>
          </div>
          <div className="ganttSummaryItem">
            <div className="ganttSummaryDot" style={{ background: "#64748b" }} />
            <span>{allOrders.filter((o) => o.status === "planned").length} 待排产</span>
          </div>
          <div className="ganttSummaryItem">
            <div className="ganttSummaryDot" style={{ background: "#22c55e" }} />
            <span>{allOrders.filter((o) => o.status === "completed").length} 已完成</span>
          </div>
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 4, fontSize: 12, color: "var(--muted)" }}>
            共 {filteredFactories.length} 工厂 | {allOrders.length} 订单
            <br />拖拽订单块可调整排期
          </div>
        </div>
        <div className="ganttLegend">
          <div className="ganttLegendItem"><div className="ganttLegendDot" style={{ background: "rgba(100,116,139,.4)" }} /> 待排</div>
          <div className="ganttLegendItem"><div className="ganttLegendDot" style={{ background: "rgba(167,139,250,.4)" }} /> 已排</div>
          <div className="ganttLegendItem"><div className="ganttLegendDot" style={{ background: "rgba(110,231,255,.4)" }} /> 生产中</div>
          <div className="ganttLegendItem"><div className="ganttLegendDot" style={{ background: "rgba(34,197,94,.35)" }} /> 完成</div>
          <div className="ganttLegendItem"><div className="ganttLegendDot" style={{ background: "var(--danger)", width: 2, borderRadius: 1 }} /> 今天</div>
        </div>
      </div>

      <OrderDrawer
        order={selectedOrder}
        factoryName={selectedOrder ? factories.find((f) => f.id === selectedOrder.factoryId)?.name ?? "" : ""}
        onClose={() => setSelectedOrderId(null)}
      />
    </div>
  );
}

function FactoryRow({
  factory,
  orders,
  timeline,
  onOpen,
}: {
  factory: { id: string; name: string };
  orders: OrderBlock[];
  timeline: TimelineWindow;
  onOpen: (orderId: string) => void;
}) {
  const rowRef = React.useRef<HTMLDivElement | null>(null);
  const widthPx = rowRef.current?.getBoundingClientRect().width ?? 1;
  const rowHeight = Math.max(56, orders.length * 38 + 16);

  const statusLabel = orders.length === 0 ? "空闲" :
    `${orders.filter((o) => o.status === "in_progress").length} 生产中`;

  return (
    <div className="row">
      <div className="rowLeft">
        <div className="name">{factory.name}</div>
        <div className="meta">{orders.length} 订单 | {statusLabel}</div>
      </div>
      <div className="rowRight" ref={rowRef} style={{ minHeight: rowHeight }}>
        {/* Today marker */}
        {(() => {
          const todayX = dateToX(new Date(), timeline, widthPx);
          if (todayX > 0 && todayX < widthPx) {
            return <div className="todayLine" style={{ left: todayX }} />;
          }
          return null;
        })()}
        {orders.map((o, idx) => {
          const start = isoToDate(o.startAt);
          const end = isoToDate(o.endAt);
          const x1 = dateToX(start, timeline, widthPx);
          const x2 = dateToX(end, timeline, widthPx);
          const left = Math.max(0, Math.min(widthPx - 10, x1));
          const w = Math.max(60, x2 - x1);
          const top = 8 + idx * 38;
          return (
            <OrderBlockView key={o.id} order={o} left={left} width={w} top={top} onOpen={() => onOpen(o.id)} />
          );
        })}
      </div>
    </div>
  );
}

const STATUS_CLASS: Record<string, string> = {
  planned: "blockPlanned",
  confirmed: "blockConfirmed",
  in_progress: "blockInProgress",
  completed: "blockCompleted",
};

const STATUS_LABEL: Record<string, string> = {
  planned: "待排",
  confirmed: "已排",
  in_progress: "生产中",
  completed: "完成",
};

function OrderBlockView({
  order,
  left,
  width,
  top,
  onOpen,
}: {
  order: OrderBlock;
  left: number;
  width: number;
  top: number;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: order.id,
    data: { type: "order", orderId: order.id } satisfies DraggableData,
  });

  const dx = transform?.x ?? 0;
  const statusCls = STATUS_CLASS[order.status] ?? "blockPlanned";

  return (
    <div
      ref={setNodeRef}
      className={`block ${statusCls} ${isDragging ? "blockDragging" : ""}`}
      style={{ left: left + dx, width, top }}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      {...listeners}
      {...attributes}
    >
      <div className="blockLabel">
        <span className="blockOrderId">{order.productType}</span>
        <span className="blockQty">x{order.quantity}</span>
      </div>
      {width > 100 && <span className="blockStatus">{STATUS_LABEL[order.status] ?? order.status}</span>}
    </div>
  );
}
