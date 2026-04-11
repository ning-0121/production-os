import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchReworks, updateRework } from "../../services/api";
import { useToast } from "../Toast";
import { PageSkeleton } from "../Skeleton";
import "./quality.css";

const STATUS_LABELS: Record<string, string> = { pending: "待处理", in_progress: "返工中", completed: "已完成", waived: "已豁免" };
const STATUS_CLS: Record<string, string> = { pending: "statusPlanned", in_progress: "statusProgress", completed: "statusCompleted", waived: "statusCancelled" };
const PARTY_LABELS: Record<string, string> = { factory: "工厂", material: "物料", design: "设计", customer: "客户" };

export function ReworkPage() {
  const { toast } = useToast();
  const { data: reworks, loading, refetch } = useAsync(() => fetchReworks(), []);

  async function handleStatusChange(id: string, status: string) {
    try {
      await updateRework(id, { status });
      toast("状态已更新", "success");
      refetch();
    } catch { toast("更新失败", "error"); }
  }

  if (loading) return <PageSkeleton />;

  const list = (reworks ?? []) as Array<Record<string, unknown>>;
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
        <div className="cardHeader"><h2>返工单列表</h2><span className="hint">{list.length} 单</span></div>
        <div className="qcList">
          {list.length === 0 && <div className="emptyState">暂无返工单</div>}
          {list.map((rw) => {
            const order = rw.orders as Record<string, unknown> | null;
            const factory = rw.factories as Record<string, unknown> | null;
            return (
              <div key={rw.id as string} className="reworkCard">
                <div className="reworkHeader">
                  <div className="reworkLeft">
                    <span className={`orderStatus ${STATUS_CLS[rw.status as string] ?? ""}`}>{STATUS_LABELS[rw.status as string] ?? rw.status}</span>
                    <span className="orderCellId">{order ? String((order as Record<string, unknown>).order_number ?? "") : "—"}</span>
                    <span>{factory ? String((factory as Record<string, unknown>).name ?? "") : "—"}</span>
                  </div>
                  <div className="reworkRight">
                    <span>{String(rw.rework_qty ?? 0)} 件</span>
                    {rw.cost != null && <span>¥{Number(rw.cost).toLocaleString()}</span>}
                    {rw.impact_on_delivery === true && <span className="reworkDelay">延期 {String(rw.delay_days ?? 0)} 天</span>}
                  </div>
                </div>
                <div className="reworkBody">
                  <span className="reworkReason">{String(rw.rework_reason ?? "—")}</span>
                  <span className="pill">{PARTY_LABELS[rw.responsible_party as string] ?? rw.responsible_party}责任</span>
                </div>
                {(rw.status === "pending" || rw.status === "in_progress") && (
                  <div className="reworkActions">
                    {rw.status === "pending" && <button className="btn" onClick={() => handleStatusChange(rw.id as string, "in_progress")}>开始返工</button>}
                    {rw.status === "in_progress" && <button className="btn primary" onClick={() => handleStatusChange(rw.id as string, "completed")}>完成返工</button>}
                    <button className="btn" onClick={() => handleStatusChange(rw.id as string, "waived")}>豁免</button>
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
