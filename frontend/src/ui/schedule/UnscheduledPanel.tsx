import React from "react";
import { OrderCard } from "./OrderCard";
import type { Allocation } from "../../types";

type Props = {
  allocations: Allocation[];
  loading: boolean;
};

type SortKey = "due" | "qty";

export function UnscheduledPanel({ allocations, loading }: Props) {
  const [search, setSearch] = React.useState("");
  const [sort, setSort] = React.useState<SortKey>("due");

  const filtered = React.useMemo(() => {
    let list = allocations;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (a) =>
          (a.order_id ?? "").toLowerCase().includes(q) ||
          a.id.toLowerCase().includes(q),
      );
    }
    list = [...list].sort((a, b) => {
      if (sort === "due") {
        return (a.planned_end_date ?? "").localeCompare(b.planned_end_date ?? "");
      }
      return (b.allocated_qty ?? 0) - (a.allocated_qty ?? 0);
    });
    return list;
  }, [allocations, search, sort]);

  return (
    <div className="unschedPanel">
      <div className="unschedHeader">
        <h3 className="unschedTitle">待排产</h3>
        <span className="unschedCount">{allocations.length}</span>
      </div>

      <div className="unschedControls">
        <input
          className="unschedSearch"
          placeholder="搜索订单号..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="unschedSort">
          <button
            className={`unschedSortBtn ${sort === "due" ? "active" : ""}`}
            onClick={() => setSort("due")}
          >
            交期
          </button>
          <button
            className={`unschedSortBtn ${sort === "qty" ? "active" : ""}`}
            onClick={() => setSort("qty")}
          >
            数量
          </button>
        </div>
      </div>

      <div className="unschedList">
        {loading && <div className="loadingCenter">加载中...</div>}
        {!loading && filtered.length === 0 && (
          <div className="emptyState">暂无待排产订单</div>
        )}
        {filtered.map((a) => (
          <OrderCard key={a.id} allocation={a} />
        ))}
      </div>
    </div>
  );
}
