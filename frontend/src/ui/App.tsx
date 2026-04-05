import React from "react";
import { Sidebar } from "./layout/Sidebar";
import type { ModuleKey } from "./layout/Sidebar";
import { TodayPage } from "./today/TodayPage";
import { SchedulePage } from "./schedule/SchedulePage";
import { OrderCenterPage } from "./orders/OrderCenterPage";
import { DailyReportPage } from "./reports/DailyReportPage";
import { ExceptionPage } from "./exceptions/ExceptionPage";
import { FactoriesPage } from "./factories/FactoriesPage";
import { LoginPage } from "./auth/LoginPage";
import { ErrorBoundary } from "./ErrorBoundary";
import { ToastProvider } from "./Toast";
import { checkHealth } from "../services/api";
import { supabase, logout, getSession, parseUser } from "../services/auth";
import type { AuthUser } from "../services/auth";
import type { ApiHealth } from "../services/api";

import "./auth/login.css";

export function App() {
  const [authReady, setAuthReady] = React.useState(false);
  const [user, setUser] = React.useState<AuthUser | null>(null);

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
      <div className="appLoading">
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
  const [module, setModule] = React.useState<ModuleKey>("today");
  const [loggingOut, setLoggingOut] = React.useState(false);
  const [apiHealth, setApiHealth] = React.useState<ApiHealth | null>(null);

  React.useEffect(() => {
    checkHealth().then(setApiHealth).catch(() => {});
  }, []);

  async function handleLogout() {
    setLoggingOut(true);
    try { await logout(); } catch { /* ignore */ }
    setLoggingOut(false);
  }

  return (
    <div className="appShell">
      <Sidebar
        active={module}
        onNavigate={setModule}
        userName={user.name}
        onLogout={handleLogout}
        loggingOut={loggingOut}
      />

      <main className="appContent">
        {/* Connection banner */}
        {apiHealth && !apiHealth.ok && (
          <div className="riskBanner riskBannerHigh" style={{ margin: "0 0 12px" }}>
            <div className="riskBannerLeft">
              <span className="riskBannerIcon">!</span>
              <span className="riskBannerText">Backend API unreachable ({apiHealth.base_url})</span>
            </div>
          </div>
        )}

        {module === "today" && <TodayPage />}
        {module === "scheduling" && <SchedulingWorkbench />}
        {module === "execution" && <ExecutionModule />}
        {module === "factories" && <FactoriesPage />}
      </main>
    </div>
  );
}

// ── Scheduling Workbench (Order Center + Scheduling Board) ──

function SchedulingWorkbench() {
  const [subTab, setSubTab] = React.useState<"orders" | "board">("orders");

  return (
    <div>
      <div className="subTabs">
        <button
          className={`subTab ${subTab === "orders" ? "subTab--active" : ""}`}
          onClick={() => setSubTab("orders")}
        >
          订单中心
        </button>
        <button
          className={`subTab ${subTab === "board" ? "subTab--active" : ""}`}
          onClick={() => setSubTab("board")}
        >
          排产看板
        </button>
      </div>
      {subTab === "orders" && <OrderCenterPage />}
      {subTab === "board" && <SchedulePage />}
    </div>
  );
}

// ── Execution Module (combines Reports + Exceptions) ──────

function ExecutionModule() {
  const [subTab, setSubTab] = React.useState<"reports" | "exceptions">("reports");

  return (
    <div>
      <div className="subTabs">
        <button
          className={`subTab ${subTab === "reports" ? "subTab--active" : ""}`}
          onClick={() => setSubTab("reports")}
        >
          日报中心
        </button>
        <button
          className={`subTab ${subTab === "exceptions" ? "subTab--active" : ""}`}
          onClick={() => setSubTab("exceptions")}
        >
          异常中心
        </button>
      </div>
      {subTab === "reports" && <DailyReportPage />}
      {subTab === "exceptions" && <ExceptionPage />}
    </div>
  );
}
