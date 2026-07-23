/**
 * Cohort-Level Collusion Detection and Integrity Graph v1 — pair
 * eligibility, connected-component clustering, and cluster eligibility.
 * See docs/cohort-collusion-graph-v1.md, Part 3 ("the most important
 * safety requirement").
 *
 * Pure, dependency-free, deterministic: no Prisma, no Next.js, no
 * randomness. A transparent connected-component approach over eligible
 * edges — deliberately NOT an opaque machine-learning model, so every
 * cluster is explainable in the lecturer interface.
 *
 * THIS PRODUCES REVIEW SIGNALS ONLY. Nothing here ever decides
 * misconduct — it decides only whether a pattern is structurally strong
 * and diverse enough to surface for lecturer review.
 */
import {
  SIGNAL_FAMILIES,
  type SignalFamily,
  FAMILY_SCORE_CAPS,
  MIN_INDEPENDENT_FAMILIES_FOR_EDGE,
  PAIR_ELIGIBILITY_SCORE_THRESHOLD,
  MIN_CLUSTER_MEMBERS,
  MIN_CLUSTER_INDEPENDENT_FAMILIES,
  MIN_MEMBER_SUPPORTING_EDGES,
  HIGHER_CONCERN_MIN_INDEPENDENT_FAMILIES,
  HIGHER_CONCERN_MIN_STRONG_EDGES,
  STRONG_EDGE_SCORE_THRESHOLD,
  HIGHER_CONCERN_MIN_CROSS_EXAM_RECURRENCE_COUNT,
  STRONG_FAMILY_SCORE_FRACTION_OF_CAP,
  CLUSTER_NEEDS_REVIEW_MIN_AVG_EDGE_SCORE,
  WEAK_SUPPORT_ONLY_FAMILIES,
} from "@/lib/cohortCollusionThresholds";
import { canonicalSubmissionPair, type PairSignal } from "./types";

// ---------------------------------------------------------------------------
// Cluster-level validated string values
// ---------------------------------------------------------------------------

export const CONCERN_LEVELS = ["NONE", "WATCH", "NEEDS_REVIEW", "HIGHER_CONCERN"] as const;
export type ConcernLevel = (typeof CONCERN_LEVELS)[number];

export const CLUSTER_REVIEW_STATUSES = [
  "NEEDS_REVIEW",
  "REVIEWED_NO_CONCERN",
  "REVIEWED_CONCERN_REMAINS",
  "ORAL_VERIFICATION_REQUESTED",
  "ESCALATED",
  "RESOLVED",
] as const;
export type ClusterReviewStatus = (typeof CLUSTER_REVIEW_STATUSES)[number];

export function isValidClusterReviewStatus(value: string): value is ClusterReviewStatus {
  return (CLUSTER_REVIEW_STATUSES as readonly string[]).includes(value);
}

/** Required neutral wording — see docs/cohort-collusion-graph-v1.md. Never "confirmed collusion" / "students cheated". */
export const CLUSTER_REVIEW_STATUS_LABELS: Record<ClusterReviewStatus, string> = {
  NEEDS_REVIEW: "Needs review",
  REVIEWED_NO_CONCERN: "Reviewed — no concern",
  REVIEWED_CONCERN_REMAINS: "Concern remains",
  ORAL_VERIFICATION_REQUESTED: "Oral verification requested",
  ESCALATED: "Escalated",
  RESOLVED: "Resolved",
};

export const CONCERN_LEVEL_LABELS: Record<ConcernLevel, string> = {
  NONE: "No concern identified",
  WATCH: "Watch",
  NEEDS_REVIEW: "Needs review",
  HIGHER_CONCERN: "Higher concern",
};

export const ANALYSIS_STATUSES = ["PENDING", "PROCESSING", "COMPLETE", "FAILED", "INSUFFICIENT_DATA"] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

// ---------------------------------------------------------------------------
// Part 3.1 — Pair-edge eligibility
// ---------------------------------------------------------------------------

export type FamilyScores = Partial<Record<SignalFamily, number>>;

/**
 * Reduces every signal in a family to ONE capped contribution — the
 * strongest single signal in that family, capped at FAMILY_SCORE_CAPS.
 * Multiple signals from the same family (e.g. three ANSWER_CONTENT
 * detections) are never additive: "three answer-content signals do not
 * equal three independent families", and no family can dominate the
 * combined score regardless of how many or how strong its own signals
 * are.
 */
export function computeFamilyScores(signals: PairSignal[]): FamilyScores {
  const maxRawByFamily = new Map<SignalFamily, number>();
  for (const s of signals) {
    const current = maxRawByFamily.get(s.signalFamily) ?? 0;
    if (s.score > current) maxRawByFamily.set(s.signalFamily, s.score);
  }
  const result: FamilyScores = {};
  for (const family of SIGNAL_FAMILIES) {
    const raw = maxRawByFamily.get(family);
    if (raw != null) result[family] = Math.min(FAMILY_SCORE_CAPS[family], Math.max(0, raw));
  }
  return result;
}

export type PairEdgeResult = {
  sourceSubmissionId: string;
  comparedSubmissionId: string;
  combinedScore: number;
  independentFamilyCount: number;
  eligibleForClustering: boolean;
  familyScores: FamilyScores;
  signals: PairSignal[];
};

/**
 * Builds one pair edge from every signal found for that pair, across all
 * six families. Returns null when there are no signals at all (no edge
 * is ever created for a pair with nothing to show). eligibleForClustering
 * requires BOTH >= MIN_INDEPENDENT_FAMILIES_FOR_EDGE independent families
 * AND combinedScore >= PAIR_ELIGIBILITY_SCORE_THRESHOLD — see the module
 * doc comment. Neither condition alone is ever sufficient: because every
 * FAMILY_SCORE_CAPS entry is below the threshold, a single family can
 * never reach the threshold by itself even if the family-count check were
 * somehow bypassed.
 */
export function buildPairEdge(submissionIdA: string, submissionIdB: string, signals: PairSignal[]): PairEdgeResult | null {
  if (signals.length === 0) return null;
  const [sourceSubmissionId, comparedSubmissionId] = canonicalSubmissionPair(submissionIdA, submissionIdB);
  const familyScores = computeFamilyScores(signals);
  const independentFamilyCount = Object.keys(familyScores).length;
  const combinedScore = Object.values(familyScores).reduce((sum, v) => sum + (v ?? 0), 0);
  const eligibleForClustering =
    independentFamilyCount >= MIN_INDEPENDENT_FAMILIES_FOR_EDGE && combinedScore >= PAIR_ELIGIBILITY_SCORE_THRESHOLD;
  return { sourceSubmissionId, comparedSubmissionId, combinedScore, independentFamilyCount, eligibleForClustering, familyScores, signals };
}

// ---------------------------------------------------------------------------
// Part 3.2 — Connected components over ELIGIBLE edges only
// ---------------------------------------------------------------------------

function pairKey(a: string, b: string): string {
  return canonicalSubmissionPair(a, b).join("|");
}

/** Simple union-find over eligible edges only — ineligible edges never connect anyone. */
export function findConnectedComponents(eligibleEdges: PairEdgeResult[]): string[][] {
  const parent = new Map<string, string>();
  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const edge of eligibleEdges) {
    find(edge.sourceSubmissionId);
    find(edge.comparedSubmissionId);
    union(edge.sourceSubmissionId, edge.comparedSubmissionId);
  }

  const groups = new Map<string, Set<string>>();
  for (const id of parent.keys()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root)!.add(id);
  }
  return [...groups.values()].map((set) => [...set]);
}

// ---------------------------------------------------------------------------
// Part 3.3 — Cluster eligibility: minimum size/diversity + weak-member pruning
// ---------------------------------------------------------------------------

/** Union of signal families across every edge connecting `members` to each other (edges fully inside the member set). */
function familyUnionWithinMembers(members: Set<string>, edgesByKey: Map<string, PairEdgeResult>): Set<SignalFamily> {
  const union = new Set<SignalFamily>();
  for (const edge of edgesByKey.values()) {
    if (members.has(edge.sourceSubmissionId) && members.has(edge.comparedSubmissionId)) {
      for (const family of Object.keys(edge.familyScores) as SignalFamily[]) union.add(family);
    }
  }
  return union;
}

/** Every edge connecting `members` to each other. */
function edgesWithinMembers(members: Set<string>, edgesByKey: Map<string, PairEdgeResult>): PairEdgeResult[] {
  return [...edgesByKey.values()].filter((e) => members.has(e.sourceSubmissionId) && members.has(e.comparedSubmissionId));
}

const WEAK_SUPPORT_ONLY_FAMILY_SET = new Set<SignalFamily>(WEAK_SUPPORT_ONLY_FAMILIES);

/**
 * Iteratively removes members whose ENTIRE support within the remaining
 * cluster comes only from WEAK_SUPPORT_ONLY_FAMILIES (a shared network/
 * device and/or bare cross-exam recurrence, with no other family present
 * on ANY of their edges into the cluster), or who have fewer than
 * MIN_MEMBER_SUPPORTING_EDGES edges into the remaining cluster. This is
 * "no isolated member included solely through a weak shared-network
 * relationship" (Part 3), generalised to every family that is explicitly
 * supporting-evidence-only. Removing one member can make another member
 * newly unsupported, so this repeats until stable — "recalculate the
 * component" (Part 4).
 */
export function pruneUnsupportedMembers(
  initialMembers: string[],
  edgesByKey: Map<string, PairEdgeResult>,
): { members: Set<string>; removed: string[] } {
  const members = new Set(initialMembers);
  const removed: string[] = [];

  let changed = true;
  while (changed) {
    changed = false;
    for (const member of [...members]) {
      const memberEdges = edgesWithinMembers(members, edgesByKey).filter(
        (e) => e.sourceSubmissionId === member || e.comparedSubmissionId === member,
      );
      if (memberEdges.length < MIN_MEMBER_SUPPORTING_EDGES) {
        members.delete(member);
        removed.push(member);
        changed = true;
        continue;
      }
      const familiesExcludingWeakSupport = new Set<SignalFamily>();
      for (const e of memberEdges) {
        for (const family of Object.keys(e.familyScores) as SignalFamily[]) {
          if (!WEAK_SUPPORT_ONLY_FAMILY_SET.has(family)) familiesExcludingWeakSupport.add(family);
        }
      }
      if (familiesExcludingWeakSupport.size === 0) {
        members.delete(member);
        removed.push(member);
        changed = true;
      }
    }
  }

  return { members, removed };
}

export type ClusterCandidate = {
  memberSubmissionIds: string[];
  edges: PairEdgeResult[];
  independentFamilyCount: number;
  concernLevel: ConcernLevel;
};

function averageEdgeScore(edges: PairEdgeResult[]): number {
  if (edges.length === 0) return 0;
  return edges.reduce((sum, e) => sum + e.combinedScore, 0) / edges.length;
}

function isFamilyStrong(familyScores: FamilyScores, family: SignalFamily): boolean {
  const score = familyScores[family];
  if (score == null) return false;
  return score >= FAMILY_SCORE_CAPS[family] * STRONG_FAMILY_SCORE_FRACTION_OF_CAP;
}

/**
 * HIGHER_CONCERN requires meaningfully more than the NEEDS_REVIEW
 * minimum (Part 3): 4+ independent families across the cluster, OR
 * repeated cross-exam recurrence, OR multiple strong eligible edges, OR
 * strong rare-mistake + timing evidence together on the same edge.
 */
function computeConcernLevel(edges: PairEdgeResult[], independentFamilyCount: number): ConcernLevel {
  if (independentFamilyCount >= HIGHER_CONCERN_MIN_INDEPENDENT_FAMILIES) return "HIGHER_CONCERN";

  const strongEdgeCount = edges.filter((e) => e.combinedScore >= STRONG_EDGE_SCORE_THRESHOLD).length;
  if (strongEdgeCount >= HIGHER_CONCERN_MIN_STRONG_EDGES) return "HIGHER_CONCERN";

  const recurrenceEdges = edges.filter((e) => e.familyScores.CROSS_EXAM_RECURRENCE != null);
  if (recurrenceEdges.length >= HIGHER_CONCERN_MIN_CROSS_EXAM_RECURRENCE_COUNT) return "HIGHER_CONCERN";

  const hasStrongRareMistakeAndTiming = edges.some(
    (e) => isFamilyStrong(e.familyScores, "RARE_MISTAKE") && isFamilyStrong(e.familyScores, "TIMING_SYNCHRONISATION"),
  );
  if (hasStrongRareMistakeAndTiming) return "HIGHER_CONCERN";

  if (averageEdgeScore(edges) >= CLUSTER_NEEDS_REVIEW_MIN_AVG_EDGE_SCORE) return "NEEDS_REVIEW";
  return "WATCH";
}

/**
 * Builds every possible coordinated-answer cluster from a set of pair
 * edges (eligible AND ineligible — only eligible ones ever connect a
 * component). For each connected component: verify minimum member count,
 * verify family diversity, remove unsupported members, recalculate, and
 * discard the whole component if it no longer qualifies. Never creates a
 * cluster from fewer than MIN_CLUSTER_MEMBERS members or fewer than
 * MIN_CLUSTER_INDEPENDENT_FAMILIES families.
 */
export function buildClusters(allEdges: PairEdgeResult[]): ClusterCandidate[] {
  const eligibleEdges = allEdges.filter((e) => e.eligibleForClustering);
  const edgesByKey = new Map(eligibleEdges.map((e) => [pairKey(e.sourceSubmissionId, e.comparedSubmissionId), e]));
  const components = findConnectedComponents(eligibleEdges);

  const clusters: ClusterCandidate[] = [];
  for (const component of components) {
    if (component.length < MIN_CLUSTER_MEMBERS) continue;

    const { members } = pruneUnsupportedMembers(component, edgesByKey);
    if (members.size < MIN_CLUSTER_MEMBERS) continue;

    const edges = edgesWithinMembers(members, edgesByKey);
    const independentFamilyCount = familyUnionWithinMembers(members, edgesByKey).size;
    if (independentFamilyCount < MIN_CLUSTER_INDEPENDENT_FAMILIES) continue;

    // A pruned member set can end up disconnected — only keep the
    // largest remaining connected sub-component so a cluster is never
    // reported with members that no longer have a path to each other.
    const reconnected = findConnectedComponents(edges).filter((c) => c.length >= MIN_CLUSTER_MEMBERS);
    if (reconnected.length === 0) continue;
    const largest = reconnected.reduce((a, b) => (b.length > a.length ? b : a));
    const finalMembers = new Set(largest);
    const finalEdges = edgesWithinMembers(finalMembers, edgesByKey);
    const finalFamilyCount = familyUnionWithinMembers(finalMembers, edgesByKey).size;
    if (finalFamilyCount < MIN_CLUSTER_INDEPENDENT_FAMILIES) continue;

    clusters.push({
      memberSubmissionIds: [...finalMembers].sort(),
      edges: finalEdges,
      independentFamilyCount: finalFamilyCount,
      concernLevel: computeConcernLevel(finalEdges, finalFamilyCount),
    });
  }
  return clusters;
}

/** Stable, deterministic cluster identifier from its sorted member submission ids — a re-run of the same underlying pattern updates the same row rather than creating a duplicate. */
export function clusterKeyForMembers(memberSubmissionIds: string[]): string {
  return [...memberSubmissionIds].sort().join("|");
}

export type ClusterMemberResult = {
  submissionId: string;
  supportingEdgeCount: number;
  independentFamilyCount: number;
  memberScore: number;
};

/** Per-member support WITHIN one cluster — a member's own edges only, never the cluster's totals. Used both for display and to guarantee "a student must never receive a cluster-level status merely because they appear in one weak pair." */
export function computeClusterMembers(cluster: ClusterCandidate): ClusterMemberResult[] {
  const results: ClusterMemberResult[] = [];
  for (const submissionId of cluster.memberSubmissionIds) {
    const memberEdges = cluster.edges.filter((e) => e.sourceSubmissionId === submissionId || e.comparedSubmissionId === submissionId);
    const families = new Set<SignalFamily>();
    for (const e of memberEdges) for (const f of Object.keys(e.familyScores) as SignalFamily[]) families.add(f);
    results.push({
      submissionId,
      supportingEdgeCount: memberEdges.length,
      independentFamilyCount: families.size,
      memberScore: memberEdges.length === 0 ? 0 : memberEdges.reduce((s, e) => s + e.combinedScore, 0) / memberEdges.length,
    });
  }
  return results;
}

/** Analysis-level overallReviewLevel = the highest concernLevel of any cluster produced, or NONE when no cluster qualified. */
export function overallReviewLevelFromClusters(clusters: ClusterCandidate[]): ConcernLevel {
  if (clusters.some((c) => c.concernLevel === "HIGHER_CONCERN")) return "HIGHER_CONCERN";
  if (clusters.some((c) => c.concernLevel === "NEEDS_REVIEW")) return "NEEDS_REVIEW";
  if (clusters.some((c) => c.concernLevel === "WATCH")) return "WATCH";
  return "NONE";
}
