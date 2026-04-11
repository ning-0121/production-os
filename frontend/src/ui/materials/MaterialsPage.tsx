import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchMaterials, runMaterialCheck } from "../../services/api";
import { useToast } from "../Toast";
import { PageSkeleton } from "../Skeleton";
import type { AIAction } from "../../types";
import "./materials.css";

const CATEGORY_LABELS: Record<string, string> = { fabric: "面料", trim: "辅料", packaging: "包装", sample: "样品", remnant: "尾料" };

export function MaterialsPage() {
  const { toast } = useToast();
  const { data: materials, loading } = useAsync(() => fetchMaterials(), []);
  const [filter, setFilter] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [alerts, setAlerts] = React.useState<AIAction[]>([]);
  const [checking, setChecking] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  async function handleCheck() {
    setChecking(true);
    try {
      const res = await runMaterialCheck();
      setAlerts(res.actions ?? []);
      if (res.actions.length === 0) toast("物料状态正常", "success");
    } catch { toast("检查失败", "error"); }
    finally { setChecking(false); }
  }

  const list = React.useMemo(() => {
    let items = (materials ?? []) as Array<Record<string, unknown>>;
    if (filter) items = items.filter((m) => m.category === filter);
    if (search) {
      const q = search.toLowerCase();
      items = items.filter((m) => String(m.name ?? "").toLowerCase().includes(q) || String(m.code ?? "").toLowerCase().includes(q));
    }
    return items;
  }, [materials, filter, search]);

  if (loading) return <PageSkeleton />;

  const totalCount = (materials ?? []).length;
  const fabricCount = (materials ?? []).filter((m: Record<string, unknown>) => m.category === "fabric").length;
  const trimCount = (materials ?? []).filter((m: Record<string, unknown>) => m.category === "trim").length;

  return (
    <div className="matPage">
      <div className="todayKpiRow">
        <KpiCard label="物料总数" value={totalCount} accent />
        <KpiCard label="面料" value={fabricCount} />
        <KpiCard label="辅料" value={trimCount} />
        <KpiCard label="AI 预警" value={alerts.length} color={alerts.length > 0 ? "#fb7185" : "#22c55e"} />
      </div>

      {alerts.length > 0 && (
        <div className="card todaySection">
          <div className="cardHeader"><h2>物料预警</h2><span className="hint">{alerts.length} 条</span></div>
          <div className="todayAiList">
            {alerts.map((a, i) => (
              <div key={i} className={`todayAiCard todayAiCard--${a.urgency}`}>
                <div className="todayAiCardTop">
                  <span className={`todayAiUrgency todayAiUrgency--${a.urgency}`}>{a.urgency === "critical" ? "紧急" : a.urgency === "high" ? "重要" : "提示"}</span>
                </div>
                <div className="todayAiSummary">{a.summary}</div>
                <div className="todayAiImpact">{a.impact}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="orderToolbar">
          <input className="filterSearch" placeholder="搜索物料编码、名称..." value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="orderToolbarActions">
            <select className="filterSelect" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">全部类型</option>
              <option value="fabric">面料</option>
              <option value="trim">辅料</option>
              <option value="packaging">包装</option>
            </select>
            <button className="btn" onClick={handleCheck} disabled={checking}>{checking ? "检查中..." : "物料检查"}</button>
          </div>
        </div>

        <div className="matList">
          {list.length === 0 && <div className="emptyState">暂无物料数据</div>}
          {list.map((m) => {
            const isExp = expanded === (m.id as string);
            const colors = (m.material_colors ?? []) as Array<Record<string, unknown>>;
            return (
              <div key={m.id as string} className={`matCard ${isExp ? "matCard--expanded" : ""}`} onClick={() => setExpanded(isExp ? null : m.id as string)}>
                <div className="matCardHeader">
                  <div className="matCardMain">
                    <span className="matCode">{String(m.code)}</span>
                    <span className="matName">{String(m.name)}</span>
                  </div>
                  <div className="matCardMeta">
                    <span className="pill">{CATEGORY_LABELS[m.category as string] ?? m.category}</span>
                    <span className="matUnit">{String(m.unit ?? "")}</span>
                    {colors.length > 0 && <span className="matColorCount">{colors.length} 色</span>}
                    <span className="factoryToggle">{isExp ? "▼" : "▶"}</span>
                  </div>
                </div>
                {isExp && colors.length > 0 && (
                  <div className="matColorList">
                    {colors.map((c) => (
                      <div key={c.id as string} className="matColorChip">
                        <span className="matColorDot" style={{ background: `#${String(c.color_code ?? "999").slice(0, 6)}` }} />
                        <span>{String(c.color_name ?? c.color_code)}</span>
                        {c.pantone != null && <span className="matPantone">{String(c.pantone)}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
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
