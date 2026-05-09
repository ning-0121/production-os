/**
 * ConstraintGraph — visual proof of the AI Factory Operating Brain.
 *
 * Loads the manufacturing dependency graph and renders it with react-flow
 * (xyflow). Layout is a simple type-ranked horizontal lane:
 *   factory → line → allocation → order → material → shipment
 *
 * Click a node → fetches a propagation result from /api/runtime/propagate and
 * highlights the cascading path. Edges colored by edge_type. Severity dots
 * (from current open events) overlay matching nodes.
 *
 * Defensive: empty graph renders a coaching empty state, never crashes.
 */

import React from "react";
import {
  ReactFlow, Background, Controls, MiniMap, MarkerType,
  type Node, type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useAsync } from "../../hooks/useAsync";
import { fetchRuntimeGraph, propagateRuntimeFrom } from "../../services/api";
import { useAppStore } from "../../stores/appStore";
import type { ConstraintNode as CNode, ConstraintEdge as CEdge, RuntimeSeverity } from "../../types";

const TYPE_LANE: Record<string, number> = {
  factory: 0,
  line: 1,
  allocation: 2,
  order: 3,
  material: 4,
  rework: 5,
  shipment: 6,
  quality_hold: 5,
  qc_block: 5,
  equipment: 1,
  worker_team: 1,
};

const TYPE_COLOR: Record<string, string> = {
  factory: "#a78bfa",
  line: "#6ee7ff",
  allocation: "#facc15",
  order: "#22c55e",
  material: "#fb923c",
  rework: "#fb7185",
  shipment: "#60a5fa",
  quality_hold: "#f87171",
  qc_block: "#f87171",
};

const EDGE_COLOR: Record<string, string> = {
  requires: "#fb923c",
  blocks: "#fb7185",
  supplies: "#a78bfa",
  assigned_to: "#6ee7ff",
  downstream_of: "#facc15",
  replaces: "#94a3b8",
};

export function ConstraintGraph({ refreshKey = 0 }: { refreshKey?: number }) {
  const { data, loading, error } = useAsync(() => fetchRuntimeGraph(), [refreshKey]);
  const setRuntimeSelectedNodeId = useAppStore((s) => s.setRuntimeSelectedNodeId);
  const [highlightedNodes, setHighlightedNodes] = React.useState<Set<string>>(new Set());
  const [propagationInfo, setPropagationInfo] = React.useState<string | null>(null);
  const [propLoading, setPropLoading] = React.useState(false);

  const safeNodes = React.useMemo(() => Array.isArray(data?.nodes) ? data!.nodes : [], [data?.nodes]);
  const safeEdges = React.useMemo(() => Array.isArray(data?.edges) ? data!.edges : [], [data?.edges]);
  const rfNodes = React.useMemo(() => buildNodes(safeNodes, highlightedNodes), [safeNodes, highlightedNodes]);
  const rfEdges = React.useMemo(() => buildEdges(safeEdges, highlightedNodes), [safeEdges, highlightedNodes]);

  async function handleNodeClick(_evt: React.MouseEvent, node: Node) {
    setRuntimeSelectedNodeId(node.id);
    const original = (node.data as { _node?: CNode })._node;
    if (!original) return;
    setPropLoading(true);
    setPropagationInfo(null);
    try {
      const res = await propagateRuntimeFrom(
        { node_type: original.node_type, ref_id: original.ref_id },
        "high",
      );
      const ids = new Set<string>([node.id, ...res.impacted.map((x) => x.node_id)]);
      setHighlightedNodes(ids);
      setPropagationInfo(
        res.impacted.length === 0
          ? `从 ${original.node_type}#${original.ref_id} 出发：无下游依赖。`
          : `从 ${original.node_type}#${original.ref_id} 出发：影响 ${res.impacted.length} 个节点；最深 ${(res.stats as { max_depth_reached?: number } | undefined)?.max_depth_reached ?? "?"} 跳。`,
      );
    } catch (err) {
      setPropagationInfo(`传播失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPropLoading(false);
    }
  }

  function clearHighlight() {
    setHighlightedNodes(new Set());
    setPropagationInfo(null);
    setRuntimeSelectedNodeId(null);
  }

  if (loading) return <div className="loadingCenter" style={{ padding: 32 }}>加载约束图...</div>;
  if (error) return <div style={{ padding: 16, color: "var(--danger)" }}>加载失败：{error}</div>;

  if (safeNodes.length === 0) {
    return (
      <div className="emptyState" style={{ padding: 32 }}>
        约束图为空。
        <div className="hint" style={{ marginTop: 8 }}>
          物料、订单、产线被引用后会自动生成节点。先创建几个订单再回来看。
        </div>
      </div>
    );
  }

  return (
    <div className="rtGraphWrap">
      <div className="rtGraphToolbar">
        <span className="hint">
          {safeNodes.length} 节点 · {safeEdges.length} 边
        </span>
        {(highlightedNodes.size > 0 || propagationInfo) && (
          <>
            <span className="rtGraphInfo">{propLoading ? "传播中..." : propagationInfo}</span>
            <button className="btn" onClick={clearHighlight}>清除高亮</button>
          </>
        )}
        <div style={{ flex: 1 }} />
        <span className="hint">点击节点查看影响传播路径</span>
      </div>
      <div style={{ height: 560, background: "rgba(255,255,255,.02)", borderRadius: 8 }}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          onNodeClick={handleNodeClick}
          fitView
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          panOnDrag
          zoomOnScroll
        >
          <Background gap={24} color="rgba(255,255,255,.06)" />
          <Controls />
          <MiniMap
            nodeColor={(n) => TYPE_COLOR[String((n.data as { _node?: CNode })?._node?.node_type ?? "")] ?? "#94a3b8"}
            maskColor="rgba(0,0,0,.6)"
            style={{ background: "#0b1220" }}
          />
        </ReactFlow>
      </div>
      <div className="rtGraphLegend">
        {Object.entries(TYPE_COLOR).map(([t, c]) => (
          <span key={t} className="rtGraphLegendItem">
            <span className="rtGraphLegendDot" style={{ background: c }} />
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Layout ──────────────────────────────────────────────

function buildNodes(nodes: CNode[], highlighted: Set<string>): Node[] {
  // Group by type-lane to assign x positions; spread within lane for y.
  const byLane: Record<number, CNode[]> = {};
  for (const n of nodes) {
    const lane = TYPE_LANE[n.node_type] ?? 8;
    if (!byLane[lane]) byLane[lane] = [];
    byLane[lane].push(n);
  }
  const out: Node[] = [];
  for (const [laneStr, members] of Object.entries(byLane)) {
    const lane = Number(laneStr);
    const x = 60 + lane * 220;
    members.forEach((n, idx) => {
      const isHighlighted = highlighted.size > 0 && highlighted.has(n.id);
      const dimmed = highlighted.size > 0 && !isHighlighted;
      out.push({
        id: n.id,
        position: { x, y: 30 + idx * 90 },
        data: {
          label: (
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,.7)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                {n.node_type}
              </div>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{(n.ref_label ?? n.ref_id ?? "").toString().slice(0, 16)}</div>
            </div>
          ),
          _node: n,
        },
        style: nodeStyle(n.node_type, isHighlighted, dimmed),
      });
    });
  }
  return out;
}

function buildEdges(edges: CEdge[], highlighted: Set<string>): Edge[] {
  return edges.map((e) => {
    const isHighlighted = highlighted.size > 0 && highlighted.has(e.from_node) && highlighted.has(e.to_node);
    const dimmed = highlighted.size > 0 && !isHighlighted;
    return {
      id: e.id,
      source: e.from_node,
      target: e.to_node,
      label: e.edge_type,
      labelStyle: { fontSize: 10, fill: "rgba(255,255,255,.7)" },
      labelBgStyle: { fill: "rgba(11,18,32,.85)" },
      style: {
        stroke: EDGE_COLOR[e.edge_type] ?? "#94a3b8",
        strokeWidth: isHighlighted ? 3 : 1.5,
        opacity: dimmed ? 0.15 : (isHighlighted ? 1 : 0.7),
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR[e.edge_type] ?? "#94a3b8" },
      animated: isHighlighted,
    };
  });
}

function nodeStyle(node_type: string, highlighted: boolean, dimmed: boolean): React.CSSProperties {
  const color = TYPE_COLOR[node_type] ?? "#94a3b8";
  return {
    background: "rgba(11,18,32,.92)",
    color: "var(--text)",
    border: `2px solid ${color}`,
    borderRadius: 8,
    padding: "8px 10px",
    width: 170,
    boxShadow: highlighted ? `0 0 0 3px ${color}55, 0 0 16px ${color}aa` : "none",
    opacity: dimmed ? 0.25 : 1,
    transition: "all 0.18s ease",
  };
}
