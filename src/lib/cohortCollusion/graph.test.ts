import { describe, it, expect } from "vitest";
import {
  buildPairEdge,
  buildClusters,
  computeFamilyScores,
  pruneUnsupportedMembers,
  findConnectedComponents,
  overallReviewLevelFromClusters,
  type PairEdgeResult,
} from "./graph";
import type { PairSignal } from "./types";

function signal(family: PairSignal["signalFamily"], score: number, signalType = "TEST"): PairSignal {
  return { signalFamily: family, signalType, score, confidence: 0.8, explanation: "test", evidence: {} };
}

describe("computeFamilyScores / buildPairEdge — pair eligibility (Part 10)", () => {
  it("one shared IP (SESSION_NETWORK_DEVICE only) creates no eligible edge", () => {
    const edge = buildPairEdge("a", "b", [signal("SESSION_NETWORK_DEVICE", 1)]);
    expect(edge!.independentFamilyCount).toBe(1);
    expect(edge!.eligibleForClustering).toBe(false);
  });

  it("one device match (SESSION_NETWORK_DEVICE only) creates no eligible edge", () => {
    const edge = buildPairEdge("a", "b", [signal("SESSION_NETWORK_DEVICE", 1, "REPEATED_SHARED_DEVICE")]);
    expect(edge!.eligibleForClustering).toBe(false);
  });

  it("one high similarity score (ANSWER_CONTENT only) creates no eligible edge", () => {
    const edge = buildPairEdge("a", "b", [signal("ANSWER_CONTENT", 1, "HIGH_WRITTEN_SIMILARITY")]);
    expect(edge!.independentFamilyCount).toBe(1);
    expect(edge!.eligibleForClustering).toBe(false);
  });

  it("one timing event (TIMING_SYNCHRONISATION only) creates no eligible edge", () => {
    const edge = buildPairEdge("a", "b", [signal("TIMING_SYNCHRONISATION", 1, "SYNCHRONISED_ANSWER_TIMES")]);
    expect(edge!.eligibleForClustering).toBe(false);
  });

  it("several signals from one family still count as one family", () => {
    const scores = computeFamilyScores([
      signal("ANSWER_CONTENT", 0.9, "HIGH_WRITTEN_SIMILARITY"),
      signal("ANSWER_CONTENT", 0.8, "IDENTICAL_NONTRIVIAL_RESPONSE"),
      signal("ANSWER_CONTENT", 0.7, "UNUSUAL_PHRASE_MATCH"),
    ]);
    expect(Object.keys(scores)).toEqual(["ANSWER_CONTENT"]);
    const edge = buildPairEdge("a", "b", [
      signal("ANSWER_CONTENT", 0.9, "HIGH_WRITTEN_SIMILARITY"),
      signal("ANSWER_CONTENT", 0.8, "IDENTICAL_NONTRIVIAL_RESPONSE"),
      signal("ANSWER_CONTENT", 0.7, "UNUSUAL_PHRASE_MATCH"),
    ]);
    expect(edge!.independentFamilyCount).toBe(1);
    expect(edge!.eligibleForClustering).toBe(false); // still only one family, regardless of score
  });

  it("two independent weak families below threshold create no eligible edge", () => {
    // SESSION_NETWORK_DEVICE cap 0.2, CROSS_EXAM_RECURRENCE weak raw score -> combined well under 0.5.
    const edge = buildPairEdge("a", "b", [
      signal("SESSION_NETWORK_DEVICE", 1, "REPEATED_SHARED_NETWORK"),
      signal("CROSS_EXAM_RECURRENCE", 0.15, "REPEATED_PAIR_SIMILARITY"),
    ]);
    expect(edge!.independentFamilyCount).toBe(2);
    expect(edge!.combinedScore).toBeLessThan(0.5);
    expect(edge!.eligibleForClustering).toBe(false);
  });

  it("two independent sufficiently strong families create an eligible edge", () => {
    const edge = buildPairEdge("a", "b", [
      signal("ANSWER_CONTENT", 1, "HIGH_WRITTEN_SIMILARITY"),
      signal("MCQ_PATTERN", 1, "HIGH_MCQ_SEQUENCE_SIMILARITY"),
    ]);
    expect(edge!.independentFamilyCount).toBe(2);
    expect(edge!.combinedScore).toBeGreaterThanOrEqual(0.5);
    expect(edge!.eligibleForClustering).toBe(true);
  });

  it("family score caps prevent one family dominating", () => {
    const scores = computeFamilyScores([signal("ANSWER_CONTENT", 5)]);
    expect(scores.ANSWER_CONTENT).toBeLessThanOrEqual(0.4);
    // Even an absurdly high raw score in one family, paired with another
    // absurdly high raw score in a second family, cannot exceed the sum
    // of the two caps.
    const edge = buildPairEdge("a", "b", [signal("ANSWER_CONTENT", 100), signal("RARE_MISTAKE", 100)]);
    expect(edge!.combinedScore).toBeCloseTo(0.4 + 0.4, 5);
  });
});

function edgeBetween(a: string, b: string, signals: PairSignal[]): PairEdgeResult {
  const edge = buildPairEdge(a, b, signals);
  if (!edge) throw new Error("expected an edge");
  return edge;
}

describe("buildClusters — cluster eligibility (Part 10)", () => {
  it("two students never form a cluster", () => {
    const edges = [edgeBetween("s1", "s2", [signal("ANSWER_CONTENT", 1), signal("MCQ_PATTERN", 1)])];
    expect(buildClusters(edges)).toHaveLength(0);
  });

  it("three students connected only by shared IP never form a cluster", () => {
    const edges = [
      edgeBetween("s1", "s2", [signal("SESSION_NETWORK_DEVICE", 1)]),
      edgeBetween("s2", "s3", [signal("SESSION_NETWORK_DEVICE", 1)]),
      edgeBetween("s1", "s3", [signal("SESSION_NETWORK_DEVICE", 1)]),
    ];
    // None of these edges are even eligible (single family each), so no component forms at all.
    expect(buildClusters(edges)).toHaveLength(0);
  });

  it("three students with eligible edges but only two total families never form a cluster", () => {
    const edges = [
      edgeBetween("s1", "s2", [signal("ANSWER_CONTENT", 1), signal("MCQ_PATTERN", 1)]),
      edgeBetween("s2", "s3", [signal("ANSWER_CONTENT", 1), signal("MCQ_PATTERN", 1)]),
      edgeBetween("s1", "s3", [signal("ANSWER_CONTENT", 1), signal("MCQ_PATTERN", 1)]),
    ];
    expect(buildClusters(edges)).toHaveLength(0);
  });

  it("three students with three independent families form a review cluster", () => {
    const edges = [
      edgeBetween("s1", "s2", [signal("ANSWER_CONTENT", 1), signal("MCQ_PATTERN", 1)]),
      edgeBetween("s2", "s3", [signal("MCQ_PATTERN", 1), signal("TIMING_SYNCHRONISATION", 1)]),
      edgeBetween("s1", "s3", [signal("ANSWER_CONTENT", 1), signal("TIMING_SYNCHRONISATION", 1)]),
    ];
    const clusters = buildClusters(edges);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].memberSubmissionIds.sort()).toEqual(["s1", "s2", "s3"]);
    expect(clusters[0].independentFamilyCount).toBe(3);
    expect(["NEEDS_REVIEW", "HIGHER_CONCERN"]).toContain(clusters[0].concernLevel);
  });

  it("unsupported peripheral members are removed (isolated member solely via weak shared-network support)", () => {
    // Strong triangle s1/s2/s3 with 3 independent families.
    const coreEdges = [
      edgeBetween("s1", "s2", [signal("ANSWER_CONTENT", 1), signal("MCQ_PATTERN", 1)]),
      edgeBetween("s2", "s3", [signal("MCQ_PATTERN", 1), signal("TIMING_SYNCHRONISATION", 1)]),
      edgeBetween("s1", "s3", [signal("ANSWER_CONTENT", 1), signal("TIMING_SYNCHRONISATION", 1)]),
    ];
    // s4 connects to s1 ONLY via a network+cross-exam edge (both weak-support-only families) — technically eligible (2 families, score right at threshold), but must not survive as a genuine cluster member.
    const peripheralEdge = edgeBetween("s1", "s4", [
      signal("SESSION_NETWORK_DEVICE", 1, "REPEATED_SHARED_NETWORK"),
      signal("CROSS_EXAM_RECURRENCE", 1, "REPEATED_PAIR_SIMILARITY"),
    ]);
    expect(peripheralEdge.eligibleForClustering).toBe(true); // confirms this is a real test of pruning, not just non-eligibility

    const clusters = buildClusters([...coreEdges, peripheralEdge]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].memberSubmissionIds).not.toContain("s4");
    expect(clusters[0].memberSubmissionIds.sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("cluster is discarded if fewer than three supported members remain after pruning", () => {
    // s1-s2 strong pair, s3 only connects via a weak-support-only edge to s1 — after pruning s3 is removed, leaving only 2 members.
    const edges = [
      edgeBetween("s1", "s2", [signal("ANSWER_CONTENT", 1), signal("MCQ_PATTERN", 1), signal("TIMING_SYNCHRONISATION", 1)]),
      edgeBetween("s1", "s3", [signal("SESSION_NETWORK_DEVICE", 1), signal("CROSS_EXAM_RECURRENCE", 1)]),
    ];
    expect(buildClusters(edges)).toHaveLength(0);
  });

  it("repeated cross-exam evidence strengthens but does not independently create a cluster", () => {
    // CROSS_EXAM_RECURRENCE combined with only SESSION_NETWORK_DEVICE (both weak-only) across a whole triangle must never form a cluster, no matter how "repeated" the recurrence signal is scored.
    const edges = [
      edgeBetween("s1", "s2", [signal("SESSION_NETWORK_DEVICE", 1), signal("CROSS_EXAM_RECURRENCE", 1)]),
      edgeBetween("s2", "s3", [signal("SESSION_NETWORK_DEVICE", 1), signal("CROSS_EXAM_RECURRENCE", 1)]),
      edgeBetween("s1", "s3", [signal("SESSION_NETWORK_DEVICE", 1), signal("CROSS_EXAM_RECURRENCE", 1)]),
    ];
    expect(buildClusters(edges)).toHaveLength(0);
  });

  it("a student is never given cluster status merely for appearing in one weak pair, even inside an otherwise-eligible edge count", () => {
    const edges = [
      edgeBetween("s1", "s2", [signal("ANSWER_CONTENT", 1), signal("MCQ_PATTERN", 1)]),
      edgeBetween("s2", "s3", [signal("MCQ_PATTERN", 1), signal("TIMING_SYNCHRONISATION", 1)]),
      edgeBetween("s1", "s3", [signal("ANSWER_CONTENT", 1), signal("TIMING_SYNCHRONISATION", 1)]),
    ];
    const clusters = buildClusters(edges);
    const members = clusters[0]!.memberSubmissionIds;
    // Every member must have a real (>= MIN_INDEPENDENT_FAMILIES_FOR_EDGE) supporting edge, not just appear once.
    for (const m of members) {
      const memberEdges = clusters[0]!.edges.filter((e) => e.sourceSubmissionId === m || e.comparedSubmissionId === m);
      expect(memberEdges.length).toBeGreaterThanOrEqual(1);
      expect(memberEdges.every((e) => e.independentFamilyCount >= 2)).toBe(true);
    }
  });
});

describe("pruneUnsupportedMembers", () => {
  it("removes a member whose only edges are weak-support-only, even across multiple such edges", () => {
    const edgesByKey = new Map<string, PairEdgeResult>();
    const e1 = edgeBetween("s1", "s2", [signal("ANSWER_CONTENT", 1), signal("MCQ_PATTERN", 1)]);
    const e2 = edgeBetween("s1", "s3", [signal("SESSION_NETWORK_DEVICE", 1)]);
    edgesByKey.set("s1|s2", e1);
    edgesByKey.set("s1|s3", e2);
    const { members, removed } = pruneUnsupportedMembers(["s1", "s2", "s3"], edgesByKey);
    expect(removed).toContain("s3");
    expect(members.has("s3")).toBe(false);
  });
});

describe("findConnectedComponents", () => {
  it("groups only via eligible edges and leaves disjoint pairs separate", () => {
    const e1 = edgeBetween("s1", "s2", [signal("ANSWER_CONTENT", 1), signal("MCQ_PATTERN", 1)]);
    const e2 = edgeBetween("s3", "s4", [signal("ANSWER_CONTENT", 1), signal("MCQ_PATTERN", 1)]);
    const components = findConnectedComponents([e1, e2]);
    expect(components).toHaveLength(2);
  });
});

describe("overallReviewLevelFromClusters", () => {
  it("is NONE when there are no clusters", () => {
    expect(overallReviewLevelFromClusters([])).toBe("NONE");
  });
});
