import React from "react";
import * as XLSX from "xlsx";
import { useToast } from "../Toast";
import { request } from "../../services/client";
import "./orders.css";

type ImportRow = {
  quantity: number;
  end_date: string;
  order_id?: string;
  _error?: string;
};

type Props = {
  onClose: () => void;
  onImported: () => void;
};

export function ImportDrawer({ onClose, onImported }: Props) {
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
            quantity: Number(row["quantity"] ?? row["数量"] ?? row["allocated_qty"] ?? 0),
            end_date: parseDate(row["end_date"] ?? row["end_at"] ?? row["planned_end_date"] ?? row["交货日期"] ?? row["交期"] ?? ""),
            order_id: String(row["order_id"] ?? row["order_external_id"] ?? row["外部订单号"] ?? row["订单号"] ?? ""),
          };

          // Validate
          if (!r.quantity || r.quantity <= 0) r._error = "数量无效";
          else if (!r.end_date) r._error = "交货日期无效";

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
      // Excel serial date
      const d = XLSX.SSF.parse_date_code(val);
      if (d) return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
    }
    const s = String(val);
    const d = new Date(s);
    if (isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  }

  const validRows = rows.filter((r) => !r._error);
  const errorRows = rows.filter((r) => r._error);

  async function handleImport() {
    if (validRows.length === 0) return;
    setImporting(true);
    try {
      const orders = validRows.map((r) => ({
        quantity: r.quantity,
        end_date: new Date(r.end_date).toISOString(),
        order_id: r.order_id || undefined,
      }));

      const result = await request<{ created: number; failed: number; errors?: string[] }>(
        "/import/orders",
        { method: "POST", body: JSON.stringify({ orders }) },
      );

      toast(`导入成功：${result.created} 条${result.failed > 0 ? `，失败 ${result.failed} 条` : ""}`, result.failed > 0 ? "warning" : "success");
      onImported();
    } catch (err) {
      toast(err instanceof Error ? err.message : "导入失败", "error");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="drawerOverlay" onClick={onClose}>
      <div className="drawer importDrawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawerHeader">
          <h3>批量导入订单</h3>
          <button className="drawerClose" onClick={onClose}>x</button>
        </div>

        <div className="importBody">
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
            支持列名：quantity/数量/allocated_qty、end_date/planned_end_date/交货日期、order_id/订单号
          </div>

          {/* Preview table */}
          {rows.length > 0 && (
            <>
              <div className="importSummary">
                共 {rows.length} 行 | <span style={{ color: "#22c55e" }}>{validRows.length} 有效</span>
                {errorRows.length > 0 && <> | <span style={{ color: "var(--danger)" }}>{errorRows.length} 错误</span></>}
              </div>

              <div className="importTable">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>数量</th>
                      <th>交货日期</th>
                      <th>订单号</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 20).map((r, i) => (
                      <tr key={i} className={r._error ? "importRowError" : ""}>
                        <td>{i + 1}</td>
                        <td>{r.quantity || "-"}</td>
                        <td>{r.end_date || "-"}</td>
                        <td>{r.order_id || "-"}</td>
                        <td>{r._error ? <span style={{ color: "var(--danger)" }}>{r._error}</span> : <span style={{ color: "#22c55e" }}>ok</span>}</td>
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
            <button type="button" className="btn" onClick={onClose}>取消</button>
            <button
              className="btn primary"
              disabled={importing || validRows.length === 0}
              onClick={() => void handleImport()}
            >
              {importing ? "导入中..." : `导入 ${validRows.length} 条订单`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
