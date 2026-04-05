import React from "react";
import { useAsync } from "../../hooks/useAsync";
import {
  fetchFactories,
  updateCapability,
  fetchProductionLines,
  createProductionLine,
  updateProductionLine,
} from "../../services/api";
import { useToast } from "../Toast";
import type { Factory, ProductionLine } from "../../types";
import "./factories.css";

export function FactoriesPage() {
  const { data: rawFactories, loading, error, refetch } = useAsync(() => fetchFactories(), []);
  const { data: allLines, refetch: refetchLines } = useAsync(() => fetchProductionLines(), []);
  const { toast } = useToast();
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [filterStatus, setFilterStatus] = React.useState("");
  const [searchText, setSearchText] = React.useState("");

  const factories = React.useMemo(() => {
    let list = rawFactories ?? [];
    if (filterStatus) list = list.filter((f) => f.status === filterStatus);
    if (searchText) {
      const q = searchText.toLowerCase();
      list = list.filter((f) =>
        f.name.toLowerCase().includes(q) ||
        (f.location ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [rawFactories, filterStatus, searchText]);

  // Lines grouped by factory
  const linesByFactory = React.useMemo(() => {
    const map = new Map<string, ProductionLine[]>();
    for (const l of allLines ?? []) {
      if (!map.has(l.factory_id)) map.set(l.factory_id, []);
      map.get(l.factory_id)!.push(l);
    }
    return map;
  }, [allLines]);

  async function handleCapabilityUpdate(capId: string, field: string, value: number) {
    try {
      await updateCapability(capId, { [field]: value });
      toast("更新成功", "success");
    } catch {
      toast("更新失败", "error");
    }
    refetch();
  }

  if (loading) return <div className="card"><div className="loadingCenter">加载中...</div></div>;
  if (error) return <div className="card"><div style={{ padding: 24, color: "var(--danger)" }}>加载失败: {error}</div></div>;
  if (!rawFactories) return null;

  return (
    <div className="factoryCenter">
      {/* Header */}
      <div className="card">
        <div className="cardHeader">
          <div>
            <h2>工厂 & 资源管理</h2>
            <div className="hint">管理工厂、产线、产能配置</div>
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
      </div>

      {/* Factory cards */}
      {factories.map((f) => {
        const isExpanded = expandedId === f.id;
        const lines = linesByFactory.get(f.id) ?? [];
        const caps = f.factory_capabilities ?? [];

        return (
          <div key={f.id} className={`card factoryCard ${isExpanded ? "factoryCard--expanded" : ""}`}>
            {/* Factory header row */}
            <div className="factoryRow" onClick={() => setExpandedId(isExpanded ? null : f.id)}>
              <div className="factoryMain">
                <span className="factoryName">{f.name}</span>
                <span className="factoryLocation">{f.location ?? "—"}</span>
              </div>
              <div className="factoryScores">
                <ScoreChip label="质量" value={f.quality_score} />
                <ScoreChip label="延期" value={f.delay_score} />
                <ScoreChip label="协作" value={f.cooperation_score} />
              </div>
              <div className="factoryMeta">
                <span className={`factoryStatus factoryStatus--${f.status}`}>
                  {f.status === "active" ? "运营中" : f.status === "maintenance" ? "维护中" : "停用"}
                </span>
                <span className="factoryLineCount">{lines.length} 产线</span>
                <span className="factoryToggle">{isExpanded ? "▼" : "▶"}</span>
              </div>
            </div>

            {/* Expanded detail */}
            {isExpanded && (
              <div className="factoryDetail">
                {/* Capabilities */}
                <div className="factoryDetailSection">
                  <h4 className="factoryDetailTitle">产能配置</h4>
                  {caps.length === 0 && <div className="emptyState" style={{ padding: 12 }}>暂无产能配置</div>}
                  <div className="capGrid">
                    {caps.map((c) => (
                      <div key={c.id} className="capCard">
                        <span className="capType">{c.product_type}</span>
                        <div className="capFields">
                          <CapField
                            label="日产能"
                            value={c.daily_capacity}
                            onSave={(v) => handleCapabilityUpdate(c.id, "daily_capacity", v)}
                          />
                          <CapField
                            label="效率"
                            value={c.efficiency_rate ?? 0}
                            step={0.01}
                            format={(v) => `${(v * 100).toFixed(0)}%`}
                            onSave={(v) => handleCapabilityUpdate(c.id, "efficiency_rate", v)}
                          />
                          <CapField
                            label="加班系数"
                            value={c.overtime_factor ?? 1}
                            step={0.1}
                            onSave={(v) => handleCapabilityUpdate(c.id, "overtime_factor", v)}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Production Lines */}
                <div className="factoryDetailSection">
                  <div className="factoryDetailHeader">
                    <h4 className="factoryDetailTitle">生产线</h4>
                    <AddLineButton factoryId={f.id} onCreated={refetchLines} />
                  </div>
                  {lines.length === 0 && <div className="emptyState" style={{ padding: 12 }}>暂无生产线</div>}
                  <div className="lineGrid">
                    {lines.map((line) => (
                      <LineCard key={line.id} line={line} onUpdated={refetchLines} />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Sub Components ─────────────────────────────────────

function ScoreChip({ label, value }: { label: string; value: number | null }) {
  const v = value ?? 0;
  const cls = v >= 80 ? "scoreChip--good" : v >= 60 ? "scoreChip--warn" : "scoreChip--bad";
  return (
    <span className={`scoreChip ${cls}`}>
      {label} {v || "—"}
    </span>
  );
}

function CapField({ label, value, step, format, onSave }: {
  label: string;
  value: number;
  step?: number;
  format?: (v: number) => string;
  onSave: (v: number) => void;
}) {
  const [editing, setEditing] = React.useState(false);

  return (
    <div className="capField">
      <span className="capFieldLabel">{label}</span>
      {editing ? (
        <input
          className="capFieldInput"
          type="number"
          step={step}
          defaultValue={value}
          autoFocus
          onBlur={(e) => { onSave(Number(e.target.value)); setEditing(false); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        />
      ) : (
        <span className="capFieldValue" onClick={() => setEditing(true)}>
          {format ? format(value) : value}
        </span>
      )}
    </div>
  );
}

function LineCard({ line, onUpdated }: { line: ProductionLine; onUpdated: () => void }) {
  const { toast } = useToast();
  const [editingField, setEditingField] = React.useState<string | null>(null);

  async function handleUpdate(field: string, value: number) {
    try {
      await updateProductionLine(line.id, { [field]: value });
      toast("更新成功", "success");
      onUpdated();
    } catch {
      toast("更新失败", "error");
    }
    setEditingField(null);
  }

  return (
    <div className="lineCard">
      <span className="lineName">{line.name}</span>
      <div className="lineCapacities">
        <div className="lineCap">
          <span className="lineCapLabel">前道</span>
          {editingField === "front" ? (
            <input
              className="capFieldInput"
              type="number"
              defaultValue={line.front_capacity_per_day}
              autoFocus
              onBlur={(e) => handleUpdate("front_capacity_per_day", Number(e.target.value))}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            />
          ) : (
            <span className="lineCapValue" onClick={() => setEditingField("front")}>
              {line.front_capacity_per_day}/天
            </span>
          )}
        </div>
        <div className="lineCap">
          <span className="lineCapLabel">后道</span>
          {editingField === "back" ? (
            <input
              className="capFieldInput"
              type="number"
              defaultValue={line.back_capacity_per_day}
              autoFocus
              onBlur={(e) => handleUpdate("back_capacity_per_day", Number(e.target.value))}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            />
          ) : (
            <span className="lineCapValue" onClick={() => setEditingField("back")}>
              {line.back_capacity_per_day}/天
            </span>
          )}
        </div>
      </div>
      <span className={`lineStatus lineStatus--${line.status}`}>{line.status}</span>
    </div>
  );
}

function AddLineButton({ factoryId, onCreated }: { factoryId: string; onCreated: () => void }) {
  const { toast } = useToast();
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState("");

  async function handleAdd() {
    if (!name.trim()) return;
    try {
      await createProductionLine({
        factory_id: factoryId,
        name: name.trim(),
        front_capacity_per_day: 300,
        back_capacity_per_day: 200,
      });
      toast("产线创建成功", "success");
      setName("");
      setAdding(false);
      onCreated();
    } catch {
      toast("创建失败", "error");
    }
  }

  if (!adding) {
    return <button className="btn" onClick={() => setAdding(true)}>+ 新增产线</button>;
  }

  return (
    <div className="addLineForm">
      <input
        className="capFieldInput"
        placeholder="产线名称"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); if (e.key === "Escape") setAdding(false); }}
      />
      <button className="btn primary" onClick={handleAdd}>确定</button>
      <button className="btn" onClick={() => setAdding(false)}>取消</button>
    </div>
  );
}
