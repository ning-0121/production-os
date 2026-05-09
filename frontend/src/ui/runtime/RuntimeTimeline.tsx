/**
 * RuntimeTimeline — vis-timeline Gantt for production lines.
 *
 * Features:
 *   - groups grouped by factory
 *   - one row per line; rows highlighted when overloaded / red risk
 *   - order blocks colored by risk + progress overlay
 *   - drag/move blocks → fires a dry-run simulate before showing confirm
 *   - 7d / 14d / 30d zoom presets
 *   - clicking a block selects it (drives the right-hand drawer via Zustand)
 */

import React from "react";
import { Timeline, type TimelineOptions, type DataItem, type DataGroup } from "vis-timeline/standalone";
import { DataSet } from "vis-data/standalone";
import "vis-timeline/styles/vis-timeline-graph2d.css";

import { useAsync } from "../../hooks/useAsync";
import { fetchRuntimeTimeline, simulateRuntimeEvents } from "../../services/api";
import { useAppStore } from "../../stores/appStore";
import { useToast } from "../Toast";
import type { TimelineGroup, TimelineItem } from "../../types";

type Zoom = 7 | 14 | 30;

export function RuntimeTimeline({ refreshKey = 0 }: { refreshKey?: number }) {
  const factoryFilter = useAppStore((s) => s.runtimeFactoryFilter);
  const setRuntimeSelectedAllocationId = useAppStore((s) => s.setRuntimeSelectedAllocationId);
  const { toast } = useToast();
  const [zoom, setZoom] = React.useState<Zoom>(14);

  const range = React.useMemo(() => {
    const now = Date.now();
    return {
      from: new Date(now - Math.floor(zoom / 3) * 86400000).toISOString(),
      to: new Date(now + Math.ceil((zoom * 2) / 3) * 86400000).toISOString(),
    };
  }, [zoom]);

  const { data, loading, error } = useAsync(
    () => fetchRuntimeTimeline({ factory_id: factoryFilter || undefined, from: range.from, to: range.to }),
    [factoryFilter, range.from, range.to, refreshKey],
  );

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const timelineRef = React.useRef<Timeline | null>(null);
  const groupsDsRef = React.useRef<DataSet<DataGroup> | null>(null);
  const itemsDsRef = React.useRef<DataSet<DataItem> | null>(null);
  const pendingMoveRef = React.useRef<{ item: TimelineItem; newStart: string; newEnd: string } | null>(null);

  // Build / refresh datasets
  React.useEffect(() => {
    if (!containerRef.current) return;
    const groups = Array.isArray(data?.groups) ? data!.groups : [];
    const items = Array.isArray(data?.items) ? data!.items : [];

    const groupItems: DataGroup[] = groups.map((g: TimelineGroup) => ({
      id: g.id,
      content: renderGroupHtml(g),
      className: `rtTlGroup rtTlGroup--${g.runtime_risk}`,
      treeLevel: 1,
    }));

    const dataItems: DataItem[] = items.map((it: TimelineItem) => ({
      id: it.id,
      group: it.group,
      start: it.start,
      end: it.end,
      content: renderItemHtml(it),
      className: itemClass(it),
      editable: { updateTime: !it.is_locked, updateGroup: !it.is_locked, remove: false, add: false },
      title: itemTooltip(it),
    }));

    if (!timelineRef.current) {
      const groupsDs = new DataSet<DataGroup>(groupItems);
      const itemsDs = new DataSet<DataItem>(dataItems);
      groupsDsRef.current = groupsDs;
      itemsDsRef.current = itemsDs;

      const opts: TimelineOptions = {
        stack: true,
        editable: { updateTime: true, updateGroup: true, remove: false, add: false, overrideItems: false },
        margin: { item: 6, axis: 24 },
        orientation: { axis: "top", item: "top" },
        zoomMin: 1000 * 60 * 60 * 24,
        zoomMax: 1000 * 60 * 60 * 24 * 90,
        showCurrentTime: true,
        groupOrder: "content",
        verticalScroll: true,
        maxHeight: "560px",
        // Critical: dry-run simulate before allowing a move to commit
        onMoving: (movedItem, callback) => {
          const original = itemsDsRef.current?.get(movedItem.id);
          if (!original) return callback(movedItem);
          // Allow visual drag; we capture the result on onMove.
          callback(movedItem);
        },
        onMove: async (movedItem, callback) => {
          const original = itemsDsRef.current?.get(movedItem.id) as (DataItem & TimelineItem) | undefined;
          if (!original) return callback(null);
          if (original.is_locked) {
            toast("已锁定，无法移动", "error");
            return callback(null);
          }
          pendingMoveRef.current = {
            item: original as unknown as TimelineItem,
            newStart: new Date(movedItem.start as Date | string).toISOString(),
            newEnd: new Date(movedItem.end as Date | string).toISOString(),
          };
          // Run dry-run simulate (we use vip_inserted as a proxy event for impact)
          try {
            const sim = await simulateRuntimeEvents([{
              event_type: "vip_inserted",
              line_id: String(movedItem.group ?? ""),
              payload: {
                allocation_id: movedItem.id,
                new_start: pendingMoveRef.current.newStart,
                new_end: pendingMoveRef.current.newEnd,
                overload_delta: 10,
              },
            }]);
            const linesAffected = sim.summary?.lines_affected?.length ?? 0;
            const ok = window.confirm(
              `调整 "${(original as unknown as TimelineItem).content}"：\n`
              + `  新时段：${formatRange(movedItem.start as Date | string, movedItem.end as Date | string)}\n`
              + `  模拟影响产线数：${linesAffected}\n\n`
              + `应用此调整？\n（提交：会发起本地重排；取消：恢复原位）`,
            );
            if (!ok) {
              callback(null);
              return;
            }
            // Persist via PATCH /allocations/:id (existing endpoint)
            const res = await fetch(`/api/allocations/${movedItem.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                planned_start_date: pendingMoveRef.current.newStart,
                planned_end_date: pendingMoveRef.current.newEnd,
              }),
            });
            if (!res.ok) throw new Error(await res.text());
            toast("已应用调整", "success");
            callback(movedItem);
          } catch (err) {
            toast(`调整失败：${err instanceof Error ? err.message : String(err)}`, "error");
            callback(null);
          } finally {
            pendingMoveRef.current = null;
          }
        },
      };

      timelineRef.current = new Timeline(containerRef.current, itemsDs, groupsDs, opts);
      timelineRef.current.on("select", (props: { items: (string | number)[] }) => {
        const id = props.items?.[0];
        if (id) setRuntimeSelectedAllocationId(String(id));
      });
    } else {
      groupsDsRef.current?.clear();
      groupsDsRef.current?.add(groupItems);
      itemsDsRef.current?.clear();
      itemsDsRef.current?.add(dataItems);
    }

    // Set viewport to range
    timelineRef.current?.setWindow(range.from, range.to, { animation: false });
  }, [data, range.from, range.to, setRuntimeSelectedAllocationId, toast]);

  // Cleanup on unmount only
  React.useEffect(() => {
    return () => {
      timelineRef.current?.destroy();
      timelineRef.current = null;
      groupsDsRef.current = null;
      itemsDsRef.current = null;
    };
  }, []);

  return (
    <div className="rtTimelineWrap">
      <div className="rtTimelineToolbar">
        <span className="hint">视图：</span>
        {[7, 14, 30].map((z) => (
          <button
            key={z}
            className={`btn rtZoomBtn ${zoom === z ? "rtZoomBtn--active" : ""}`}
            onClick={() => setZoom(z as Zoom)}
          >
            {z} 天
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <span className="hint">
          {data?.counts ? `${data.counts.groups} 条产线 · ${data.counts.items} 个订单块` : "—"}
        </span>
      </div>

      {loading && <div className="loadingCenter" style={{ padding: 24 }}>加载排产时间线...</div>}
      {error && !loading && <div style={{ padding: 16, color: "var(--danger)" }}>加载失败：{error}</div>}
      {!loading && !error && (data?.groups?.length ?? 0) === 0 && (
        <div className="emptyState" style={{ padding: 32 }}>
          当前工厂无活跃产线 — 请先在「工厂资源」配置产线。
        </div>
      )}

      <div ref={containerRef} className="rtTimelineContainer" />

      <div className="rtTimelineLegend">
        <span><span className="rtLegendDot rtLegendDot--ok" />正常</span>
        <span><span className="rtLegendDot rtLegendDot--running" />进行中</span>
        <span><span className="rtLegendDot rtLegendDot--high" />落后</span>
        <span><span className="rtLegendDot rtLegendDot--critical" />严重偏离</span>
        <span><span className="rtLegendDot rtLegendDot--locked" />锁定</span>
        <span style={{ marginLeft: 12, color: "var(--muted)" }}>拖拽订单块可调整排期，会先模拟再确认</span>
      </div>
    </div>
  );
}

// ── Renderers ───────────────────────────────────────────

function renderGroupHtml(g: TimelineGroup): string {
  const overload = g.overload_pct > 100 ? `<span class="rtTlGroupBadge rtTlGroupBadge--danger">${Math.round(g.overload_pct)}%</span>` : "";
  const eff = g.current_efficiency < 0.8 ? `<span class="rtTlGroupBadge rtTlGroupBadge--warn">eff ${(g.current_efficiency * 100).toFixed(0)}%</span>` : "";
  return `<div class="rtTlGroupContent">
    <div class="rtTlGroupName">${escapeHtml(g.content)}</div>
    <div class="rtTlGroupSub">${escapeHtml(g.factory_name)} · ${g.runtime_status} ${overload} ${eff}</div>
  </div>`;
}

function renderItemHtml(it: TimelineItem): string {
  const lockIcon = it.is_locked ? "🔒 " : "";
  const progressBar = `<div class="rtTlProgressBar"><div class="rtTlProgressFill" style="width:${Math.max(0, Math.min(100, it.progress))}%"></div></div>`;
  return `<div class="rtTlItemInner">
    <div class="rtTlItemTitle">${lockIcon}${escapeHtml(it.content)}</div>
    <div class="rtTlItemMeta">${escapeHtml(String(it.qty))}件 · ${it.progress}%</div>
    ${progressBar}
  </div>`;
}

function itemClass(it: TimelineItem): string {
  const r = it.risk;
  return `rtTlItem rtTlItem--${r}${it.is_locked ? " rtTlItem--locked" : ""}${it.status === "in_progress" ? " rtTlItem--running" : ""}`;
}

function itemTooltip(it: TimelineItem): string {
  return [
    `订单 ${it.content}`,
    `数量 ${it.qty}`,
    `进度 ${it.progress}%`,
    `偏差 ${it.deviation_pct.toFixed(1)}%`,
    `状态 ${it.status}`,
    it.is_locked ? "已锁定" : "可调整",
  ].join(" · ");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function formatRange(start: Date | string, end: Date | string): string {
  const s = new Date(start);
  const e = new Date(end);
  return `${s.toLocaleDateString()} → ${e.toLocaleDateString()}`;
}
