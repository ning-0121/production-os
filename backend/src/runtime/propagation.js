/**
 * Constraint Propagation Engine
 *
 * Given a triggering event at an origin node, compute the cascading impact
 * across the manufacturing dependency graph. Pure function; no I/O.
 *
 * Algorithm: bounded BFS with severity decay.
 *   impact(node)  = severity_score × Π edge.weight × decay^depth
 *   visited       = set, prevents re-walking on cycles
 *   stop when     impact < MIN_IMPACT or depth > MAX_DEPTH
 *
 * Output is sorted by impact desc and includes a full path trace per affected
 * node — mandatory for "explainable AI" decisions.
 */

import { neighborsOut } from "./graph.js";

const SEVERITY_SCORE = {
  critical: 1.0,
  high: 0.75,
  medium: 0.5,
  low: 0.25,
  info: 0.05,
};

// Edge-type aware propagation behavior. Some edges propagate forward (downstream
// is affected when upstream breaks), others propagate backward.
const FORWARD_EDGE_TYPES = new Set([
  "requires",       // downstream order requires upstream material — material delay propagates to order
  "blocks",         // upstream rework blocks downstream — propagates
  "supplies",       // factory supplies line — shutdown propagates
  "assigned_to",    // allocation assigned to line — allocation issue affects line
  "downstream_of",  // explicit downstream relation
]);

// Backward-propagating edge types (rare — used for "replaces" substitution flows)
const BACKWARD_EDGE_TYPES = new Set(["replaces"]);

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_DECAY = 0.85;          // each hop attenuates impact by 15%
const DEFAULT_MIN_IMPACT = 0.05;     // below this, propagation stops

/**
 * @typedef {Object} PropagationOptions
 * @property {number} [max_depth]
 * @property {number} [decay]
 * @property {number} [min_impact]
 * @property {number} [estimated_delay_days]   if provided, also computes cascading delay
 */

/**
 * @typedef {Object} ImpactedNode
 * @property {string} node_id
 * @property {string} node_type
 * @property {string} ref_id
 * @property {number} impact                   final scalar 0..1
 * @property {number} depth                    hops from origin
 * @property {number} estimated_delay_days     0 if no delay propagation
 * @property {string[]} path                   node ids from origin to this node
 * @property {string[]} edge_path              edge_types traversed
 * @property {string} reasoning                human-readable trace
 */

/**
 * Propagate impact from an origin node across the graph.
 *
 * @param {import("./graph.js").Graph} graph
 * @param {string} originNodeId
 * @param {string} severity                    "critical" | "high" | ...
 * @param {PropagationOptions} [opts]
 * @returns {{
 *   origin_node_id: string,
 *   severity: string,
 *   severity_score: number,
 *   impacted: ImpactedNode[],
 *   stats: { visited: number, max_depth_reached: number, stopped_by_threshold: number },
 *   reasoning: string,
 * }}
 */
export function propagateImpact(graph, originNodeId, severity, opts = {}) {
  if (!graph.nodesById.has(originNodeId)) {
    return {
      origin_node_id: originNodeId,
      severity,
      severity_score: 0,
      impacted: [],
      stats: { visited: 0, max_depth_reached: 0, stopped_by_threshold: 0 },
      reasoning: "origin node not found in graph",
    };
  }

  const max_depth = opts.max_depth ?? DEFAULT_MAX_DEPTH;
  const decay = opts.decay ?? DEFAULT_DECAY;
  const min_impact = opts.min_impact ?? DEFAULT_MIN_IMPACT;
  const baseDelay = Number(opts.estimated_delay_days ?? 0);
  const baseImpact = SEVERITY_SCORE[severity] ?? SEVERITY_SCORE.medium;

  // Best-known impact per node — keeps the strongest path when multiple exist
  const bestImpact = new Map();         // node_id -> { impact, depth, path, edge_path, delay }
  const queue = [{
    nodeId: originNodeId,
    impact: baseImpact,
    depth: 0,
    path: [originNodeId],
    edgePath: [],
    delay: baseDelay,
  }];

  let stoppedByThreshold = 0;
  let maxDepthReached = 0;

  while (queue.length > 0) {
    const cur = queue.shift();

    // Skip if we already found a stronger path to this node
    const prev = bestImpact.get(cur.nodeId);
    if (prev && prev.impact >= cur.impact) continue;
    bestImpact.set(cur.nodeId, cur);
    if (cur.depth > maxDepthReached) maxDepthReached = cur.depth;

    if (cur.depth >= max_depth) continue;

    // Walk outgoing forward-propagating edges
    for (const edge of neighborsOut(graph, cur.nodeId)) {
      const isForward = FORWARD_EDGE_TYPES.has(edge.edge_type);
      const isBackward = BACKWARD_EDGE_TYPES.has(edge.edge_type);
      if (!isForward && !isBackward) continue;

      const nextImpact = cur.impact * Number(edge.weight ?? 1) * decay;
      if (nextImpact < min_impact) {
        stoppedByThreshold++;
        continue;
      }

      // Delay accumulates additively per "requires"/"blocks" hop (those move
      // schedule forward in time). Other edge types preserve current delay.
      const addsDelay = edge.edge_type === "requires" || edge.edge_type === "blocks";
      const nextDelay = addsDelay && baseDelay > 0
        ? cur.delay + Math.max(0, baseDelay * Number(edge.weight ?? 1) * Math.pow(decay, cur.depth))
        : cur.delay;

      queue.push({
        nodeId: edge.to_node,
        impact: nextImpact,
        depth: cur.depth + 1,
        path: [...cur.path, edge.to_node],
        edgePath: [...cur.edgePath, edge.edge_type],
        delay: nextDelay,
      });
    }
  }

  // Build output (exclude origin from impacted list — it's where the event began)
  const impacted = [];
  for (const [nodeId, info] of bestImpact) {
    if (nodeId === originNodeId) continue;
    const node = graph.nodesById.get(nodeId);
    impacted.push({
      node_id: nodeId,
      node_type: node.node_type,
      ref_id: node.ref_id,
      ref_label: node.ref_label ?? null,
      impact: round3(info.impact),
      depth: info.depth,
      estimated_delay_days: round1(info.delay),
      path: info.path,
      edge_path: info.edgePath,
      reasoning: buildReasoning(graph, info),
    });
  }
  impacted.sort((a, b) => b.impact - a.impact || a.depth - b.depth);

  return {
    origin_node_id: originNodeId,
    severity,
    severity_score: baseImpact,
    impacted,
    stats: {
      visited: bestImpact.size,
      max_depth_reached: maxDepthReached,
      stopped_by_threshold: stoppedByThreshold,
    },
    reasoning: impacted.length === 0
      ? `事件源 ${originNodeId.slice(0, 8)} 无下游依赖，未传播。`
      : `从 ${originNodeId.slice(0, 8)} 传播到 ${impacted.length} 个节点，最深 ${maxDepthReached} 跳，${stoppedByThreshold} 次因衰减阈值停止。`,
  };
}

/**
 * Group impacted nodes by node_type — useful for triggering type-specific
 * downstream actions (e.g. "all impacted orders" vs "all impacted lines").
 */
export function groupImpactedByType(propagationResult) {
  const groups = {};
  for (const n of propagationResult.impacted) {
    if (!groups[n.node_type]) groups[n.node_type] = [];
    groups[n.node_type].push(n);
  }
  return groups;
}

// ── Internals ─────────────────────────────────────────────

function buildReasoning(graph, info) {
  if (info.path.length <= 1) return "直接受影响";
  const labels = info.path.map((id) => {
    const n = graph.nodesById.get(id);
    return n ? `${n.node_type}#${(n.ref_label ?? n.ref_id).toString().slice(0, 12)}` : id.slice(0, 8);
  });
  const edges = info.edgePath.join("→");
  return `${labels.join(" → ")}（${edges}），impact=${round3(info.impact)}`;
}

function round3(x) { return Math.round(x * 1000) / 1000; }
function round1(x) { return Math.round(x * 10) / 10; }
