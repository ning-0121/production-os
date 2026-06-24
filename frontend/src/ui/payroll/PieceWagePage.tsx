/**
 * 计件试算 / Piece-wage trial (Wedge S1).
 *
 * 工人扫码报工 → 件数 × 工序工价 = 计件金额。这是让工人愿意扫码的唯一理由。
 * 本页是「试算」:与工厂现有工资表并行,导出按工人汇总给组长对账(目标误差<1%),
 * 对账通过一个完整发薪周期后才谈正式发薪。本页不发薪。
 */

import React from "react";
import { useAsync } from "../../hooks/useAsync";
import {
  fetchPieceRates, setPieceRate, deletePieceRate, fetchPieceWages, fetchProductionLines,
  type PieceRate,
} from "../../services/api";
import { DataGrid, type DataGridColumn } from "../shared/DataGrid";
import { useToast } from "../Toast";
import { PageSkeleton } from "../Skeleton";
import "../shared/DataGrid.css";
import "./payroll.css";

type WorkerRow = { worker: string; output_qty: number; amount: number; missing_rate_qty: number };

function todayLocal() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

const WORKER_COLUMNS: DataGridColumn<WorkerRow>[] = [
  { id: "worker", header: "工人", sticky: true, sortValue: (r) => r.worker, filterValue: (r) => r.worker },
  { id: "output", header: "报工件数", align: "right", sortValue: (r) => r.output_qty, filterValue: (r) => String(r.output_qty), accessor: (r) => r.output_qty.toLocaleString() },
  { id: "amount", header: "计件金额(元)", align: "right", sortValue: (r) => r.amount, filterValue: (r) => String(r.amount), accessor: (r) => <strong>{r.amount.toFixed(2)}</strong> },
  {
    id: "missing", header: "缺工价件数", align: "right", sortValue: (r) => r.missing_rate_qty, filterValue: (r) => String(r.missing_rate_qty),
    accessor: (r) => r.missing_rate_qty > 0 ? <span style={{ color: "var(--danger)" }}>{r.missing_rate_qty}</span> : "—",
  },
];

export function PieceWagePage() {
  const { toast } = useToast();
  const [date, setDate] = React.useState(todayLocal());
  const [lineId, setLineId] = React.useState<string>("");
  const [refreshKey, setRefreshKey] = React.useState(0);
  const refresh = () => setRefreshKey((k) => k + 1);

  const { data: lines } = useAsync(() => fetchProductionLines(), []);
  const { data: ratesData, refetch: refetchRates } = useAsync(() => fetchPieceRates(), [refreshKey]);
  const { data: wages, loading, error } = useAsync(() => fetchPieceWages(date, lineId || null), [date, lineId, refreshKey]);

  const lineName = (id: string | null) => (lines ?? []).find((l) => l.id === id)?.name ?? (id ? id.slice(0, 6) : "全厂");

  if (loading && !wages) return <PageSkeleton />;

  return (
    <div className="pwPage">
      <div className="cardHeader" style={{ marginBottom: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>计件试算</h1>
          <div className="hint">扫码报工 × 工序工价 = 计件金额。<strong>试算并行,不发薪</strong>——导出给组长对账,误差&lt;1% 跑满一个发薪周期再谈正式发薪。</div>
        </div>
        <button className="btn" onClick={refresh}>↻ 刷新</button>
      </div>

      {/* 控制条 */}
      <div className="pwControls">
        <label>日期 <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label>产线
          <select value={lineId} onChange={(e) => setLineId(e.target.value)}>
            <option value="">全厂</option>
            {(lines ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
      </div>

      {error && <div className="dgError">加载失败：{error}</div>}

      {/* 当日 KPI */}
      {wages && (
        <div className="pwKpiRow">
          <PwKpi label="报工件数" value={wages.total.output_qty.toLocaleString()} />
          <PwKpi label="计件金额(元)" value={wages.total.amount.toFixed(2)} accent />
          <PwKpi label="缺工价件数" value={wages.total.missing_rate_qty.toLocaleString()} danger={wages.total.missing_rate_qty > 0} />
          <PwKpi label="报工条数" value={String(wages.report_rows)} />
        </div>
      )}

      {/* 缺工价提醒 */}
      {wages && wages.missing_rates.length > 0 && (
        <div className="pwWarn">
          ⚠ 以下工序有报工但未配置工价,这部分计件按 0 计——请先补工价：
          {wages.missing_rates.map((m, i) => <span key={i} className="pwTag">{m.operation ?? "(未填工序)"}{m.line_id ? ` @${lineName(m.line_id)}` : ""}</span>)}
        </div>
      )}

      {/* 按工人汇总(可排序、可导出对账) */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="cardHeader"><h2 style={{ fontSize: 16, margin: 0 }}>按工人计件汇总</h2><span className="hint">{lineName(lineId || null)} · {date}</span></div>
        <DataGrid<WorkerRow>
          rows={wages?.by_worker ?? []}
          columns={WORKER_COLUMNS}
          rowKey={(r) => r.worker}
          searchPlaceholder="搜索工人…"
          csvFilename={`计件汇总-${lineName(lineId || null)}-${date}`}
          pageSize={50}
          emptyTitle="当日无报工数据"
          emptyDescription="工人通过车间执行台扫码报工后,这里会自动出计件金额。"
        />
      </div>

      {/* 工价管理 */}
      <RateManager rates={ratesData?.rates ?? []} lines={lines ?? []} onChanged={() => { refetchRates(); refresh(); }} toast={toast} />
    </div>
  );
}

function PwKpi({ label, value, accent, danger }: { label: string; value: string; accent?: boolean; danger?: boolean }) {
  return (
    <div className="pwKpi">
      <div className="pwKpiVal" style={{ color: danger ? "var(--danger)" : accent ? "var(--accent)" : undefined }}>{value}</div>
      <div className="pwKpiLabel">{label}</div>
    </div>
  );
}

function RateManager({ rates, lines, onChanged, toast }: {
  rates: PieceRate[];
  lines: { id: string; name: string }[];
  onChanged: () => void;
  toast: (m: string, t?: "success" | "error") => void;
}) {
  const [operation, setOperation] = React.useState("");
  const [lineId, setLineId] = React.useState("");
  const [price, setPrice] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const lineName = (id: string | null) => lines.find((l) => l.id === id)?.name ?? "全厂通用";

  async function add() {
    if (!operation.trim() || !(Number(price) >= 0)) { toast("请填写工序和工价(≥0)", "error"); return; }
    setBusy(true);
    try {
      await setPieceRate({ operation: operation.trim(), line_id: lineId || null, unit_price: Number(price) });
      toast("工价已保存", "success");
      setOperation(""); setPrice("");
      onChanged();
    } catch (e) { toast(e instanceof Error ? e.message : "保存失败", "error"); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    try { await deletePieceRate(id); toast("已停用", "success"); onChanged(); }
    catch (e) { toast(e instanceof Error ? e.message : "操作失败", "error"); }
  }

  return (
    <div className="card">
      <div className="cardHeader"><h2 style={{ fontSize: 16, margin: 0 }}>工序工价表</h2><span className="hint">产线专用价优先于全厂通用价</span></div>
      <div className="pwRateForm">
        <input placeholder="工序(如 平车/锁眼)" value={operation} onChange={(e) => setOperation(e.target.value)} />
        <select value={lineId} onChange={(e) => setLineId(e.target.value)}>
          <option value="">全厂通用</option>
          {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <input type="number" step="0.01" min="0" placeholder="元/件" value={price} onChange={(e) => setPrice(e.target.value)} />
        <button className="btn primary" onClick={add} disabled={busy}>保存工价</button>
      </div>
      <table className="pwRateTable">
        <thead><tr><th>工序</th><th>适用</th><th>工价(元/件)</th><th></th></tr></thead>
        <tbody>
          {rates.length === 0 && <tr><td colSpan={4} className="hint" style={{ padding: 16 }}>还没有工价,先在上面添加。</td></tr>}
          {rates.map((r) => (
            <tr key={r.id}>
              <td>{r.operation}</td>
              <td>{lineName(r.line_id)}</td>
              <td>{Number(r.unit_price).toFixed(2)}</td>
              <td style={{ textAlign: "right" }}><button className="pwLinkBtn" onClick={() => remove(r.id)}>停用</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
