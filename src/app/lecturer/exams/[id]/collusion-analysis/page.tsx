"use client";

/**
 * Cohort-Level Collusion Detection and Integrity Graph v1 — see
 * docs/cohort-collusion-graph-v1.md.
 *
 * Lecturer -> Exam -> Cohort integrity analysis. Every cluster shown here
 * is a REVIEW SIGNAL, never an automatic misconduct finding — see the
 * disclaimers rendered below and the neutral wording used throughout
 * this page ("possible coordinated-answer cluster", "needs lecturer
 * review", never "confirmed collusion" or "students cheated").
 */

import { useCallback, useEffect, useState, use as usePromise } from "react";
import Link from "next/link";

type EdgeRow = {
  id?: string;
  sourceSubmissionId: string;
  comparedSubmissionId: string;
  sourceStudentName: string;
  comparedStudentName: string;
  combinedScore: number;
  independentFamilyCount: number;
  eligibleForClustering?: boolean;
  familyScores: Record<string, number> | null;
  signals: Array<{ signalFamily: string; signalType: string; score: number; confidence: number; explanation: string; evidence: unknown }>;
};

type MemberRow = {
  submissionId: string;
  attemptNumber: number;
  studentId: string;
  studentName: string;
  studentEmail: string;
  supportingEdgeCount: number;
  independentFamilyCount: number;
  memberScore: number;
};

type ClusterRow = {
  id: string;
  clusterKey: string;
  memberCount: number;
  independentFamilyCount: number;
  edgeCount: number;
  concernLevel: "NONE" | "WATCH" | "NEEDS_REVIEW" | "HIGHER_CONCERN";
  concernLevelLabel: string;
  reviewStatus: string;
  reviewStatusLabel: string;
  reviewedAt: string | null;
  reviewedByName: string | null;
  reviewNote: string | null;
  summary: { topSignalFamilies?: string[] } | null;
  members: MemberRow[];
};

type AnalysisData = {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETE" | "FAILED" | "INSUFFICIENT_DATA";
  algorithmVersion: string;
  analysedAt: string | null;
  submissionCount: number;
  eligibleEdgeCount: number;
  clusterCount: number;
  overallReviewLevel: string;
  overallReviewLevelLabel: string;
  failureCode: string | null;
  clusters: ClusterRow[];
  edges: EdgeRow[];
};

const CONCERN_STYLES: Record<string, string> = {
  NONE: "bg-gray-100 text-gray-600",
  WATCH: "bg-blue-100 text-blue-700",
  NEEDS_REVIEW: "bg-yellow-100 text-yellow-700",
  HIGHER_CONCERN: "bg-orange-100 text-orange-800",
};

const REVIEW_STATUS_STYLES: Record<string, string> = {
  NEEDS_REVIEW: "bg-gray-100 text-gray-600",
  REVIEWED_NO_CONCERN: "bg-green-100 text-green-700",
  REVIEWED_CONCERN_REMAINS: "bg-yellow-100 text-yellow-700",
  ORAL_VERIFICATION_REQUESTED: "bg-purple-100 text-purple-700",
  ESCALATED: "bg-red-100 text-red-700",
  RESOLVED: "bg-blue-100 text-blue-700",
};

const FAMILY_LABELS: Record<string, string> = {
  ANSWER_CONTENT: "Answer content",
  RARE_MISTAKE: "Rare mistakes",
  MCQ_PATTERN: "Multiple-choice pattern",
  TIMING_SYNCHRONISATION: "Timing synchronisation",
  SESSION_NETWORK_DEVICE: "Shared network/device",
  CROSS_EXAM_RECURRENCE: "Cross-exam recurrence",
};

const REVIEW_ACTIONS: Array<{ status: string; label: string }> = [
  { status: "REVIEWED_NO_CONCERN", label: "Mark no concern" },
  { status: "NEEDS_REVIEW", label: "Keep under review" },
  { status: "ORAL_VERIFICATION_REQUESTED", label: "Request oral verification" },
  { status: "ESCALATED", label: "Escalate for academic-integrity review" },
  { status: "RESOLVED", label: "Resolve" },
];

const ALTERNATIVE_EXPLANATIONS = [
  "Shared university or accommodation network",
  "Common teaching materials or lecture notes",
  "Group study before the exam",
  "Required terminology or mandatory definitions",
  "Lecturer-provided starter code or templates",
  "A standard, widely-taught calculation method",
  "Accessibility adjustments (e.g. extra time, assistive technology)",
  "Coincidental timing",
  "Small cohort size, where patterns are more likely by chance",
];

export default function CohortCollusionAnalysisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: examId } = usePromise(params);
  const [data, setData] = useState<AnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [expandedClusterId, setExpandedClusterId] = useState<string | null>(null);
  const [reviewNoteDrafts, setReviewNoteDrafts] = useState<Record<string, string>>({});
  const [showGraph, setShowGraph] = useState<Record<string, boolean>>({});
  const [familyFilter, setFamilyFilter] = useState<string>("ALL");
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/lecturer/exams/${examId}/collusion-analysis`);
      if (!res.ok) {
        setLoadError(`Could not load cohort integrity analysis (status ${res.status}).`);
        return;
      }
      const body = await res.json();
      setData(body.analysis);
    } catch {
      setLoadError("Could not load cohort integrity analysis — check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [examId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function runAnalysis() {
    setRunning(true);
    setRunError(null);
    try {
      const res = await fetch(`/api/lecturer/exams/${examId}/collusion-analysis`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setRunError(typeof body?.error === "string" ? body.error : "Cohort integrity analysis failed. Submissions and grades are unaffected.");
        return;
      }
      await load();
    } catch {
      setRunError("Could not reach the server. Submissions and grades are unaffected — try again.");
    } finally {
      setRunning(false);
    }
  }

  async function submitClusterReview(clusterId: string, reviewStatus: string) {
    const reviewNote = reviewNoteDrafts[clusterId];
    const res = await fetch(`/api/lecturer/collusion-clusters/${clusterId}/review`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewStatus, reviewNote: reviewNote || undefined }),
    });
    if (res.ok) await load();
  }

  async function saveNoteOnly(clusterId: string) {
    const reviewNote = reviewNoteDrafts[clusterId];
    if (reviewNote == null) return;
    const res = await fetch(`/api/lecturer/collusion-clusters/${clusterId}/review`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewNote }),
    });
    if (res.ok) await load();
  }

  if (loading) return <p className="text-gray-500">Loading cohort integrity analysis...</p>;
  if (loadError) {
    return (
      <div className="mx-auto max-w-4xl">
        <p className="text-red-600">{loadError}</p>
        <button onClick={() => load()} className="mt-2 rounded border border-gray-300 px-3 py-1.5 text-sm">
          Try again
        </button>
      </div>
    );
  }

  const clustersNeedingReview = data?.clusters.filter((c) => c.reviewStatus === "NEEDS_REVIEW").length ?? 0;
  const studentsIncluded = new Set(data?.clusters.flatMap((c) => c.members.map((m) => m.studentId)) ?? []).size;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Cohort integrity analysis</h1>
        <Link href={`/lecturer/exams/${examId}`} className="text-sm underline">
          Back to exam
        </Link>
      </div>
      <p className="mt-2 rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
        Review possible coordinated-answer patterns supported by multiple independent signals. These indicators
        require lecturer judgement and do not determine misconduct.
      </p>

      <div className="mt-3 space-y-1 rounded border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">
        <p>Signals identify patterns requiring review — they are never proof of collaboration.</p>
        <p>Shared networks and similar answers may have legitimate explanations.</p>
        <p>No student is included based on only one shared IP, similarity score, or timing event.</p>
        <p>Lecturer judgement remains final. Analysis does not change grades or automatically create a misconduct finding.</p>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 rounded border border-gray-200 p-4 text-sm sm:grid-cols-3">
        <div>
          <p className="text-xs uppercase text-gray-500">Submitted attempts</p>
          <p className="mt-1">{data?.submissionCount ?? "—"}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Analysed pairs</p>
          <p className="mt-1">{data?.eligibleEdgeCount ?? "—"}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Possible clusters</p>
          <p className="mt-1">{data?.clusterCount ?? 0}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Students included in possible clusters</p>
          <p className="mt-1">{studentsIncluded}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Clusters needing review</p>
          <p className="mt-1">{clustersNeedingReview}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Last analysis time</p>
          <p className="mt-1">{data?.analysedAt ? new Date(data.analysedAt).toLocaleString() : "Never"}</p>
        </div>
      </div>

      <div className="mt-4">
        <button onClick={runAnalysis} disabled={running} className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50">
          {running ? "Running..." : "Run cohort integrity analysis"}
        </button>
        {runError && <p className="mt-2 text-sm text-red-600">{runError}</p>}
        {data?.status === "FAILED" && (
          <p className="mt-2 text-sm text-amber-700">The last analysis run failed — submissions and grades were not affected. Try running it again.</p>
        )}
        {data?.status === "INSUFFICIENT_DATA" && (
          <p className="mt-2 text-sm text-gray-600">Not enough submitted attempts yet for cohort-level analysis (at least 3 are needed).</p>
        )}
      </div>

      <h2 className="mt-8 text-lg font-medium">Possible coordinated-answer clusters</h2>
      <div className="mt-3 space-y-4">
        {(!data || data.clusters.length === 0) && (
          <p className="text-gray-500">No concern identified — no possible clusters found yet. Run the analysis above.</p>
        )}
        {data?.clusters.map((c) => {
          const expanded = expandedClusterId === c.id;
          const clusterEdges = data.edges.filter(
            (e) =>
              c.members.some((m) => m.submissionId === e.sourceSubmissionId) &&
              c.members.some((m) => m.submissionId === e.comparedSubmissionId),
          );
          const memberIndexById = new Map(c.members.map((m, i) => [m.submissionId, i]));
          const filteredEdges = familyFilter === "ALL" ? clusterEdges : clusterEdges.filter((e) => (e.familyScores ?? {})[familyFilter] != null);

          return (
            <div key={c.id} className="rounded border border-gray-200 p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Possible coordinated-answer cluster</span>
                <span className={`rounded px-2 py-0.5 text-xs ${CONCERN_STYLES[c.concernLevel]}`}>{c.concernLevelLabel}</span>
                <span className={`rounded px-2 py-0.5 text-xs ${REVIEW_STATUS_STYLES[c.reviewStatus] ?? "bg-gray-100 text-gray-600"}`}>
                  {c.reviewStatusLabel}
                </span>
              </div>
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-gray-700">
                <li>{c.memberCount} students</li>
                <li>{c.edgeCount} supported connections</li>
                <li>{c.independentFamilyCount} independent supporting signal families</li>
                {c.summary?.topSignalFamilies && c.summary.topSignalFamilies.includes("CROSS_EXAM_RECURRENCE") && (
                  <li>Cross-exam recurrence indicator present</li>
                )}
              </ul>

              <div className="mt-2">
                <p className="text-xs text-gray-500">Supporting signal families:</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {(c.summary?.topSignalFamilies ?? []).map((f) => (
                    <span key={f} className="rounded bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700">
                      {FAMILY_LABELS[f] ?? f}
                    </span>
                  ))}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => setExpandedClusterId(expanded ? null : c.id)}
                  className="rounded border border-gray-300 px-2 py-1 text-xs"
                >
                  {expanded ? "Hide details" : "Review cluster"}
                </button>
                {REVIEW_ACTIONS.map((action) => (
                  <button
                    key={action.status}
                    onClick={() => submitClusterReview(c.id, action.status)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs"
                  >
                    {action.label}
                  </button>
                ))}
              </div>

              <div className="mt-2">
                <input
                  type="text"
                  placeholder="Add a private note (visible to staff only)"
                  className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
                  value={reviewNoteDrafts[c.id] ?? c.reviewNote ?? ""}
                  onChange={(e) => setReviewNoteDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))}
                  onBlur={() => saveNoteOnly(c.id)}
                />
              </div>
              {c.reviewedByName && (
                <p className="mt-1 text-xs text-gray-400">
                  Reviewed by {c.reviewedByName}
                  {c.reviewedAt ? ` on ${new Date(c.reviewedAt).toLocaleString()}` : ""}
                </p>
              )}

              {expanded && (
                <div className="mt-4 border-t border-gray-100 pt-4">
                  <h3 className="text-sm font-medium">Members</h3>
                  <table className="mt-2 w-full text-left text-xs">
                    <thead>
                      <tr className="text-gray-500">
                        <th className="py-1 pr-2">Student</th>
                        <th className="py-1 pr-2">Attempt</th>
                        <th className="py-1 pr-2">Supporting connections</th>
                        <th className="py-1 pr-2">Independent families</th>
                        <th className="py-1 pr-2">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.members.map((m, i) => (
                        <tr key={m.submissionId} className="border-t border-gray-100">
                          <td className="py-1 pr-2">
                            S{i + 1} — {m.studentName}
                          </td>
                          <td className="py-1 pr-2">{m.attemptNumber}</td>
                          <td className="py-1 pr-2">{m.supportingEdgeCount}</td>
                          <td className="py-1 pr-2">{m.independentFamilyCount}</td>
                          <td className="py-1 pr-2">
                            <Link
                              href={`/lecturer/exams/${examId}/submissions/${m.submissionId}`}
                              className="rounded border border-gray-300 px-2 py-0.5 text-xs"
                            >
                              Request oral verification
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <h3 className="mt-4 text-sm font-medium">Signal-family matrix (pairwise connections)</h3>
                  <table className="mt-2 w-full text-left text-xs">
                    <thead>
                      <tr className="text-gray-500">
                        <th className="py-1 pr-2">Connection</th>
                        <th className="py-1 pr-2">Families</th>
                        <th className="py-1 pr-2">Combined support</th>
                      </tr>
                    </thead>
                    <tbody>
                      {clusterEdges.map((e) => (
                        <tr key={`${e.sourceSubmissionId}-${e.comparedSubmissionId}`} className="border-t border-gray-100">
                          <td className="py-1 pr-2">
                            S{(memberIndexById.get(e.sourceSubmissionId) ?? 0) + 1} ({e.sourceStudentName}) ↔ S
                            {(memberIndexById.get(e.comparedSubmissionId) ?? 0) + 1} ({e.comparedStudentName})
                          </td>
                          <td className="py-1 pr-2">{Object.keys(e.familyScores ?? {}).map((f) => FAMILY_LABELS[f] ?? f).join(", ")}</td>
                          <td className="py-1 pr-2">{e.combinedScore.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <h3 className="mt-4 text-sm font-medium">Question-level / signal evidence</h3>
                  <div className="mt-2 space-y-2">
                    {clusterEdges.flatMap((e) =>
                      e.signals.map((s, idx) => (
                        <div key={`${e.sourceSubmissionId}-${e.comparedSubmissionId}-${idx}`} className="rounded border border-gray-100 p-2">
                          <p className="text-xs font-medium">
                            {FAMILY_LABELS[s.signalFamily] ?? s.signalFamily} — {s.signalType}
                          </p>
                          <p className="text-xs text-gray-600">{s.explanation}</p>
                        </div>
                      )),
                    )}
                  </div>

                  <div className="mt-4">
                    <button
                      onClick={() => setShowGraph((prev) => ({ ...prev, [c.id]: !prev[c.id] }))}
                      className="rounded border border-gray-300 px-2 py-1 text-xs"
                    >
                      {showGraph[c.id] ? "Hide graph view" : "Show graph view"}
                    </button>
                    {showGraph[c.id] && (
                      <div className="mt-2">
                        <label className="text-xs text-gray-500">
                          Filter by signal family:{" "}
                          <select
                            value={familyFilter}
                            onChange={(e) => setFamilyFilter(e.target.value)}
                            className="rounded border border-gray-300 px-1 py-0.5 text-xs"
                          >
                            <option value="ALL">All families</option>
                            {Object.keys(FAMILY_LABELS).map((f) => (
                              <option key={f} value={f}>
                                {FAMILY_LABELS[f]}
                              </option>
                            ))}
                          </select>
                        </label>
                        <ClusterGraph
                          members={c.members}
                          edges={filteredEdges}
                          selectedEdgeKey={selectedEdgeKey}
                          onSelectEdge={setSelectedEdgeKey}
                        />
                        {selectedEdgeKey &&
                          (() => {
                            const edge = filteredEdges.find((e) => `${e.sourceSubmissionId}-${e.comparedSubmissionId}` === selectedEdgeKey);
                            if (!edge) return null;
                            return (
                              <div className="mt-2 rounded border border-gray-200 bg-gray-50 p-2 text-xs">
                                <p className="font-medium">
                                  {edge.sourceStudentName} ↔ {edge.comparedStudentName}
                                </p>
                                <p className="text-gray-600">Combined support: {edge.combinedScore.toFixed(2)}</p>
                                <ul className="mt-1 list-disc pl-4">
                                  {edge.signals.map((s, i) => (
                                    <li key={i}>{s.explanation}</li>
                                  ))}
                                </ul>
                              </div>
                            );
                          })()}
                        <p className="mt-1 text-xs text-gray-400">
                          The graph is one way to explore this cluster — every connection above is also listed as text in the
                          tables above.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <h2 className="mt-8 text-lg font-medium">Alternative explanations to consider</h2>
      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-gray-700">
        {ALTERNATIVE_EXPLANATIONS.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
    </div>
  );
}

function ClusterGraph({
  members,
  edges,
  selectedEdgeKey,
  onSelectEdge,
}: {
  members: MemberRow[];
  edges: EdgeRow[];
  selectedEdgeKey: string | null;
  onSelectEdge: (key: string) => void;
}) {
  const size = 260;
  const center = size / 2;
  const radius = size / 2 - 30;
  const positions = new Map<string, { x: number; y: number }>();
  members.forEach((m, i) => {
    const angle = (2 * Math.PI * i) / Math.max(members.length, 1) - Math.PI / 2;
    positions.set(m.submissionId, { x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle) });
  });
  const maxScore = Math.max(1, ...edges.map((e) => e.combinedScore));

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="mt-2 w-full max-w-xs rounded border border-gray-100 bg-white" role="img" aria-label="Cluster connection graph">
      {edges.map((e) => {
        const from = positions.get(e.sourceSubmissionId);
        const to = positions.get(e.comparedSubmissionId);
        if (!from || !to) return null;
        const key = `${e.sourceSubmissionId}-${e.comparedSubmissionId}`;
        const strokeWidth = 1 + (e.combinedScore / maxScore) * 4;
        return (
          <line
            key={key}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke={selectedEdgeKey === key ? "#4f46e5" : "#94a3b8"}
            strokeWidth={strokeWidth}
            style={{ cursor: "pointer" }}
            onClick={() => onSelectEdge(key)}
          />
        );
      })}
      {members.map((m, i) => {
        const pos = positions.get(m.submissionId);
        if (!pos) return null;
        return (
          <g key={m.submissionId}>
            <circle cx={pos.x} cy={pos.y} r={14} fill="#e0e7ff" stroke="#4f46e5" />
            <text x={pos.x} y={pos.y + 4} textAnchor="middle" fontSize="10" fill="#3730a3">
              S{i + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
