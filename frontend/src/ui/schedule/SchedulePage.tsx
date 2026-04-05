import React from "react";
import { addDays, format, startOfDay, differenceInCalendarDays } from "date-fns";
import { useAsync } from "../../hooks/useAsync";
import { useRealtimeRefetch } from "../../hooks/useRealtime";
import {
  fetchProductionLines,
  fetchLineSchedules,
  fetchAllocations,
  batchScheduleLines,
  autoScheduleLine,
} from "../../services/api";
import { useToast } from "../Toast";
import { OrderDetailDrawer } from "./OrderDetailDrawer";
import type { ProductionLine, LineSchedule, Allocation } from "../../types";
import "../orders/orders.css";
import "./schedule.css";

const ZOOM_OPTIONS = [
  { label: "7天", days: 7 },
  { label: "14天", days: 14 },
  { label: "30天", days: 30 },
] as const;

const PRODUCT_COLORS: Record<string, string> = {
  "T恤": "#6ee7ff",
  "裤子": "#a78bfa",
  "卫衣": "#f59e0b",
  "瑜伽裤": "#22c55e",
  "外套": "#fb7185",
};

const PRODUCT_CLASS: Record<string, string> = {
  "T恤": "schedBlock--tshirt",
  "裤子": "schedBlock--pants",
  "卫衣": "schedBlock--hoodie",
  "瑜伽裤": "schedBlock--yoga",
  "外套": "schedBlock--jacket",
};

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
  allocation: Allocation | null;
  frontSchedule: LineSchedule | null;
  backSchedule: LineSchedule | null;
};

export function SchedulePage() {
  const today = React.useMemo(() => startOfDay(new Date()), []);
  const [zoomDays, setZoomDays] = React.useState(14);
  const [filterFactory, setFilterFactory] = React.useState("");
  const [selectedOrderId, setSelectedOrderId] = React.useState<string | null>(null);

  const { toast } = useToast();

  const { data: lines, loading: loadingL } = useAsync(() => fetchProductionLines(), []);
  const { data: schedules, loading: loadingS, refetch } = useAsync(() => fetchLineSchedules(), []);
  const { data: allAllocations } = useAsync(() => fetchAllocations(), []);

  useRealtimeRefetch("line_schedules", refetch);

  // Factory list for dropdown
  const factoryList = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const l of lines ?? []) {
      if (l.factories?.name) seen.set(l.factory_id, l.factories.name);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [lines]);

  // Default to first factory
  React.useEffect(() => {
    if (!filterFactory && factoryList.length > 0) {
      setFilterFactory(factoryList[0].id);
    }
  }, [factoryList, filterFactory]);

  // Lines for current factory
  const filteredLines = React.useMemo(() => {
    if (!lines) return [];
    if (!filterFactory) return lines;
    return lines.filter((l) => l.factory_id === filterFactory);
  }, [lines, filterFactory]);

  // Build allocation lookup
  const allocMap = React.useMemo(() => {
    const map = new Map<string, Allocation>();
    for (const a of allAllocations ?? []) map.set(a.id, a);
    return map;
  }, [allAllocations]);

  // Group schedules by line_id, then by allocation_id to merge front+back
  const mergedByLine = React.useMemo(() => {
    const lineMap = new Map<string, MergedBlock[]>();

    for (const line of filteredLines) {
      const lineSchedules = (schedules ?? []).filter((s) => s.line_id === line.id);

      // Group by allocation_id
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

        // Block spans from earliest start to latest end
        const starts = [frontStart, backStart].filter(Boolean);
        const ends = [frontEnd, backEnd].filter(Boolean);
        const blockStart = starts.length > 0 ? starts.reduce((a, b) => a < b ? a : b) : "";
        const blockEnd = ends.length > 0 ? ends.reduce((a, b) => a > b ? a : b) : "";

        // Guess product type from order_id or allocation
        const productType = guessProductType(orderId, alloc);

        // Compute simple progress: if completed -> 100, in_progress -> 50, else 0
        const status = front?.status ?? back?.status ?? alloc?.status ?? "planned";
        const progressPct = status === "completed" ? 100
          : status === "in_progress" ? 50
          : 10;

        blocks.push({
          allocationId: allocId,
          orderId,
          productType,
          qty,
          startDate: blockStart,
          endDate: blockEnd,
          frontStart, frontEnd,
          backStart, backEnd,
          hasFront: !!front,
          hasBack: !!back,
          status,
          progressPct,
          allocation: alloc,
          frontSchedule: front ?? null,
          backSchedule: back ?? null,
        });
      }

      // Sort blocks by start date
      blocks.sort((a, b) => a.startDate.localeCompare(b.startDate));
      lineMap.set(line.id, blocks);
    }

    return lineMap;
  }, [filteredLines, schedules, allocMap, allAllocations]);

  // Compute line utilization
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

  // Selected allocation for drawer
  const selectedAllocation = React.useMemo(() => {
    if (!selectedOrderId) return null;
    // Find the merged block
    for (const blocks of mergedByLine.values()) {
      const found = blocks.find((b) => b.allocationId === selectedOrderId);
      if (found) return found;
    }
    return null;
  }, [selectedOrderId, mergedByLine]);

  const loading = loadingL || loadingS;
  if (loading) {
    return <div className="card"><div className="loadingCenter">加载中...</div></div>;
  }

  const timelineEnd = addDays(today, zoomDays);

  return (
    <div className={`schedPage ${selectedOrderId ? "schedDrawerOpen" : ""}`}>
      <div className="schedMain">
        <div className="card">
          {/* Toolbar */}
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

          {/* Timeline */}
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
              {filteredLines.map((line) => {
                const util = getLineUtilization(line.id);
                const utilClass = util > 85 ? "schedLineRow--high"
                  : util > 50 ? "schedLineRow--mid"
                  : "schedLineRow--low";
                const utilColor = util > 85 ? "#fb7185"
                  : util > 50 ? "#facc15"
                  : "#22c55e";
                const blocks = mergedByLine.get(line.id) ?? [];

                return (
                  <div key={line.id} className={`schedLineRow ${utilClass}`}>
                    <div className="schedLineInfo">
                      <div className="schedLineName">{line.name}</div>
                      <div className="schedLineUtil">
                        <div className="schedLineUtilBar">
                          <div
                            className="schedLineUtilFill"
                            style={{ width: `${util}%`, background: utilColor }}
                          />
                        </div>
                        <span className="schedLineUtilPct">{util}%</span>
                      </div>
                    </div>
                    <div className="schedTrack">
                      {/* Today line */}
                      <div
                        className="schedTodayLine"
                        style={{ left: "0%" }}
                      />

                      {/* Order blocks */}
                      {blocks.map((block) => {
                        if (!block.startDate || !block.endDate) return null;
                        const startD = new Date(block.startDate);
                        const endD = new Date(block.endDate);
                        const leftPct = Math.max(0,
                          (differenceInCalendarDays(startD, today) / zoomDays) * 100,
                        );
                        const widthPct = Math.max(2,
                          (differenceInCalendarDays(endD, startD) / zoomDays) * 100,
                        );

                        // Out of visible range check
                        if (leftPct > 100) return null;

                        const colorClass = PRODUCT_CLASS[block.productType] ?? "schedBlock--default";
                        const isSelected = selectedOrderId === block.allocationId;

                        const progressFillClass = block.progressPct >= 80
                          ? "schedBlockProgressFill--good"
                          : block.progressPct >= 40
                            ? "schedBlockProgressFill--warn"
                            : "schedBlockProgressFill--bad";

                        return (
                          <div
                            key={block.allocationId}
                            className={`schedBlock ${colorClass} ${isSelected ? "selected" : ""}`}
                            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                            title={`${block.orderId} | ${block.productType} | ${block.qty}件\n${block.startDate} ~ ${block.endDate}`}
                            onClick={() => setSelectedOrderId(
                              isSelected ? null : block.allocationId,
                            )}
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

                            {/* Progress bar */}
                            <div className="schedBlockProgress">
                              <div
                                className={`schedBlockProgressFill ${progressFillClass}`}
                                style={{ width: `${block.progressPct}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {filteredLines.length === 0 && (
                <div className="emptyState" style={{ padding: 40 }}>暂无生产线数据</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Order Detail Drawer */}
      {selectedAllocation && selectedAllocation.allocation && (
        <OrderDetailDrawer
          allocation={selectedAllocation.allocation}
          frontSchedule={selectedAllocation.frontSchedule}
          backSchedule={selectedAllocation.backSchedule}
          onClose={() => setSelectedOrderId(null)}
        />
      )}
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
  // Try to extract from allocation data or order_id patterns
  const combined = (orderId + " " + JSON.stringify(alloc?.factories ?? "")).toLowerCase();
  if (combined.includes("t恤") || combined.includes("tshirt") || combined.includes("t-shirt")) return "T恤";
  if (combined.includes("裤子") || combined.includes("pant")) return "裤子";
  if (combined.includes("卫衣") || combined.includes("hoodie")) return "卫衣";
  if (combined.includes("瑜伽") || combined.includes("yoga")) return "瑜伽裤";
  if (combined.includes("外套") || combined.includes("jacket")) return "外套";
  return "T恤"; // default
}
