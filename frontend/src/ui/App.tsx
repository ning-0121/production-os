import React from "react";
import { Sidebar } from "./layout/Sidebar";
import type { ModuleKey } from "./layout/Sidebar";
import { useAppStore } from "../stores/appStore";
import { TodayPage } from "./today/TodayPage";
import { SchedulePage } from "./schedule/SchedulePage";
import { OrderCenterPage } from "./orders/OrderCenterPage";
import { DailyReportPage } from "./reports/DailyReportPage";
import { ExceptionPage } from "./exceptions/ExceptionPage";
import { FactoriesPage } from "./factories/FactoriesPage";
import { MaterialsPage } from "./materials/MaterialsPage";
import { ProcurementPage } from "./materials/ProcurementPage";
import { BOMPage } from "./materials/BOMPage";
import { QualityPage } from "./quality/QualityPage";
import { ReworkPage } from "./quality/ReworkPage";
import { ProfitPage } from "./profit/ProfitPage";
import { RuntimeWarRoomPage } from "./runtime/RuntimeWarRoomPage";
import { CustomersPage } from "./customers/CustomersPage";
import { ImportCenterPage } from "./imports/ImportCenterPage";
import { TaskCenterPage } from "./tasks/TaskCenterPage";
import { NotificationBell } from "./notifications/NotificationBell";
import { RetrospectivePage } from "./retrospective/RetrospectivePage";
import { DecisionIntelPage } from "./decision-intel/DecisionIntelPage";
import { ShopfloorConsolePage } from "./shopfloor/ShopfloorConsolePage";
import { SystemHealthPage } from "./admin/SystemHealthPage";
import { AIAssistant } from "./today/AIAssistant";
import { LoginPage } from "./auth/LoginPage";
import { ErrorBoundary, PageBoundary } from "./ErrorBoundary";
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
  const { activeModule, setActiveModule } = useAppStore();
  const module = activeModule as ModuleKey;
  const setModule = (m: ModuleKey) => setActiveModule(m);
  const [loggingOut, setLoggingOut] = React.useState(false);
  const [apiHealth, setApiHealth] = React.useState<ApiHealth | null>(null);

  React.useEffect(() => {
    checkHealth().then(setApiHealth).catch(() => {});
  }, []);

  // Listen for 401 auto-logout broadcast from client.ts
  React.useEffect(() => {
    function onAuthExpired() {
      // Lightweight notification — full toast via the existing alert path.
      // We don't import useToast here because the alert flow is fire-and-forget.
      try { alert("登录已过期，正在重新登录..."); } catch { /* ignore */ }
    }
    window.addEventListener("prodos:auth-expired", onAuthExpired);
    return () => window.removeEventListener("prodos:auth-expired", onAuthExpired);
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

      <NotificationBell />

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

        {module === "today" && <PageBoundary name="今日运营"><TodayPage /></PageBoundary>}
        {module === "scheduling" && <PageBoundary name="排产工作台"><SchedulingWorkbench /></PageBoundary>}
        {module === "execution" && <PageBoundary name="生产执行"><ExecutionModule /></PageBoundary>}
        {module === "materials" && <PageBoundary name="物料采购"><MaterialsModule /></PageBoundary>}
        {module === "quality" && <PageBoundary name="品质中心"><QualityModule /></PageBoundary>}
        {module === "factories" && <PageBoundary name="工厂资源"><FactoriesPage /></PageBoundary>}
        {module === "runtime" && <PageBoundary name="运行时战室"><RuntimeWarRoomPage /></PageBoundary>}
        {module === "imports" && <PageBoundary name="数据网关"><ImportCenterPage /></PageBoundary>}
        {module === "tasks" && <PageBoundary name="任务中心"><TaskCenterPage /></PageBoundary>}
        {module === "retrospective" && <PageBoundary name="复盘分析"><RetrospectivePage /></PageBoundary>}
        {module === "decisionIntel" && <PageBoundary name="决策智能"><DecisionIntelPage /></PageBoundary>}
        {module === "shopfloor" && <PageBoundary name="车间执行台"><ShopfloorConsolePage /></PageBoundary>}
        {module === "admin" && <PageBoundary name="系统健康"><SystemHealthPage /></PageBoundary>}
      </main>

      {/* Global AI Assistant — floating button on all pages */}
      <AIAssistant />
    </div>
  );
}

// ── Scheduling Workbench (Order Center + Scheduling Board) ──

function SchedulingWorkbench() {
  const { schedulingSubTab: subTab, setSchedulingSubTab: setSubTab } = useAppStore();

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
        <button
          className={`subTab ${subTab === "customers" ? "subTab--active" : ""}`}
          onClick={() => setSubTab("customers")}
        >
          客户管理
        </button>
        <button
          className={`subTab ${subTab === "profit" ? "subTab--active" : ""}`}
          onClick={() => setSubTab("profit")}
        >
          订单损益
        </button>
      </div>
      {subTab === "orders" && <OrderCenterPage />}
      {subTab === "board" && <SchedulePage />}
      {subTab === "customers" && <CustomersPage />}
      {subTab === "profit" && <ProfitPage />}
    </div>
  );
}

// ── Execution Module (combines Reports + Exceptions) ──────

function ExecutionModule() {
  const { executionSubTab: subTab, setExecutionSubTab: setSubTab } = useAppStore();

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

// ── Materials Module ──────────────────────────────────────

function MaterialsModule() {
  const { materialsSubTab: subTab, setMaterialsSubTab: setSubTab } = useAppStore();

  return (
    <div>
      <div className="subTabs">
        <button className={`subTab ${subTab === "overview" ? "subTab--active" : ""}`} onClick={() => setSubTab("overview")}>物料总览</button>
        <button className={`subTab ${subTab === "procurement" ? "subTab--active" : ""}`} onClick={() => setSubTab("procurement")}>采购管理</button>
        <button className={`subTab ${subTab === "bom" ? "subTab--active" : ""}`} onClick={() => setSubTab("bom")}>BOM</button>
      </div>
      {subTab === "overview" && <MaterialsPage />}
      {subTab === "procurement" && <ProcurementPage />}
      {subTab === "bom" && <BOMPage />}
    </div>
  );
}

// ── Quality Module ────────────────────────────────────────

function QualityModule() {
  const { qualitySubTab: subTab, setQualitySubTab: setSubTab } = useAppStore();

  return (
    <div>
      <div className="subTabs">
        <button className={`subTab ${subTab === "inspections" ? "subTab--active" : ""}`} onClick={() => setSubTab("inspections")}>验货中心</button>
        <button className={`subTab ${subTab === "reworks" ? "subTab--active" : ""}`} onClick={() => setSubTab("reworks")}>返工管理</button>
      </div>
      {subTab === "inspections" && <QualityPage />}
      {subTab === "reworks" && <ReworkPage />}
    </div>
  );
}
