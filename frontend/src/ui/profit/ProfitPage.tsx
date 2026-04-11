import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchProfitDashboard } from "../../services/api";
import type { ProfitDashboard } from "../../services/api";
import type { AIAction } from "../../types";
import { PageSkeleton } from "../Skeleton";
import "./profit.css";

type SortKey = "margin_pct" | "revenue" | "gross_profit" | "rework_cost";

export function ProfitPage() {
  const { data, loading, error } = useAsync(() => fetchProfitDashboard(), []);
  const [sort, setSort] = React.useState<SortKey>("margin_pct");
  const [filter, setFilter] = React.useState<"all" | "negative" | "low" | "healthy">("all");
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [section, setSection] = React.useState<"orders" | "customers" | "factories">("orders");

  if (loading) return <PageSkeleton />;
  if (error) return <div className="card"><div style={{ padding: 24, color: "var(--danger)" }}>加载失败: {error}</div></div>;
  if (!data) return null;

  const { kpi, orders, customers, factories, insights } = data;

  // Filter orders
  const filtered = orders.filter((o) => {
    if (filter === "negative") return o.margin_pct < 0;
    if (filter === "low") return o.margin_pct >= 0 && o.margin_pct < 10;
    if (filter === "healthy") return o.margin_pct >= 10;
    return true;
  }).sort((a, b) => {
    if (sort === "margin_pct") return a.margin_pct - b.margin_pct;
    if (sort === "revenue") return b.revenue - a.revenue;
    if (sort === "gross_profit") return a.gross_profit - b.gross_profit;
    if (sort === "rework_cost") return b.rework_cost - a.rework_cost;
    return 0;
  });

  return (
    <div className="plPage">
      {/* KPI Row */}
      <div className="plKpiRow">
        <PlKpi label="总收入" value={`¥${fmt(kpi.total_revenue)}`} accent />
        <PlKpi label="毛利润" value={`¥${fmt(kpi.gross_profit)}`} color={kpi.gross_profit >= 0 ? "#22c55e" : "#fb7185"} />
        <PlKpi label="毛利率" value={`${kpi.gross_margin_pct}%`} color={kpi.gross_margin_pct >= 15 ? "#22c55e" : kpi.gross_margin_pct >= 8 ? "#facc15" : "#fb7185"} />
        <PlKpi label="返工损失" value={`¥${fmt(kpi.rework_loss)}`} color={kpi.rework_loss > 0 ? "#fb7185" : "#22c55e"} />
        <PlKpi label="运费/关税" value={`¥${fmt(kpi.freight_loss)}`} />
        <PlKpi label="低利润单" value={kpi.low_margin_count} color={kpi.low_margin_count > 0 ? "#facc15" : "#22c55e"} />
        <PlKpi label="亏损单" value={kpi.negative_count} color={kpi.negative_count > 0 ? "#fb7185" : "#22c55e"} />
      </div>

      {/* Profit Risk Banners */}
      {kpi.negative_count > 0 && (
        <div className="riskBanner riskBannerHigh" style={{ marginBottom: 8 }}>
          <div className="riskBannerLeft">
            <span className="riskBannerIcon">!</span>
            <span className="riskBannerText">{kpi.negative_count} 个订单已亏损，需立即处理</span>
          </div>
          <button className="btn" style={{ fontSize: 11 }} onClick={() => setFilter("negative")}>查看亏损单</button>
        </div>
      )}
      {kpi.low_margin_count > 0 && (
        <div className="riskBanner riskBannerMedium" style={{ marginBottom: 8 }}>
          <div className="riskBannerLeft">
            <span className="riskBannerIcon">~</span>
            <span className="riskBannerText">{kpi.low_margin_count} 个订单利润率低于 10%</span>
          </div>
          <button className="btn" style={{ fontSize: 11 }} onClick={() => setFilter("low")}>查看低利润</button>
        </div>
      )}

      {/* AI Insights */}
      {insights.length > 0 && (
        <div className="card plSection">
          <div className="cardHeader">
            <div><h2>AI 利润洞察</h2><div className="hint">基于订单、客户、工厂数据分析</div></div>
            <span className="todayAiBadge">AI Agent</span>
          </div>
          <div className="plInsights">
            {insights.slice(0, 6).map((insight, i) => (
              <div key={i} className={`todayAiCard todayAiCard--${insight.urgency}`}>
                <div className="todayAiCardTop">
                  <span className={`todayAiUrgency todayAiUrgency--${insight.urgency}`}>
                    {insight.urgency === "critical" ? "紧急" : insight.urgency === "high" ? "重要" : "建议"}
                  </span>
                  <span className="todayAiConfidence">{Math.round(insight.confidence * 100)}%</span>
                </div>
                <div className="todayAiSummary">{insight.summary}</div>
                <div className="todayAiImpact">{insight.impact}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Section Tabs */}
      <div className="subTabs" style={{ marginBottom: 12 }}>
        <button className={`subTab ${section === "orders" ? "subTab--active" : ""}`} onClick={() => setSection("orders")}>订单损益</button>
        <button className={`subTab ${section === "customers" ? "subTab--active" : ""}`} onClick={() => setSection("customers")}>客户盈利</button>
        <button className={`subTab ${section === "factories" ? "subTab--active" : ""}`} onClick={() => setSection("factories")}>工厂 ROI</button>
      </div>

      {section === "orders" && (
        <div className="card plSection">
          <div className="cardHeader">
            <h2>订单利润表</h2>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <select className="filterSelect" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
                <option value="all">全部 ({orders.length})</option>
                <option value="negative">亏损 ({orders.filter((o) => o.margin_pct < 0).length})</option>
                <option value="low">低利润 ({orders.filter((o) => o.margin_pct >= 0 && o.margin_pct < 10).length})</option>
                <option value="healthy">健康 ({orders.filter((o) => o.margin_pct >= 10).length})</option>
              </select>
              <select className="filterSelect" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                <option value="margin_pct">按利润率</option>
                <option value="revenue">按收入</option>
                <option value="gross_profit">按利润</option>
                <option value="rework_cost">按返工成本</option>
              </select>
            </div>
          </div>

          <div className="plOrderList">
            {filtered.length === 0 && <div className="emptyState">暂无订单利润数据</div>}
            {filtered.map((o) => {
              const isExp = expanded === o.order_id;
              return (
                <div key={o.order_id} className={`plOrderRow ${isExp ? "plOrderRow--expanded" : ""} plOrderRow--${o.risk_tag}`} onClick={() => setExpanded(isExp ? null : o.order_id)}>
                  <div className="plOrderHeader">
                    <div className="plOrderLeft">
                      <span className={`plMarginBadge plMarginBadge--${o.risk_tag}`}>{o.margin_pct}%</span>
                      <span className="orderCellId">{o.order_number}</span>
                      <span className="plCustomer">{o.customer_name}</span>
                      <span className="pill">{o.product_type}</span>
                    </div>
                    <div className="plOrderRight">
                      <span className="plRevenue">¥{fmt(o.revenue)}</span>
                      <span className={`plProfit ${o.gross_profit < 0 ? "plProfit--neg" : ""}`}>¥{fmt(o.gross_profit)}</span>
                      <span className="factoryToggle">{isExp ? "▼" : "▶"}</span>
                    </div>
                  </div>

                  {isExp && (
                    <div className="plOrderDetail">
                      <div className="plCostGrid">
                        <CostItem label="面料" value={o.fabric_cost} />
                        <CostItem label="辅料" value={o.trim_cost} />
                        <CostItem label="加工费" value={o.cmt_cost} />
                        <CostItem label="返工" value={o.rework_cost} danger={o.rework_cost > 0} />
                        <CostItem label="运费" value={o.freight_cost} />
                        <CostItem label="关税" value={o.duty_cost} />
                        <CostItem label="赔偿" value={o.compensation_cost} danger={o.compensation_cost > 0} />
                      </div>
                      <div className="plOrderSummary">
                        <div className="plSummaryRow"><span>总收入</span><span>¥{fmt(o.revenue)}</span></div>
                        <div className="plSummaryRow"><span>总成本</span><span>¥{fmt(o.total_cost)}</span></div>
                        <div className="plSummaryRow plSummaryRow--total">
                          <span>毛利润</span>
                          <span className={o.gross_profit < 0 ? "plProfit--neg" : ""}>{o.gross_profit < 0 ? "-" : ""}¥{fmt(Math.abs(o.gross_profit))}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {section === "customers" && (
        <div className="card plSection">
          <div className="cardHeader"><h2>客户盈利分析</h2><span className="hint">{customers.length} 个客户</span></div>
          <div className="plOrderList">
            {customers.length === 0 && <div className="emptyState">暂无客户数据</div>}
            {customers.map((c, i) => (
              <div key={i} className={`plOrderRow plOrderRow--${c.margin_pct < 0 ? "negative" : c.margin_pct < 10 ? "critical" : c.margin_pct < 15 ? "warning" : "safe"}`}>
                <div className="plOrderHeader">
                  <div className="plOrderLeft">
                    <span className={`plMarginBadge plMarginBadge--${c.margin_pct < 0 ? "negative" : c.margin_pct < 10 ? "critical" : c.margin_pct < 15 ? "warning" : "safe"}`}>{c.margin_pct}%</span>
                    <span className="orderCellId">{c.name}</span>
                    <span className="pill">{c.orders} 单</span>
                  </div>
                  <div className="plOrderRight">
                    <span className="plRevenue">收入 ¥{fmt(c.revenue)}</span>
                    <span className={`plProfit ${c.profit < 0 ? "plProfit--neg" : ""}`}>利润 ¥{fmt(c.profit)}</span>
                    {c.rework_cost > 0 && <span className="reworkDelay">返工 ¥{fmt(c.rework_cost)}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {section === "factories" && (
        <div className="card plSection">
          <div className="cardHeader"><h2>工厂 ROI 分析</h2><span className="hint">{factories.length} 家工厂</span></div>
          <div className="plOrderList">
            {factories.length === 0 && <div className="emptyState">暂无工厂数据</div>}
            {factories.map((f) => (
              <div key={f.factory_id} className="plOrderRow">
                <div className="plOrderHeader">
                  <div className="plOrderLeft">
                    <span className="orderCellId">{f.name}</span>
                    <span className={`scoreChip ${(f.quality_score ?? 0) >= 80 ? "scoreChip--good" : (f.quality_score ?? 0) >= 60 ? "scoreChip--warn" : "scoreChip--bad"}`}>质量 {f.quality_score ?? "—"}</span>
                    <span className={`scoreChip ${(f.delay_score ?? 0) >= 80 ? "scoreChip--good" : (f.delay_score ?? 0) >= 60 ? "scoreChip--warn" : "scoreChip--bad"}`}>交期 {f.delay_score ?? "—"}</span>
                  </div>
                  <div className="plOrderRight">
                    {f.rework_cost > 0 && <span className="reworkDelay">返工成本 ¥{fmt(f.rework_cost)}</span>}
                    {f.rework_cost === 0 && <span style={{ color: "#22c55e", fontSize: 12 }}>无返工</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub Components ──────────────────────────────────────

function PlKpi({ label, value, color, accent }: { label: string; value: string | number; color?: string; accent?: boolean }) {
  return (
    <div className="plKpiCard">
      <div className="plKpiLabel">{label}</div>
      <div className="plKpiValue" style={{ color: color ?? (accent ? "var(--accent)" : undefined) }}>{value}</div>
    </div>
  );
}

function CostItem({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="plCostItem">
      <span className="plCostLabel">{label}</span>
      <span className={`plCostValue ${danger ? "plCostValue--danger" : ""}`}>¥{fmt(value)}</span>
    </div>
  );
}

function fmt(n: number): string {
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return n.toLocaleString();
}
