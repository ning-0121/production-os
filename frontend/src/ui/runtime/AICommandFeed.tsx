/**
 * AI Command Feed — actionable runtime stream.
 *
 * Each card surfaces: severity, source, affected entities, reason, expected
 * impact, confidence, recommended actions. Buttons hit the runtime APIs.
 */

import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchRuntimeCommands, executeCommandAction, simulateRuntimeEvents } from "../../services/api";
import { useToast } from "../Toast";
import { useAppStore } from "../../stores/appStore";
import type { RuntimeCommand, RuntimeCommandAction, RuntimeSeverity } from "../../types";

const SEVERITY_LABEL: Record<RuntimeSeverity, string> = {
  critical: "紧急",
  high: "重要",
  medium: "建议",
  low: "提示",
  info: "信息",
};

export function AICommandFeed({ refreshKey = 0 }: { refreshKey?: number }) {
  const { data, loading, error } = useAsync(() => fetchRuntimeCommands(20), [refreshKey]);
  const setRuntimeSelectedEventId = useAppStore((s) => s.setRuntimeSelectedEventId);
  const setRuntimeSubTab = useAppStore((s) => s.setRuntimeSubTab);

  const commands: RuntimeCommand[] = Array.isArray(data?.commands) ? data!.commands : [];

  if (loading && commands.length === 0) {
    return <div className="card rtCommandFeed"><div className="loadingCenter" style={{ padding: 32 }}>分析中...</div></div>;
  }
  if (error && commands.length === 0) {
    return <div className="card rtCommandFeed"><div style={{ padding: 16, color: "var(--danger)" }}>加载失败：{error}</div></div>;
  }

  return (
    <div className="card rtCommandFeed">
      <div className="cardHeader">
        <div>
          <h3 style={{ margin: 0 }}>AI 指挥流</h3>
          <div className="hint">实时事件 + agent 建议合流</div>
        </div>
        <span className="todayAiBadge">{commands.length}</span>
      </div>
      {commands.length === 0 ? (
        <div className="emptyState" style={{ padding: 24 }}>当前无紧急指令 — 系统平稳</div>
      ) : (
        <div className="rtCommandList">
          {commands.map((cmd) => (
            <CommandCard
              key={cmd.id}
              cmd={cmd}
              onSelectEvent={(eid) => {
                setRuntimeSelectedEventId(eid);
                setRuntimeSubTab("replay");
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CommandCard({ cmd, onSelectEvent }: { cmd: RuntimeCommand; onSelectEvent?: (id: string) => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [dismissed, setDismissed] = React.useState(false);
  const [simResult, setSimResult] = React.useState<string | null>(null);

  if (dismissed) return null;

  const sevClass = `rtCommandCard--${cmd.severity}`;
  const affectedSummary = summarizeAffected(cmd);

  async function runAction(act: RuntimeCommandAction) {
    setBusy(act.type);
    setSimResult(null);
    try {
      if (act.type === "dismiss") {
        setDismissed(true);
        toast("已忽略", "success");
        return;
      }
      if (act.type === "simulate") {
        const events = (act.payload?.events ?? []) as Array<{ event_type: string; line_id?: string | null; payload?: Record<string, unknown> }>;
        const r = await simulateRuntimeEvents(events);
        const lines = r.summary?.lines_affected?.length ?? 0;
        const applied = r.summary?.events_applied ?? 0;
        setSimResult(`模拟：${applied} 个事件应用，影响 ${lines} 条产线`);
        toast(`模拟完成：影响 ${lines} 条产线`, "success");
        return;
      }
      await executeCommandAction(act);
      toast(`已${act.label}`, "success");
      if (act.type === "incident" || act.type === "execute") setDismissed(true);
    } catch (err) {
      toast(`${act.label}失败：${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={`rtCommandCard ${sevClass}`}>
      <div className="rtCommandCardTop">
        <span className={`todayAiUrgency todayAiUrgency--${cmd.severity}`}>{SEVERITY_LABEL[cmd.severity] ?? cmd.severity}</span>
        <span className="rtCommandKindBadge">{cmd.kind === "event" ? "运行时事件" : "Agent 建议"}</span>
        <span className="rtCommandTitle">{cmd.title}</span>
        {cmd.confidence != null && <span className="rtCommandConfidence">{Math.round(cmd.confidence * 100)}%</span>}
      </div>

      <div className="rtCommandSummary">{cmd.summary}</div>

      {affectedSummary && (
        <div className="rtCommandAffected">
          <strong>影响：</strong>{affectedSummary}
        </div>
      )}

      <div className="rtCommandMeta">
        <span>来源：{cmd.source}</span>
        <span>状态：{cmd.propagation_status}</span>
        <span>{new Date(cmd.occurred_at).toLocaleString()}</span>
        {cmd.source_event_id && (
          <button className="rtLinkBtn" onClick={() => onSelectEvent?.(cmd.source_event_id!)}>查看回放 →</button>
        )}
      </div>

      {simResult && <div className="rtCommandSimResult">{simResult}</div>}

      <div className="rtCommandActions">
        {cmd.actions.map((act) => (
          <button
            key={act.type}
            className={`btn ${act.type === "dismiss" ? "" : "primary"} rtCommandBtn`}
            disabled={busy !== null}
            onClick={() => runAction(act)}
          >
            {busy === act.type ? "…" : act.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function summarizeAffected(cmd: RuntimeCommand): string | null {
  const arr = Array.isArray(cmd.affected) ? cmd.affected : [];
  if (arr.length === 0) {
    const targets: string[] = [];
    if (cmd.order_id) targets.push(`订单 ${cmd.order_id}`);
    if (cmd.line_id) targets.push(`产线 ${cmd.line_id.slice(0, 8)}`);
    if (cmd.factory_id) targets.push(`工厂 ${cmd.factory_id.slice(0, 8)}`);
    return targets.length > 0 ? targets.join(" / ") : null;
  }
  const groups: Record<string, number> = {};
  for (const a of arr) {
    const t = String((a as { node_type?: string }).node_type ?? "node");
    groups[t] = (groups[t] ?? 0) + 1;
  }
  return Object.entries(groups).map(([k, v]) => `${k} × ${v}`).join("，");
}
