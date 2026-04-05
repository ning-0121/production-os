import React from "react";
import { addDays, format, startOfDay, differenceInCalendarDays } from "date-fns";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
} from "@dnd-kit/core";
import type { DragStartEvent, DragEndEvent } from "@dnd-kit/core";
import { useAsync } from "../../hooks/useAsync";
import { useRealtimeRefetch } from "../../hooks/useRealtime";
import {
  fetchProductionLines,
  fetchLineSchedules,
  fetchAllocations,
  dryRunAutoSchedule,
  autoScheduleLine,
} from "../../services/api";
import type { AutoScheduleSummary } from "../../services/api";
import { useToast } from "../Toast";
import { UnscheduledPanel } from "./UnscheduledPanel";
import { OrderCard } from "./OrderCard";
import { ScheduleConfirmDialog } from "./ScheduleConfirmDialog";
import { OrderDetailDrawer } from "./OrderDetailDrawer";
import { AIDecisionPanel } from "./AIDecisionPanel";
import type { ProductionLine, LineSchedule, Allocation } from "../../types";
import "./schedule.css";

// ── Constants ─────────────────────────────────────────────

const ZOOM_OPTIONS = [
  { label: "7天", days: 7 },
  { label: "14天", days: 14 },
  { label: "30天", days: 30 },
] as const;

const PRODUCT_CLASS: Record<string, string> = {
  "T恤": "schedBlock--tshirt",
  "裤子": "schedBlock--pants",
  "卫衣": "schedBlock--hoodie",
  "瑜伽裤": "schedBlock--yoga",
  "外套": "schedBlock--jacket",
};

const DEFAULT_FRONT_DAYS = 5;

// ── Types ─────────────────────────────────────────────────

type MergedBlock = {
  allocationId: string;
  orderId: string;
  productType: string;
  qty: number;
  startDate: string;
  endDate: string;
  frontStart: string;
  frontEnd: string;
  backStart: string;
  backEnd: string;
  hasFront: boolean;
  hasBack: boolean;
  status: string;
  progressPct: number;
  riskLevel: "SAFE" | "MEDIUM" | "HIGH";
  allocation: Allocation | null;
  frontSchedule: LineSchedule | null;
  backSchedule: LineSchedule | null;
};

type PendingSchedule = {
  allocationId: string;
  lineId: string;
  summary: AutoScheduleSummary;
};

// ── Main Component ────────────────────────────────────────

export function SchedulePage() {
  const today = React.useMemo(() => startOfDay(new Date()), []);
  const [zoomDays, setZoomDays] = React.useState(14);
  const [filterFactory, setFilterFactory] = React.useState("");
  const [selectedOrderId, setSelectedOrderId] = React.useState<string | null>(null);
  const [draggingAlloc, setDraggingAlloc] = React.useState<Allocation | null>(null);
  const [pending, setPending] = React.useState<PendingSchedule | null>(null);
  const [confirming, setConfirming] = React.useState(false);

  const { toast } = useToast();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  // Data loading
  const { data: lines, loading: loadingL } = useAsync(() => fetchProductionLines(), []);
  const { data: schedules, loading: loadingS, refetch: refetchSchedules } = useAsync(() => fetchLineSchedules(), []);
  const { data: allAllocations, loading: loadingA, refetch: refetchAllocations } = useAsync(() => fetchAllocations(), []);

  useRealtimeRefetch("line_schedules", refetchSchedules);

  // Factory list
  const factoryList = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const l of lines ?? []) {
      if (l.factories?.name) seen.set(l.factory_id, l.factories.name);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [lines]);

  React.useEffect(() => {
    if (!filterFactory && factoryList.length > 0) {
      setFilterFactory(factoryList[0].id);
    }
  }, [factoryList, filterFactory]);

  // Filtered lines for current factory
  const filteredLines = React.useMemo(() => {
    if (!lines) return [];
    if (!filterFactory) return lines;
    return lines.filter((l) => l.factory_id === filterFactory);
  }, [lines, filterFactory]);

  // Allocation lookup
  const allocMap = React.useMemo(() => {
    const map = new Map<string, Allocation>();
    for (const a of allAllocations ?? []) map.set(a.id, a);
    return map;
  }, [allAllocations]);

  // Unscheduled allocations (planned + not in line_schedules)
  const scheduledAllocIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const s of schedules ?? []) ids.add(s.allocation_id);
    return ids;
  }, [schedules]);

  const unscheduledAllocations = React.useMemo(() => {
    return (allAllocations ?? []).filter(
      (a) => a.status === "planned" && !scheduledAllocIds.has(a.id),
    );
  }, [allAllocations, scheduledAllocIds]);

  // Merged blocks by line
  const mergedByLine = React.useMemo(() => {
    const lineMap = new Map<string, MergedBlock[]>();

    for (const line of filteredLines) {
      const lineSchedules = (schedules ?? []).filter((s) => s.line_id === line.id);
      const byAlloc = new Map<string, { front?: LineSchedule; back?: LineSchedule }>();
      for (const s of lineSchedules) {
        if (!byAlloc.has(s.allocation_id)) byAlloc.set(s.allocation_id, {});
        const entry = byAlloc.get(s.allocation_id)!;
        if (s.process === "front") entry.front = s;
        if (s.process === "back") entry.back = s;
      }

      const blocks: MergedBlock[] = [];
      for (const [allocId, { front, back }] of byAlloc) {
        const alloc = allocMap.get(allocId) ?? null;
        const orderId = front?.production_allocations?.order_id
          ?? back?.production_allocations?.order_id
          ?? alloc?.order_id
          ?? allocId.slice(0, 8);
        const qty = front?.production_allocations?.allocated_qty
          ?? back?.production_allocations?.allocated_qty
          ?? alloc?.allocated_qty
          ?? 0;

        const frontStart = front?.start_date ?? "";
        const frontEnd = front?.end_date ?? "";
        const backStart = back?.start_date ?? "";
        const backEnd = back?.end_date ?? "";

        const starts = [frontStart, backStart].filter(Boolean);
        const ends = [frontEnd, backEnd].filter(Boolean);
        const blockStart = starts.length > 0 ? starts.reduce((a, b) => a < b ? a : b) : "";
        const blockEnd = ends.length > 0 ? ends.reduce((a, b) => a > b ? a : b) : "";

        const productType = guessProductType(orderId, alloc);
        const status = front?.status ?? back?.status ?? alloc?.status ?? "planned";
        const progressPct = status === "completed" ? 100 : status === "in_progress" ? 50 : 10;

        // Risk level based on due date vs end date
        let riskLevel: "SAFE" | "MEDIUM" | "HIGH" = "SAFE";
        if (alloc?.planned_end_date && blockEnd) {
          const due = new Date(alloc.planned_end_date).getTime();
          const end = new Date(blockEnd).getTime();
          const buffer = Math.round((due - end) / (1000 * 60 * 60 * 24));
          if (buffer < 0) riskLevel = "HIGH";
          else if (buffer < 3) riskLevel = "MEDIUM";
        }

        blocks.push({
          allocationId: allocId, orderId, productType, qty,
          startDate: blockStart, endDate: blockEnd,
          frontStart, frontEnd, backStart, backEnd,
          hasFront: !!front, hasBack: !!back,
          status, progressPct, riskLevel,
          allocation: alloc,
          frontSchedule: front ?? null,
          backSchedule: back ?? null,
        });
      }

      blocks.sort((a, b) => a.startDate.localeCompare(b.startDate));
      lineMap.set(line.id, blocks);
    }
    return lineMap;
  }, [filteredLines, schedules, allocMap]);

  // Line utilization
  function getLineUtilization(lineId: string): number {
    const blocks = mergedByLine.get(lineId) ?? [];
    if (blocks.length === 0) return 0;
    let totalDays = 0;
    for (const b of blocks) {
      if (b.startDate && b.endDate) {
        const s = new Date(b.startDate);
        const e = new Date(b.endDate);
        const overlap = Math.max(0,
          differenceInCalendarDays(
            e < addDays(today, zoomDays) ? e : addDays(today, zoomDays),
            s > today ? s : today,
          ),
        );
        totalDays += overlap;
      }
    }
    return Math.min(100, Math.round((totalDays / zoomDays) * 100));
  }

  // Line delayed order count
  function getDelayedCount(lineId: string): number {
    const blocks = mergedByLine.get(lineId) ?? [];
    return blocks.filter((b) => b.riskLevel === "HIGH").length;
  }

  // Drag handlers
  function handleDragStart(event: DragStartEvent) {
    const alloc = event.active.data.current?.allocation as Allocation | undefined;
    setDraggingAlloc(alloc ?? null);
  }

  async function handleDragEnd(event: DragEndEvent) {
    setDraggingAlloc(null);
    const { active, over } = event;
    if (!over) return;

    const lineId = over.id as string;
    const alloc = active.data.current?.allocation as Allocation | undefined;
    if (!alloc) return;

    // Dry-run to preview
    try {
      const result = await dryRunAutoSchedule({
        line_id: lineId,
        allocation_id: alloc.id,
        front_days: DEFAULT_FRONT_DAYS,
      });
      setPending({ allocationId: alloc.id, lineId, summary: result.summary });
    } catch (err) {
      toast(err instanceof Error ? err.message : "预览失败", "error");
    }
  }

  // Confirm scheduling
  async function handleConfirm() {
    if (!pending) return;
    setConfirming(true);
    try {
      await autoScheduleLine({
        line_id: pending.lineId,
        allocation_id: pending.allocationId,
        front_days: DEFAULT_FRONT_DAYS,
      });
      toast("排产成功", "success");
      setPending(null);
      refetchSchedules();
      refetchAllocations();
    } catch (err) {
      toast(err instanceof Error ? err.message : "排产失败", "error");
    } finally {
      setConfirming(false);
    }
  }

  // Selected block for detail drawer
  const selectedAllocation = React.useMemo(() => {
    if (!selectedOrderId) return null;
    for (const blocks of mergedByLine.values()) {
      const found = blocks.find((b) => b.allocationId === selectedOrderId);
      if (found) return found;
    }
    return null;
  }, [selectedOrderId, mergedByLine]);

  const loading = loadingL || loadingS;
  if (loading && !lines) {
    return <div className="card"><div className="loadingCenter">加载中...</div></div>;
  }

  const timelineEnd = addDays(today, zoomDays);

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="schedBoard">
        {/* Left: Unscheduled orders */}
        <UnscheduledPanel allocations={unscheduledAllocations} loading={loadingA} />

        {/* Center: Timeline */}
        <div className="schedMain">
          <div className="card">
            <div className="schedToolbar">
              <div className="schedToolbarLeft">
                <select
                  className="filterSelect"
                  value={filterFactory}
                  onChange={(e) => setFilterFactory(e.target.value)}
                >
                  <option value="">全部工厂</option>
                  {factoryList.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
                <span className="pill">
                  {format(today, "MM/dd")} - {format(timelineEnd, "MM/dd")}
                </span>
              </div>
              <div className="schedToolbarRight">
                {ZOOM_OPTIONS.map((z) => (
                  <button
                    key={z.days}
                    className={`schedZoomBtn ${zoomDays === z.days ? "active" : ""}`}
                    onClick={() => setZoomDays(z.days)}
                  >
                    {z.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="schedTimeline">
              <div className="schedTimelineInner" style={{ minWidth: Math.max(800, zoomDays * 36) }}>
                {/* Date header */}
                <div className="schedDateHeader">
                  <div className="schedDateLabel">产线</div>
                  <div className="schedDates">
                    {Array.from({ length: zoomDays + 1 }, (_, i) => {
                      const d = addDays(today, i);
                      const isToday = i === 0;
                      const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                      return (
                        <div
                          key={i}
                          className={`schedDateCell ${isToday ? "schedDateCell--today" : ""} ${isWeekend ? "schedDateCell--weekend" : ""}`}
                        >
                          {format(d, "d")}
                          {(i === 0 || d.getDate() === 1) && (
                            <span className="schedDateMonth">{format(d, "M月")}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Line rows */}
                {filteredLines.map((line) => (
                  <DroppableLineRow
                    key={line.id}
                    line={line}
                    blocks={mergedByLine.get(line.id) ?? []}
                    utilization={getLineUtilization(line.id)}
                    delayedCount={getDelayedCount(line.id)}
                    zoomDays={zoomDays}
                    today={today}
                    selectedOrderId={selectedOrderId}
                    onSelectBlock={setSelectedOrderId}
                    isDragActive={!!draggingAlloc}
                  />
                ))}

                {filteredLines.length === 0 && (
                  <div className="emptyState" style={{ padding: 40 }}>暂无生产线数据</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* AI Decision Panel */}
      <AIDecisionPanel />

      {/* Drag overlay */}
      <DragOverlay>
        {draggingAlloc ? <OrderCard allocation={draggingAlloc} isOverlay /> : null}
      </DragOverlay>

      {/* Confirm dialog */}
      {pending && (
        <ScheduleConfirmDialog
          summary={pending.summary}
          onConfirm={handleConfirm}
          onCancel={() => setPending(null)}
          confirming={confirming}
        />
      )}

      {/* Order detail drawer */}
      {selectedAllocation && selectedAllocation.allocation && (
        <OrderDetailDrawer
          allocation={selectedAllocation.allocation}
          frontSchedule={selectedAllocation.frontSchedule}
          backSchedule={selectedAllocation.backSchedule}
          onClose={() => setSelectedOrderId(null)}
        />
      )}
    </DndContext>
  );
}

// ── Droppable Line Row ────────────────────────────────────

function DroppableLineRow({
  line,
  blocks,
  utilization,
  delayedCount,
  zoomDays,
  today,
  selectedOrderId,
  onSelectBlock,
  isDragActive,
}: {
  line: ProductionLine;
  blocks: MergedBlock[];
  utilization: number;
  delayedCount: number;
  zoomDays: number;
  today: Date;
  selectedOrderId: string | null;
  onSelectBlock: (id: string | null) => void;
  isDragActive: boolean;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: line.id });

  const utilColor = utilization > 85 ? "#fb7185"
    : utilization > 50 ? "#facc15"
    : "#22c55e";
  const utilClass = utilization > 85 ? "schedLineRow--high"
    : utilization > 50 ? "schedLineRow--mid"
    : "schedLineRow--low";

  return (
    <div
      ref={setNodeRef}
      className={`schedLineRow ${utilClass} ${isDragActive ? "schedLineRow--dropTarget" : ""} ${isOver ? "schedLineRow--dropHover" : ""}`}
    >
      <div className="schedLineInfo">
        <div className="schedLineName">{line.name}</div>
        <div className="schedLineUtil">
          <div className="schedLineUtilBar">
            <div className="schedLineUtilFill" style={{ width: `${utilization}%`, background: utilColor }} />
          </div>
          <span className="schedLineUtilPct">{utilization}%</span>
        </div>
        <div className="schedLineSummary">
          <span className="schedLineStat">{blocks.length}单</span>
          {delayedCount > 0 && (
            <span className="schedLineStat schedLineStat--danger">{delayedCount}延</span>
          )}
        </div>
      </div>
      <div className="schedTrack">
        <div className="schedTodayLine" style={{ left: "0%" }} />

        {blocks.map((block) => {
          if (!block.startDate || !block.endDate) return null;
          const startD = new Date(block.startDate);
          const endD = new Date(block.endDate);
          const leftPct = Math.max(0, (differenceInCalendarDays(startD, today) / zoomDays) * 100);
          const widthPct = Math.max(2, (differenceInCalendarDays(endD, startD) / zoomDays) * 100);
          if (leftPct > 100) return null;

          const colorClass = PRODUCT_CLASS[block.productType] ?? "schedBlock--default";
          const isSelected = selectedOrderId === block.allocationId;
          const riskBorder = block.riskLevel === "HIGH"
            ? "schedBlock--riskHigh"
            : block.riskLevel === "MEDIUM"
              ? "schedBlock--riskMedium"
              : "";

          return (
            <div
              key={block.allocationId}
              className={`schedBlock ${colorClass} ${riskBorder} ${isSelected ? "selected" : ""}`}
              style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
              title={`${block.orderId} | ${block.productType} | ${block.qty}件\n${block.startDate} ~ ${block.endDate}`}
              onClick={() => onSelectBlock(isSelected ? null : block.allocationId)}
            >
              <div className="schedBlockTop">
                <span className="schedBlockOrderId">
                  {block.orderId?.replace("ORD-2026-", "")}
                </span>
                <span className="schedBlockQty">{block.qty}件</span>
              </div>
              <div className="schedBlockTags">
                {block.hasFront && (
                  <span className="schedMicroTag schedMicroTag--front">
                    前 {fmtShort(block.frontStart)}-{fmtShort(block.frontEnd)}
                  </span>
                )}
                {block.hasBack && (
                  <span className="schedMicroTag schedMicroTag--back">
                    后 {fmtShort(block.backStart)}-{fmtShort(block.backEnd)}
                  </span>
                )}
              </div>
              <div className="schedBlockProgress">
                <div
                  className={`schedBlockProgressFill ${
                    block.progressPct >= 80 ? "schedBlockProgressFill--good"
                      : block.progressPct >= 40 ? "schedBlockProgressFill--warn"
                        : "schedBlockProgressFill--bad"
                  }`}
                  style={{ width: `${block.progressPct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────

function fmtShort(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function guessProductType(orderId: string, alloc: Allocation | null): string {
  const combined = (orderId + " " + JSON.stringify(alloc?.factories ?? "")).toLowerCase();
  if (combined.includes("t恤") || combined.includes("tshirt")) return "T恤";
  if (combined.includes("裤子") || combined.includes("pant")) return "裤子";
  if (combined.includes("卫衣") || combined.includes("hoodie")) return "卫衣";
  if (combined.includes("瑜伽") || combined.includes("yoga")) return "瑜伽裤";
  if (combined.includes("外套") || combined.includes("jacket")) return "外套";
  return "T恤";
}
