import React from "react";
import { CommandPage } from "./command/CommandPage";
import { SchedulePage } from "./schedule/SchedulePage";
import { DailyReportPage } from "./reports/DailyReportPage";
import { ExceptionPage } from "./exceptions/ExceptionPage";
import { FactoriesPage } from "./factories/FactoriesPage";
import { LoginPage } from "./auth/LoginPage";
import { ErrorBoundary } from "./ErrorBoundary";
import { ToastProvider } from "./Toast";
import { runRiskScan, checkHealth, runVerification } from "../services/api";
import { isPilotMode, getPilotLabel } from "../services/pilot";
import { getAuditLog, getAuditSummary, downloadAuditLog } from "../services/audit";
import { supabase, logout, getSession, parseUser } from "../services/auth";
import type { AuthUser } from "../services/auth";
import type { ApiHealth, VerificationResult } from "../services/api";
import type { RiskLevel } from "../types";
import type { AuditEntry } from "../services/audit";

import "./auth/login.css";

type TabKey = "command" | "schedule" | "reports" | "exceptions" | "factories";

const tabs: { key: TabKey; label: string }[] = [
  { key: "command", label: "指挥中心" },
  { key: "schedule", label: "排产计划" },
  { key: "reports", label: "日报中心" },
  { key: "exceptions", label: "异常中心" },
  { key: "factories", label: "工厂管理" },
];

type RiskCounts = { HIGH: number; MEDIUM: number; SAFE: number; total: number };

export function App() {
  const [authReady, setAuthReady] = React.useState(false);
  const [user, setUser] = React.useState<AuthUser | null>(null);

  // Check session on mount
  React.useEffect(() => {
    getSession().then((session) => {
      if (session) setUser(parseUser(session));
      setAuthReady(true);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        setUser(parseUser(session));
      } else {
        setUser(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  if (!authReady) {
    return (
      <div className="container" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
        <div style={{ color: "var(--muted)", fontSize: 14 }}>加载中...</div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage onLogin={() => {}} />;
  }

  return (
    <ErrorBoundary>
      <ToastProvider>
        <MainApp user={user} />
      </ToastProvider>
    </ErrorBoundary>
  );
}

// ── Main App (after auth) ──────────────────────────────

function MainApp({ user }: { user: AuthUser }) {
  const [tab, setTab] = React.useState<TabKey>("command");
  const [risk, setRisk] = React.useState<RiskCounts | null>(null);
  const [riskError, setRiskError] = React.useState(false);
  const [apiHealth, setApiHealth] = React.useState<ApiHealth | null>(null);
  const [showVerify, setShowVerify] = React.useState(false);
  const [verification, setVerification] = React.useState<VerificationResult | null>(null);
  const [verifying, setVerifying] = React.useState(false);
  const [showAudit, setShowAudit] = React.useState(false);
  const [auditEntries, setAuditEntries] = React.useState<AuditEntry[]>([]);
  const [loggingOut, setLoggingOut] = React.useState(false);

  const pilotLabel = getPilotLabel();

  React.useEffect(() => {
    checkHealth().then((health) => {
      setApiHealth(health);
      if (health.ok) {
        runRiskScan()
          .then((res) => setRisk({ ...res.summary, total: res.scanned }))
          .catch(() => setRiskError(true));
      }
    });
  }, []);

  // Triple-click logo to open verification panel
  const clickCount = React.useRef(0);
  const clickTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  function onLogoClick() {
    clickCount.current++;
    clearTimeout(clickTimer.current);
    if (clickCount.current >= 3) {
      clickCount.current = 0;
      setShowVerify((v) => !v);
    } else {
      clickTimer.current = setTimeout(() => { clickCount.current = 0; }, 500);
    }
  }

  async function handleRunVerification() {
    setVerifying(true);
    setVerification(null);
    const result = await runVerification();
    setVerification(result);
    setVerifying(false);
  }

  function refreshAuditLog() {
    setAuditEntries(getAuditLog());
  }

  async function handleLogout() {
    setLoggingOut(true);
    try { await logout(); } catch { /* ignore */ }
    setLoggingOut(false);
  }

  return (
    <div className="container">
      <div className="topbar">
        <div className="brand">
          <div className="logo" onClick={onLogoClick} title="Triple-click for diagnostics" />
          <div className="title">
            <strong>Production OS</strong>
            <span>排产管理 + 巡厂定位</span>
          </div>
          {pilotLabel && (
            <span
              className="pilotBadge"
              onClick={() => { refreshAuditLog(); setShowAudit((v) => !v); }}
              title="Click to view audit log"
            >
              {pilotLabel}
            </span>
          )}
        </div>

        <div className="topbarRight">
          <div className="tabs" role="tablist" aria-label="Views">
            {tabs.map((t) => (
              <button
                key={t.key}
                className={`tab ${tab === t.key ? "active" : ""}`}
                onClick={() => setTab(t.key)}
                role="tab"
                aria-selected={tab === t.key}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="userInfo">
            <span className="userName">{user.name}</span>
            <button className="btn logoutBtn" onClick={handleLogout} disabled={loggingOut}>
              {loggingOut ? "..." : "退出"}
            </button>
          </div>
        </div>
      </div>

      {/* Pilot mode audit log */}
      {showAudit && isPilotMode() && (
        <AuditPanel
          entries={auditEntries}
          onRefresh={refreshAuditLog}
          onDownload={downloadAuditLog}
          onClose={() => setShowAudit(false)}
        />
      )}

      {/* Verification panel */}
      {showVerify && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="cardHeader">
            <div>
              <h2>System Verification</h2>
              <div className="hint">
                API: {apiHealth?.base_url ?? "?"} | Supabase: {apiHealth?.supabase ? "connected" : "disconnected"}
                {apiHealth?.latency_ms != null && ` | ${apiHealth.latency_ms}ms`}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn primary" onClick={() => void handleRunVerification()} disabled={verifying}>
                {verifying ? "Running…" : "Run Full Check"}
              </button>
              <button className="btn" onClick={() => setShowVerify(false)}>Close</button>
            </div>
          </div>
          {verification && (
            <div style={{ padding: 14, fontSize: 13 }}>
              <div style={{ marginBottom: 8, fontWeight: 600, color: verification.all_ok ? "#22c55e" : "var(--danger)" }}>
                {verification.all_ok ? "ALL CHECKS PASSED" : `${verification.failed} / ${verification.total} FAILED`}
              </div>
              {verification.checks.map((c) => (
                <div key={c.name} style={{ display: "flex", gap: 8, padding: "3px 0", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ width: 20, textAlign: "center", color: c.ok ? "#22c55e" : "var(--danger)" }}>{c.ok ? "ok" : "X"}</span>
                  <span style={{ flex: 1 }}>{c.name}</span>
                  <span style={{ color: "var(--muted)", width: 50, textAlign: "right" }}>{c.latency_ms}ms</span>
                  <span style={{ color: c.ok ? "var(--muted)" : "var(--danger)", fontSize: 12, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.detail}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Connection banners */}
      {apiHealth && !apiHealth.ok && (
        <div className="riskBanner riskBannerHigh">
          <div className="riskBannerLeft">
            <span className="riskBannerIcon">!</span>
            <span className="riskBannerText">Backend API unreachable ({apiHealth.base_url}). {apiHealth.error ?? "Set VITE_API_BASE_URL."}</span>
          </div>
        </div>
      )}

      {apiHealth?.ok && apiHealth.supabase === false && (
        <div className="riskBanner riskBannerMedium">
          <div className="riskBannerLeft">
            <span className="riskBannerIcon">~</span>
            <span className="riskBannerText">API reachable but Supabase disconnected. {apiHealth.error ?? "Check backend env vars."}</span>
          </div>
        </div>
      )}

      {risk && (risk.HIGH > 0 || risk.MEDIUM > 0) && <RiskBanner counts={risk} />}
      {riskError && apiHealth?.ok && (
        <div className="riskBanner riskBannerSafe">
          <span className="riskBannerIcon">i</span>
          <span>Risk scan unavailable — check risk_alerts table.</span>
        </div>
      )}

      {tab === "command" && <CommandPage />}
      {tab === "schedule" && <SchedulePage />}
      {tab === "reports" && <DailyReportPage />}
      {tab === "exceptions" && <ExceptionPage />}
      {tab === "factories" && <FactoriesPage />}
    </div>
  );
}

// ── Audit Panel ─────────────────────────────────────────

function AuditPanel({
  entries,
  onRefresh,
  onDownload,
  onClose,
}: {
  entries: AuditEntry[];
  onRefresh: () => void;
  onDownload: () => void;
  onClose: () => void;
}) {
  const summary = getAuditSummary();
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="cardHeader">
        <div>
          <h2>Pilot Audit Log</h2>
          <div className="hint">{summary.total} actions | {summary.blocked} blocked | {summary.allowed} allowed</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={onRefresh}>Refresh</button>
          <button className="btn" onClick={onDownload}>Download</button>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
      <div style={{ padding: 14, maxHeight: 300, overflowY: "auto", fontSize: 12 }}>
        {entries.length === 0 && <div style={{ color: "var(--muted)" }}>No actions recorded yet.</div>}
        {entries.slice().reverse().map((e, i) => (
          <div key={i} style={{ display: "flex", gap: 8, padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
            <span style={{ width: 16, textAlign: "center", color: e.blocked ? "var(--danger)" : "#22c55e", fontWeight: 700 }}>
              {e.blocked ? "X" : "o"}
            </span>
            <span style={{ width: 65, color: "var(--muted)", flexShrink: 0 }}>{e.timestamp.slice(11, 19)}</span>
            <span style={{ width: 80, flexShrink: 0 }}>{e.category}</span>
            <span style={{ flex: 1 }}>{e.action}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Risk Banner ─────────────────────────────────────────

function RiskBanner({ counts }: { counts: RiskCounts }) {
  const level: RiskLevel = counts.HIGH > 0 ? "HIGH" : counts.MEDIUM > 0 ? "MEDIUM" : "SAFE";
  const cls = level === "HIGH" ? "riskBannerHigh" : level === "MEDIUM" ? "riskBannerMedium" : "riskBannerSafe";

  return (
    <div className={`riskBanner ${cls}`}>
      <div className="riskBannerLeft">
        <span className="riskBannerIcon">{level === "HIGH" ? "!" : level === "MEDIUM" ? "~" : "ok"}</span>
        <span className="riskBannerText">
          {level === "HIGH" ? `${counts.HIGH} high-risk orders need immediate attention` : `${counts.MEDIUM} orders with delivery risk`}
        </span>
      </div>
      <div className="riskBannerCounts">
        {counts.HIGH > 0 && <span className="riskDot riskDotHigh">{counts.HIGH} HIGH</span>}
        {counts.MEDIUM > 0 && <span className="riskDot riskDotMedium">{counts.MEDIUM} MEDIUM</span>}
        <span className="riskDot riskDotSafe">{counts.SAFE} SAFE</span>
      </div>
    </div>
  );
}
