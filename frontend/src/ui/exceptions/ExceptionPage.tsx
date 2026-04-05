import React from "react";
import { useAsync } from "../../hooks/useAsync";
import { fetchExceptions } from "../../services/api";
import type { ExceptionItem } from "../../types";
import "./exceptions.css";

type SectionDef = {
  type: ExceptionItem["type"];
  title: string;
  icon: string;
  severity: "high" | "medium" | "low";
};

const SECTIONS: SectionDef[] = [
  { type: "delayed", title: "延期订单", icon: "!", severity: "high" },
  { type: "at_risk", title: "预计延期", icon: "~", severity: "medium" },
  { type: "overloaded", title: "产线过载", icon: "#", severity: "medium" },
  { type: "underperforming", title: "持续低效", icon: "-", severity: "low" },
  { type: "unreported", title: "未报工厂", icon: "?", severity: "medium" },
  { type: "unschedulable", title: "无法排产", icon: "X", severity: "high" },
];

export function ExceptionPage() {
  const { data: exceptions, loading, error, refetch } = useAsync(
    () => fetchExceptions(),
    [],
  );

  // Group by type
  const grouped = React.useMemo(() => {
    const map: Record<string, ExceptionItem[]> = {};
    for (const s of SECTIONS) {
      map[s.type] = [];
    }
    if (exceptions) {
      for (const exc of exceptions) {
        if (map[exc.type]) {
          map[exc.type].push(exc);
        }
      }
    }
    return map;
  }, [exceptions]);

  const totalCount = exceptions?.length ?? 0;

  if (loading && !exceptions) {
    return <div className="loadingCenter">加载异常数据...</div>;
  }

  if (error) {
    return (
      <div className="emptyState">
        加载失败：{error}
        <br />
        <button className="btn" onClick={refetch} style={{ marginTop: 8 }}>
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="excPage">
      <div className="excPageHeader">
        <h2>异常中心</h2>
        {totalCount > 0 && (
          <span className="excTotalBadge">{totalCount} 项异常</span>
        )}
      </div>

      {SECTIONS.map((section) => {
        const items = grouped[section.type] ?? [];
        return (
          <ExceptionSection
            key={section.type}
            section={section}
            items={items}
          />
        );
      })}

      {totalCount === 0 && (
        <div className="emptyState">当前无异常，运行正常</div>
      )}
    </div>
  );
}

// ── Collapsible Section ─────────────────────────────────

function ExceptionSection({
  section,
  items,
}: {
  section: SectionDef;
  items: ExceptionItem[];
}) {
  const [open, setOpen] = React.useState(items.length > 0);

  // Auto-open when items appear
  React.useEffect(() => {
    if (items.length > 0) setOpen(true);
  }, [items.length]);

  if (items.length === 0) {
    return null;
  }

  return (
    <div className={`excSection${open ? " open" : ""}`}>
      <div className="excSectionHeader" onClick={() => setOpen(!open)}>
        <span className={`excSectionIcon excSectionIcon--${section.severity}`}>
          {section.icon}
        </span>
        <span className="excSectionTitle">{section.title}</span>
        <span className={`excSectionCount excSectionCount--${section.severity}`}>
          {items.length}
        </span>
        <span className="excSectionToggle">▼</span>
      </div>

      {open && (
        <div className="excItems">
          {items.map((item, i) => (
            <div className="excItem" key={i}>
              <span className={`excIcon excIcon--${item.severity}`}>
                {section.icon}
              </span>
              <span className="excItemMsg">{item.message}</span>
              <span className={`excSeverity excSeverity--${item.severity}`}>
                {item.severity === "high"
                  ? "严重"
                  : item.severity === "medium"
                    ? "警告"
                    : "提示"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
