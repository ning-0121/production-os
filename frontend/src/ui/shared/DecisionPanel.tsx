/**
 * DecisionPanel — shared decision cockpit.
 *
 * Given a subject (order/allocation/line/factory), evaluates the Decision
 * Engine and renders: current state, if-no-action, scored option cards (with
 * the recommended one highlighted), and explicit action buttons. Generating is
 * read-only; applying is an explicit click that creates tasks/actions and
 * records the decision.
 *
 * Drop-in usable from TodayPage, Task Center, War Room, Exception Center,
 * Order detail. Handles loading / empty / error itself.
 */

import React from "react";
import { evaluateDecision, applyDecisionOption } from "../../services/api";
import { useToast } from "../Toast";
import { COLOR_HEX } from "./riskColors";
import type { DecisionAssessment, DecisionOption } from "../../types";

const CUSTOMER_IMPACT_LABEL = { low: "低", medium: "中", high: "高" };

export function DecisionPanel({
  subject,
  decisionType,
  onApplied,
}: {
  subject: { type: string; id: string };
  decisionType?: string;
  onApplied?: () => void;
}) {
  const { toast } = useToast();
  const [data, setData] = React.useState<DecisionAssessment | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    setLoading(true); setError(null);
    evaluateDecision(subject, decisionType)
      .then((d) => setData(d))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [subject.type, subject.id, decisionType]);

  React.useEffect(() => { load(); }, [load]);

  async function apply(option: DecisionOption, mode: "apply" | "task_only" | "request_approval" | "dismiss") {
    if (!data?.id) { toast("决策未持久化，无法执行", "error"); return; }
    let overrideReason: string | undefined;
    if (mode === "apply" && data.recommended_option_id && data.recommended_option_id !== option.id) {
      overrideReason = prompt("你选择了非推荐选项，请说明原因（可选）：") ?? undefined;
    }
    if (mode === "dismiss" && !confirm("确认忽略该决策？")) return;
    setBusy(`${option.id}:${mode}`);
    try {
      const r = await applyDecisionOption(data.id, option.id, mode, overrideReason);
      const label = mode === "task_only" ? "已仅建任务" : mode === "request_approval" ? "已请求审批" : mode === "dismiss" ? "已忽略" : "已执行";
      toast(`${label}（${r.actions_taken.length} 个动作）`, r.status === "failed" ? "error" : "success");
      setDone(option.id);
      onApplied?.();
    } catch (e) {
      toast(e instanceof Error ? e.message : "执行失败", "error");
    } finally { setBusy(null); }
  }

  if (loading) return <div className="decisionPanel"><div className="loadingCenter" style={{ padding: 24 }}>正在生成决策方案…</div></div>;
  if (error) return <div className="decisionPanel"><div style={{ padding: 16, color: "var(--danger)" }}>决策生成失败：{error} <button className="btn" onClick={load} style={{ marginLeft: 8 }}>重试</button></div></div>;
  if (!data || data.options.length === 0) return <div className="decisionPanel"><div className="emptyState" style={{ padding: 24 }}>当前无需决策</div></div>;

  const cs = data.current_state;
  const noAct = data.if_no_action;

  return (
    <div className="decisionPanel">
      {/* Current state */}
      <div className="decisionState">
        <div className="decisionStateSummary">{cs.summary}</div>
        <div className="decisionStateFacts">
          <Fact label="风险分" value={Math.round(cs.risk_score)} />
          <Fact label="预计延期" value={`${cs.expected_delay_days} 天`} tone={cs.expected_delay_days > 0 ? "danger" : "ok"} />
          <Fact label="毛利影响" value={`¥${Math.round(cs.estimated_margin_impact).toLocaleString()}`} />
          <Fact label="影响订单" value={cs.affected_orders.length} />
        </div>
      </div>

      {/* If no action */}
      <div className="decisionNoAction">
        <strong>⚠ 若不处理：</strong>
        延期 {noAct.expected_delay_days} 天 · 毛利损失约 ¥{Math.round(noAct.margin_loss).toLocaleString()} ·
        客户风险 <b>{CUSTOMER_IMPACT_LABEL[noAct.customer_risk]}</b> · 升级风险 <b>{CUSTOMER_IMPACT_LABEL[noAct.escalation_risk]}</b>
      </div>

      {/* Recommendation banner */}
      {data.recommendation_reason && (
        <div className="decisionRecBanner">★ {data.recommendation_reason}（置信度 {Math.round(data.confidence_score * 100)}%）</div>
      )}

      {/* Option cards */}
      <div className="decisionOptions">
        {data.options.map((o) => {
          const recommended = o.id === data.recommended_option_id;
          const applied = done === o.id;
          return (
            <div key={o.id} className={`decisionOption ${recommended ? "decisionOption--recommended" : ""} ${applied ? "decisionOption--applied" : ""}`}>
              <div className="decisionOptionTop">
                <span className="decisionOptionTitle">{o.title}</span>
                {recommended && <span className="decisionRecTag">推荐</span>}
                <span className="decisionScore" style={{ color: scoreColor(o.total_score) }}>{o.total_score}</span>
              </div>
              <div className="decisionOptionDesc">{o.description}</div>
              <div className="decisionImpactRow">
                <Impact label="工期" value={fmtDelta(o.impact.delay_days_delta, "天")} good={o.impact.delay_days_delta < 0} bad={o.impact.delay_days_delta > 0} />
                <Impact label="成本" value={o.impact.cost_delta > 0 ? `+¥${o.impact.cost_delta.toLocaleString()}` : "¥0"} bad={o.impact.cost_delta > 0} />
                <Impact label="风险" value={fmtDelta(o.impact.risk_delta, "")} good={o.impact.risk_delta < 0} />
                <Impact label="客户冲击" value={CUSTOMER_IMPACT_LABEL[o.impact.customer_impact]} bad={o.impact.customer_impact === "high"} />
                <Impact label="置信" value={`${Math.round(o.confidence_score * 100)}%`} />
              </div>
              {o.reasoning.length > 0 && (
                <ul className="decisionReasoning">{o.reasoning.map((r, i) => <li key={i}>{r}</li>)}</ul>
              )}
              {/* Learning trace — bounded, explainable organizational memory */}
              {o.learning && o.learning.delta !== 0 && (
                <div className={`decisionLearning ${o.learning.delta > 0 ? "decisionLearning--up" : "decisionLearning--down"}`}>
                  🧠 历史学习 {o.learning.delta > 0 ? `+${o.learning.delta}` : o.learning.delta}
                  <span className="decisionLearningReason"> · {o.learning.reason}</span>
                </div>
              )}
              {(o.impact.affected_orders.length > 0 || o.required_actions.length > 0) && (
                <div className="decisionOptionMeta">
                  {o.impact.affected_orders.length > 0 && <span>影响订单 {o.impact.affected_orders.length} 个</span>}
                  <span>将执行：{o.required_actions.map((a) => actionLabel(a.action_type)).join("、")}</span>
                </div>
              )}
              <div className="decisionOptionActions">
                <button className="btn primary" disabled={busy !== null || applied} onClick={() => apply(o, "apply")}>
                  {busy === `${o.id}:apply` ? "执行中…" : "执行"}
                </button>
                <button className="btn" disabled={busy !== null || applied} onClick={() => apply(o, "task_only")}>仅建任务</button>
                {o.required_actions.some((a) => a.action_type === "request_approval") && (
                  <button className="btn" disabled={busy !== null || applied} onClick={() => apply(o, "request_approval")}>请求审批</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <style>{decisionCss}</style>
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "ok" | "danger" }) {
  return (
    <div className="decisionFact">
      <span className="decisionFactLabel">{label}</span>
      <span className="decisionFactValue" style={{ color: tone === "danger" ? COLOR_HEX.red.fg : tone === "ok" ? COLOR_HEX.green.fg : undefined }}>{value}</span>
    </div>
  );
}
function Impact({ label, value, good, bad }: { label: string; value: string; good?: boolean; bad?: boolean }) {
  const color = good ? COLOR_HEX.green.fg : bad ? COLOR_HEX.red.fg : "var(--text)";
  return <span className="decisionImpact"><span className="decisionImpactLabel">{label}</span><span style={{ color, fontWeight: 600 }}>{value}</span></span>;
}

function fmtDelta(v: number, unit: string): string {
  if (v === 0) return `0${unit}`;
  return `${v > 0 ? "+" : ""}${v}${unit}`;
}
function scoreColor(s: number): string {
  return s >= 75 ? COLOR_HEX.green.fg : s >= 50 ? COLOR_HEX.amber.fg : COLOR_HEX.red.fg;
}
function actionLabel(t: string): string {
  const m: Record<string, string> = {
    create_task: "建任务", reschedule: "重排", create_incident: "建事件", notify_owner: "通知",
    update_watchlist: "加观察", request_approval: "请审批", mark_customer_delay: "标记客户延期",
    create_purchase_followup: "采购跟进", create_qc_followup: "质检跟进",
  };
  return m[t] ?? t;
}

const decisionCss = `
.decisionPanel { display: flex; flex-direction: column; gap: 10px; }
.decisionState { background: rgba(255,255,255,.03); border-radius: 8px; padding: 12px; }
.decisionStateSummary { font-size: 14px; margin-bottom: 8px; }
.decisionStateFacts { display: flex; gap: 18px; flex-wrap: wrap; }
.decisionFact { display: flex; flex-direction: column; }
.decisionFactLabel { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .4px; }
.decisionFactValue { font-size: 16px; font-weight: 700; }
.decisionNoAction { background: rgba(251,113,133,.06); border-left: 3px solid #fb7185; border-radius: 6px; padding: 10px 12px; font-size: 13px; }
.decisionRecBanner { background: rgba(34,197,94,.08); border-left: 3px solid #22c55e; border-radius: 6px; padding: 8px 12px; font-size: 13px; color: #22c55e; }
.decisionOptions { display: flex; flex-direction: column; gap: 8px; }
.decisionOption { background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); border-radius: 8px; padding: 12px; }
.decisionOption--recommended { border-color: rgba(34,197,94,.45); background: rgba(34,197,94,.04); }
.decisionOption--applied { opacity: .5; }
.decisionOptionTop { display: flex; align-items: center; gap: 8px; }
.decisionOptionTitle { font-size: 14px; font-weight: 600; }
.decisionRecTag { font-size: 10px; padding: 2px 7px; border-radius: 3px; background: rgba(34,197,94,.18); color: #22c55e; font-weight: 600; }
.decisionScore { margin-left: auto; font-size: 18px; font-weight: 700; }
.decisionOptionDesc { font-size: 12px; color: var(--muted); margin: 4px 0 8px; }
.decisionImpactRow { display: flex; gap: 16px; flex-wrap: wrap; padding: 6px 0; border-top: 1px solid rgba(255,255,255,.05); }
.decisionImpact { display: flex; flex-direction: column; }
.decisionImpactLabel { font-size: 10px; color: var(--muted); }
.decisionReasoning { margin: 8px 0 0; padding-left: 18px; font-size: 11px; color: var(--muted); }
.decisionReasoning li { margin: 2px 0; }
.decisionLearning { margin-top: 8px; font-size: 11px; padding: 4px 8px; border-radius: 4px; }
.decisionLearning--up { background: rgba(34,197,94,.08); color: #22c55e; }
.decisionLearning--down { background: rgba(250,204,21,.08); color: #facc15; }
.decisionLearningReason { color: var(--muted); }
.decisionOptionMeta { display: flex; gap: 12px; font-size: 11px; color: var(--muted); margin-top: 8px; flex-wrap: wrap; }
.decisionOptionActions { display: flex; gap: 6px; margin-top: 10px; }
`;
