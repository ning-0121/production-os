import React from "react";
import { addDays, format, startOfDay } from "date-fns";
import { DndContext, PointerSensor, useDraggable, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";

import "./Gantt.css";
import type { Factory, OrderBlock, TimelineWindow } from "./model";
import { dateToX, isoToDate, minutesInWindow } from "./time";
import { OrderDrawer } from "./OrderDrawer";

type DraggableData = {
  type: "order";
  orderId: string;
};

function pxToMinutes(px: number, win: TimelineWindow, widthPx: number) {
  const total = minutesInWindow(win);
  return (px / Math.max(1, widthPx)) * total;
}

export function GanttPage() {
  const timeline: TimelineWindow = React.useMemo(() => {
    const s = startOfDay(new Date());
    const e = addDays(s, 14);
    return { start: s, end: e };
  }, []);

  const [factories] = React.useState<Factory[]>([
    { id: "f1", name: "Factory Shenzhen 01" },
    { id: "f2", name: "Factory Suzhou 02" },
    { id: "f3", name: "Factory Chengdu 03" },
  ]);

  const [orders, setOrders] = React.useState<OrderBlock[]>(() => {
    const base = startOfDay(new Date());
    return [
      {
        id: "o1",
        factoryId: "f1",
        productType: "widget-A",
        quantity: 1200,
        startAt: addDays(base, 1).toISOString(),
        endAt: addDays(base, 3).toISOString(),
        status: "planned",
      },
      {
        id: "o2",
        factoryId: "f2",
        productType: "widget-A",
        quantity: 600,
        startAt: addDays(base, 2).toISOString(),
        endAt: addDays(base, 4).toISOString(),
        status: "confirmed",
      },
      {
        id: "o3",
        factoryId: "f1",
        productType: "widget-B",
        quantity: 3000,
        startAt: addDays(base, 5).toISOString(),
        endAt: addDays(base, 8).toISOString(),
        status: "in_progress",
      },
    ];
  });

  const [selectedOrderId, setSelectedOrderId] = React.useState<string | null>(null);
  const selectedOrder = orders.find((o) => o.id === selectedOrderId) ?? null;

  const gridRef = React.useRef<HTMLDivElement | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function onDragEnd(ev: DragEndEvent) {
    const activeData = ev.active.data.current as DraggableData | undefined;
    if (!activeData || activeData.type !== "order") return;
    if (!gridRef.current) return;

    const deltaX = ev.delta.x;
    const rect = gridRef.current.getBoundingClientRect();
    const widthPx = rect.width;

    setOrders((prev) =>
      prev.map((o) => {
        if (o.id !== activeData.orderId) return o;
        const start = isoToDate(o.startAt);
        const end = isoToDate(o.endAt);
        const minutesDelta = pxToMinutes(deltaX, timeline, widthPx);
        const newStart = new Date(start.getTime() + minutesDelta * 60_000);
        const newEnd = new Date(end.getTime() + minutesDelta * 60_000);
        return { ...o, startAt: newStart.toISOString(), endAt: newEnd.toISOString() };
      }),
    );
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

  return (
    <div className="grid2">
      <div className="card">
        <div className="cardHeader">
          <div>
            <h2>Production Schedule</h2>
            <div className="hint">Drag blocks horizontally to reschedule. Click to open details.</div>
          </div>
          <span className="pill">Window: {format(timeline.start, "MMM d")} → {format(timeline.end, "MMM d")}</span>
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
              onDragEnd={onDragEnd}
              modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
            >
              <div className="ganttGrid">
                {factories.map((f) => (
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
            <div className="hint">Wire this panel to backend `recommendFactories()` later.</div>
          </div>
          <button className="btn primary" onClick={() => alert("Next: call backend API and render ranked list.")}>
            Connect
          </button>
        </div>
        <div style={{ padding: 14, color: "var(--muted)", fontSize: 13 }}>
          This UI is ready to integrate with Supabase + the Node scheduler. The scheduling grid already supports
          drag-to-reschedule and a detail drawer.
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
  factory: Factory;
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

