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
            <h2>Production Schedule</h2>
            <div className="hint">Drag blocks horizontally to reschedule. Click to open details.</div>
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
                <div className="big">Factories</div>
                <div className="small">Rows</div>
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
          <div>
            <h2>Ranked Recommendations</h2>
            <div className="hint">Select an order to get AI-powered factory recommendations.</div>
          </div>
        </div>
        <div style={{ padding: 14, color: "var(--muted)", fontSize: 13 }}>
          {factories.length} factories loaded from Supabase. Drag-to-reschedule persists to backend.
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

  return (
    <div className="row">
      <div className="rowLeft">
        <div className="name">{factory.name}</div>
        <div className="meta">{orders.length} blocks</div>
      </div>
      <div className="rowRight" ref={rowRef}>
        {orders.map((o) => {
          const start = isoToDate(o.startAt);
          const end = isoToDate(o.endAt);
          const x1 = dateToX(start, timeline, widthPx);
          const x2 = dateToX(end, timeline, widthPx);
          const left = Math.max(0, Math.min(widthPx - 10, x1));
          const w = Math.max(36, x2 - x1);
          return (
            <OrderBlockView key={o.id} order={o} left={left} width={w} onOpen={() => onOpen(o.id)} />
          );
        })}
      </div>
    </div>
  );
}

function OrderBlockView({
  order,
  left,
  width,
  onOpen,
}: {
  order: OrderBlock;
  left: number;
  width: number;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: order.id,
    data: { type: "order", orderId: order.id } satisfies DraggableData,
  });

  const dx = transform?.x ?? 0;

  return (
    <div
      ref={setNodeRef}
      className={`block ${isDragging ? "blockDragging" : ""}`}
      style={{ left: left + dx, width }}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      {...listeners}
      {...attributes}
    >
      <div className="left">
        <div className="pt">{order.productType}</div>
        <div className="qty">Qty {order.quantity}</div>
      </div>
      <div className="badge">{order.status}</div>
    </div>
  );
}
