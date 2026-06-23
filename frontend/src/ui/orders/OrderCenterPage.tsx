import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchAllocations, deleteAllocation } from "../../services/api";
import { useRiskBatch } from "../../hooks/useRiskBatch";
import { RiskPill } from "../shared/RiskPill";
import { DecisionButton } from "../shared/DecisionDrawer";
import { DataGrid, type DataGridColumn } from "../shared/DataGrid";
import { useToast } from "../Toast";
import { CreateOrderDrawer } from "./CreateOrderDrawer";
import { ImportDrawer } from "./ImportDrawer";
import type { Allocation } from "../../types";
import "./orders.css";
import "../shared/DataGrid.css";

type FilterStatus = "" | "planned" | "confirmed" | "in_progress" | "completed" | "cancelled";

const STATUS_LABELS: Record<string, string> = {
  planned: "待排产",
  confirmed: "已排产",
  in_progress: "生产中",
  completed: "已完成",
  cancelled: "已取消",
};

const STATUS_CLASS: Record<string, string> = {
  planned: "statusPlanned",
  confirmed: "statusConfirmed",
  in_progress: "statusProgress",
  completed: "statusCompleted",
  cancelled: "statusCancelled",
};

export function OrderCenterPage() {
  const { data: allAllocations, loading, error, refetch } = useAsync(() => fetchAllocations(), []);
  const { toast } = useToast();
  const [filterStatus, setFilterStatus] = React.useState<FilterStatus>("");
  const [showCreate, setShowCreate] = React.useState(false);
  const [showImport, setShowImport] = React.useState(false);

  // Status filtering stays a top-level concern (status cards). Quick-search,
  // sorting, pagination, CSV are all owned by the DataGrid below.
  const allocations = React.useMemo(() => {
    let list = allAllocations ?? [];
    if (filterStatus) list = list.filter((a) => a.status === filterStatus);
    return list;
  }, [allAllocations, filterStatus]);

  const counts = React.useMemo(() => {
    const c: Record<string, number> = { total: 0, planned: 0, confirmed: 0, in_progress: 0, completed: 0 };
    for (const a of allAllocations ?? []) {
      c.total++;
      if (c[a.status] !== undefined) c[a.status]++;
    }
    return c;
  }, [allAllocations]);

  // Batch-fetch canonical risk for every visible allocation in ONE request.
  // No per-row API calls. Skip completed/cancelled (no live risk).
  const riskIds = React.useMemo(
    () => allocations
      .filter((a) => a.status !== "completed" && a.status !== "cancelled")
      .map((a) => a.id),
    [allocations],
  );
  const { map: riskMap } = useRiskBatch("allocation", riskIds);

  const handleDelete = React.useCallback(async (id: string) => {
    try {
      await deleteAllocation(id);
      toast("订单已删除", "success");
      refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : "删除失败", "error");
    }
  }, [toast, refetch]);

  const columns = React.useMemo<DataGridColumn<Allocation>[]>(() => [
    {
      id: "order_id", header: "订单号", sticky: true, width: 130,
      sortValue: (a) => a.order_id ?? a.id,
      filterValue: (a) => `${a.order_id ?? ""} ${a.id}`,
      accessor: (a) => <span className="orderCellId">{a.order_id ?? a.id.slice(0, 8)}</span>,
    },
    {
      id: "qty", header: "数量", width: 90, align: "right",
      sortValue: (a) => a.allocated_qty ?? 0,
      filterValue: (a) => String(a.allocated_qty ?? ""),
      accessor: (a) => a.allocated_qty?.toLocaleString(),
    },
    {
      id: "factory", header: "工厂", width: 140,
      sortValue: (a) => a.factories?.name ?? "",
      filterValue: (a) => a.factories?.name ?? "未分配",
      accessor: (a) => a.factories?.name ?? "未分配",
    },
    {
      id: "start", header: "计划开始", width: 110,
      sortValue: (a) => a.planned_start_date ?? null,
      filterValue: (a) => (a.planned_start_date ?? "").slice(0, 10),
      accessor: (a) => (a.planned_start_date ?? "").slice(0, 10) || "—",
    },
    {
      id: "due", header: "交货日期", width: 150,
      sortValue: (a) => a.planned_end_date ?? null,
      filterValue: (a) => (a.planned_end_date ?? "").slice(0, 10),
      accessor: (a) => {
        const dueDate = (a.planned_end_date ?? "").slice(0, 10);
        if (!dueDate) return "—";
        const daysLeft = Math.ceil((new Date(dueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        const active = a.status !== "completed" && a.status !== "cancelled";
        const daysLevel = riskMap.get(a.id)?.level ?? "ok";
        return (
          <>
            {dueDate}
            {active && (
              <span className={`orderDaysTag orderDaysTag--${daysLevel}`}>
                {daysLeft < 0 ? `逾期${Math.abs(daysLeft)}天` : `${daysLeft}天`}
              </span>
            )}
          </>
        );
      },
    },
    {
      id: "risk", header: "风险", width: 120,
      sortValue: (a) => {
        const lvl = riskMap.get(a.id)?.level;
        return lvl === "critical" ? 3 : lvl === "warn" ? 2 : lvl === "ok" ? 1 : 0;
      },
      filterValue: (a) => riskMap.get(a.id)?.level ?? "",
      accessor: (a) => {
        const active = a.status !== "completed" && a.status !== "cancelled";
        return active
          ? <RiskPill assessment={riskMap.get(a.id) ?? null} detailed compact />
          : <span style={{ color: "var(--muted)", fontSize: 11 }}>—</span>;
      },
    },
    {
      id: "status", header: "状态", width: 100,
      sortValue: (a) => a.status, filterValue: (a) => STATUS_LABELS[a.status] ?? a.status,
      accessor: (a) => <span className={`orderStatus ${STATUS_CLASS[a.status] ?? ""}`}>{STATUS_LABELS[a.status] ?? a.status}</span>,
    },
    {
      id: "actions", header: "操作", width: 130, align: "right",
      accessor: (a) => {
        const risk = riskMap.get(a.id) ?? null;
        const active = a.status !== "completed" && a.status !== "cancelled";
        return (
          <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end" }}>
            {active && (risk?.level === "critical" || risk?.level === "warn") && (
              <DecisionButton
                subject={{ type: "allocation", id: a.id }}
                title={`订单 ${a.order_id ?? a.id.slice(0, 8)}`}
                label="决策"
                className="orderActionBtn orderActionBtn--decision"
              />
            )}
            {a.status === "planned" && (
              <button className="orderActionBtn orderActionBtn--danger" onClick={() => handleDelete(a.id)}>删除</button>
            )}
          </div>
        );
      },
    },
  ], [riskMap, handleDelete]);

  if (loading && !allAllocations) return <div className="card"><div className="loadingCenter">加载中...</div></div>;
  if (error) return <div className="card"><div style={{ padding: 24, color: "var(--danger)" }}>加载失败: {error}</div></div>;

  return (
    <div className="orderCenter">
      {/* Status summary cards */}
      <div className="orderStatusRow">
        <StatusCard label="全部" count={counts.total} active={filterStatus === ""} onClick={() => setFilterStatus("")} />
        <StatusCard label="待排产" count={counts.planned} active={filterStatus === "planned"} onClick={() => setFilterStatus("planned")} color="#facc15" />
        <StatusCard label="已排产" count={counts.confirmed} active={filterStatus === "confirmed"} onClick={() => setFilterStatus("confirmed")} color="var(--accent)" />
        <StatusCard label="生产中" count={counts.in_progress} active={filterStatus === "in_progress"} onClick={() => setFilterStatus("in_progress")} color="#a78bfa" />
        <StatusCard label="已完成" count={counts.completed} active={filterStatus === "completed"} onClick={() => setFilterStatus("completed")} color="#22c55e" />
      </div>

      {/* Order grid */}
      <div className="card">
        <DataGrid<Allocation>
          rows={allocations}
          columns={columns}
          rowKey={(a) => a.id}
          searchPlaceholder="搜索订单号、工厂名…"
          csvFilename="订单中心"
          pageSize={25}
          emptyTitle="暂无订单数据"
          emptyDescription="导入 Excel 或新建订单以开始排产。"
          emptyAction={<button className="btn primary" onClick={() => setShowCreate(true)}>新建订单</button>}
          toolbarExtra={
            <>
              <button className="btn" onClick={() => setShowImport(true)}>Excel 导入</button>
              <button className="btn primary" onClick={() => setShowCreate(true)}>新建订单</button>
            </>
          }
        />
      </div>

      {/* Drawers */}
      {showCreate && <CreateOrderDrawer onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); refetch(); }} />}
      {showImport && <ImportDrawer onClose={() => setShowImport(false)} onImported={() => { setShowImport(false); refetch(); }} />}
    </div>
  );
}

function StatusCard({ label, count, active, onClick, color }: {
  label: string; count: number; active: boolean; onClick: () => void; color?: string;
}) {
  return (
    <button className={`orderStatusCard ${active ? "orderStatusCard--active" : ""}`} onClick={onClick}>
      <span className="orderStatusCount" style={{ color: active ? (color ?? "var(--accent)") : undefined }}>{count}</span>
      <span className="orderStatusLabel">{label}</span>
    </button>
  );
}
