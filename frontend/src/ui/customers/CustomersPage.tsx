/**
 * CustomersPage — minimal CRUD so factory managers can register customers
 * before creating orders. Form is intentionally simple; full CRM features
 * come later.
 */

import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchCustomers, createCustomer, updateCustomer, deleteCustomer, type Customer } from "../../services/api";
import { useToast } from "../Toast";
import { PageSkeleton } from "../Skeleton";

const VIP_LABEL: Record<Customer["vip_level"], string> = {
  platinum: "白金", gold: "金牌", silver: "银牌", standard: "标准",
};
const RISK_LABEL: Record<Customer["risk_level"], string> = { low: "低", medium: "中", high: "高" };

export function CustomersPage() {
  const { toast } = useToast();
  const [q, setQ] = React.useState("");
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Customer | null>(null);

  const { data, loading, error } = useAsync(
    () => fetchCustomers({ q: q || undefined }),
    [q, refreshKey],
  );
  const customers = Array.isArray(data) ? data : [];

  function openCreate() { setEditing(null); setDrawerOpen(true); }
  function openEdit(c: Customer) { setEditing(c); setDrawerOpen(true); }

  async function handleDelete(c: Customer) {
    if (!confirm(`确认删除客户「${c.name}」？`)) return;
    try {
      await deleteCustomer(c.id);
      toast("已删除", "success");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? err.message : "删除失败", "error");
    }
  }

  if (loading && customers.length === 0) return <PageSkeleton />;

  return (
    <div className="custPage">
      <div className="cardHeader" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>客户管理</h2>
          <div className="hint">{customers.length} 个客户</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="search"
            placeholder="搜索代码 / 名称"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ padding: "6px 12px", borderRadius: 6, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.12)", color: "var(--text)" }}
          />
          <button className="btn primary" onClick={openCreate}>+ 新建客户</button>
        </div>
      </div>

      {error && <div style={{ padding: 16, color: "var(--danger)" }}>加载失败：{error}</div>}

      {!error && customers.length === 0 && (
        <div className="card" style={{ padding: 40, textAlign: "center" }}>
          <div style={{ fontSize: 14, color: "var(--muted)", marginBottom: 12 }}>
            还没有客户。新订单需要先选客户。
          </div>
          <button className="btn primary" onClick={openCreate}>+ 创建第一个客户</button>
        </div>
      )}

      {customers.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: "auto" }}>
          <table className="custTable">
            <thead>
              <tr>
                <th>代码</th><th>名称</th><th>国家</th><th>VIP</th><th>风险</th>
                <th style={{ textAlign: "right" }}>本年订单</th>
                <th style={{ textAlign: "right" }}>本年收入</th>
                <th>付款</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.code}</strong></td>
                  <td>{c.name}</td>
                  <td>{c.country ?? "—"}</td>
                  <td><span className={`vipBadge vipBadge--${c.vip_level}`}>{VIP_LABEL[c.vip_level]}</span></td>
                  <td><span className={`riskBadge riskBadge--${c.risk_level}`}>{RISK_LABEL[c.risk_level]}</span></td>
                  <td style={{ textAlign: "right" }}>{c.total_orders_ytd}</td>
                  <td style={{ textAlign: "right" }}>¥{Number(c.total_revenue_ytd).toLocaleString()}</td>
                  <td>{c.payment_terms ?? "—"}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="btn" onClick={() => openEdit(c)}>编辑</button>
                    <button className="btn" style={{ marginLeft: 6, color: "var(--danger)" }} onClick={() => handleDelete(c)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {drawerOpen && (
        <CustomerDrawer
          customer={editing}
          onClose={() => setDrawerOpen(false)}
          onSaved={() => { setDrawerOpen(false); setRefreshKey((k) => k + 1); }}
        />
      )}

      <style>{`
        .custTable { width: 100%; border-collapse: collapse; font-size: 13px; }
        .custTable th { text-align: left; padding: 10px 12px; color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .4px; border-bottom: 1px solid rgba(255,255,255,.08); }
        .custTable td { padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,.05); }
        .custTable tbody tr:hover { background: rgba(255,255,255,.03); }
        .vipBadge { font-size: 10px; padding: 2px 7px; border-radius: 3px; font-weight: 600; }
        .vipBadge--platinum { background: rgba(196,181,253,.18); color: #c4b5fd; }
        .vipBadge--gold { background: rgba(250,204,21,.18); color: #facc15; }
        .vipBadge--silver { background: rgba(148,163,184,.18); color: #cbd5e1; }
        .vipBadge--standard { background: rgba(255,255,255,.06); color: var(--muted); }
        .riskBadge { font-size: 10px; padding: 2px 7px; border-radius: 3px; }
        .riskBadge--low { background: rgba(34,197,94,.18); color: #22c55e; }
        .riskBadge--medium { background: rgba(250,204,21,.18); color: #facc15; }
        .riskBadge--high { background: rgba(251,113,133,.18); color: #fb7185; }
      `}</style>
    </div>
  );
}

function CustomerDrawer({ customer, onClose, onSaved }: {
  customer: Customer | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState({
    code: customer?.code ?? "",
    name: customer?.name ?? "",
    country: customer?.country ?? "",
    vip_level: (customer?.vip_level ?? "standard") as Customer["vip_level"],
    risk_level: (customer?.risk_level ?? "low") as Customer["risk_level"],
    payment_terms: customer?.payment_terms ?? "",
    credit_limit: customer?.credit_limit ?? "",
    payment_cycle_days: customer?.payment_cycle_days ?? "",
    notes: customer?.notes ?? "",
  });

  function set<K extends keyof typeof form>(k: K, v: typeof form[K]) { setForm((f) => ({ ...f, [k]: v })); }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.code.trim() || !form.name.trim()) {
      toast("代码和名称必填", "error");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        code: form.code.trim(),
        name: form.name.trim(),
        country: form.country.trim() || undefined,
        vip_level: form.vip_level,
        risk_level: form.risk_level,
        payment_terms: form.payment_terms.trim() || undefined,
        credit_limit: form.credit_limit === "" ? undefined : Number(form.credit_limit),
        payment_cycle_days: form.payment_cycle_days === "" ? undefined : Number(form.payment_cycle_days),
        notes: form.notes.trim() || undefined,
      };
      if (customer) {
        const { code: _drop, ...patch } = payload;
        await updateCustomer(customer.id, patch);
        toast("已更新", "success");
      } else {
        await createCustomer(payload);
        toast("已创建", "success");
      }
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : "保存失败", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="drawerBackdrop" onClick={onClose}>
      <div className="drawerPanel" onClick={(e) => e.stopPropagation()}>
        <div className="cardHeader">
          <h3 style={{ margin: 0 }}>{customer ? `编辑客户：${customer.name}` : "新建客户"}</h3>
          <button className="btn" onClick={onClose}>关闭 ×</button>
        </div>
        <form onSubmit={submit} className="drawerForm">
          <Field label="客户代码 *" hint={customer ? "代码不可改" : "唯一，例：CUS-001"}>
            <input value={form.code} onChange={(e) => set("code", e.target.value)} disabled={!!customer} required maxLength={64} />
          </Field>
          <Field label="客户名称 *">
            <input value={form.name} onChange={(e) => set("name", e.target.value)} required maxLength={200} />
          </Field>
          <div className="drawerRow">
            <Field label="国家 / 地区"><input value={form.country} onChange={(e) => set("country", e.target.value)} /></Field>
            <Field label="付款条件" hint="例：Net 30, 现结"><input value={form.payment_terms} onChange={(e) => set("payment_terms", e.target.value)} /></Field>
          </div>
          <div className="drawerRow">
            <Field label="VIP 等级">
              <select value={form.vip_level} onChange={(e) => set("vip_level", e.target.value as Customer["vip_level"])}>
                <option value="standard">标准</option><option value="silver">银牌</option>
                <option value="gold">金牌</option><option value="platinum">白金</option>
              </select>
            </Field>
            <Field label="风险等级">
              <select value={form.risk_level} onChange={(e) => set("risk_level", e.target.value as Customer["risk_level"])}>
                <option value="low">低</option><option value="medium">中</option><option value="high">高</option>
              </select>
            </Field>
          </div>
          <div className="drawerRow">
            <Field label="信用额度（元）"><input type="number" min={0} value={form.credit_limit} onChange={(e) => set("credit_limit", e.target.value)} /></Field>
            <Field label="账期天数"><input type="number" min={0} max={365} value={form.payment_cycle_days} onChange={(e) => set("payment_cycle_days", e.target.value)} /></Field>
          </div>
          <Field label="备注">
            <textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={3} maxLength={2000} />
          </Field>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
            <button type="button" className="btn" onClick={onClose}>取消</button>
            <button type="submit" className="btn primary" disabled={saving}>{saving ? "保存中..." : customer ? "保存修改" : "创建客户"}</button>
          </div>
        </form>

        <style>{`
          .drawerBackdrop { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex; justify-content: flex-end; z-index: 1000; }
          .drawerPanel { width: 520px; max-width: 100%; background: #0b1220; border-left: 1px solid rgba(255,255,255,.1); padding: 20px; overflow-y: auto; }
          .drawerForm { display: flex; flex-direction: column; gap: 14px; margin-top: 16px; }
          .drawerRow { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
          .drawerForm input, .drawerForm select, .drawerForm textarea {
            width: 100%; padding: 8px 10px; background: rgba(255,255,255,.05);
            border: 1px solid rgba(255,255,255,.12); border-radius: 6px;
            color: var(--text); font-size: 13px; font-family: inherit;
          }
          .drawerForm input:focus, .drawerForm select:focus, .drawerForm textarea:focus {
            outline: none; border-color: var(--accent); background: rgba(255,255,255,.07);
          }
          .drawerForm input:disabled { opacity: .5; cursor: not-allowed; }
          .fieldLabel { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
          .fieldHint { font-size: 10px; color: var(--muted); margin-top: 2px; }
        `}</style>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label>
      <div className="fieldLabel">{label}</div>
      {children}
      {hint && <div className="fieldHint">{hint}</div>}
    </label>
  );
}
