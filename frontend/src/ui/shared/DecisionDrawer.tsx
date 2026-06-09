/**
 * DecisionDrawer — reusable modal wrapper around DecisionPanel.
 *
 * The single decision entry point for every surface (Today / War Room /
 * Exception Center / Order Center). It does NOT duplicate any decision logic —
 * it just lazily mounts the shared DecisionPanel when opened (so no N+1: the
 * decision is only evaluated when the user actually clicks).
 *
 * Two pieces:
 *   - <DecisionButton subject ... />  a compact trigger button
 *   - <DecisionDrawer subject open onClose />  the modal (mounts DecisionPanel)
 *
 * Most callers just use <DecisionButton/> which manages its own open state.
 */

import React from "react";
import { DecisionPanel } from "./DecisionPanel";

export type DecisionSubject = { type: string; id: string };

export function DecisionDrawer({
  subject,
  title,
  decisionType,
  open,
  onClose,
  onApplied,
}: {
  subject: DecisionSubject;
  title?: string;
  decisionType?: string;
  open: boolean;
  onClose: () => void;
  onApplied?: () => void;
}) {
  // Close on Escape
  React.useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="decisionDrawerBackdrop" onClick={onClose}>
      <div className="decisionDrawerPanel" onClick={(e) => e.stopPropagation()}>
        <div className="decisionDrawerHeader">
          <div>
            <h3 style={{ margin: 0 }}>生产决策</h3>
            <div className="hint">{title ?? `${subject.type} ${String(subject.id).slice(0, 12)}`}</div>
          </div>
          <button className="btn" onClick={onClose}>关闭 ×</button>
        </div>
        {/* Lazy: DecisionPanel only mounts (and evaluates) when drawer is open */}
        <DecisionPanel subject={subject} decisionType={decisionType} onApplied={onApplied} />
      </div>
      <style>{drawerCss}</style>
    </div>
  );
}

/**
 * DecisionButton — self-contained trigger. Manages its own open state so any
 * surface can drop it in with one line.
 */
export function DecisionButton({
  subject,
  title,
  decisionType,
  label = "查看决策",
  className = "btn",
  onApplied,
}: {
  subject: DecisionSubject;
  title?: string;
  decisionType?: string;
  label?: string;
  className?: string;
  onApplied?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  // Guard: no subject id → render nothing (decision needs a subject).
  if (!subject?.id || !subject?.type) return null;
  return (
    <>
      <button
        className={className}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title="生成生产决策方案"
      >
        {label}
      </button>
      <DecisionDrawer
        subject={subject}
        title={title}
        decisionType={decisionType}
        open={open}
        onClose={() => setOpen(false)}
        onApplied={onApplied}
      />
    </>
  );
}

const drawerCss = `
.decisionDrawerBackdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,.55);
  display: flex; justify-content: flex-end; z-index: 1100;
}
.decisionDrawerPanel {
  width: 620px; max-width: 100%; background: #0b1220;
  border-left: 1px solid rgba(255,255,255,.12); padding: 20px;
  overflow-y: auto;
}
.decisionDrawerHeader {
  display: flex; justify-content: space-between; align-items: flex-start;
  gap: 12px; margin-bottom: 16px; padding-bottom: 12px;
  border-bottom: 1px solid rgba(255,255,255,.08);
}
@media (max-width: 640px) { .decisionDrawerPanel { width: 100%; } }
`;
