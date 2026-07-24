"use client";

import { use as usePromise, useMemo, useState, useEffect } from "react";
import Link from "next/link";
import { diffAnswerText, type DiffSegment } from "@/lib/answerDevelopmentDiff";

type VersionRow = {
  id: string;
  versionNumber: number;
  changeType: string;
  source: string;
  responseText: string;
  responseLength: number;
  charactersAdded: number;
  charactersRemoved: number;
  changeRatio: number;
  serverReceivedAt: string;
};
type EventRow = { id: string; eventType: string; eventLevel: string; serverReceivedAt: string; metadata: unknown };
type Observation = { code: string; recommendation: string; explanation: string };
type QuestionData = { questionId: string; observations: Observation[]; versions: VersionRow[]; events: EventRow[] };
type ArtifactRow = { id: string; artifactType: string; questionId: string | null; version: number; updatedAt: string; content: string };
type SummaryData = {
  questionsWithData: number;
  totalCheckpoints: number;
  pasteEventCount: number;
  substantialEditCount: number;
  outlineArtifactCount: number;
  calculationWorkingArtifactCount: number;
  codeWorkingArtifactCount: number;
  sourceDeclarationCount: number;
  firstMeaningfulInputAt: string | null;
  finalSubmissionAt: string | null;
};
type ApiResponse =
  | { enabled: false; mode: "OFF" }
  | { enabled: true; mode: string; summary: SummaryData; perQuestion: QuestionData[]; artifacts: ArtifactRow[] };

const CHANGE_TYPE_LABELS: Record<string, string> = {
  INITIAL_TEXT: "First meaningful answer text",
  PERIODIC_CHECKPOINT: "Development checkpoint",
  SUBSTANTIAL_EDIT: "Substantial edit",
  POST_PASTE_CHECKPOINT: "Paste event",
  PRE_SUBMISSION_CHECKPOINT: "Pre-submission checkpoint",
  FINAL_SUBMISSION: "Final answer submitted",
  MANUAL_STUDENT_CHECKPOINT: "Manual checkpoint",
};

const RECOMMENDATION_LABELS: Record<string, string> = {
  NO_IMMEDIATE_ACTION: "No immediate action",
  LECTURER_REVIEW: "Needs lecturer review",
  COMPARE_WITH_SIMILARITY_EVIDENCE: "Compare with similarity evidence",
  ORAL_VERIFICATION_MAY_ASSIST: "Oral verification may assist",
};

type FilterKey = "ALL" | "CHECKPOINTS" | "PASTE" | "SUBSTANTIAL" | "WORKING" | "CODE" | "SOURCES";

function timelineLabelForVersion(v: VersionRow): string {
  return CHANGE_TYPE_LABELS[v.changeType] ?? v.changeType;
}
function timelineLabelForEvent(e: EventRow): string {
  const map: Record<string, string> = {
    OUTLINE_CREATED: "Outline created",
    OUTLINE_UPDATED: "Outline updated",
    CALCULATION_WORKING_CREATED: "Calculation working created",
    CALCULATION_WORKING_UPDATED: "Calculation working updated",
    CODE_WORKING_CREATED: "Code working created",
    CODE_WORKING_UPDATED: "Code working updated",
    CODE_RUN_REQUESTED: "Code run requested",
    PASTED_TEXT_SUBSTANTIALLY_REPLACED: "Most pasted material replaced",
    SOURCE_DECLARATION_CREATED: "Source declaration provided",
    SOURCE_DECLARATION_UPDATED: "Source declaration updated",
    FINAL_ANSWER_SUBMITTED: "Final answer submitted",
  };
  return map[e.eventType] ?? e.eventType.replaceAll("_", " ").toLowerCase();
}

function DiffView({ segments }: { segments: DiffSegment[] }) {
  return (
    <div className="whitespace-pre-wrap rounded border border-gray-200 p-3 text-sm leading-relaxed">
      {segments.map((seg, i) => {
        if (seg.type === "equal") return <span key={i}>{seg.text}</span>;
        if (seg.type === "added")
          return (
            <span key={i} className="rounded bg-green-100 text-green-900">
              {seg.text}
            </span>
          );
        return (
          <span key={i} className="rounded bg-gray-200 text-gray-600 line-through">
            {seg.text}
          </span>
        );
      })}
    </div>
  );
}

function QuestionPanel({ q }: { q: QuestionData }) {
  const [filter, setFilter] = useState<FilterKey>("ALL");
  const [compareA, setCompareA] = useState<string>("");
  const [compareB, setCompareB] = useState<string>("");

  const timeline = useMemo(() => {
    const versionEntries = q.versions.map((v) => ({ atMs: new Date(v.serverReceivedAt).getTime(), label: timelineLabelForVersion(v), kind: "version" as const, ref: v }));
    const eventEntries = q.events.map((e) => ({ atMs: new Date(e.serverReceivedAt).getTime(), label: timelineLabelForEvent(e), kind: "event" as const, ref: e }));
    return [...versionEntries, ...eventEntries].sort((a, b) => a.atMs - b.atMs);
  }, [q]);

  const filtered = timeline.filter((entry) => {
    if (filter === "ALL") return true;
    if (filter === "CHECKPOINTS") return entry.kind === "version";
    if (filter === "PASTE") return entry.kind === "version" && (entry.ref as VersionRow).changeType === "POST_PASTE_CHECKPOINT";
    if (filter === "SUBSTANTIAL") return entry.kind === "version" && (entry.ref as VersionRow).changeType === "SUBSTANTIAL_EDIT";
    if (filter === "WORKING")
      return entry.kind === "event" && ["OUTLINE_CREATED", "OUTLINE_UPDATED", "CALCULATION_WORKING_CREATED", "CALCULATION_WORKING_UPDATED"].includes((entry.ref as EventRow).eventType);
    if (filter === "CODE")
      return entry.kind === "event" && (entry.ref as EventRow).eventType.startsWith("CODE_");
    if (filter === "SOURCES") return entry.kind === "event" && (entry.ref as EventRow).eventType.startsWith("SOURCE_DECLARATION");
    return true;
  });

  const versionA = q.versions.find((v) => v.id === compareA);
  const versionB = q.versions.find((v) => v.id === compareB);
  const diff = versionA && versionB ? diffAnswerText(versionA.responseText, versionB.responseText) : null;

  return (
    <div className="mt-4 rounded border border-gray-200 p-4">
      <h3 className="text-sm font-semibold">Question {q.questionId}</h3>

      {q.observations.length > 0 && (
        <div className="mt-2 space-y-1">
          {q.observations.map((o, i) => (
            <div key={i} className="rounded border border-gray-200 bg-gray-50 p-2 text-xs">
              <span className="font-medium">{o.code.replaceAll("_", " ").toLowerCase()}</span>
              {" — "}
              <span className="text-gray-600">{RECOMMENDATION_LABELS[o.recommendation] ?? o.recommendation}</span>
              <p className="mt-1 text-gray-600">{o.explanation}</p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-1 text-xs">
        {(["ALL", "CHECKPOINTS", "PASTE", "SUBSTANTIAL", "WORKING", "CODE", "SOURCES"] as FilterKey[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded border px-2 py-1 ${filter === f ? "border-gray-500 bg-gray-100" : "border-gray-200"}`}
          >
            {f.charAt(0) + f.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      <ul className="mt-3 space-y-1 text-sm">
        {filtered.map((entry, i) => (
          <li key={i} className="text-gray-700">
            <span className="text-gray-400">{new Date(entry.atMs).toLocaleTimeString()}</span> — {entry.label}
          </li>
        ))}
        {filtered.length === 0 && <li className="text-gray-400">No activity for this filter.</li>}
      </ul>

      {q.versions.length >= 2 && (
        <div className="mt-4 border-t border-gray-200 pt-3">
          <p className="text-xs font-medium text-gray-600">Compare versions</p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <select value={compareA} onChange={(e) => setCompareA(e.target.value)} className="rounded border border-gray-300 px-2 py-1">
              <option value="">Previous version</option>
              {q.versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.versionNumber} — {CHANGE_TYPE_LABELS[v.changeType] ?? v.changeType}
                </option>
              ))}
            </select>
            <span>vs</span>
            <select value={compareB} onChange={(e) => setCompareB(e.target.value)} className="rounded border border-gray-300 px-2 py-1">
              <option value="">Selected version</option>
              {q.versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.versionNumber} — {CHANGE_TYPE_LABELS[v.changeType] ?? v.changeType}
                </option>
              ))}
            </select>
          </div>
          {diff && (
            <div className="mt-2">
              <p className="text-xs text-gray-500">
                +{diff.charactersAdded} / -{diff.charactersRemoved} characters ({Math.round(diff.changeRatio * 100)}% changed) ·{" "}
                {new Date(versionB!.serverReceivedAt).toLocaleString()} · {CHANGE_TYPE_LABELS[versionB!.changeType] ?? versionB!.changeType}
              </p>
              <DiffView segments={diff.segments} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AnswerDevelopmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/lecturer/submissions/${id}/answer-development`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? "Failed to load answer development data");
        }
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err.message));
  }, [id]);

  return (
    <div className="mx-auto max-w-3xl">
      <Link href={`/lecturer/exams`} className="text-sm text-gray-500">
        &larr; Back
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">Answer development</h1>
      <p className="mt-1 text-sm text-gray-600">
        Review how the response developed over time. This is process evidence and does not by itself establish misconduct.
      </p>

      <div className="mt-3 rounded border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">
        Signals identify patterns for review, not proof of misconduct. Paste events, limited development history, and rapid
        rewrites may all have legitimate explanations — accessibility tools, connectivity gaps, proofreading, or a change of
        approach. Lecturer judgement remains final. No grade is automatically changed by anything on this page.
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      {!data && !error && <p className="mt-4 text-gray-500">Loading…</p>}

      {data && !data.enabled && (
        <p className="mt-4 text-sm text-gray-500">Answer-development provenance was not enabled for this attempt.</p>
      )}

      {data && data.enabled && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Questions with data" value={data.summary.questionsWithData} />
            <Stat label="Checkpoints" value={data.summary.totalCheckpoints} />
            <Stat label="Paste events" value={data.summary.pasteEventCount} />
            <Stat label="Substantial edits" value={data.summary.substantialEditCount} />
            <Stat label="Outline artifacts" value={data.summary.outlineArtifactCount} />
            <Stat label="Calculation working" value={data.summary.calculationWorkingArtifactCount} />
            <Stat label="Code working" value={data.summary.codeWorkingArtifactCount} />
            <Stat label="Source declarations" value={data.summary.sourceDeclarationCount} />
          </div>
          <p className="mt-2 text-xs text-gray-500">
            First meaningful input:{" "}
            {data.summary.firstMeaningfulInputAt ? new Date(data.summary.firstMeaningfulInputAt).toLocaleString() : "—"} · Final
            submission: {data.summary.finalSubmissionAt ? new Date(data.summary.finalSubmissionAt).toLocaleString() : "—"}
          </p>

          {data.perQuestion.length === 0 && <p className="mt-4 text-sm text-gray-500">No development data recorded for this attempt.</p>}
          {data.perQuestion.map((q) => (
            <QuestionPanel key={q.questionId} q={q} />
          ))}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-gray-200 p-3 text-center">
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  );
}
