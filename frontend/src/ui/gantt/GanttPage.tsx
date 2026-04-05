import React from "react";
import { addDays, format, startOfDay, differenceInCalendarDays } from "date-fns";

import "../orders/orders.css";
import "./Gantt.css";
import { useAsync } from "../../hooks/useAsync";
import { useRealtimeRefetch } from "../../hooks/useRealtime";
import { fetchProductionLines, fetchLineSchedules, fetchAllocations, autoScheduleLine, batchScheduleLines } from "../../services/api";
import { useToast } from "../Toast";
import type { ProductionLine, LineSchedule, Allocation } from "../../types";

const TIMELINE_DAYS = 30;

export function GanttPage() {
  const today = React.useMemo(() => startOfDay(new Date()), []);
  const timelineEnd = React.useMemo(() => addDays(today, TIMELINE_DAYS), [today]);

  const { data: lines, loading: loadingL } = useAsync(() => fetchProductionLines(), []);
  const { data: schedules, loading: loadingS, refetch } = useAsync(() => fetchLineSchedules(), []);
  const { data: allAllocations } = useAsync(() => fetchAllocations(), []);

  useRealtimeRefetch("line_schedules", refetch);

  const [filterFactory, setFilterFactory] = React.useState("");
  const [showScheduler, setShowScheduler] = React.useState(false);
  const [showBatch, setShowBatch] = React.useState(false);
  const { toast } = useToast();

  // Group lines by factory
  const factoryGroups = React.useMemo(() => {
    if (!lines) return [];
    const map = new Map<string, { factoryName: string; lines: ProductionLine[] }>();
    for (const line of lines) {
      if (filterFactory && line.factory_id !== filterFactory) continue;
      const key = line.factory_id;
      if (!map.has(key)) map.set(key, { factoryName: line.factories?.name ?? "Unknown", lines: [] });
      map.get(key)!.lines.push(line);
    }
    return [...map.values()];
  }, [lines, filterFactory]);

  // Group schedules by line_id + process
  const scheduleMap = React.useMemo(() => {
    const map = new Map<string, LineSchedule[]>();
    for (const s of schedules ?? []) {
      const key = `${s.line_id}:${s.process}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    // Sort each group by seq
    for (const arr of map.values()) arr.sort((a, b) => a.seq - b.seq);
    return map;
  }, [schedules]);

  // Factory list for filter
  const factoryList = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const l of lines ?? []) {
      if (l.factories?.name) seen.set(l.factory_id, l.factories.name);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [lines]);

  const loading = loadingL || loadingS;
  if (loading) return <div className="card"><div className="loadingCenter">加载中...</div></div>;

  // Detect gaps (idle time between front process orders)
  function detectGaps(items: LineSchedule[]): { start: string; end: string; days: number }[] {
    const gaps: { start: string; end: string; days: number }[] = [];
    for (let i = 0; i < items.length - 1; i++) {
      const gapDays = differenceInCalendarDays(new Date(items[i + 1].start_date), new Date(items[i].end_date));
      if (gapDays > 0) {
        gaps.push({ start: items[i].end_date, end: items[i + 1].start_date, days: gapDays });
      }
    }
    return gaps;
  }

  return (
    <div className="card">
      <div className="cardHeader">
        <div>
          <h2>生产线排产</h2>
          <div className="hint">前道（青色）完成后接新单 | 后道（紫色）跟进 | 红色=空闲间隙</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select className="filterSelect" value={filterFactory} onChange={(e) => setFilterFactory(e.target.value)}>
            <option value="">全部工厂</option>
            {factoryList.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <span className="pill">{format(today, "MM/dd")} → {format(timelineEnd, "MM/dd")}</span>
          <button className="btn" onClick={() => setShowScheduler(true)}>+ 手动排单</button>
          <button className="btn primary" onClick={() => setShowBatch(true)}>智能全排</button>
        </div>
      </div>

      <div className="ganttWrap">
        <div className="gantt">
          {/* Timeline header */}
          <div className="timelineHeader">
            <div className="timelineLabel">生产线</div>
            <div className="timelineDates">
              {Array.from({ length: TIMELINE_DAYS + 1 }, (_, i) => {
                const d = addDays(today, i);
                const isToday = i === 0;
                const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                return (
                  <div key={i} className={`timelineDay ${isToday ? "timelineDayToday" : ""} ${isWeekend ? "timelineDayWeekend" : ""}`}>
                    {format(d, "d")}
                    {(i === 0 || d.getDate() === 1) && <span className="timelineMonth">{format(d, "MMM")}</span>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Factory groups */}
          {factoryGroups.map((group) => (
            <div key={group.factoryName} className="factoryGroup">
              <div className="factoryGroupHeader">{group.factoryName}</div>
              {group.lines.map((line) => {
                const frontItems = scheduleMap.get(`${line.id}:front`) ?? [];
                const backItems = scheduleMap.get(`${line.id}:back`) ?? [];
                const frontGaps = detectGaps(frontItems);

                return (
                  <div key={line.id} className="lineGroup">
                    {/* Front process row */}
                    <div className="lineRow">
                      <div className="lineRowLabel">
                        <span className="lineName">{line.name}</span>
                        <span className="processLabel processFront">前道</span>
                        <span className="capacityLabel">{line.front_capacity_per_day}/天</span>
                      </div>
                      <div className="lineRowTimeline">
                        {frontItems.map((s) => (
                          <ScheduleBlock key={s.id} schedule={s} process="front" today={today} totalDays={TIMELINE_DAYS} />
                        ))}
                        {frontGaps.map((g, i) => (
                          <GapIndicator key={`gap-${i}`} gap={g} today={today} totalDays={TIMELINE_DAYS} />
                        ))}
                      </div>
                    </div>
                    {/* Back process row */}
                    <div className="lineRow lineRowBack">
                      <div className="lineRowLabel">
                        <span className="lineName"></span>
                        <span className="processLabel processBack">后道</span>
                        <span className="capacityLabel">{line.back_capacity_per_day}/天</span>
                      </div>
                      <div className="lineRowTimeline">
                        {backItems.map((s) => (
                          <ScheduleBlock key={s.id} schedule={s} process="back" today={today} totalDays={TIMELINE_DAYS} />
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {factoryGroups.length === 0 && (
            <div className="emptyState" style={{ padding: 40 }}>暂无生产线数据</div>
          )}
        </div>
      </div>

      {/* Scheduler Drawer */}
      {showScheduler && (
        <SchedulerDrawer
          lines={lines ?? []}
          allocations={allAllocations ?? []}
          schedules={schedules ?? []}
          onClose={() => setShowScheduler(false)}
          onScheduled={() => { setShowScheduler(false); refetch(); toast("排单成功", "success"); }}
          onError={(msg) => toast(msg, "error")}
        />
      )}

      {/* Batch Scheduler */}
      {showBatch && (
        <BatchSchedulerDrawer
          onClose={() => setShowBatch(false)}
          onScheduled={() => { setShowBatch(false); refetch(); toast("全部排产完成", "success"); }}
          onError={(msg) => toast(msg, "error")}
        />
      )}

      {/* Legend */}
      <div className="ganttLegend">
        <div className="ganttLegendItem"><div className="ganttLegendDot" style={{ background: "#6ee7ff" }} /> 前道</div>
        <div className="ganttLegendItem"><div className="ganttLegendDot" style={{ background: "#a78bfa" }} /> 后道</div>
        <div className="ganttLegendItem"><div className="ganttLegendDot" style={{ background: "rgba(251,113,133,.3)", border: "1px dashed #fb7185", width: 12, height: 12, borderRadius: 2 }} /> 空闲间隙</div>
        <div className="ganttLegendItem"><div className="ganttLegendDot" style={{ background: "var(--danger)", width: 2, height: 12, borderRadius: 1 }} /> 今天</div>
      </div>
    </div>
  );
}

// ── Schedule Block ──────────────────────────────────────

function ScheduleBlock({ schedule, process, today, totalDays }: {
  schedule: LineSchedule;
  process: "front" | "back";
  today: Date;
  totalDays: number;
}) {
  const start = new Date(schedule.start_date);
  const end = new Date(schedule.end_date);
  const leftPct = Math.max(0, (differenceInCalendarDays(start, today) / totalDays) * 100);
  const widthPct = Math.max(1, (differenceInCalendarDays(end, start) / totalDays) * 100);
  const orderId = schedule.production_allocations?.order_id ?? "?";
  const qty = schedule.production_allocations?.allocated_qty ?? 0;
  const days = differenceInCalendarDays(end, start);

  const statusCls = schedule.status === "completed" ? "schCompleted" :
    schedule.status === "in_progress" ? "schInProgress" : "schPending";

  return (
    <div
      className={`schBlock ${process === "front" ? "schFront" : "schBack"} ${statusCls}`}
      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
      title={`${orderId} | ${qty}件 | ${format(start, "MM/dd")}-${format(end, "MM/dd")} (${days}天) | ${schedule.status}`}
    >
      <span className="schOrderId">{orderId}</span>
      <span className="schInfo">{qty}件 {days}天</span>
    </div>
  );
}

// ── Batch Scheduler (Full-screen visual Gantt preview) ───

type BatchAssignment = Awaited<ReturnType<typeof batchScheduleLines>>["assignments"][0];
type BatchResult = Awaited<ReturnType<typeof batchScheduleLines>>;

function BatchSchedulerDrawer({ onClose, onScheduled, onError }: {
  onClose: () => void;
  onScheduled: () => void;
  onError: (msg: string) => void;
}) {
  const [preview, setPreview] = React.useState<BatchResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);

  React.useEffect(() => {
    setLoading(true);
    batchScheduleLines(true)
      .then((r) => setPreview(r))
      .catch((err) => onError(err instanceof Error ? err.message : "预览失败"))
      .finally(() => setLoading(false));
  }, []);

  async function handleConfirm() {
    setConfirming(true);
    try {
      await batchScheduleLines(false);
      onScheduled();
    } catch (err) {
      onError(err instanceof Error ? err.message : "排产失败");
    } finally {
      setConfirming(false);
    }
  }

  // Compute timeline range from assignments
  const { timeStart, timeEnd, totalDays } = React.useMemo(() => {
    if (!preview || preview.assignments.length === 0) {
      const s = startOfDay(new Date());
      return { timeStart: s, timeEnd: addDays(s, 30), totalDays: 30 };
    }
    let minDate = preview.assignments[0].front.start;
    let maxDate = preview.assignments[0].back.end;
    for (const a of preview.assignments) {
      if (a.front.start < minDate) minDate = a.front.start;
      if (a.back.end > maxDate) maxDate = a.back.end;
      if (a.due_date > maxDate) maxDate = a.due_date;
    }
    const s = startOfDay(new Date(minDate));
    const e = addDays(new Date(maxDate), 2);
    return { timeStart: s, timeEnd: e, totalDays: Math.max(14, differenceInCalendarDays(e, s)) };
  }, [preview]);

  // Group assignments by line
  const lineGroups = React.useMemo(() => {
    if (!preview) return [];
    const map = new Map<string, { lineName: string; assignments: BatchAssignment[] }>();
    for (const a of preview.assignments) {
      if (!map.has(a.line_id)) map.set(a.line_id, { lineName: a.line_name, assignments: [] });
      map.get(a.line_id)!.assignments.push(a);
    }
    return [...map.values()];
  }, [preview]);

  // Colors per product type
  const productColors: Record<string, string> = {
    "T恤": "#6ee7ff",
    "裤子": "#a78bfa",
    "卫衣": "#f59e0b",
    "瑜伽裤": "#22c55e",
    "外套": "#fb7185",
  };

  function pct(dateStr: string) {
    return Math.max(0, Math.min(100, (differenceInCalendarDays(new Date(dateStr), timeStart) / totalDays) * 100));
  }

  function widthPct(start: string, end: string) {
    return Math.max(1.5, (differenceInCalendarDays(new Date(end), new Date(start)) / totalDays) * 100);
  }

  return (
    <div className="batchOverlay">
      <div className="batchPanel">
        {/* Header */}
        <div className="batchHeader">
          <div>
            <h2>智能排产预览</h2>
            {preview && (
              <span className="batchHeaderSub">
                {preview.summary.scheduled} 单 |
                <span style={{ color: "#22c55e" }}> {preview.summary.on_time} 准时</span>
                {preview.summary.at_risk > 0 && <span style={{ color: "var(--danger)" }}> {preview.summary.at_risk} 延期</span>}
                {preview.summary.unscheduled > 0 && <span style={{ color: "var(--muted)" }}> {preview.summary.unscheduled} 未排</span>}
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={onClose}>取消</button>
            <button
              className="btn primary"
              disabled={confirming || !preview || preview.assignments.length === 0}
              onClick={handleConfirm}
            >
              {confirming ? "排产中..." : `确认排产 ${preview?.assignments.length ?? 0} 单`}
            </button>
          </div>
        </div>

        {loading && <div className="loadingCenter" style={{ padding: 60 }}>计算最优排产方案...</div>}

        {preview && (
          <div className="batchGanttWrap">
            {/* Timeline dates */}
            <div className="batchTimeline">
              <div className="batchTimelineLabel">产线</div>
              <div className="batchTimelineDates">
                {Array.from({ length: totalDays + 1 }, (_, i) => {
                  const d = addDays(timeStart, i);
                  const isToday = format(d, "yyyy-MM-dd") === format(new Date(), "yyyy-MM-dd");
                  return (
                    <div key={i} className={`batchTimelineDay ${isToday ? "batchTimelineDayToday" : ""}`}>
                      {format(d, "d")}
                      {(i === 0 || d.getDate() === 1) && <span className="batchTimelineMonth">{format(d, "M月")}</span>}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Line rows */}
            {lineGroups.map((group) => (
              <div key={group.lineName} className="batchLineGroup">
                {/* Front row */}
                <div className="batchRow">
                  <div className="batchRowLabel">
                    <span className="batchLineName">{group.lineName}</span>
                    <span className="processLabel processFront">前道</span>
                  </div>
                  <div className="batchRowBars">
                    {group.assignments.map((a) => {
                      const color = productColors[a.product_type] ?? "#6ee7ff";
                      return (
                        <div
                          key={a.allocation_id + "-f"}
                          className="batchBar"
                          style={{
                            left: `${pct(a.front.start)}%`,
                            width: `${widthPct(a.front.start, a.front.end)}%`,
                            background: `linear-gradient(135deg, ${color}44, ${color}22)`,
                            borderColor: `${color}88`,
                          }}
                          title={`${a.order_id} ${a.product_type} ${a.qty}件\n前道 ${a.front.start}→${a.front.end} (${a.front.days}天)`}
                        >
                          <span className="batchBarText" style={{ color }}>{a.order_id?.replace("ORD-2026-", "")}</span>
                          <span className="batchBarSub">{a.product_type}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
                {/* Back row */}
                <div className="batchRow batchRowBack">
                  <div className="batchRowLabel">
                    <span className="batchLineName" />
                    <span className="processLabel processBack">后道</span>
                  </div>
                  <div className="batchRowBars">
                    {group.assignments.map((a) => {
                      const color = productColors[a.product_type] ?? "#a78bfa";
                      return (
                        <div
                          key={a.allocation_id + "-b"}
                          className={`batchBar ${a.delivery_ok ? "" : "batchBarLate"}`}
                          style={{
                            left: `${pct(a.back.start)}%`,
                            width: `${widthPct(a.back.start, a.back.end)}%`,
                            background: `linear-gradient(135deg, ${color}33, ${color}18)`,
                            borderColor: a.delivery_ok ? `${color}66` : "var(--danger)",
                          }}
                          title={`${a.order_id} 后道 ${a.back.start}→${a.back.end} (${a.back.days}天)\n交期 ${a.due_date} ${a.delivery_ok ? "✓准时" : `⚠延期${a.days_late}天`}`}
                        >
                          <span className="batchBarText">{a.order_id?.replace("ORD-2026-", "")}</span>
                          <span className="batchBarSub">{a.qty}件</span>
                          {!a.delivery_ok && <span className="batchBarWarn">延{a.days_late}天</span>}
                        </div>
                      );
                    })}
                    {/* Due date markers */}
                    {group.assignments.map((a) => (
                      <div
                        key={a.allocation_id + "-due"}
                        className="batchDueMark"
                        style={{ left: `${pct(a.due_date)}%` }}
                        title={`${a.order_id} 交期 ${a.due_date}`}
                      >
                        <span className="batchDueLabel">{a.order_id?.replace("ORD-2026-", "")}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}

            {/* Warnings */}
            {preview.warnings.length > 0 && (
              <div className="batchWarnings" style={{ margin: "12px 0" }}>
                <div className="batchWarningsTitle">⚠ 注意</div>
                {preview.warnings.map((w, i) => (
                  <div key={i} className="batchWarnItem">{w.message}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Scheduler Drawer ────────────────────────────────────

function SchedulerDrawer({ lines, allocations, schedules, onClose, onScheduled, onError }: {
  lines: ProductionLine[];
  allocations: Allocation[];
  schedules: LineSchedule[];
  onClose: () => void;
  onScheduled: () => void;
  onError: (msg: string) => void;
}) {
  const [lineId, setLineId] = React.useState("");
  const [allocId, setAllocId] = React.useState("");
  const [frontDays, setFrontDays] = React.useState(5);
  const [submitting, setSubmitting] = React.useState(false);

  // Filter out already-scheduled allocations
  const scheduledAllocIds = new Set(schedules.map((s) => s.allocation_id));
  const availableOrders = allocations.filter((a) => !scheduledAllocIds.has(a.id));

  // Preview calculation
  const selectedLine = lines.find((l) => l.id === lineId);
  const selectedOrder = allocations.find((a) => a.id === allocId);

  const preview = React.useMemo(() => {
    if (!selectedLine || !selectedOrder || !frontDays) return null;

    const today = new Date().toISOString().slice(0, 10);

    // Find last front end on this line
    const lineFronts = schedules.filter((s) => s.line_id === lineId && s.process === "front");
    const lastFrontEnd = lineFronts.length > 0
      ? lineFronts.reduce((max, s) => s.end_date > max ? s.end_date : max, "")
      : today;
    const frontStart = lastFrontEnd > today ? lastFrontEnd : today;

    const frontStartDate = new Date(frontStart);
    const frontEndDate = new Date(frontStartDate);
    frontEndDate.setDate(frontEndDate.getDate() + frontDays);
    const frontEnd = frontEndDate.toISOString().slice(0, 10);

    // Find last back end on this line
    const lineBacks = schedules.filter((s) => s.line_id === lineId && s.process === "back");
    const lastBackEnd = lineBacks.length > 0
      ? lineBacks.reduce((max, s) => s.end_date > max ? s.end_date : max, "")
      : today;
    const backStart = frontEnd > lastBackEnd ? frontEnd : lastBackEnd;

    const backCap = selectedLine.back_capacity_per_day || 300;
    const qty = selectedOrder.allocated_qty || 1000;
    const backDays = Math.ceil(qty / backCap);
    const backEndDate = new Date(backStart);
    backEndDate.setDate(backEndDate.getDate() + backDays);

    return {
      frontStart,
      frontEnd,
      backStart,
      backEnd: backEndDate.toISOString().slice(0, 10),
      backDays,
      backCap,
      qty,
      hasBackQueue: backStart > frontEnd,
    };
  }, [lineId, allocId, frontDays, selectedLine, selectedOrder, schedules]);

  async function handleSubmit() {
    if (!lineId || !allocId) return;
    setSubmitting(true);
    try {
      await autoScheduleLine({ line_id: lineId, allocation_id: allocId, front_days: frontDays });
      onScheduled();
    } catch (err) {
      onError(err instanceof Error ? err.message : "排单失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="drawerOverlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawerHeader">
          <h3>智能排单</h3>
          <button className="drawerClose" onClick={onClose}>x</button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "12px 0" }}>
          {/* Select Line */}
          <label className="orderField">
            <span className="orderFieldLabel">选择产线 *</span>
            <select className="orderInput" value={lineId} onChange={(e) => setLineId(e.target.value)}>
              <option value="">请选择...</option>
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.factories?.name} - {l.name} (前{l.front_capacity_per_day}/天 后{l.back_capacity_per_day}/天)
                </option>
              ))}
            </select>
          </label>

          {/* Select Order */}
          <label className="orderField">
            <span className="orderFieldLabel">选择订单 *</span>
            <select className="orderInput" value={allocId} onChange={(e) => setAllocId(e.target.value)}>
              <option value="">请选择...</option>
              {availableOrders.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.order_id ?? a.id.slice(0, 8)} — {a.allocated_qty}件
                </option>
              ))}
            </select>
            {availableOrders.length === 0 && (
              <span className="orderFieldError">没有可排的订单，请先在看板创建订单</span>
            )}
          </label>

          {/* Front Days Input */}
          <label className="orderField">
            <span className="orderFieldLabel">前道天数 *</span>
            <input
              className="orderInput"
              type="number"
              min={1}
              max={30}
              value={frontDays}
              onChange={(e) => setFrontDays(Number(e.target.value))}
            />
            <span style={{ fontSize: 11, color: "var(--muted)" }}>前道需要几天完成这个订单</span>
          </label>

          {/* Preview */}
          {preview && (
            <div className="schedPreview">
              <div className="schedPreviewTitle">排单预览</div>
              <div className="schedPreviewRow">
                <span className="processLabel processFront">前道</span>
                <span>{preview.frontStart} → {preview.frontEnd}</span>
                <span className="schedPreviewDays">{frontDays}天</span>
              </div>
              <div className="schedPreviewRow">
                <span className="processLabel processBack">后道</span>
                <span>{preview.backStart} → {preview.backEnd}</span>
                <span className="schedPreviewDays">{preview.backDays}天 ({preview.backCap}件/天)</span>
              </div>
              {preview.hasBackQueue && (
                <div className="schedPreviewWarn">
                  后道需要排队：上一单后道 {preview.backStart} 才结束
                </div>
              )}
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                共 {preview.qty} 件 | 前道结束后后道立即开始
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="orderActions">
            <button className="btn" onClick={onClose}>取消</button>
            <button
              className="btn primary"
              disabled={!lineId || !allocId || !frontDays || submitting}
              onClick={handleSubmit}
            >
              {submitting ? "排单中..." : "确认排入"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Gap Indicator ───────────────────────────────────────

function GapIndicator({ gap, today, totalDays }: {
  gap: { start: string; end: string; days: number };
  today: Date;
  totalDays: number;
}) {
  const leftPct = Math.max(0, (differenceInCalendarDays(new Date(gap.start), today) / totalDays) * 100);
  const widthPct = Math.max(0.5, (gap.days / totalDays) * 100);

  return (
    <div
      className="schGap"
      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
      title={`空闲 ${gap.days} 天 — 产线浪费！`}
    >
      <span className="schGapLabel">空闲{gap.days}天</span>
    </div>
  );
}
