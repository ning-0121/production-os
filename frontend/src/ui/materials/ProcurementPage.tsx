import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchPurchaseOrders, fetchSuppliers } from "../../services/api";
import { PageSkeleton } from "../Skeleton";
import "./materials.css";

const STATUS_LABELS: Record<string, string> = { draft: "草稿", sent: "已发", confirmed: "已确认", partial: "部分到货", received: "已到货", cancelled: "已取消" };
const STATUS_CLS: Record<string, string> = { draft: "statusPlanned", sent: "statusConfirmed", confirmed: "statusProgress", received: "statusCompleted", cancelled: "statusCancelled" };

export function ProcurementPage() {
  const { data: pos, loading: loadingPO } = useAsync(() => fetchPurchaseOrders(), []);
  const { data: suppliers } = useAsync(() => fetchSuppliers(), []);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  if (loadingPO) return <PageSkeleton />;

  const poList = (pos ?? []) as Array<Record<string, unknown>>;
  const today = new Date().toISOString().slice(0, 10);
  const overdueCount = poList.filter((p) => p.expected_date && String(p.expected_date) < today && p.status !== "received" && p.status !== "cancelled").length;
  const inTransit = poList.filter((p) => p.status === "sent" || p.status === "confirmed").length;
  const totalPO = poList.length;

  return (
    <div className="matPage">
      <div className="todayKpiRow">
        <KpiCard label="采购单总数" value={totalPO} accent />
        <KpiCard label="在途" value={inTransit} />
        <KpiCard label="已延迟" value={overdueCount} color={overdueCount > 0 ? "#fb7185" : "#22c55e"} />
        <KpiCard label="供应商" value={(suppliers ?? []).length} />
      </div>

      {overdueCount > 0 && (
        <div className="riskBanner riskBannerHigh" style={{ marginBottom: 12 }}>
          <div className="riskBannerLeft">
            <span className="riskBannerIcon">!</span>
            <span className="riskBannerText">{overdueCount} 个采购单已逾期未到货</span>
          </div>
        </div>
      )}

      <div className="card">
        <div className="cardHeader"><h2>采购单列表</h2><span className="hint">{totalPO} 单</span></div>
        <div className="orderTable">
          <table>
            <thead><tr><th>PO 号</th><th>供应商</th><th>总金额</th><th>预计到货</th><th>状态</th><th>延迟</th></tr></thead>
            <tbody>
              {poList.length === 0 && <tr><td colSpan={6} className="emptyState">暂无采购单</td></tr>}
              {poList.map((po) => {
                const isOverdue = po.expected_date && String(po.expected_date) < today && po.status !== "received" && po.status !== "cancelled";
                const isExp = expanded === (po.id as string);
                const lines = (po.purchase_order_lines ?? []) as Array<Record<string, unknown>>;
                const supplier = po.suppliers as Record<string, unknown> | null;
                return (
                  <React.Fragment key={po.id as string}>
                    <tr className={isOverdue ? "orderRow--overdue" : ""} onClick={() => setExpanded(isExp ? null : po.id as string)} style={{ cursor: "pointer" }}>
                      <td className="orderCellId">{String(po.po_number)}</td>
                      <td>{supplier?.name ? String(supplier.name) : "—"}</td>
                      <td>{po.total_amount ? `¥${Number(po.total_amount).toLocaleString()}` : "—"}</td>
                      <td>{String(po.expected_date ?? "—")}</td>
                      <td><span className={`orderStatus ${STATUS_CLS[po.status as string] ?? ""}`}>{STATUS_LABELS[po.status as string] ?? po.status}</span></td>
                      <td>{po.delay_days ? <span style={{ color: "var(--danger)", fontWeight: 600 }}>{String(po.delay_days)}天</span> : "—"}</td>
                    </tr>
                    {isExp && lines.length > 0 && (
                      <tr><td colSpan={6} style={{ padding: 0 }}>
                        <div className="poLines">
                          {lines.map((l, i) => {
                            const mat = l.materials as Record<string, unknown> | null;
                            return (
                              <div key={i} className="poLine">
                                <span>{mat?.code ? String(mat.code) : "—"} {mat?.name ? String(mat.name) : ""}</span>
                                <span>订{String(l.qty_ordered ?? 0)} | 收{String(l.qty_received ?? 0)} | 拒{String(l.qty_rejected ?? 0)}</span>
                                <span>¥{String(l.unit_price ?? "—")}/单位</span>
                              </div>
                            );
                          })}
                        </div>
                      </td></tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function KpiCard({ label, value, color, accent }: { label: string; value: string | number; color?: string; accent?: boolean }) {
  return (
    <div className="todayKpiCard">
      <div className="todayKpiLabel">{label}</div>
      <div className="todayKpiValue" style={{ color: color ?? (accent ? "var(--accent)" : undefined) }}>{value}</div>
    </div>
  );
}
