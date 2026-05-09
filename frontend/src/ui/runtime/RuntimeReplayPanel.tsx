/**
 * RuntimeReplayPanel — event-by-event "what happened" review.
 *
 * MVP scope: list recent events (paginated/filterable), pick one, show its
 * propagation result + suggested actions + next/previous navigation.
 *
 * No video-style scrubber yet — we deliberately keep this simple to match the
 * "MVP" requirement.
 */

import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchRuntimeEvents } from "../../services/api";
import { useAppStore } from "../../stores/appStore";
import type { RuntimeEvent, RuntimeSeverity } from "../../types";

const SEVERITY_LABEL: Record<RuntimeSeverity, string> = {
  critical: "紧急", high: "重要", medium: "建议", low: "提示", info: "信息",
};

export function RuntimeReplayPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const selectedId = useAppStore((s) => s.runtimeSelectedEventId);
  const setSelected = useAppStore((s) => s.setRuntimeSelectedEventId);
  const factoryFilter = useAppStore((s) => s.runtimeFactoryFilter);
  const [severityFilter, setSeverityFilter] = React.useState<RuntimeSeverity | "all">("all");

  const { data, loading, error } = useAsync(
    () => fetchRuntimeEvents({
      factory_id: factoryFilter || undefined,
      severity: severityFilter === "all" ? undefined : severityFilter,
      limit: 200,
    }),
    [factoryFilter, severityFilter, refreshKey],
  );

  const events: RuntimeEvent[] = Array.isArray(data?.events) ? data!.events : [];
  const idx = events.findIndex((e) => e.id === selectedId);
  const current = idx >= 0 ? events[idx] : null;

  function navigate(step: 1 | -1) {
    if (events.length === 0) return;
    if (idx < 0) {
      setSelected(events[0].id);
      return;
    }
    const next = idx + step;
    if (next < 0 || next >= events.length) return;
    setSelected(events[next].id);
  }

  return (
    <div className="rtReplayWrap">
      <div className="rtReplayLeft">
        <div className="rtReplayToolbar">
          <span className="hint">严重度：</span>
          {(["all", "critical", "high", "medium", "low", "info"] as const).map((s) => (
            <button
              key={s}
              className={`btn rtZoomBtn ${severityFilter === s ? "rtZoomBtn--active" : ""}`}
              onClick={() => setSeverityFilter(s)}
            >
              {s === "all" ? "全部" : SEVERITY_LABEL[s as RuntimeSeverity] ?? s}
            </button>
          ))}
        </div>
        {loading && <div className="loadingCenter" style={{ padding: 24 }}>加载事件...</div>}
        {error && <div style={{ padding: 16, color: "var(--danger)" }}>加载失败：{error}</div>}
        {!loading && !error && events.length === 0 && (
          <div className="emptyState" style={{ padding: 24 }}>窗口期内无事件</div>
        )}
        <div className="rtReplayList">
          {events.map((e) => (
            <button
              key={e.id}
              className={`rtReplayItem rtReplayItem--${e.severity} ${e.id === selectedId ? "rtReplayItem--active" : ""}`}
              onClick={() => setSelected(e.id)}
            >
              <div className="rtReplayItemTop">
                <span className={`todayAiUrgency todayAiUrgency--${e.severity}`}>{SEVERITY_LABEL[e.severity] ?? e.severity}</span>
                <span className="rtReplayItemType">{e.event_type}</span>
                <span className="rtReplayItemSeq">#{e.replay_seq}</span>
              </div>
              <div className="rtReplayItemMeta">
                {[e.line_id ? `产线 ${e.line_id.slice(0, 6)}` : null, e.order_id ? `订单 ${e.order_id}` : null, new Date(e.occurred_at).toLocaleString()].filter(Boolean).join(" · ")}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="rtReplayRight card">
        <div className="cardHeader">
          <h3 style={{ margin: 0 }}>事件回放</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" disabled={idx <= 0} onClick={() => navigate(-1)}>← 上一个</button>
            <button className="btn" disabled={idx < 0 || idx >= events.length - 1} onClick={() => navigate(1)}>下一个 →</button>
          </div>
        </div>
        {!current ? (
          <div className="emptyState" style={{ padding: 32 }}>从左侧选择一个事件查看传播路径与建议</div>
        ) : (
          <EventDetailView event={current} />
        )}
      </div>
    </div>
  );
}

function EventDetailView({ event }: { event: RuntimeEvent }) {
  const affected = Array.isArray(event.affected_entities) ? event.affected_entities : [];
  return (
    <div className="rtReplayDetail">
      <div className="rtReplayDetailRow">
        <div><strong>类型：</strong>{event.event_type}</div>
        <div><strong>严重度：</strong>{event.severity}</div>
        <div><strong>来源：</strong>{event.source}{event.source_ref ? ` (${event.source_ref})` : ""}</div>
        <div><strong>时间：</strong>{new Date(event.occurred_at).toLocaleString()}</div>
        {event.confidence != null && <div><strong>置信度：</strong>{Math.round(event.confidence * 100)}%</div>}
        <div><strong>传播状态：</strong>{event.propagation_status}</div>
      </div>

      {event.reasoning && (
        <div className="rtReplayDetailReasoning">
          <strong>原因：</strong>{event.reasoning}
        </div>
      )}

      <div className="rtReplayDetailSection">
        <h4>影响节点（{affected.length}）</h4>
        {affected.length === 0 ? (
          <div className="emptyState" style={{ padding: 16 }}>该事件无下游传播</div>
        ) : (
          <div className="rtReplayAffectedTable">
            <div className="rtReplayAffectedHeader">
              <span>节点</span>
              <span>影响</span>
              <span>深度</span>
              <span>预计延期</span>
              <span>路径</span>
            </div>
            {affected.slice(0, 20).map((n, i) => (
              <div className="rtReplayAffectedRow" key={i}>
                <span>{n.node_type}#{(n.ref_label ?? n.ref_id ?? "").toString().slice(0, 16)}</span>
                <span>{(n.impact * 100).toFixed(0)}%</span>
                <span>{n.depth}</span>
                <span>{n.estimated_delay_days?.toFixed(1) ?? 0}d</span>
                <span className="rtReplayPathTrail">{(n.edge_path ?? []).join(" → ")}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {Object.keys(event.payload ?? {}).length > 0 && (
        <details className="rtReplayDetailPayload">
          <summary>原始 payload</summary>
          <pre>{JSON.stringify(event.payload, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
