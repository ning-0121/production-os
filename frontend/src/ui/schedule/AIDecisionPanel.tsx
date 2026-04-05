import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { runRiskPrediction } from "../../services/api";
import type { AIAction } from "../../types";

export function AIDecisionPanel() {
  const { data, loading, refetch } = useAsync(() => runRiskPrediction(), []);
  const [expanded, setExpanded] = React.useState(true);

  const actions = data?.actions ?? [];
  const reasoning = data?.reasoning ?? "";

  return (
    <div className="aiPanel">
      <div className="aiPanelHeader" onClick={() => setExpanded(!expanded)}>
        <div className="aiPanelTitle">
          <span className="aiPanelBadge">AI</span>
          <span>智能决策</span>
        </div>
        <div className="aiPanelHeaderRight">
          {actions.length > 0 && <span className="aiPanelCount">{actions.length}</span>}
          <button className="aiPanelRefresh" onClick={(e) => { e.stopPropagation(); refetch(); }} disabled={loading}>
            {loading ? "..." : "刷新"}
          </button>
          <span className="aiPanelToggle">{expanded ? "▼" : "▶"}</span>
        </div>
      </div>

      {expanded && (
        <div className="aiPanelBody">
          {loading && <div className="loadingCenter" style={{ padding: 20 }}>分析中...</div>}
          {!loading && actions.length === 0 && (
            <div className="emptyState" style={{ padding: 16 }}>当前无风险建议</div>
          )}
          {actions.slice(0, 8).map((action) => (
            <AIActionItem key={action.id} action={action} />
          ))}
          {reasoning && (
            <div className="aiPanelReasoning">{reasoning}</div>
          )}
        </div>
      )}
    </div>
  );
}

function AIActionItem({ action }: { action: AIAction }) {
  const urgencyLabels: Record<string, string> = {
    critical: "紧急",
    high: "重要",
    medium: "建议",
    low: "提示",
  };

  return (
    <div className={`aiActionItem aiActionItem--${action.urgency}`}>
      <div className="aiActionTop">
        <span className={`aiActionUrgency aiActionUrgency--${action.urgency}`}>
          {urgencyLabels[action.urgency] ?? action.urgency}
        </span>
        <span className="aiActionConfidence">{Math.round(action.confidence * 100)}%</span>
      </div>
      <div className="aiActionSummary">{action.summary}</div>
      {action.impact && <div className="aiActionImpact">{action.impact}</div>}
    </div>
  );
}
