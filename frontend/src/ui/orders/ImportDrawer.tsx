import React from "react";
import * as XLSX from "xlsx";
import { useToast } from "../Toast";
import { request } from "../../services/client";
import "./orders.css";

type ImportRow = {
  product_type: string;
  quantity: number;
  end_at: string;
  priority?: number;
  order_external_id?: string;
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
            product_type: String(row["product_type"] ?? row["产品类型"] ?? row["产品"] ?? ""),
            quantity: Number(row["quantity"] ?? row["数量"] ?? 0),
            end_at: parseDate(row["end_at"] ?? row["交货日期"] ?? row["交期"] ?? ""),
            priority: Number(row["priority"] ?? row["优先级"] ?? 0),
            order_external_id: String(row["order_external_id"] ?? row["外部订单号"] ?? row["订单号"] ?? ""),
          };

          // Validate
          if (!r.product_type) r._error = "缺少产品类型";
          else if (!r.quantity || r.quantity <= 0) r._error = "数量无效";
          else if (!r.end_at) r._error = "交货日期无效";

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
        product_type: r.product_type,
        quantity: r.quantity,
        end_at: new Date(r.end_at).toISOString(),
        priority: r.priority ?? 0,
        order_external_id: r.order_external_id || undefined,
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
            支持列名：product_type/产品类型、quantity/数量、end_at/交货日期、priority/优先级、order_external_id/订单号
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
                      <th>产品类型</th>
                      <th>数量</th>
                      <th>交货日期</th>
                      <th>优先级</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 20).map((r, i) => (
                      <tr key={i} className={r._error ? "importRowError" : ""}>
                        <td>{i + 1}</td>
                        <td>{r.product_type || "-"}</td>
                        <td>{r.quantity || "-"}</td>
                        <td>{r.end_at || "-"}</td>
                        <td>{r.priority ?? 0}</td>
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
