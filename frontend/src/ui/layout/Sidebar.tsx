import React from "react";

export type ModuleKey = "today" | "scheduling" | "execution" | "materials" | "quality" | "factories" | "runtime" | "imports" | "tasks";

type NavItem = {
  key: ModuleKey;
  label: string;
  sublabel: string;
  icon: string;
};

const NAV_ITEMS: NavItem[] = [
  { key: "today", label: "今日运营", sublabel: "Today", icon: "!" },
  { key: "scheduling", label: "排产工作台", sublabel: "Scheduling", icon: "#" },
  { key: "execution", label: "生产执行", sublabel: "Execution", icon: ">" },
  { key: "materials", label: "物料采购", sublabel: "Materials", icon: "M" },
  { key: "quality", label: "品质中心", sublabel: "Quality", icon: "Q" },
  { key: "factories", label: "工厂资源", sublabel: "Resources", icon: "F" },
  { key: "runtime", label: "运行时战室", sublabel: "Runtime War Room", icon: "W" },
  { key: "imports", label: "数据网关", sublabel: "Import Gateway", icon: "↓" },
  { key: "tasks", label: "任务中心", sublabel: "Task Center", icon: "✓" },
];

type Props = {
  active: ModuleKey;
  onNavigate: (key: ModuleKey) => void;
  userName: string;
  onLogout: () => void;
  loggingOut: boolean;
  kpiSnapshot?: {
    active_orders?: number;
    abnormal_count?: number;
    unscheduled_count?: number;
  };
};

export function Sidebar({ active, onNavigate, userName, onLogout, loggingOut, kpiSnapshot }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebarTop">
        <div className="sidebarBrand">
          <div className="sidebarLogo" />
          <div className="sidebarTitle">
            <strong>Production OS</strong>
            <span>AI 排产系统</span>
          </div>
        </div>

        <nav className="sidebarNav">
          {NAV_ITEMS.map((item) => {
            const isActive = active === item.key;
            const badge = getBadge(item.key, kpiSnapshot);
            return (
              <button
                key={item.key}
                className={`sidebarItem ${isActive ? "sidebarItem--active" : ""}`}
                onClick={() => onNavigate(item.key)}
              >
                <span className="sidebarItemIcon">{item.icon}</span>
                <div className="sidebarItemText">
                  <span className="sidebarItemLabel">{item.label}</span>
                  <span className="sidebarItemSub">{item.sublabel}</span>
                </div>
                {badge > 0 && <span className="sidebarBadge">{badge}</span>}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="sidebarBottom">
        <div className="sidebarUser">
          <span className="sidebarUserName">{userName}</span>
          <button className="sidebarLogout" onClick={onLogout} disabled={loggingOut}>
            {loggingOut ? "..." : "退出"}
          </button>
        </div>
      </div>
    </aside>
  );
}

function getBadge(key: ModuleKey, kpi?: Props["kpiSnapshot"]): number {
  if (!kpi) return 0;
  switch (key) {
    case "today": return kpi.abnormal_count ?? 0;
    case "scheduling": return kpi.unscheduled_count ?? 0;
    default: return 0;
  }
}
