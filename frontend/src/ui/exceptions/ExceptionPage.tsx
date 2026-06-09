import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchExceptionsV2 } from "../../services/api";
import { RiskPill, legacyAssessment } from "../shared/RiskPill";
import { DecisionButton } from "../shared/DecisionDrawer";
import type { ExceptionV2Response, AIAction } from "../../types";
import "./exceptions.css";

/** Map a resource/material exception to a decision subject (material > line > factory). */
function resourceSubject(item: { line_id?: string; factory_id?: string; data?: Record<string, unknown> }): { type: string; id: string } | null {
  const materialId = item.data?.material_id;
  if (typeof materialId === "string" && materialId) return { type: "material", id: materialId };
  if (item.line_id) return { type: "line", id: item.line_id };
  if (item.factory_id) return { type: "factory", id: item.factory_id };
  return null;
}

export function ExceptionPage() {
  const { data, loading, error, refetch } = useAsync(() => fetchExceptionsV2(), []);

  if (loading && !data) return <div className="loadingCenter">加载异常数据...</div>;
  if (error) {
    return (
      <div className="emptyState">
        加载失败：{error}
        <br />
        <button className="btn" onClick={refetch} style={{ marginTop: 8 }}>重试</button>
      </div>
    );
  }
  if (!data) return null;

  const { order_exceptions, factory_exceptions, resource_exceptions, incident_exceptions, ai_actions } = data;
  const totalCount = order_exceptions.length + factory_exceptions.length + resource_exceptions.length + incident_exceptions.length;

  return (
    <div className="excPage">
      <div className="excPageHeader">
        <h2>异常中心</h2>
        {totalCount > 0 && <span className="excTotalBadge">{totalCount} 项异常</span>}
        <button className="btn" onClick={refetch} style={{ marginLeft: "auto" }}>刷新</button>
      </div>

      {/* AI Actions — action first */}
      {ai_actions.length > 0 && (
        <div className="excSection open">
          <div className="excSectionHeader">
            <span className="excSectionIcon excSectionIcon--ai">AI</span>
            <span className="excSectionTitle">AI 行动建议</span>
            <span className="excSectionCount excSectionCount--ai">{ai_actions.length}</span>
          </div>
          <div className="excItems">
            {ai_actions.slice(0, 6).map((action) => (
              <AIActionRow key={action.id} action={action} />
            ))}
          </div>
        </div>
      )}

      {/* Order Exceptions */}
      <ExceptionSection
        title="订单异常"
        icon="!"
        severity="high"
        items={order_exceptions}
        renderItem={(item) => (
          <div className="excItem" key={item.allocation_id ?? item.order_id}>
            <span className={`excIcon excIcon--${item.severity}`}>!</span>
            <div className="excItemBody">
              <span className="excItemMsg">{item.message}</span>
              <span className="excItemMeta">
                {item.factory_name && <span>{item.factory_name}</span>}
                {item.data?.qty != null && <span> | {String(item.data.qty)}件</span>}
              </span>
            </div>
            <RiskPill assessment={legacyAssessment(item.severity, "order", item.allocation_id ?? item.order_id ?? "_")} compact />
            {(item.allocation_id || item.order_id) && (
              <DecisionButton
                subject={item.allocation_id ? { type: "allocation", id: item.allocation_id } : { type: "order", id: item.order_id! }}
                title={item.message}
                label="决策"
                className="excDecisionBtn"
              />
            )}
          </div>
        )}
      />

      {/* Factory Exceptions */}
      <ExceptionSection
        title="工厂异常"
        icon="F"
        severity="medium"
        items={factory_exceptions}
        renderItem={(item) => (
          <div className="excItem" key={item.factory_id}>
            <span className={`excIcon excIcon--${item.severity}`}>F</span>
            <div className="excItemBody">
              <span className="excItemMsg">{item.message}</span>
            </div>
            <RiskPill assessment={legacyAssessment(item.severity, "factory", item.factory_id ?? "_")} compact />
            {item.factory_id && (
              <DecisionButton subject={{ type: "factory", id: item.factory_id }} title={item.message} label="决策" className="excDecisionBtn" />
            )}
          </div>
        )}
      />

      {/* Resource Exceptions */}
      <ExceptionSection
        title="资源异常"
        icon="#"
        severity="medium"
        items={resource_exceptions}
        renderItem={(item) => (
          <div className="excItem" key={item.line_id ?? item.factory_id}>
            <span className={`excIcon excIcon--${item.severity}`}>#</span>
            <div className="excItemBody">
              <span className="excItemMsg">{item.message}</span>
            </div>
            <RiskPill assessment={legacyAssessment(item.severity, "line", item.line_id ?? item.factory_id ?? "_")} compact />
            {resourceSubject(item) && (
              <DecisionButton subject={resourceSubject(item)!} title={item.message} label="决策" className="excDecisionBtn" />
            )}
          </div>
        )}
      />

      {/* Incident Exceptions */}
      <ExceptionSection
        title="生产事件"
        icon="X"
        severity="high"
        items={incident_exceptions}
        renderItem={(item) => (
          <div className="excItem" key={`${item.factory_id}-${item.order_id}`}>
            <span className={`excIcon excIcon--${item.severity}`}>X</span>
            <div className="excItemBody">
              <span className="excItemMsg">{item.message}</span>
            </div>
            <RiskPill assessment={legacyAssessment(item.severity ?? "high", "order", item.order_id ?? item.factory_id ?? "_")} compact />
            {(item.order_id || item.factory_id) && (
              <DecisionButton
                subject={item.order_id ? { type: "order", id: item.order_id } : { type: "factory", id: item.factory_id! }}
                title={item.message} label="决策" className="excDecisionBtn"
              />
            )}
          </div>
        )}
      />

      {totalCount === 0 && ai_actions.length === 0 && (
        <div className="emptyState">当前无异常，运行正常</div>
      )}
    </div>
  );
}

// ── Collapsible Section ─────────────────────────────────

function ExceptionSection<T>({
  title,
  icon,
  severity,
  items,
  renderItem,
}: {
  title: string;
  icon: string;
  severity: string;
  items: T[];
  renderItem: (item: T) => React.ReactNode;
}) {
  const [open, setOpen] = React.useState(items.length > 0);

  React.useEffect(() => {
    if (items.length > 0) setOpen(true);
  }, [items.length]);

  if (items.length === 0) return null;

  return (
    <div className={`excSection${open ? " open" : ""}`}>
      <div className="excSectionHeader" onClick={() => setOpen(!open)}>
        <span className={`excSectionIcon excSectionIcon--${severity}`}>{icon}</span>
        <span className="excSectionTitle">{title}</span>
        <span className={`excSectionCount excSectionCount--${severity}`}>{items.length}</span>
        <span className="excSectionToggle">{open ? "▼" : "▶"}</span>
      </div>
      {open && <div className="excItems">{items.map(renderItem)}</div>}
    </div>
  );
}

// ── AI Action Row ─────────────────────────────────────────

function AIActionRow({ action }: { action: AIAction }) {
  return (
    <div className={`excItem excItem--ai excItem--ai-${action.urgency}`}>
      <span className="excAiBadge">AI</span>
      <div className="excItemBody">
        <span className="excItemMsg">{action.summary}</span>
        {action.impact && <span className="excItemMeta">{action.impact}</span>}
      </div>
      <div className="excAiRight">
        <RiskPill assessment={legacyAssessment(action.urgency, "order", action.target_id ?? "_")} compact />
        <span className="excAiConfidence">{Math.round(action.confidence * 100)}%</span>
      </div>
    </div>
  );
}
