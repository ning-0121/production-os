/**
 * Import Center — V5-C Production Data Gateway UI.
 *
 * Sections:
 *   1. Upload + AI column recognition + confirmation
 *   2. Import history
 *   3. Pending entity mappings (factory_name / line_name / order_no not yet matched)
 *   4. Errors + warnings
 *
 * UX principle: feel like "the system understands your file" — NOT
 * "manually configure 30 fields".
 */

import React from "react";
import * as XLSX from "xlsx";
import { useAsync } from "../../hooks/useAsync";
import {
  uploadImport, confirmImport,
  fetchImportRuns, fetchImportRun, fetchUnresolvedMappings,
  type ImportUploadResponse, type ImportRun, type ImportColumnMapping,
} from "../../services/api";
import { useToast } from "../Toast";
import "./imports.css";

const INTERNAL_FIELD_LABELS: Record<string, string> = {
  date: "日期", factory_name: "工厂", line_name: "产线", order_no: "订单号",
  product_type: "品类", operator: "报工人", shift: "班次", note: "备注",
  planned_output: "计划产量", actual_output: "实际产量", cumulative_output: "累计产量",
  stage: "工序", is_abnormal: "异常", abnormal_reason: "异常原因",
  pieces_per_hour: "小时产量", operation_code: "工序号",
  inspection_type: "验货类型", total_qty_inspected: "抽检数量", total_defects: "不良数",
  result: "验货结果", defect_code: "缺陷代码", severity: "严重度",
  rework_qty: "返工数量", rework_reason: "返工原因", responsible_party: "责任方",
  estimated_days: "预计天数", cost: "成本",
};

const TYPE_LABELS: Record<string, string> = {
  daily_report: "日报", hanging_line: "吊挂产出", qc: "验货", rework: "返工", generic: "通用",
};

const STATUS_LABELS: Record<string, string> = {
  parsing: "解析中", awaiting_confirmation: "待确认",
  committing: "提交中", completed: "完成", partial: "部分完成",
  failed: "失败", rolled_back: "已回滚",
};

export function ImportCenterPage() {
  const [tab, setTab] = React.useState<"upload" | "history" | "unresolved">("upload");
  const [previewRunId, setPreviewRunId] = React.useState<string | null>(null);

  return (
    <div className="impPage">
      <div className="impHeader">
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>数据网关</h1>
          <div className="hint">
            上传工厂任意 Excel 报表（吊挂系统 / ERP / 主管手填）— 系统自动识别字段并接入运行时大脑
          </div>
        </div>
      </div>

      <div className="impTabs">
        <button className={`impTab ${tab === "upload" ? "impTab--active" : ""}`} onClick={() => setTab("upload")}>
          上传识别
        </button>
        <button className={`impTab ${tab === "history" ? "impTab--active" : ""}`} onClick={() => setTab("history")}>
          导入历史
        </button>
        <button className={`impTab ${tab === "unresolved" ? "impTab--active" : ""}`} onClick={() => setTab("unresolved")}>
          待解析映射
        </button>
      </div>

      {tab === "upload" && (
        previewRunId
          ? <ConfirmationPanel runId={previewRunId} onDone={() => { setPreviewRunId(null); }} />
          : <UploadPanel onUploaded={setPreviewRunId} />
      )}
      {tab === "history" && <HistoryPanel />}
      {tab === "unresolved" && <UnresolvedPanel />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// 1. Upload Panel
// ════════════════════════════════════════════════════════════

function UploadPanel({ onUploaded }: { onUploaded: (runId: string) => void }) {
  const { toast } = useToast();
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setError(null);
    setUploading(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array", cellDates: true });
      const sheetName = wb.SheetNames[0];
      const sheet = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: false });
      if (rows.length === 0) throw new Error("Excel 没有数据");

      const headers = Object.keys(rows[0]);
      const result = await uploadImport({
        filename: file.name,
        file_size_bytes: file.size,
        sheet_name: sheetName,
        headers,
        rows: rows.slice(0, 5000),
      });
      toast(`已识别 ${result.recognition.mappings.filter(m => m.internal_field).length}/${headers.length} 字段`, "success");
      onUploaded(result.run_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast(`上传失败：${msg}`, "error");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  return (
    <div className="card impUploadPanel" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="impUploadInner">
        <div style={{ fontSize: 36, marginBottom: 12 }}>📁</div>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>拖入 Excel 文件，或点击选择</div>
        <div className="hint" style={{ marginBottom: 18 }}>
          支持任意列名（中英文都行）和列顺序。常见格式：日报 / 吊挂产出 / 验货 / 返工
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />
        <button className="btn primary" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
          {uploading ? "解析中..." : "选择文件"}
        </button>
        {error && <div style={{ marginTop: 14, color: "var(--danger)", fontSize: 13 }}>{error}</div>}
      </div>

      <div className="impUploadHints">
        <div className="impHintItem"><strong>🤖 AI 自动识别</strong>列名（"今日产量"、"Qty Today"、"日产量" 都认）</div>
        <div className="impHintItem"><strong>👁 预览确认</strong>识别不准的字段，你点一下改</div>
        <div className="impHintItem"><strong>🔗 自动入库</strong>+ 触发运行时事件 + AI 分析</div>
        <div className="impHintItem"><strong>📚 系统学习</strong>，下次同样文件秒识别</div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// 2. Confirmation Panel (after upload, before commit)
// ════════════════════════════════════════════════════════════

function ConfirmationPanel({ runId, onDone }: { runId: string; onDone: () => void }) {
  const { toast } = useToast();
  const { data, loading, error } = useAsync(() => fetchImportRun(runId), [runId]);
  const [mappings, setMappings] = React.useState<ImportColumnMapping[] | null>(null);
  const [committing, setCommitting] = React.useState(false);

  React.useEffect(() => {
    if (data?.run?.column_mappings) {
      setMappings(data.run.column_mappings as unknown as ImportColumnMapping[]);
    }
  }, [data]);

  if (loading || !data) return <div className="card"><div className="loadingCenter" style={{ padding: 32 }}>加载中...</div></div>;
  if (error) return <div className="card"><div style={{ padding: 16, color: "var(--danger)" }}>{error}</div></div>;

  const run = data.run;
  const previewRows = data.rows.slice(0, 8);
  const errorCount = data.errors.filter((e) => e.severity === "error").length;
  const warningCount = data.errors.filter((e) => e.severity === "warning").length;

  function updateMapping(header: string, internalField: string | null) {
    setMappings((prev) => (prev ?? []).map((m) =>
      m.external_header === header ? { ...m, internal_field: internalField } : m,
    ));
  }

  async function handleCommit() {
    if (!mappings) return;
    setCommitting(true);
    try {
      const result = await confirmImport(runId, {
        column_mappings: mappings.map((m) => ({ external_header: m.external_header, internal_field: m.internal_field })),
      });
      toast(`已导入 ${result.committed} 条，触发 ${result.events_emitted} 个运行时事件`, "success");
      onDone();
    } catch (err) {
      toast(err instanceof Error ? err.message : "提交失败", "error");
    } finally {
      setCommitting(false);
    }
  }

  const allInternalFields = Object.keys(INTERNAL_FIELD_LABELS);

  return (
    <div className="impConfirmWrap">
      <div className="card">
        <div className="cardHeader">
          <div>
            <h3 style={{ margin: 0 }}>{run.filename ?? "Excel 文件"}</h3>
            <div className="hint">
              检测为 <strong>{TYPE_LABELS[run.import_type]}</strong> ·
              共 {run.total_rows} 行 ·
              <span style={{ color: errorCount > 0 ? "var(--danger)" : "var(--muted)" }}> {errorCount} 错误</span> ·
              <span style={{ color: warningCount > 0 ? "#facc15" : "var(--muted)" }}> {warningCount} 警告</span>
            </div>
          </div>
          <button className="btn" onClick={onDone}>取消</button>
        </div>
      </div>

      {/* Column mappings */}
      <div className="card">
        <div className="cardHeader">
          <h3 style={{ margin: 0 }}>字段映射</h3>
          <span className="hint">绿色 = 高置信，黄色 = 待确认，灰色 = 未映射</span>
        </div>
        <div className="impMappingGrid">
          {(mappings ?? []).map((m) => (
            <div key={m.external_header} className={`impMappingRow ${
              !m.internal_field ? "impMappingRow--unmapped"
              : m.auto_accepted ? "impMappingRow--auto" : "impMappingRow--manual"
            }`}>
              <div className="impMappingExternal">
                <div className="impMappingLabel">外部列</div>
                <div className="impMappingValue">{m.external_header}</div>
              </div>
              <div className="impMappingArrow">→</div>
              <div className="impMappingInternal">
                <div className="impMappingLabel">
                  内部字段
                  {m.confidence > 0 && (
                    <span className="impConfidence"> {Math.round(m.confidence * 100)}%</span>
                  )}
                </div>
                <select
                  value={m.internal_field ?? ""}
                  onChange={(e) => updateMapping(m.external_header, e.target.value || null)}
                >
                  <option value="">— 忽略 —</option>
                  {allInternalFields.map((f) => (
                    <option key={f} value={f}>{INTERNAL_FIELD_LABELS[f]} ({f})</option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Preview */}
      <div className="card">
        <div className="cardHeader">
          <h3 style={{ margin: 0 }}>数据预览（前 8 行）</h3>
          <span className="hint">提交前最后审核</span>
        </div>
        <div style={{ overflow: "auto" }}>
          <table className="impPreviewTable">
            <thead>
              <tr>
                <th>#</th>
                <th>状态</th>
                {mappings?.filter((m) => m.internal_field).map((m) => (
                  <th key={m.external_header}>
                    {INTERNAL_FIELD_LABELS[m.internal_field!] ?? m.internal_field}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {previewRows.map((row) => (
                <tr key={row.id} className={`impPreviewRow--${row.status}`}>
                  <td>{row.row_number}</td>
                  <td>
                    <span className={`impStatusPill impStatusPill--${row.status}`}>
                      {row.status === "rejected" ? "拒绝"
                        : row.status === "warning" ? "警告"
                        : row.status === "skipped_duplicate" ? "重复"
                        : "OK"}
                    </span>
                  </td>
                  {mappings?.filter((m) => m.internal_field).map((m) => {
                    const v = (row.normalized as Record<string, unknown>)[m.internal_field!];
                    return <td key={m.external_header}>{v == null || v === "" ? "—" : String(v)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Errors */}
      {data.errors.length > 0 && (
        <div className="card">
          <div className="cardHeader">
            <h3 style={{ margin: 0 }}>数据质量提示</h3>
            <span className="hint">{data.errors.length} 条</span>
          </div>
          <div className="impErrorList">
            {data.errors.slice(0, 30).map((e) => (
              <div key={e.id} className={`impErrorRow impErrorRow--${e.severity}`}>
                <span className="impErrorCode">{e.code}</span>
                <span className="impErrorMsg">{e.message}</span>
                {(e.details?.row_number != null) && <span className="impErrorRowNum">行 {String(e.details.row_number)}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Commit */}
      <div className="card impCommitBar">
        <div>
          <div className="hint">确认后将写入目标表 + 触发运行时事件</div>
          {errorCount > 0 && (
            <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 4 }}>
              ⚠ {errorCount} 行有错误会被自动跳过
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={onDone} disabled={committing}>取消</button>
          <button className="btn primary" onClick={handleCommit} disabled={committing}>
            {committing ? "提交中..." : `确认导入 ${run.total_rows - errorCount} 行`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// 3. History Panel
// ════════════════════════════════════════════════════════════

function HistoryPanel() {
  const { data, loading, error } = useAsync(() => fetchImportRuns(50), []);
  const [openId, setOpenId] = React.useState<string | null>(null);

  if (loading) return <div className="card"><div className="loadingCenter" style={{ padding: 24 }}>加载中...</div></div>;
  if (error) return <div className="card"><div style={{ padding: 16, color: "var(--danger)" }}>{error}</div></div>;
  const runs = data?.runs ?? [];
  if (runs.length === 0) {
    return <div className="card emptyState" style={{ padding: 48, textAlign: "center" }}>暂无导入历史 — 上传第一个 Excel 试试</div>;
  }

  return (
    <div className="impHistoryWrap">
      {runs.map((r) => (
        <RunRow key={r.id} run={r} expanded={openId === r.id} onToggle={() => setOpenId(openId === r.id ? null : r.id)} />
      ))}
    </div>
  );
}

function RunRow({ run, expanded, onToggle }: { run: ImportRun; expanded: boolean; onToggle: () => void }) {
  const summary = (run.summary ?? {}) as Record<string, unknown>;
  const committed = Number(summary.committed ?? 0);
  const errors = Number(summary.commit_errors ?? summary.preview_errors ?? 0);
  const events = Number(summary.events_emitted ?? 0);

  return (
    <div className={`card impRunCard impRunCard--${run.status}`} onClick={onToggle}>
      <div className="impRunHeader">
        <div className="impRunHeaderLeft">
          <span className={`impRunStatus impRunStatus--${run.status}`}>{STATUS_LABELS[run.status]}</span>
          <span className="impRunFilename">{run.filename ?? "—"}</span>
          <span className="hint">{TYPE_LABELS[run.import_type]}</span>
        </div>
        <div className="impRunHeaderRight">
          <span>{run.total_rows} 行</span>
          {committed > 0 && <span style={{ color: "#22c55e" }}>✓ {committed}</span>}
          {errors > 0 && <span style={{ color: "var(--danger)" }}>✗ {errors}</span>}
          {events > 0 && <span style={{ color: "var(--accent)" }}>⚡ {events}</span>}
          <span className="hint">{new Date(run.started_at).toLocaleString()}</span>
        </div>
      </div>
      {expanded && (
        <div className="impRunDetail">
          <pre style={{ background: "rgba(0,0,0,.3)", padding: 12, borderRadius: 6, fontSize: 11, overflow: "auto" }}>
            {JSON.stringify(run.summary, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// 4. Unresolved Mappings Panel
// ════════════════════════════════════════════════════════════

function UnresolvedPanel() {
  const { data, loading, error } = useAsync(() => fetchUnresolvedMappings(), []);

  if (loading) return <div className="card"><div className="loadingCenter" style={{ padding: 24 }}>加载中...</div></div>;
  if (error) return <div className="card"><div style={{ padding: 16, color: "var(--danger)" }}>{error}</div></div>;
  const items = data?.items ?? [];
  if (items.length === 0) {
    return <div className="card emptyState" style={{ padding: 48, textAlign: "center" }}>✓ 没有待解析的映射 — 所有外部值都匹配到了内部实体</div>;
  }

  return (
    <div className="card">
      <div className="cardHeader">
        <h3 style={{ margin: 0 }}>待解析映射</h3>
        <span className="hint">导入时未匹配到内部实体的外部值，在这里手动关联</span>
      </div>
      <table className="impUnresolvedTable">
        <thead>
          <tr>
            <th>外部字段</th><th>外部值</th><th>出现次数</th><th>建议匹配</th><th>状态</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id}>
              <td>{it.external_field}</td>
              <td><strong>{it.external_value}</strong></td>
              <td>{it.occurrences}</td>
              <td>
                {Array.isArray(it.suggested_matches) && it.suggested_matches.length > 0
                  ? it.suggested_matches.map((s) => (s as { label?: string }).label ?? "—").join("、")
                  : <span className="hint">无建议</span>}
              </td>
              <td><span className="hint">{it.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
