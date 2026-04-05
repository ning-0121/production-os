import React from "react";
import { addDays, format, startOfDay, differenceInCalendarDays } from "date-fns";

import "../orders/orders.css";
import "./Gantt.css";
import { useAsync } from "../../hooks/useAsync";
import { useRealtimeRefetch } from "../../hooks/useRealtime";
import { fetchProductionLines, fetchLineSchedules } from "../../services/api";
import type { ProductionLine, LineSchedule } from "../../types";

const TIMELINE_DAYS = 30;

export function GanttPage() {
  const today = React.useMemo(() => startOfDay(new Date()), []);
  const timelineEnd = React.useMemo(() => addDays(today, TIMELINE_DAYS), [today]);

  const { data: lines, loading: loadingL } = useAsync(() => fetchProductionLines(), []);
  const { data: schedules, loading: loadingS, refetch } = useAsync(() => fetchLineSchedules(), []);

  useRealtimeRefetch("line_schedules", refetch);

  const [filterFactory, setFilterFactory] = React.useState("");

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
