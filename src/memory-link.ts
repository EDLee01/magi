import { MemoryEdgeRelation, MemoryNodeStore } from "./memory-node-store.js";
import { syncMemoryGraph } from "./memory-wiki-indexer.js";
import { MagiPaths } from "./paths.js";
import { MemoryRootOptions } from "./memory-files.js";

const VALID_RELATIONS = new Set<MemoryEdgeRelation>([
  "relates_to",
  "belongs_to",
  "depends_on",
  "supersedes",
  "conflicts_with",
  "derived_from",
  "uses_skill"
]);

export interface LinkMemoryNodesInput extends MemoryRootOptions {
  paths: MagiPaths;
  from: string;
  to: string;
  relation?: string;
  weight?: number;
}

export interface LinkMemoryNodesResult {
  edgeId: number;
  fromNodeId: string;
  toNodeId: string;
  relation: MemoryEdgeRelation;
  weight: number;
  fromTitle: string;
  toTitle: string;
}

export function linkMemoryNodes(input: LinkMemoryNodesInput): LinkMemoryNodesResult {
  syncMemoryGraph({ appRoot: input.appRoot, root: input.root, paths: input.paths });
  const relation = readRelation(input.relation);
  const weight = input.weight ?? 0.7;
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
    throw new Error("Memory link weight must be a number between 0 and 1");
  }

  const store = MemoryNodeStore.open(input.paths);
  try {
    const from = resolveNode(store, input.from, "from");
    const to = resolveNode(store, input.to, "to");
    if (from.id === to.id) {
      throw new Error("Memory link cannot connect a node to itself");
    }
    const edge = store.addEdge({
      fromNodeId: from.id,
      toNodeId: to.id,
      relation,
      weight,
      metadata: { source: "cli" }
    });
    return {
      edgeId: edge.id,
      fromNodeId: from.id,
      toNodeId: to.id,
      relation: edge.relation,
      weight: edge.weight,
      fromTitle: from.title,
      toTitle: to.title
    };
  } finally {
    store.close();
  }
}

export function formatMemoryLinkResult(result: LinkMemoryNodesResult): string {
  return [
    `Linked Memory nodes: ${result.edgeId}`,
    `${result.fromTitle} (${result.fromNodeId})`,
    `${result.relation} -> ${result.toTitle} (${result.toNodeId})`,
    `weight: ${result.weight.toFixed(2)}`
  ].join("\n");
}

function readRelation(value: string | undefined): MemoryEdgeRelation {
  const relation = (value?.trim() || "relates_to") as MemoryEdgeRelation;
  if (!VALID_RELATIONS.has(relation)) {
    throw new Error(`Invalid Memory relation: ${value}`);
  }
  return relation;
}

function resolveNode(
  store: MemoryNodeStore,
  ref: string,
  label: "from" | "to"
): { id: string; title: string } {
  const value = ref.trim();
  if (!value) {
    throw new Error(`Memory link --${label} must not be empty`);
  }
  const byId = store.getNode(value);
  if (byId?.status === "active") {
    return { id: byId.id, title: byId.title };
  }

  const hits = store.searchGraph({ query: value, limit: 3, minScore: 1 });
  if (hits.length === 0) {
    throw new Error(`Memory node not found for --${label}: ${value}`);
  }
  const exact = hits.filter(
    (hit) =>
      hit.node.title.toLowerCase() === value.toLowerCase() ||
      hit.chunk.heading.toLowerCase() === value.toLowerCase()
  );
  const candidates = exact.length > 0 ? exact : hits;
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
    throw new Error(`Memory node reference is ambiguous for --${label}: ${value}`);
  }
  return { id: candidates[0].node.id, title: candidates[0].node.title };
}
