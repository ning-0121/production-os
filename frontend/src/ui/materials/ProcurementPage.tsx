import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchPurchaseOrders, fetchSuppliers } from "../../services/api";
import { PageSkeleton } from "../Skeleton";
import { DataGrid, type DataGridColumn } from "../shared/DataGrid";
import "./materials.css";
import "../shared/DataGrid.css";

type PORow = Record<string, unknown>;

const STATUS_LABELS: Record<string, string> = { draft: "草稿", sent: "已发", confirmed: "已确认", partial: "部分到货", received: "已到货", cancelled: "已取消" };
const STATUS_CLS: Record<string, string> = { draft: "statusPlanned", sent: "statusConfirmed", confirmed: "statusProgress", received: "statusCompleted", cancelled: "statusCancelled" };

export function ProcurementPage() {
  const { data: pos, loading: loadingPO } = useAsync(() => fetchPurchaseOrders(), []);
  const { data: suppliers } = useAsync(() => fetchSuppliers(), []);

  const poList = (pos ?? []) as PORow[];
  const today = new Date().toISOString().slice(0, 10);
  const isOverdue = (p: PORow) => !!p.expected_date && String(p.expected_date) < today && p.status !== "received" && p.status !== "cancelled";

  const columns = React.useMemo<DataGridColumn<PORow>[]>(() => [
    {
      id: "po_number", header: "PO 号", sticky: true, width: 140,
      sortValue: (p) => String(p.po_number ?? ""), filterValue: (p) => String(p.po_number ?? ""),
      accessor: (p) => <span className="orderCellId">{String(p.po_number)}</span>,
    },
    {
      id: "supplier", header: "供应商", width: 160,
      sortValue: (p) => String((p.suppliers as PORow | null)?.name ?? ""),
      filterValue: (p) => String((p.suppliers as PORow | null)?.name ?? ""),
      accessor: (p) => { const s = p.suppliers as PORow | null; return s?.name ? String(s.name) : "—"; },
    },
    {
      id: "total", header: "总金额", width: 120, align: "right",
      sortValue: (p) => Number(p.total_amount ?? 0),
      filterValue: (p) => String(p.total_amount ?? ""),
      accessor: (p) => p.total_amount ? `¥${Number(p.total_amount).toLocaleString()}` : "—",
    },
    {
      id: "expected", header: "预计到货", width: 120,
      sortValue: (p) => String(p.expected_date ?? ""),
      filterValue: (p) => String(p.expected_date ?? ""),
      accessor: (p) => <span className={isOverdue(p) ? "taskOverdue" : ""}>{String(p.expected_date ?? "—")}</span>,
    },
    {
      id: "status", header: "状态", width: 100,
      sortValue: (p) => String(p.status), filterValue: (p) => STATUS_LABELS[p.status as string] ?? String(p.status),
      accessor: (p) => <span className={`orderStatus ${STATUS_CLS[p.status as string] ?? ""}`}>{STATUS_LABELS[p.status as string] ?? String(p.status)}</span>,
    },
    {
      id: "delay", header: "延迟", width: 80, align: "right",
      sortValue: (p) => Number(p.delay_days ?? 0),
      filterValue: (p) => (p.delay_days ? `${p.delay_days}天` : ""),
      accessor: (p) => p.delay_days ? <span style={{ color: "var(--danger)", fontWeight: 600 }}>{String(p.delay_days)}天</span> : "—",
    },
  ], [today]);

  if (loadingPO) return <PageSkeleton />;

  const overdueCount = poList.filter(isOverdue).length;
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
        <DataGrid<PORow>
          rows={poList}
          columns={columns}
          rowKey={(p) => p.id as string}
          searchPlaceholder="搜索 PO 号、供应商…"
          csvFilename="采购单"
          pageSize={25}
          emptyTitle="暂无采购单"
          renderExpandedRow={(po) => {
            const lines = (po.purchase_order_lines ?? []) as PORow[];
            if (lines.length === 0) return <span className="hint">无明细行</span>;
            return (
              <div className="poLines">
                {lines.map((l, i) => {
                  const mat = l.materials as PORow | null;
                  return (
                    <div key={i} className="poLine">
                      <span>{mat?.code ? String(mat.code) : "—"} {mat?.name ? String(mat.name) : ""}</span>
                      <span>订{String(l.qty_ordered ?? 0)} | 收{String(l.qty_received ?? 0)} | 拒{String(l.qty_rejected ?? 0)}</span>
                      <span>¥{String(l.unit_price ?? "—")}/单位</span>
                    </div>
                  );
                })}
              </div>
            );
          }}
        />
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
