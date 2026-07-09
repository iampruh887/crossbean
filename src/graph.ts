// Build the knowledge graph: nodes = notes, edges are either
//   - "user": explicit [[wikilinks]] the author typed, or
//   - "ai":   pairs whose embeddings are similar above a threshold (cosine).
// AI edges never duplicate a user edge between the same pair.

import { knn, listNotes, notesWithBodies, resolveTitle, embeddedIds } from "./store";
import { parseWikilinks } from "./vault";

export interface GraphNode {
  id: number;
  title: string;
  degree: number;
  hasVec: boolean;
}
export interface GraphEdge {
  source: number;
  target: number;
  type: "user" | "ai";
  weight: number; // similarity for ai edges, 1 for user edges
}

const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

// Default threshold is tuned for all-MiniLM-L6-v2, whose cosine scores for
// related-but-distinct notes typically land in the 0.3–0.5 range.
export function buildGraph(threshold = 0.3, neighbors = 6) {
  const notes = listNotes();
  const nodes: GraphNode[] = notes.map((n) => ({
    id: n.id,
    title: n.title,
    degree: 0,
    hasVec: n.hasVec,
  }));

  const edges: GraphEdge[] = [];
  const userPairs = new Set<string>();

  // user edges: resolve [[wikilinks]] live from each note's body, so link
  // targets connect regardless of the order notes were created in.
  for (const n of notesWithBodies()) {
    for (const t of parseWikilinks(n.body)) {
      const dst = resolveTitle(t);
      if (!dst || dst === n.id) continue;
      const key = pairKey(n.id, dst);
      if (userPairs.has(key)) continue;
      userPairs.add(key);
      edges.push({ source: n.id, target: dst, type: "user", weight: 1 });
    }
  }

  // ai edges from vector similarity
  const aiPairs = new Set<string>();
  for (const id of embeddedIds()) {
    const hits = knn.length ? knnSafe(id, neighbors) : [];
    for (const h of hits) {
      if (h.id === id) continue;
      if (h.sim < threshold) continue;
      const key = pairKey(id, h.id);
      if (userPairs.has(key) || aiPairs.has(key)) continue;
      aiPairs.add(key);
      edges.push({ source: id, target: h.id, type: "ai", weight: h.sim });
    }
  }

  // degrees
  const deg = new Map<number, number>();
  for (const e of edges) {
    deg.set(e.source, (deg.get(e.source) || 0) + 1);
    deg.set(e.target, (deg.get(e.target) || 0) + 1);
  }
  for (const n of nodes) n.degree = deg.get(n.id) || 0;

  return { nodes, edges };
}

// query the vec index using a note's own stored embedding
import { getEmbedding } from "./store";
function knnSafe(id: number, k: number) {
  const v = getEmbedding(id);
  if (!v) return [];
  return knn(Array.from(v), k, id);
}

// Suggested links for a single note (used by the "suggest connections" action).
export function suggestFor(id: number, k = 8, threshold = 0.25) {
  const v = getEmbedding(id);
  if (!v) return [];
  const byId = new Map(listNotes().map((n) => [n.id, n.title]));
  return knn(Array.from(v), k, id)
    .filter((h) => h.sim >= threshold)
    .map((h) => ({ id: h.id, title: byId.get(h.id) || "?", sim: h.sim }));
}
