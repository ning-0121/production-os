import React from "react";
import type { AutoScheduleSummary } from "../../services/api";

type Props = {
  summary: AutoScheduleSummary;
  frontDays: number;
  onFrontDaysChange: (days: number) => void;
  recalculating: boolean;
  onSaveDraft: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  saving: boolean;
  confirming: boolean;
};

const RISK_LABELS: Record<string, { label: string; cls: string }> = {
  SAFE: { label: "安全", cls: "riskSafe" },
  MEDIUM: { label: "有风险", cls: "riskMedium" },
  HIGH: { label: "高风险", cls: "riskHigh" },
};

export function ScheduleConfirmDialog({
  summary, frontDays, onFrontDaysChange, recalculating,
  onSaveDraft, onConfirm, onCancel, saving, confirming,
}: Props) {
  const risk = RISK_LABELS[summary.risk.level] ?? RISK_LABELS.SAFE;
  const busy = saving || confirming || recalculating;

  return (
    <div className="confirmOverlay" onClick={onCancel}>
      <div className="confirmDialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirmHeader">
          <h3>排产预览</h3>
          <button className="orderDrawerClose" onClick={onCancel}>x</button>
        </div>

        <div className="confirmBody">
          <div className="confirmRow">
            <span className="confirmLabel">订单</span>
            <span className="confirmValue">{summary.order_id ?? "—"}</span>
          </div>
          <div className="confirmRow">
            <span className="confirmLabel">产品</span>
            <span className="confirmValue">{summary.product_type ?? "—"}</span>
          </div>
          <div className="confirmRow">
            <span className="confirmLabel">数量</span>
            <span className="confirmValue">{summary.qty}件</span>
          </div>
          <div className="confirmRow">
            <span className="confirmLabel">产线</span>
            <span className="confirmValue">{summary.line_name}</span>
          </div>

          <div className="confirmDivider" />

          {/* Adjustable front days */}
          <div className="confirmRow">
            <span className="confirmLabel">前道天数</span>
            <span className="confirmValue">
              <input
                type="number"
                className="confirmInput"
                min={1}
                max={60}
                value={frontDays}
                onChange={(e) => onFrontDaysChange(Math.max(1, Number(e.target.value)))}
              />
              <span className="confirmDays">天</span>
            </span>
          </div>

          <div className="confirmRow">
            <span className="confirmLabel">前道</span>
            <span className="confirmValue">
              {recalculating ? "计算中..." : `${summary.front.start} ~ ${summary.front.end}`}
              <span className="confirmDays">{summary.front.days}天</span>
            </span>
          </div>
          <div className="confirmRow">
            <span className="confirmLabel">后道</span>
            <span className="confirmValue">
              {recalculating ? "计算中..." : `${summary.back.start} ~ ${summary.back.end}`}
              <span className="confirmDays">{summary.back.days}天</span>
            </span>
          </div>

          <div className="confirmDivider" />

          <div className="confirmRow">
            <span className="confirmLabel">交期</span>
            <span className="confirmValue">{summary.risk.due_date ?? "—"}</span>
          </div>
          <div className="confirmRow">
            <span className="confirmLabel">风险</span>
            <span className={`confirmRisk ${risk.cls}`}>
              {risk.label}
              {summary.risk.buffer_days !== 0 && (
                <span className="confirmBuffer">
                  {summary.risk.buffer_days > 0
                    ? `提前${summary.risk.buffer_days}天`
                    : `延期${Math.abs(summary.risk.buffer_days)}天`}
                </span>
              )}
            </span>
          </div>
        </div>

        <div className="confirmActions">
          <button className="btn" onClick={onCancel} disabled={busy}>取消</button>
          <button className="btn" onClick={onSaveDraft} disabled={busy}>
            {saving ? "保存中..." : "保存草稿"}
          </button>
          <button className="btn primary" onClick={onConfirm} disabled={busy}>
            {confirming ? "确认中..." : "确认排产"}
          </button>
        </div>
      </div>
    </div>
  );
}
