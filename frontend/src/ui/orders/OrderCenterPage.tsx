import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchAllocations, deleteAllocation } from "../../services/api";
import { useToast } from "../Toast";
import { CreateOrderDrawer } from "./CreateOrderDrawer";
import { ImportDrawer } from "./ImportDrawer";
import type { Allocation } from "../../types";
import "./orders.css";

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
  const [search, setSearch] = React.useState("");
  const [filterStatus, setFilterStatus] = React.useState<FilterStatus>("");
  const [showCreate, setShowCreate] = React.useState(false);
  const [showImport, setShowImport] = React.useState(false);

  const allocations = React.useMemo(() => {
    let list = allAllocations ?? [];
    if (filterStatus) list = list.filter((a) => a.status === filterStatus);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((a) =>
        (a.order_id ?? "").toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q) ||
        (a.factories?.name ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [allAllocations, filterStatus, search]);

  const counts = React.useMemo(() => {
    const c: Record<string, number> = { total: 0, planned: 0, confirmed: 0, in_progress: 0, completed: 0 };
    for (const a of allAllocations ?? []) {
      c.total++;
      if (c[a.status] !== undefined) c[a.status]++;
    }
    return c;
  }, [allAllocations]);

  async function handleDelete(id: string) {
    try {
      await deleteAllocation(id);
      toast("订单已删除", "success");
      refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : "删除失败", "error");
    }
  }

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

      {/* Toolbar */}
      <div className="card">
        <div className="orderToolbar">
          <input
            className="filterSearch"
            placeholder="搜索订单号、工厂名..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="orderToolbarActions">
            <button className="btn" onClick={() => setShowImport(true)}>Excel 导入</button>
            <button className="btn primary" onClick={() => setShowCreate(true)}>新建订单</button>
          </div>
        </div>

        {/* Order table */}
        <div className="orderTable">
          <table>
            <thead>
              <tr>
                <th>订单号</th>
                <th>数量</th>
                <th>工厂</th>
                <th>计划开始</th>
                <th>交货日期</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {allocations.length === 0 && (
                <tr><td colSpan={7} className="emptyState">暂无订单数据</td></tr>
              )}
              {allocations.map((a) => {
                const dueDate = (a.planned_end_date ?? "").slice(0, 10);
                const daysLeft = dueDate
                  ? Math.ceil((new Date(dueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
                  : null;
                const isOverdue = daysLeft !== null && daysLeft < 0 && a.status !== "completed" && a.status !== "cancelled";

                return (
                  <tr key={a.id} className={isOverdue ? "orderRow--overdue" : ""}>
                    <td className="orderCellId">{a.order_id ?? a.id.slice(0, 8)}</td>
                    <td>{a.allocated_qty?.toLocaleString()}</td>
                    <td>{a.factories?.name ?? "未分配"}</td>
                    <td>{(a.planned_start_date ?? "").slice(0, 10)}</td>
                    <td>
                      {dueDate}
                      {daysLeft !== null && a.status !== "completed" && a.status !== "cancelled" && (
                        <span className={`orderDaysTag ${daysLeft < 0 ? "orderDaysTag--overdue" : daysLeft <= 3 ? "orderDaysTag--urgent" : ""}`}>
                          {daysLeft < 0 ? `逾期${Math.abs(daysLeft)}天` : `${daysLeft}天`}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`orderStatus ${STATUS_CLASS[a.status] ?? ""}`}>
                        {STATUS_LABELS[a.status] ?? a.status}
                      </span>
                    </td>
                    <td>
                      {a.status === "planned" && (
                        <button className="orderActionBtn orderActionBtn--danger" onClick={() => handleDelete(a.id)}>删除</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
