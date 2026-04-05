import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchFactories, updateCapability } from "../../services/api";
import type { Factory } from "../../types";
import "../orders/orders.css";
import "./factories.css";

export function FactoriesPage() {
  const { data: rawFactories, loading, error, refetch } = useAsync(() => fetchFactories(), []);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [filterStatus, setFilterStatus] = React.useState("");
  const [searchText, setSearchText] = React.useState("");

  const factories = React.useMemo(() => {
    let list = rawFactories ?? [];
    if (filterStatus) list = list.filter((f) => f.status === filterStatus);
    if (searchText) {
      const q = searchText.toLowerCase();
      list = list.filter((f) =>
        f.name.toLowerCase().includes(q) ||
        (f.location ?? "").toLowerCase().includes(q)
      );
    }
    return list;
  }, [rawFactories, filterStatus, searchText]);

  async function handleCapabilityUpdate(capId: string, field: string, value: number) {
    try {
      await updateCapability(capId, { [field]: value });
    } catch {
      // silent — will revert on next refetch
    }
    refetch();
  }

  if (loading) return <div className="card"><div className="loadingCenter">加载中...</div></div>;
  if (error) return <div className="card"><div style={{ padding: 24, color: "var(--danger)" }}>加载失败: {error}</div></div>;
  if (!rawFactories) return null;

  return (
    <div className="card">
      <div className="cardHeader">
        <div>
          <h2>工厂列表</h2>
          <div className="hint">产能参数自动校准 — 每次订单完成后自动更新</div>
        </div>
        <span className="pill">{factories.length} / {rawFactories.length} 工厂</span>
      </div>

      <div className="filterBar">
        <input
          className="filterSearch"
          placeholder="搜索工厂名称、地址..."
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
        />
        <select
          className="filterSelect"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          <option value="">全部状态</option>
          <option value="active">运营中</option>
          <option value="inactive">停用</option>
          <option value="maintenance">维护中</option>
        </select>
      </div>

      <div className="ftable">
        <div className="fthead">
          <div className="ftcell ftname">名称</div>
          <div className="ftcell">地点</div>
          <div className="ftcell ftnum">日产能</div>
          <div className="ftcell ftnum">效率</div>
          <div className="ftcell ftnum">质量分</div>
          <div className="ftcell ftnum">协作分</div>
          <div className="ftcell ftnum">状态</div>
          <div className="ftcell">产品类型</div>
        </div>

        {factories.map((f: Factory) => {
          const editing = editingId === f.id;
          const caps = f.factory_capabilities ?? [];
          const bestCap = caps[0];
          const dailyCapacity = bestCap?.daily_capacity ?? 0;
          const efficiencyRate = bestCap?.efficiency_rate ?? 0;
          const qualityScore = f.quality_score ?? 0;
          const cooperationScore = f.cooperation_score ?? 0;

          return (
            <React.Fragment key={f.id}>
              <div
                className={`ftrow ${editing ? "ftrowEdit" : ""}`}
                onClick={() => setEditingId(editing ? null : f.id)}
              >
                <div className="ftcell ftname">{f.name}</div>
                <div className="ftcell">{f.location ?? "—"}</div>
                <div className="ftcell ftnum">
                  {editing && bestCap ? (
                    <input
                      type="number"
                      className="ftinput"
                      defaultValue={dailyCapacity}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => void handleCapabilityUpdate(bestCap.id, "daily_capacity", Number(e.target.value))}
                    />
                  ) : (
                    <span>{dailyCapacity}</span>
                  )}
                </div>
                <div className="ftcell ftnum">
                  {editing && bestCap ? (
                    <input
                      type="number"
                      step="0.01"
                      className="ftinput"
                      defaultValue={efficiencyRate}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => void handleCapabilityUpdate(bestCap.id, "efficiency_rate", Number(e.target.value))}
                    />
                  ) : (efficiencyRate ? `${(efficiencyRate * 100).toFixed(0)}%` : "—")}
                </div>
                <div className="ftcell ftnum">
                  <ScoreBar value={qualityScore} />
                </div>
                <div className="ftcell ftnum">
                  <ScoreBar value={cooperationScore} />
                </div>
                <div className="ftcell ftnum">
                  <span className="pill">{f.status}</span>
                </div>
                <div className="ftcell">
                  <div className="ftcaps">
                    {caps.map((c) => (
                      <span key={c.id} className="pill">{c.product_type}</span>
                    ))}
                  </div>
                </div>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────

function ScoreBar({ value }: { value: number }) {
  const color = value >= 85 ? "var(--accent)" : value >= 70 ? "var(--accent2)" : "var(--danger)";
  return (
    <div className="scoreBar">
      <div className="scoreBarFill" style={{ width: `${value}%`, background: color }} />
      <span className="scoreBarLabel">{value}</span>
    </div>
  );
}
