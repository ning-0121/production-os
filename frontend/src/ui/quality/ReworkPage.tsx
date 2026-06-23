import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchReworks, updateRework, createRework } from "../../services/api";
import { useToast } from "../Toast";
import { PageSkeleton } from "../Skeleton";
import { DataGrid, type DataGridColumn } from "../shared/DataGrid";
import "./quality.css";
import "../shared/DataGrid.css";

type RWRow = Record<string, unknown>;

const STATUS_LABELS: Record<string, string> = { pending: "待处理", in_progress: "返工中", completed: "已完成", waived: "已豁免" };
const STATUS_CLS: Record<string, string> = { pending: "statusPlanned", in_progress: "statusProgress", completed: "statusCompleted", waived: "statusCancelled" };
const PARTY_LABELS: Record<string, string> = { factory: "工厂", material: "物料", design: "设计", customer: "客户" };

export function ReworkPage() {
  const { toast } = useToast();
  const { data: reworks, loading, refetch } = useAsync(() => fetchReworks(), []);
  const [createOpen, setCreateOpen] = React.useState(false);

  const handleStatusChange = React.useCallback(async (id: string, status: string) => {
    try {
      await updateRework(id, { status });
      toast("状态已更新", "success");
      refetch();
    } catch { toast("更新失败", "error"); }
  }, [toast, refetch]);

  const columns = React.useMemo<DataGridColumn<RWRow>[]>(() => [
    {
      id: "status", header: "状态", width: 90,
      sortValue: (r) => String(r.status), filterValue: (r) => STATUS_LABELS[r.status as string] ?? String(r.status),
      accessor: (r) => <span className={`orderStatus ${STATUS_CLS[r.status as string] ?? ""}`}>{STATUS_LABELS[r.status as string] ?? String(r.status)}</span>,
    },
    {
      id: "order", header: "订单", sticky: true, width: 130,
      sortValue: (r) => String((r.orders as RWRow | null)?.order_number ?? ""),
      filterValue: (r) => String((r.orders as RWRow | null)?.order_number ?? ""),
      accessor: (r) => { const o = r.orders as RWRow | null; return <span className="orderCellId">{o ? String(o.order_number ?? "—") : "—"}</span>; },
    },
    {
      id: "factory", header: "工厂", width: 130,
      sortValue: (r) => String((r.factories as RWRow | null)?.name ?? ""),
      filterValue: (r) => String((r.factories as RWRow | null)?.name ?? ""),
      accessor: (r) => { const f = r.factories as RWRow | null; return f ? String(f.name ?? "—") : "—"; },
    },
    {
      id: "qty", header: "数量", width: 80, align: "right",
      sortValue: (r) => Number(r.rework_qty ?? 0), filterValue: (r) => String(r.rework_qty ?? 0),
      accessor: (r) => `${String(r.rework_qty ?? 0)} 件`,
    },
    {
      id: "cost", header: "成本", width: 100, align: "right",
      sortValue: (r) => Number(r.cost ?? 0), filterValue: (r) => String(r.cost ?? ""),
      accessor: (r) => r.cost != null ? `¥${Number(r.cost).toLocaleString()}` : "—",
    },
    {
      id: "reason", header: "原因 / 责任",
      sortValue: (r) => String(r.rework_reason ?? ""),
      filterValue: (r) => `${r.rework_reason ?? ""} ${PARTY_LABELS[r.responsible_party as string] ?? r.responsible_party ?? ""}`,
      accessor: (r) => (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="reworkReason">{String(r.rework_reason ?? "—")}</span>
          <span className="pill">{PARTY_LABELS[r.responsible_party as string] ?? String(r.responsible_party)}责任</span>
          {r.impact_on_delivery === true && <span className="reworkDelay">延期 {String(r.delay_days ?? 0)} 天</span>}
        </div>
      ),
    },
    {
      id: "actions", header: "操作", width: 180, align: "right",
      accessor: (r) => {
        if (r.status !== "pending" && r.status !== "in_progress") return <span style={{ color: "var(--muted)" }}>—</span>;
        return (
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            {r.status === "pending" && <button className="btn" onClick={() => handleStatusChange(r.id as string, "in_progress")}>开始</button>}
            {r.status === "in_progress" && <button className="btn primary" onClick={() => handleStatusChange(r.id as string, "completed")}>完成</button>}
            <button className="btn" onClick={() => handleStatusChange(r.id as string, "waived")}>豁免</button>
          </div>
        );
      },
    },
  ], [handleStatusChange]);

  if (loading) return <PageSkeleton />;

  const list = (reworks ?? []) as RWRow[];
  const active = list.filter((r) => r.status === "pending" || r.status === "in_progress");
  const totalCost = list.reduce((s, r) => s + Number(r.cost ?? 0), 0);

  return (
    <div className="qcPage">
      <div className="todayKpiRow">
        <KpiCard label="返工单总数" value={list.length} accent />
        <KpiCard label="处理中" value={active.length} color={active.length > 0 ? "#facc15" : "#22c55e"} />
        <KpiCard label="总返工成本" value={`¥${totalCost.toLocaleString()}`} color={totalCost > 0 ? "#fb7185" : undefined} />
        <KpiCard label="影响交期" value={list.filter((r) => r.impact_on_delivery).length} color="#fb7185" />
      </div>

      <div className="card">
        <div className="cardHeader">
          <h2>返工单列表</h2>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="hint">{list.length} 单</span>
            <button className="btn primary" onClick={() => setCreateOpen(true)}>+ 新建返工</button>
          </div>
        </div>
        <DataGrid<RWRow>
          rows={list}
          columns={columns}
          rowKey={(r) => r.id as string}
          searchPlaceholder="搜索订单、工厂、原因…"
          csvFilename="返工单"
          pageSize={25}
          emptyTitle="暂无返工单"
          emptyAction={<button className="btn primary" onClick={() => setCreateOpen(true)}>+ 创建第一个返工单</button>}
        />
      </div>

      {createOpen && (
        <CreateReworkModal
          onCancel={() => setCreateOpen(false)}
          onSubmit={async (payload) => {
            try {
              await createRework(payload);
              toast("返工单已创建", "success");
              setCreateOpen(false);
              refetch();
            } catch (err) {
              toast(err instanceof Error ? err.message : "创建失败", "error");
            }
          }}
        />
      )}
    </div>
  );
}

function CreateReworkModal({ onCancel, onSubmit }: {
  onCancel: () => void;
  onSubmit: (p: Record<string, unknown>) => void | Promise<void>;
}) {
  const [orderId, setOrderId] = React.useState("");
  const [qty, setQty] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [responsibleParty, setResponsibleParty] = React.useState("factory");
  const [estDays, setEstDays] = React.useState("");
  const [cost, setCost] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!qty || Number(qty) <= 0) return;
    setSaving(true);
    await onSubmit({
      order_id: orderId.trim() || undefined,
      rework_qty: Number(qty),
      reason: reason.trim() || undefined,
      responsible_party: responsibleParty,
      estimated_days: estDays === "" ? undefined : Number(estDays),
      cost: cost === "" ? undefined : Number(cost),
    });
    setSaving(false);
  }

  const inp: React.CSSProperties = {
    width: "100%", padding: "8px 10px", marginTop: 4,
    background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 6, color: "var(--text)", fontSize: 13, fontFamily: "inherit",
  };
  const lab: React.CSSProperties = { fontSize: 12, color: "var(--muted)", display: "block" };

  return (
    <div onClick={onCancel}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000 }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        style={{ background: "#0b1220", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, padding: 24, width: 460, display: "flex", flexDirection: "column", gap: 14 }}>
        <h3 style={{ margin: 0 }}>新建返工单</h3>
        <label style={lab}>订单号<input value={orderId} onChange={(e) => setOrderId(e.target.value)} placeholder="ORD-..." style={inp} /></label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label style={lab}>返工数量 *<input required type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} style={inp} /></label>
          <label style={lab}>责任方
            <select value={responsibleParty} onChange={(e) => setResponsibleParty(e.target.value)} style={inp}>
              <option value="factory">工厂</option>
              <option value="material">物料</option>
              <option value="design">设计</option>
              <option value="customer">客户</option>
            </select>
          </label>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label style={lab}>预计天数<input type="number" min={0} value={estDays} onChange={(e) => setEstDays(e.target.value)} style={inp} /></label>
          <label style={lab}>预计成本（元）<input type="number" min={0} value={cost} onChange={(e) => setCost(e.target.value)} style={inp} /></label>
        </div>
        <label style={lab}>返工原因<textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} style={inp} /></label>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onCancel}>取消</button>
          <button type="submit" className="btn primary" disabled={saving}>{saving ? "保存中..." : "创建"}</button>
        </div>
      </form>
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
