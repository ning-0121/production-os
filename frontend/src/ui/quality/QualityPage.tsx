import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchQCInspections, fetchReworks, createQCInspection } from "../../services/api";
import { useToast } from "../Toast";
import { PageSkeleton } from "../Skeleton";
import { DataGrid, type DataGridColumn } from "../shared/DataGrid";
import "./quality.css";
import "../shared/DataGrid.css";

type QCRow = Record<string, unknown>;

const TYPE_LABELS: Record<string, string> = { pp_sample: "产前样", shipping_sample: "船样", inline: "中查", final: "终查", third_party: "第三方" };
const RESULT_CLS: Record<string, string> = { pass: "qcPass", fail: "qcFail", conditional: "qcConditional", pending: "qcPending" };
const RESULT_LABELS: Record<string, string> = { pass: "合格", fail: "不合格", conditional: "有条件放行", pending: "待验" };
const RESULT_RANK: Record<string, number> = { fail: 3, conditional: 2, pending: 1, pass: 0 };

const QC_COLUMNS: DataGridColumn<QCRow>[] = [
  {
    id: "result", header: "结果", width: 110,
    sortValue: (i) => RESULT_RANK[i.result as string] ?? 0,
    filterValue: (i) => RESULT_LABELS[i.result as string] ?? String(i.result),
    accessor: (i) => <span className={`qcResult ${RESULT_CLS[i.result as string] ?? ""}`}>{RESULT_LABELS[i.result as string] ?? String(i.result)}</span>,
  },
  {
    id: "type", header: "类型", width: 90,
    sortValue: (i) => String(i.inspection_type), filterValue: (i) => TYPE_LABELS[i.inspection_type as string] ?? String(i.inspection_type),
    accessor: (i) => <span className="qcType">{TYPE_LABELS[i.inspection_type as string] ?? String(i.inspection_type)}</span>,
  },
  {
    id: "order", header: "订单", sticky: true, width: 140,
    sortValue: (i) => String((i.orders as QCRow | null)?.order_number ?? ""),
    filterValue: (i) => String((i.orders as QCRow | null)?.order_number ?? ""),
    accessor: (i) => { const o = i.orders as QCRow | null; return o ? String(o.order_number ?? "—") : "—"; },
  },
  {
    id: "factory", header: "工厂", width: 140,
    sortValue: (i) => String((i.factories as QCRow | null)?.name ?? ""),
    filterValue: (i) => String((i.factories as QCRow | null)?.name ?? ""),
    accessor: (i) => { const f = i.factories as QCRow | null; return f ? String(f.name ?? "—") : "—"; },
  },
  {
    id: "date", header: "验货日期", width: 120,
    sortValue: (i) => String(i.inspection_date ?? ""), filterValue: (i) => String(i.inspection_date ?? ""),
    accessor: (i) => String(i.inspection_date ?? "—"),
  },
  {
    id: "defect_rate", header: "不良率", width: 90, align: "right",
    sortValue: (i) => Number(i.defect_rate_pct ?? 0), filterValue: (i) => `${i.defect_rate_pct ?? 0}%`,
    accessor: (i) => <span className={`qcRate ${Number(i.defect_rate_pct ?? 0) > 5 ? "qcRate--bad" : ""}`}>{String(i.defect_rate_pct ?? 0)}%</span>,
  },
];

export function QualityPage() {
  const [refreshKey, setRefreshKey] = React.useState(0);
  const { data: inspections, loading } = useAsync(() => fetchQCInspections(), [refreshKey]);
  const { data: reworks } = useAsync(() => fetchReworks("pending"), [refreshKey]);
  const [createOpen, setCreateOpen] = React.useState(false);
  const { toast } = useToast();

  if (loading) return <PageSkeleton />;

  const inspList = (inspections ?? []) as QCRow[];
  const reworkList = (reworks ?? []) as QCRow[];
  const totalInsp = inspList.length;
  const failCount = inspList.filter((i) => i.result === "fail").length;
  const passRate = totalInsp > 0 ? Math.round(((totalInsp - failCount) / totalInsp) * 100) : 100;

  return (
    <div className="qcPage">
      <div className="todayKpiRow">
        <KpiCard label="验货总数" value={totalInsp} accent />
        <KpiCard label="合格率" value={`${passRate}%`} color={passRate >= 90 ? "#22c55e" : passRate >= 70 ? "#facc15" : "#fb7185"} />
        <KpiCard label="不合格" value={failCount} color={failCount > 0 ? "#fb7185" : "#22c55e"} />
        <KpiCard label="待返工" value={reworkList.length} color={reworkList.length > 0 ? "#facc15" : "#22c55e"} />
      </div>

      {failCount > 0 && (
        <div className="riskBanner riskBannerHigh" style={{ marginBottom: 12 }}>
          <div className="riskBannerLeft">
            <span className="riskBannerIcon">!</span>
            <span className="riskBannerText">{failCount} 次验货不合格，需要跟进处理</span>
          </div>
        </div>
      )}

      <div className="card">
        <div className="cardHeader">
          <h2>验货记录</h2>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="hint">{totalInsp} 条</span>
            <button className="btn primary" onClick={() => setCreateOpen(true)}>+ 新建验货</button>
          </div>
        </div>
        <DataGrid<QCRow>
          rows={inspList}
          columns={QC_COLUMNS}
          rowKey={(i) => i.id as string}
          searchPlaceholder="搜索订单、工厂、类型…"
          csvFilename="验货记录"
          pageSize={25}
          emptyTitle="暂无验货记录"
          emptyAction={<button className="btn primary" onClick={() => setCreateOpen(true)}>+ 创建第一个验货</button>}
          renderExpandedRow={(insp) => {
            const defects = (insp.qc_defects ?? []) as QCRow[];
            if (defects.length === 0) return <span className="hint">无不良明细</span>;
            return (
              <div className="qcDefectList">
                {defects.map((d, i) => (
                  <div key={i} className={`qcDefect qcDefect--${d.severity}`}>
                    <span className="qcDefectCode">{String(d.defect_code)}</span>
                    <span>x{String(d.qty ?? 1)}</span>
                    <span className={`qcSeverity qcSeverity--${d.severity}`}>{d.severity === "critical" ? "致命" : d.severity === "major" ? "主要" : "次要"}</span>
                    {d.location != null && <span className="qcLocation">{String(d.location)}</span>}
                  </div>
                ))}
              </div>
            );
          }}
        />
      </div>

      {createOpen && (
        <CreateInspectionModal
          onCancel={() => setCreateOpen(false)}
          onSubmit={async (payload) => {
            try {
              await createQCInspection(payload);
              toast("验货已创建", "success");
              setCreateOpen(false);
              setRefreshKey((k) => k + 1);
            } catch (err) {
              toast(err instanceof Error ? err.message : "创建失败", "error");
            }
          }}
        />
      )}
    </div>
  );
}

function CreateInspectionModal({ onCancel, onSubmit }: {
  onCancel: () => void;
  onSubmit: (p: Record<string, unknown>) => void | Promise<void>;
}) {
  const [type, setType] = React.useState("final");
  const [result, setResult] = React.useState("pending");
  const [orderId, setOrderId] = React.useState("");
  const [totalQty, setTotalQty] = React.useState("");
  const [defectsQty, setDefectsQty] = React.useState("");
  const [note, setNote] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await onSubmit({
      inspection_type: type,
      result,
      order_id: orderId.trim() || undefined,
      total_qty_inspected: totalQty === "" ? undefined : Number(totalQty),
      total_defects: defectsQty === "" ? undefined : Number(defectsQty),
      note: note.trim() || undefined,
    });
    setSaving(false);
  }

  return (
    <div onClick={onCancel}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000 }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        style={{ background: "#0b1220", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, padding: 24, width: 460, display: "flex", flexDirection: "column", gap: 14 }}>
        <h3 style={{ margin: 0 }}>新建验货记录</h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Label text="验货类型">
            <select value={type} onChange={(e) => setType(e.target.value)} style={inputStyle}>
              <option value="pp_sample">产前样</option>
              <option value="shipping_sample">船样</option>
              <option value="inline">中查</option>
              <option value="final">终查</option>
              <option value="third_party">第三方</option>
            </select>
          </Label>
          <Label text="结果">
            <select value={result} onChange={(e) => setResult(e.target.value)} style={inputStyle}>
              <option value="pending">待验</option>
              <option value="pass">合格</option>
              <option value="fail">不合格</option>
              <option value="conditional">有条件放行</option>
            </select>
          </Label>
        </div>
        <Label text="订单号">
          <input value={orderId} onChange={(e) => setOrderId(e.target.value)} placeholder="ORD-..." style={inputStyle} />
        </Label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Label text="抽检数量">
            <input type="number" min={0} value={totalQty} onChange={(e) => setTotalQty(e.target.value)} style={inputStyle} />
          </Label>
          <Label text="不良数">
            <input type="number" min={0} value={defectsQty} onChange={(e) => setDefectsQty(e.target.value)} style={inputStyle} />
          </Label>
        </div>
        <Label text="备注">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} style={inputStyle} />
        </Label>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onCancel}>取消</button>
          <button type="submit" className="btn primary" disabled={saving}>{saving ? "保存中..." : "创建"}</button>
        </div>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", marginTop: 4,
  background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.12)",
  borderRadius: 6, color: "var(--text)", fontSize: 13, fontFamily: "inherit",
};

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return <label style={{ fontSize: 12, color: "var(--muted)", display: "block" }}>{text}{children}</label>;
}

function KpiCard({ label, value, color, accent }: { label: string; value: string | number; color?: string; accent?: boolean }) {
  return (
    <div className="todayKpiCard">
      <div className="todayKpiLabel">{label}</div>
      <div className="todayKpiValue" style={{ color: color ?? (accent ? "var(--accent)" : undefined) }}>{value}</div>
    </div>
  );
}
