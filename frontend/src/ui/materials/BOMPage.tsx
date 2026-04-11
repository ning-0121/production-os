import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchOrdersV2, checkMaterialReadiness } from "../../services/api";
import { useToast } from "../Toast";
import "./materials.css";

export function BOMPage() {
  const { toast } = useToast();
  const { data: orders } = useAsync(() => fetchOrdersV2({ status: "confirmed" }), []);
  const [selectedOrder, setSelectedOrder] = React.useState<string | null>(null);
  const [readiness, setReadiness] = React.useState<{ ready: boolean; critical_shortages: number; requirements: Array<Record<string, unknown>> } | null>(null);
  const [checking, setChecking] = React.useState(false);

  async function handleCheck(orderId: string) {
    setSelectedOrder(orderId);
    setChecking(true);
    try {
      const res = await checkMaterialReadiness(orderId);
      setReadiness(res);
    } catch { toast("齐套检查失败", "error"); }
    finally { setChecking(false); }
  }

  const orderList = (orders ?? []) as Array<Record<string, unknown>>;

  return (
    <div className="matPage">
      <div className="card todaySection">
        <div className="cardHeader"><h2>物料齐套检查</h2><span className="hint">选择订单 → 检查物料</span></div>
        <div className="bomOrderList">
          {orderList.length === 0 && <div className="emptyState">暂无已确认订单</div>}
          {orderList.map((o) => (
            <div key={o.id as string} className={`bomOrderCard ${selectedOrder === o.id ? "bomOrderCard--active" : ""}`} onClick={() => handleCheck(o.id as string)}>
              <span className="orderCellId">{String(o.order_number)}</span>
              <span className="pill">{String(o.product_type)}</span>
              <span>{String(o.total_qty)}件</span>
              <span style={{ color: "var(--muted)" }}>{String(o.due_date ?? "")}</span>
            </div>
          ))}
        </div>
      </div>

      {checking && <div className="loadingCenter">检查中...</div>}

      {readiness && !checking && (
        <div className="card todaySection">
          <div className="cardHeader">
            <h2>齐套结果</h2>
            <span className={`pill ${readiness.ready ? "" : "pillDanger"}`}>
              {readiness.ready ? "齐套" : `缺 ${readiness.critical_shortages} 项`}
            </span>
          </div>
          <div className="bomReqList">
            {readiness.requirements.map((r, i) => {
              const isShortage = r.status === "shortage";
              return (
                <div key={i} className={`bomReqRow ${isShortage ? "bomReqRow--shortage" : ""}`}>
                  <div className="bomReqLeft">
                    <span className="bomReqMaterial">{String(r.material_code ?? "")} {String(r.material_name ?? "")}</span>
                    {r.is_critical === true && <span className="bomCritical">关键</span>}
                  </div>
                  <div className="bomReqRight">
                    <span>需 {String(r.required_qty)}</span>
                    <span>可用 {String(r.available_qty)}</span>
                    {isShortage && <span className="bomShortage">缺 {String(r.shortage_qty)}</span>}
                    {!isShortage && <span className="bomSufficient">充足</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
