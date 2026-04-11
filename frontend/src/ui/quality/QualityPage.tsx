import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchQCInspections, fetchReworks } from "../../services/api";
import { PageSkeleton } from "../Skeleton";
import "./quality.css";

const TYPE_LABELS: Record<string, string> = { pp_sample: "产前样", shipping_sample: "船样", inline: "中查", final: "终查", third_party: "第三方" };
const RESULT_CLS: Record<string, string> = { pass: "qcPass", fail: "qcFail", conditional: "qcConditional", pending: "qcPending" };
const RESULT_LABELS: Record<string, string> = { pass: "合格", fail: "不合格", conditional: "有条件放行", pending: "待验" };

export function QualityPage() {
  const { data: inspections, loading } = useAsync(() => fetchQCInspections(), []);
  const { data: reworks } = useAsync(() => fetchReworks("pending"), []);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  if (loading) return <PageSkeleton />;

  const inspList = (inspections ?? []) as Array<Record<string, unknown>>;
  const reworkList = (reworks ?? []) as Array<Record<string, unknown>>;
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
        <div className="cardHeader"><h2>验货记录</h2><span className="hint">{totalInsp} 条</span></div>
        <div className="qcList">
          {inspList.length === 0 && <div className="emptyState">暂无验货记录</div>}
          {inspList.map((insp) => {
            const isExp = expanded === (insp.id as string);
            const order = insp.orders as Record<string, unknown> | null;
            const factory = insp.factories as Record<string, unknown> | null;
            const defects = (insp.qc_defects ?? []) as Array<Record<string, unknown>>;
            return (
              <div key={insp.id as string} className={`qcCard ${isExp ? "qcCard--expanded" : ""}`} onClick={() => setExpanded(isExp ? null : insp.id as string)}>
                <div className="qcCardHeader">
                  <div className="qcCardLeft">
                    <span className={`qcResult ${RESULT_CLS[insp.result as string] ?? ""}`}>{RESULT_LABELS[insp.result as string] ?? insp.result}</span>
                    <span className="qcType">{TYPE_LABELS[insp.inspection_type as string] ?? insp.inspection_type}</span>
                    <span className="qcOrder">{order ? String((order as Record<string, unknown>).order_number ?? "") : "—"}</span>
                  </div>
                  <div className="qcCardRight">
                    <span>{factory ? String((factory as Record<string, unknown>).name ?? "") : "—"}</span>
                    <span className="qcDate">{String(insp.inspection_date ?? "")}</span>
                    <span className={`qcRate ${Number(insp.defect_rate_pct ?? 0) > 5 ? "qcRate--bad" : ""}`}>{String(insp.defect_rate_pct ?? 0)}%</span>
                    <span className="factoryToggle">{isExp ? "▼" : "▶"}</span>
                  </div>
                </div>
                {isExp && defects.length > 0 && (
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
