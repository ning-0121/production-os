import React from "react";
import * as XLSX from "xlsx";
import { useAsync } from "../../hooks/useAsync";
import { useToast } from "../Toast";
import {
  fetchFactories,
  fetchProductionLines,
  fetchLineSchedules,
  submitDailyReport,
  submitDailyReportsBatch,
  fetchUnreportedFactories,
  fetchDailyReportSummary,
} from "../../services/api";
import type { Factory, ProductionLine, DailyReportSummary } from "../../types";
import "./reports.css";

type Mode = "manual" | "excel";

type ImportRow = {
  date: string;
  factory_id: string;
  line_id: string;
  order_id: string;
  actual_output: number;
  stage: string;
  is_abnormal: boolean;
  abnormal_reason: string;
  _error?: string;
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function DailyReportPage() {
  const { toast } = useToast();
  const [mode, setMode] = React.useState<Mode>("manual");

  // ── Data fetching ──────────────────────────────────────
  const { data: factories } = useAsync(() => fetchFactories(), []);
  const { data: allLines } = useAsync(() => fetchProductionLines(), []);
  const { data: allSchedules } = useAsync(() => fetchLineSchedules(), []);
  const { data: unreported, refetch: refetchUnreported } = useAsync(
    () => fetchUnreportedFactories(),
    [],
  );
  const { data: summary, refetch: refetchSummary } = useAsync(
    () => fetchDailyReportSummary(),
    [],
  );

  function refreshStatus() {
    void refetchUnreported();
    void refetchSummary();
  }

  return (
    <div className="reportPage">
      {/* Unreported banner */}
      {unreported && unreported.length > 0 && (
        <div className="unreportedBanner">
          <span className="unreportedBannerIcon">!</span>
          <span className="unreportedBannerText">
            {unreported.length} 个工厂今日未报产：
            {unreported.map((f) => f.name).join("、")}
          </span>
        </div>
      )}

      {/* Summary cards */}
      <SummaryBar summary={summary} />

      {/* Mode toggle */}
      <div className="reportModeToggle">
        <button
          className={`reportModeBtn${mode === "manual" ? " active" : ""}`}
          onClick={() => setMode("manual")}
        >
          手动填报
        </button>
        <button
          className={`reportModeBtn${mode === "excel" ? " active" : ""}`}
          onClick={() => setMode("excel")}
        >
          Excel 导入
        </button>
      </div>

      {/* Content */}
      <div className="card">
        {mode === "manual" ? (
          <ManualForm
            factories={factories ?? []}
            allLines={allLines ?? []}
            allSchedules={allSchedules ?? []}
            onSuccess={refreshStatus}
          />
        ) : (
          <ExcelUpload onSuccess={refreshStatus} />
        )}
      </div>
    </div>
  );
}

// ── Summary Bar ─────────────────────────────────────────

function SummaryBar({ summary }: { summary: DailyReportSummary | null }) {
  const items = [
    { label: "今日总产出", value: summary?.total_output ?? "-", accent: true },
    { label: "已报订单数", value: summary?.orders_reported ?? "-" },
    { label: "异常数", value: summary?.abnormal_count ?? 0, danger: (summary?.abnormal_count ?? 0) > 0 },
    { label: "已报工厂数", value: summary?.factories_reported ?? "-" },
  ];

  return (
    <div className="reportSummaryBar">
      {items.map((item) => (
        <div className="reportSummaryCard" key={item.label}>
          <span className="reportSummaryLabel">{item.label}</span>
          <span
            className={`reportSummaryValue${
              item.danger ? " reportSummaryValue--danger" : item.accent ? " reportSummaryValue--accent" : ""
            }`}
          >
            {item.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Manual Entry Form ───────────────────────────────────

function ManualForm({
  factories,
  allLines,
  allSchedules,
  onSuccess,
}: {
  factories: Factory[];
  allLines: ProductionLine[];
  allSchedules: Array<{ line_id: string; allocation_id: string; production_allocations?: { order_id: string } | null }>;
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const [submitting, setSubmitting] = React.useState(false);

  const [factoryId, setFactoryId] = React.useState("");
  const [lineId, setLineId] = React.useState("");
  const [orderId, setOrderId] = React.useState("");
  const [actualOutput, setActualOutput] = React.useState("");
  const [stage, setStage] = React.useState("front");
  const [isAbnormal, setIsAbnormal] = React.useState(false);
  const [abnormalReason, setAbnormalReason] = React.useState("");
  const [note, setNote] = React.useState("");
  const [date, setDate] = React.useState(today());

  // Derived: lines for selected factory
  const factoryLines = React.useMemo(
    () => allLines.filter((l) => l.factory_id === factoryId),
    [allLines, factoryId],
  );

  // Derived: orders on the selected line
  const lineOrders = React.useMemo(() => {
    if (!lineId) return [];
    const orderIds = new Set<string>();
    const results: Array<{ allocation_id: string; order_id: string }> = [];
    for (const s of allSchedules) {
      if (s.line_id === lineId && s.production_allocations?.order_id) {
        const oid = s.production_allocations.order_id;
        if (!orderIds.has(oid)) {
          orderIds.add(oid);
          results.push({ allocation_id: s.allocation_id, order_id: oid });
        }
      }
    }
    return results;
  }, [allSchedules, lineId]);

  // Reset cascading selections
  React.useEffect(() => {
    setLineId("");
    setOrderId("");
  }, [factoryId]);
  React.useEffect(() => {
    setOrderId("");
  }, [lineId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!factoryId || !actualOutput) return;
    setSubmitting(true);
    try {
      await submitDailyReport({
        date,
        factory_id: factoryId,
        line_id: lineId || null,
        allocation_id: lineOrders.find((o) => o.order_id === orderId)?.allocation_id ?? null,
        order_id: orderId || null,
        planned_output: 0,
        actual_output: Number(actualOutput),
        cumulative_output: 0,
        stage,
        is_abnormal: isAbnormal,
        abnormal_reason: isAbnormal ? abnormalReason : null,
        note: note || null,
        reporter: null,
      });
      toast("报产提交成功", "success");
      // Reset form
      setActualOutput("");
      setIsAbnormal(false);
      setAbnormalReason("");
      setNote("");
      onSuccess();
    } catch (err) {
      toast(err instanceof Error ? err.message : "提交失败", "error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="reportForm" onSubmit={(e) => void handleSubmit(e)}>
      <div className="reportFormRow">
        <label className="orderField">
          <span className="orderFieldLabel">日期</span>
          <input
            className="orderInput"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>

        <label className="orderField">
          <span className="orderFieldLabel">工厂 *</span>
          <select
            className="orderInput"
            value={factoryId}
            onChange={(e) => setFactoryId(e.target.value)}
            required
          >
            <option value="">选择工厂</option>
            {factories.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="reportFormRow">
        <label className="orderField">
          <span className="orderFieldLabel">产线</span>
          <select
            className="orderInput"
            value={lineId}
            onChange={(e) => setLineId(e.target.value)}
            disabled={!factoryId}
          >
            <option value="">选择产线</option>
            {factoryLines.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>

        <label className="orderField">
          <span className="orderFieldLabel">订单</span>
          <select
            className="orderInput"
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            disabled={!lineId}
          >
            <option value="">选择订单</option>
            {lineOrders.map((o) => (
              <option key={o.order_id} value={o.order_id}>
                {o.order_id}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="reportFormRow">
        <label className="orderField">
          <span className="orderFieldLabel">实际产出 *</span>
          <input
            className="orderInput"
            type="number"
            min={0}
            value={actualOutput}
            onChange={(e) => setActualOutput(e.target.value)}
            placeholder="输入产出数量"
            required
          />
        </label>

        <label className="orderField">
          <span className="orderFieldLabel">工序</span>
          <select
            className="orderInput"
            value={stage}
            onChange={(e) => setStage(e.target.value)}
          >
            <option value="front">前道</option>
            <option value="back">后道</option>
          </select>
        </label>
      </div>

      <div className="reportCheckRow">
        <input
          id="isAbnormal"
          className="reportCheckbox"
          type="checkbox"
          checked={isAbnormal}
          onChange={(e) => setIsAbnormal(e.target.checked)}
        />
        <label className="reportCheckLabel" htmlFor="isAbnormal">
          存在异常
        </label>
      </div>

      {isAbnormal && (
        <label className="orderField">
          <span className="orderFieldLabel">异常原因</span>
          <input
            className="orderInput"
            value={abnormalReason}
            onChange={(e) => setAbnormalReason(e.target.value)}
            placeholder="请描述异常原因"
          />
        </label>
      )}

      <label className="orderField">
        <span className="orderFieldLabel">备注</span>
        <input
          className="orderInput"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="可选备注"
        />
      </label>

      <div className="orderActions">
        <button type="submit" className="btn primary" disabled={submitting}>
          {submitting ? "提交中..." : "提交报产"}
        </button>
      </div>
    </form>
  );
}

// ── Excel Upload ────────────────────────────────────────

function ExcelUpload({ onSuccess }: { onSuccess: () => void }) {
  const { toast } = useToast();
  const [rows, setRows] = React.useState<ImportRow[]>([]);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = new Uint8Array(evt.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

        const parsed: ImportRow[] = json.map((row) => {
          const r: ImportRow = {
            date: parseDate(row["date"] ?? row["日期"] ?? "") || today(),
            factory_id: String(row["factory_id"] ?? row["工厂"] ?? ""),
            line_id: String(row["line_id"] ?? row["产线"] ?? ""),
            order_id: String(row["order_id"] ?? row["订单号"] ?? ""),
            actual_output: Number(row["actual_output"] ?? row["实际产出"] ?? 0),
            stage: String(row["stage"] ?? row["工序"] ?? "front"),
            is_abnormal: toBool(row["is_abnormal"] ?? row["是否异常"]),
            abnormal_reason: String(row["abnormal_reason"] ?? row["异常原因"] ?? ""),
          };

          // Validate
          if (!r.factory_id) r._error = "工厂必填";
          else if (!r.actual_output || r.actual_output <= 0) r._error = "产出无效";

          return r;
        });

        setRows(parsed);
      } catch {
        toast("文件解析失败，请检查格式", "error");
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function parseDate(val: unknown): string {
    if (!val) return "";
    if (typeof val === "number") {
      const d = XLSX.SSF.parse_date_code(val);
      if (d) return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
    }
    const s = String(val);
    const d = new Date(s);
    if (isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  }

  function toBool(val: unknown): boolean {
    if (typeof val === "boolean") return val;
    if (typeof val === "number") return val !== 0;
    const s = String(val ?? "").toLowerCase();
    return s === "true" || s === "yes" || s === "1" || s === "是";
  }

  const validRows = rows.filter((r) => !r._error);
  const errorRows = rows.filter((r) => r._error);

  async function handleImport() {
    if (validRows.length === 0) return;
    setImporting(true);
    try {
      const reports = validRows.map((r) => ({
        date: r.date,
        factory_id: r.factory_id,
        line_id: r.line_id || null,
        allocation_id: null,
        order_id: r.order_id || null,
        planned_output: 0,
        actual_output: r.actual_output,
        cumulative_output: 0,
        stage: r.stage,
        is_abnormal: r.is_abnormal,
        abnormal_reason: r.is_abnormal ? r.abnormal_reason : null,
        note: null,
        reporter: null,
      }));

      const result = await submitDailyReportsBatch(reports);
      toast(
        `导入成功：${result.created} 条${result.failed > 0 ? `，失败 ${result.failed} 条` : ""}`,
        result.failed > 0 ? "warning" : "success",
      );
      setRows([]);
      setFileName(null);
      onSuccess();
    } catch (err) {
      toast(err instanceof Error ? err.message : "导入失败", "error");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="reportUploadBody">
      {/* Upload area */}
      <div className="importUpload" onClick={() => fileRef.current?.click()}>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={handleFile}
          style={{ display: "none" }}
        />
        {fileName ? (
          <span className="importFileName">{fileName}</span>
        ) : (
          <>
            <span className="importUploadIcon">+</span>
            <span>点击选择 Excel / CSV 文件</span>
          </>
        )}
      </div>

      {/* Column mapping hint */}
      <div className="importHint">
        支持列名：date/日期、factory_id/工厂、line_id/产线、order_id/订单号、actual_output/实际产出、stage/工序、is_abnormal/是否异常、abnormal_reason/异常原因
      </div>

      {/* Preview table */}
      {rows.length > 0 && (
        <>
          <div className="importSummary">
            共 {rows.length} 行 |{" "}
            <span style={{ color: "#22c55e" }}>{validRows.length} 有效</span>
            {errorRows.length > 0 && (
              <>
                {" "}
                | <span style={{ color: "var(--danger)" }}>{errorRows.length} 错误</span>
              </>
            )}
          </div>

          <div className="importTable">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>日期</th>
                  <th>工厂</th>
                  <th>产线</th>
                  <th>订单号</th>
                  <th>产出</th>
                  <th>工序</th>
                  <th>异常</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 20).map((r, i) => (
                  <tr key={i} className={r._error ? "importRowError" : ""}>
                    <td>{i + 1}</td>
                    <td>{r.date || "-"}</td>
                    <td>{r.factory_id || "-"}</td>
                    <td>{r.line_id || "-"}</td>
                    <td>{r.order_id || "-"}</td>
                    <td>{r.actual_output || "-"}</td>
                    <td>{r.stage === "front" ? "前道" : "后道"}</td>
                    <td>{r.is_abnormal ? "是" : "否"}</td>
                    <td>
                      {r._error ? (
                        <span style={{ color: "var(--danger)" }}>{r._error}</span>
                      ) : (
                        <span style={{ color: "#22c55e" }}>ok</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 20 && (
              <div className="importMore">还有 {rows.length - 20} 行未显示...</div>
            )}
          </div>
        </>
      )}

      {/* Actions */}
      <div className="orderActions">
        <button
          className="btn primary"
          disabled={importing || validRows.length === 0}
          onClick={() => void handleImport()}
        >
          {importing ? "导入中..." : `导入 ${validRows.length} 条报产`}
        </button>
      </div>
    </div>
  );
}
