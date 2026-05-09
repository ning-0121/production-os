/**
 * RuntimeDetailDrawer — right-hand context panel.
 *
 * Shows whichever runtime entity the user has selected (allocation block in
 * timeline, node in constraint graph, or event in replay). Pure presentation
 * — pulls live data via small API calls when needed.
 */

import React from "react";
import { useAppStore } from "../../stores/appStore";
import { fetchRuntimeEvents } from "../../services/api";
import type { RuntimeEvent } from "../../types";

export function RuntimeDetailDrawer() {
  const allocId = useAppStore((s) => s.runtimeSelectedAllocationId);
  const nodeId = useAppStore((s) => s.runtimeSelectedNodeId);
  const eventId = useAppStore((s) => s.runtimeSelectedEventId);
  const setAlloc = useAppStore((s) => s.setRuntimeSelectedAllocationId);
  const setNode = useAppStore((s) => s.setRuntimeSelectedNodeId);
  const setEvent = useAppStore((s) => s.setRuntimeSelectedEventId);

  const [events, setEvents] = React.useState<RuntimeEvent[]>([]);
  const [loading, setLoading] = React.useState(false);

  const target = allocId || nodeId || eventId;

  React.useEffect(() => {
    if (!allocId) { setEvents([]); return; }
    setLoading(true);
    fetchRuntimeEvents({ allocation_id: allocId, limit: 20 })
      .then((r) => setEvents(Array.isArray(r.events) ? r.events : []))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, [allocId]);

  if (!target) {
    return (
      <div className="rtDrawer">
        <div className="cardHeader">
          <h3 style={{ margin: 0 }}>详情</h3>
        </div>
        <div className="emptyState" style={{ padding: 24 }}>
          点击时间线上的订单块、约束图节点，或事件查看详情
        </div>
      </div>
    );
  }

  return (
    <div className="rtDrawer">
      <div className="cardHeader">
        <h3 style={{ margin: 0 }}>详情</h3>
        <button className="btn" onClick={() => { setAlloc(null); setNode(null); setEvent(null); }}>关闭 ×</button>
      </div>

      {allocId && (
        <div className="rtDrawerSection">
          <div className="rtDrawerLabel">订单 / 排产块</div>
          <div className="rtDrawerValue">{allocId}</div>
          <div className="rtDrawerSubLabel">最近事件（{events.length}）</div>
          {loading && <div className="loadingCenter" style={{ padding: 12 }}>加载中...</div>}
          {!loading && events.length === 0 && <div className="emptyState" style={{ padding: 12 }}>无相关运行时事件</div>}
          <div className="rtDrawerEventList">
            {events.map((e) => (
              <div key={e.id} className={`rtDrawerEventItem rtDrawerEventItem--${e.severity}`}>
                <div className="rtDrawerEventTop">
                  <strong>{e.event_type}</strong>
                  <span className="hint">{new Date(e.occurred_at).toLocaleString()}</span>
                </div>
                {e.reasoning && <div className="rtDrawerEventReason">{e.reasoning}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {nodeId && !allocId && (
        <div className="rtDrawerSection">
          <div className="rtDrawerLabel">约束图节点</div>
          <div className="rtDrawerValue">{nodeId}</div>
          <div className="hint" style={{ marginTop: 8 }}>切到「约束图」可查看完整传播路径</div>
        </div>
      )}

      {eventId && !allocId && !nodeId && (
        <div className="rtDrawerSection">
          <div className="rtDrawerLabel">事件</div>
          <div className="rtDrawerValue">{eventId}</div>
          <div className="hint" style={{ marginTop: 8 }}>切到「回放」可查看完整影响</div>
        </div>
      )}
    </div>
  );
}
