/**
 * Runtime Constraint Graph — pure, in-memory representation
 *
 * Manufacturing entities are nodes; dependencies are directed edges.
 * Every operation here is a pure function over `{nodes, edges}`. No DB.
 *
 * Node types  : material | order | allocation | line | factory | rework | shipment | qc_block
 * Edge types  : requires | blocks | supplies | assigned_to | downstream_of | replaces
 *
 * The graph is industry-agnostic. Apparel-specific data (color, fabric width,
 * defect codes…) lives in `node.attrs` and is opaque to the engine.
 */

/**
 * @typedef {Object} ConstraintNode
 * @property {string} id            uuid
 * @property {string} node_type
 * @property {string} ref_id        id of the underlying entity
 * @property {string} [ref_label]
 * @property {Record<string,unknown>} [attrs]
 */

/**
 * @typedef {Object} ConstraintEdge
 * @property {string} id
 * @property {string} from_node
 * @property {string} to_node
 * @property {string} edge_type
 * @property {number} weight        (0, 1]
 * @property {Record<string,unknown>} [attrs]
 */

/**
 * @typedef {Object} Graph
 * @property {Map<string, ConstraintNode>} nodesById
 * @property {Map<string, ConstraintNode>} nodesByRef        key = `${type}:${ref_id}`
 * @property {Map<string, ConstraintEdge[]>} outgoing        key = node id
 * @property {Map<string, ConstraintEdge[]>} incoming
 */

/**
 * Build an in-memory graph from raw nodes + edges. O(N + E).
 * @param {ConstraintNode[]} nodes
 * @param {ConstraintEdge[]} edges
 * @returns {Graph}
 */
export function buildGraph(nodes, edges) {
  const nodesById = new Map();
  const nodesByRef = new Map();
  const outgoing = new Map();
  const incoming = new Map();

  for (const n of nodes) {
    nodesById.set(n.id, n);
    nodesByRef.set(`${n.node_type}:${n.ref_id}`, n);
    outgoing.set(n.id, []);
    incoming.set(n.id, []);
  }
  for (const e of edges) {
    if (!nodesById.has(e.from_node) || !nodesById.has(e.to_node)) continue;
    outgoing.get(e.from_node).push(e);
    incoming.get(e.to_node).push(e);
  }
  return { nodesById, nodesByRef, outgoing, incoming };
}

/** Resolve a `${type}:${ref_id}` key to a node, or null. */
export function findNodeByRef(graph, node_type, ref_id) {
  return graph.nodesByRef.get(`${node_type}:${ref_id}`) ?? null;
}

/** Outgoing neighbors of a node, optionally filtered by edge_type. */
export function neighborsOut(graph, nodeId, edgeTypeFilter = null) {
  const edges = graph.outgoing.get(nodeId) ?? [];
  return edgeTypeFilter
    ? edges.filter((e) => e.edge_type === edgeTypeFilter)
    : edges;
}

/** Incoming edges to a node. */
export function neighborsIn(graph, nodeId, edgeTypeFilter = null) {
  const edges = graph.incoming.get(nodeId) ?? [];
  return edgeTypeFilter
    ? edges.filter((e) => e.edge_type === edgeTypeFilter)
    : edges;
}

/**
 * Detect simple cycles via Tarjan-style DFS. Returns an array of node-id
 * arrays (one per cycle). For our manufacturing graph cycles are usually a
 * data error (e.g. circular allocation), so the propagation engine uses this
 * only as a safety check.
 */
export function findCycles(graph) {
  const cycles = [];
  const indexMap = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  let index = 0;

  function strongconnect(v) {
    indexMap.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const e of graph.outgoing.get(v) ?? []) {
      const w = e.to_node;
      if (!indexMap.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indexMap.get(w)));
      }
    }

    if (lowlink.get(v) === indexMap.get(v)) {
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) cycles.push(scc);
    }
  }

  for (const id of graph.nodesById.keys()) {
    if (!indexMap.has(id)) strongconnect(id);
  }
  return cycles;
}

/** Number of nodes / edges — useful for snapshot fingerprints. */
export function graphSize(graph) {
  let edgeCount = 0;
  for (const list of graph.outgoing.values()) edgeCount += list.length;
  return { nodes: graph.nodesById.size, edges: edgeCount };
}
