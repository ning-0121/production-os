/**
 * Global app state — shared across all modules via Zustand.
 *
 * Replaces scattered useState for:
 * - Factory/line filter (shared between scheduling + today + execution)
 * - Selected items (persist across tab switches)
 * - Toast notifications
 */

import { create } from "zustand";

type AppState = {
  // Global factory filter (shared across modules)
  selectedFactoryId: string;
  setSelectedFactoryId: (id: string) => void;

  // Active module
  activeModule: string;
  setActiveModule: (m: string) => void;

  // Scheduling state
  schedulingSubTab: "orders" | "board" | "profit";
  setSchedulingSubTab: (tab: "orders" | "board" | "profit") => void;

  // Execution state
  executionSubTab: "reports" | "exceptions";
  setExecutionSubTab: (tab: "reports" | "exceptions") => void;

  // Materials state
  materialsSubTab: "overview" | "procurement" | "bom";
  setMaterialsSubTab: (tab: "overview" | "procurement" | "bom") => void;

  // Quality state
  qualitySubTab: "inspections" | "reworks";
  setQualitySubTab: (tab: "inspections" | "reworks") => void;

  // Runtime War Room state (V5-B)
  runtimeSubTab: "timeline" | "graph" | "replay";
  setRuntimeSubTab: (tab: "timeline" | "graph" | "replay") => void;
  runtimeSelectedEventId: string | null;
  setRuntimeSelectedEventId: (id: string | null) => void;
  runtimeSelectedNodeId: string | null;
  setRuntimeSelectedNodeId: (id: string | null) => void;
  runtimeSelectedAllocationId: string | null;
  setRuntimeSelectedAllocationId: (id: string | null) => void;
  runtimeFactoryFilter: string;
  setRuntimeFactoryFilter: (id: string) => void;

  // Data refresh triggers (increment to force refetch)
  refreshKey: number;
  triggerRefresh: () => void;
};

export const useAppStore = create<AppState>((set) => ({
  selectedFactoryId: "",
  setSelectedFactoryId: (id) => set({ selectedFactoryId: id }),

  activeModule: "today",
  setActiveModule: (m) => set({ activeModule: m }),

  schedulingSubTab: "orders",
  setSchedulingSubTab: (tab) => set({ schedulingSubTab: tab }),

  executionSubTab: "reports",
  setExecutionSubTab: (tab) => set({ executionSubTab: tab }),

  materialsSubTab: "overview",
  setMaterialsSubTab: (tab) => set({ materialsSubTab: tab }),

  qualitySubTab: "inspections",
  setQualitySubTab: (tab) => set({ qualitySubTab: tab }),

  runtimeSubTab: "timeline",
  setRuntimeSubTab: (tab) => set({ runtimeSubTab: tab }),
  runtimeSelectedEventId: null,
  setRuntimeSelectedEventId: (id) => set({ runtimeSelectedEventId: id }),
  runtimeSelectedNodeId: null,
  setRuntimeSelectedNodeId: (id) => set({ runtimeSelectedNodeId: id }),
  runtimeSelectedAllocationId: null,
  setRuntimeSelectedAllocationId: (id) => set({ runtimeSelectedAllocationId: id }),
  runtimeFactoryFilter: "",
  setRuntimeFactoryFilter: (id) => set({ runtimeFactoryFilter: id }),

  refreshKey: 0,
  triggerRefresh: () => set((s) => ({ refreshKey: s.refreshKey + 1 })),
}));
