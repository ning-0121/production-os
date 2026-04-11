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
  schedulingSubTab: "orders" | "board";
  setSchedulingSubTab: (tab: "orders" | "board") => void;

  // Execution state
  executionSubTab: "reports" | "exceptions";
  setExecutionSubTab: (tab: "reports" | "exceptions") => void;

  // Materials state
  materialsSubTab: "overview" | "procurement" | "bom";
  setMaterialsSubTab: (tab: "overview" | "procurement" | "bom") => void;

  // Quality state
  qualitySubTab: "inspections" | "reworks";
  setQualitySubTab: (tab: "inspections" | "reworks") => void;

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

  refreshKey: 0,
  triggerRefresh: () => set((s) => ({ refreshKey: s.refreshKey + 1 })),
}));
