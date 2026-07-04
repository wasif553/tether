"use client";

import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";

type EvidenceReport = {
  submissionId: string;
  student: { name: string; email: string };
  exam: { id: string; title: string };
  status: string;
  startedAt: string;
  submittedAt: string | null;
  gradedAt: string | null;
  totalScore: number | null;
  riskScore: number;
  riskLevel: "CLEAN" | "LOW" | "MEDIUM" | "HIGH";
  events: Array<{
    eventType: string;
    eventLabel: string;
    severity: string;
    message: string;
    occurredAt: string;
    resolvedAt: string | null;
    resolvedByName: string | null;
    resolutionNote: string | null;
    confidenceBand: string | null;
  }>;
  aiCameraIntegritySummary: {
    possiblePhoneCount: number;
    possibleSecondPersonCount: number;
    noPersonCount: number;
    cameraBlockedOrDarkCount: number;
    disclaimer: string;
  } | null;
  canvasPassback: {
    status: string;
    scoreGiven: number | null;
    sentAt: string | null;
    errorMessage: string | null;
  } | null;
  aiMarking: { answeredEssayCount: number; aiDraftedCount: number } | null;
  networkEvidence: {
    start: {
      ipAddress: string | null;
      country: string | null;
      region: string | null;
      city: string | null;
      timezone: string | null;
      locationAccuracy: string;
      userAgent: string | null;
      browserName: string | null;
      osName: string | null;
      vpnOrProxySignal: boolean;
      capturedAt: string;
    } | null;
    submit: {
      ipAddress: string | null;
      country: string | null;
      region: string | null;
      city: string | null;
      timezone: string | null;
      locationAccuracy: string;
      userAgent: string | null;
      browserName: string | null;
      osName: string | null;
      vpnOrProxySignal: boolean;
      networkChanged: boolean;
      capturedAt: string;
    } | null;
    reviewSignal: "Normal" | "Needs review" | "High review signal";
    networkEvidenceDisclaimer: string;
  };
  disclaimer: string;
};

const RISK_LEVEL_STYLES: Record<string, string> = {
  CLEAN: "bg-gray-100 text-gray-600",
  LOW: "bg-blue-100 text-blue-700",
  MEDIUM: "bg-yellow-100 text-yellow-700",
  HIGH: "bg-red-100 text-red-700",
};

const RISK_LEVEL_LABELS: Record<string, string> = {
  CLEAN: "Clean",
  LOW: "Low integrity risk",
  MEDIUM: "Medium integrity risk",
  HIGH: "High integrity risk",
};

function severityBadge(severity: string) {
  const styles: Record<string, string> = {
    HIGH: "bg-red-100 text-red-700",
    MEDIUM: "bg-yellow-100 text-yellow-700",
    LOW: "bg-blue-100 text-blue-700",
    INFO: "bg-gray-100 text-gray-600",
  };
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${styles[severity] ?? styles.INFO}`}>
      {severity}
    </span>
  );
}

export default function EvidenceReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);
  const [data, setData] = useState<EvidenceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/lecturer/submissions/${id}/evidence`).then(async (res) => {
      if (!res.ok) {
        setError(
          res.status === 403
            ? "You don't have access to this submission's evidence report."
            : "Evidence report not found.",
        );
        setLoading(false);
        return;
      }
      setData(await res.json());
      setLoading(false);
    });
  }, [id]);

  if (loading) return <p className="text-gray-500">Loading evidence report...</p>;
  if (error) return <p className="text-red-600">{error}</p>;
  if (!data) return <p className="text-red-600">No data available.</p>;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Evidence report</h1>
        <div className="flex gap-2">
          <a
            href={`/api/lecturer/submissions/${id}/evidence.csv`}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            Export CSV
          </a>
          <Link
            href={`/lecturer/exams/${data.exam.id}/submissions/${data.submissionId}`}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            Back to grading
          </Link>
        </div>
      </div>

      <p className="mt-2 rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
        {data.disclaimer}
      </p>

      <div className="mt-6 grid grid-cols-2 gap-3 rounded border border-gray-200 p-4 text-sm sm:grid-cols-3">
        <div>
          <p className="text-xs uppercase text-gray-500">Student</p>
          <p>{data.student.name}</p>
          <p className="text-gray-500">{data.student.email}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Exam</p>
          <p>{data.exam.title}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Status</p>
          <p>{data.status}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Started</p>
          <p>{new Date(data.startedAt).toLocaleString()}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Submitted</p>
          <p>{data.submittedAt ? new Date(data.submittedAt).toLocaleString() : "—"}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Score</p>
          <p>{data.totalScore != null ? data.totalScore : "—"}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Integrity risk</p>
          <p>
            <span
              className={`rounded px-2 py-0.5 text-xs ${RISK_LEVEL_STYLES[data.riskLevel]}`}
            >
              {RISK_LEVEL_LABELS[data.riskLevel]}
            </span>{" "}
            <span className="text-gray-500">(score: {data.riskScore})</span>
          </p>
        </div>
      </div>

      {data.canvasPassback && (
        <div className="mt-4 rounded border border-gray-200 p-4 text-sm">
          <p className="text-xs uppercase text-gray-500">Canvas grade passback (optional module)</p>
          <p>Status: {data.canvasPassback.status}</p>
          {data.canvasPassback.scoreGiven != null && <p>Score sent: {data.canvasPassback.scoreGiven}</p>}
          {data.canvasPassback.errorMessage && (
            <p className="text-red-600">Error: {data.canvasPassback.errorMessage}</p>
          )}
        </div>
      )}

      {data.aiMarking && (
        <div className="mt-4 rounded border border-gray-200 p-4 text-sm">
          <p className="text-xs uppercase text-gray-500">AI draft marking (optional module)</p>
          <p>
            {data.aiMarking.aiDraftedCount} of {data.aiMarking.answeredEssayCount} answered essay
            answer(s) have an AI draft score. AI drafts are never final — a lecturer must approve
            them.
          </p>
        </div>
      )}

      <h2 className="mt-8 text-lg font-medium">Network evidence</h2>
      {(() => {
        const ne = data.networkEvidence;
        const signalStyle: Record<string, string> = {
          Normal: "bg-gray-100 text-gray-600",
          "Needs review": "bg-yellow-100 text-yellow-700",
          "High review signal": "bg-red-100 text-red-700",
        };
        const loc = (
          e: { country: string | null; region: string | null; city: string | null; locationAccuracy: string } | null,
        ) => {
          if (!e) return "—";
          if (e.locationAccuracy === "UNAVAILABLE") return "Not available (no geolocation provider configured)";
          const parts = [e.city, e.region, e.country].filter(Boolean);
          return parts.length ? `${parts.join(", ")} (approximate IP-based location)` : "—";
        };
        return (
          <div className="mt-3 space-y-4">
            <div className="flex items-center gap-2 rounded border border-gray-200 p-3">
              <span className="text-xs text-gray-500">Network review signal:</span>
              <span className={`rounded px-2 py-0.5 text-xs ${signalStyle[ne.reviewSignal] ?? signalStyle.Normal}`}>
                {ne.reviewSignal}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 rounded border border-gray-200 p-4 text-sm">
              <div>
                <p className="text-xs font-medium uppercase text-gray-500">At exam open</p>
                {ne.start ? (
                  <>
                    <p className="mt-1">IP: {ne.start.ipAddress ?? "—"}</p>
                    <p>Approx. location: {loc(ne.start)}</p>
                    <p>Browser: {ne.start.browserName ?? "—"} / {ne.start.osName ?? "—"}</p>
                    {ne.start.vpnOrProxySignal && (
                      <p className="text-yellow-700">VPN/proxy signal detected</p>
                    )}
                    <p className="mt-1 text-xs text-gray-400">
                      Captured {new Date(ne.start.capturedAt).toLocaleString()}
                    </p>
                  </>
                ) : (
                  <p className="text-gray-400">Not recorded</p>
                )}
              </div>
              <div>
                <p className="text-xs font-medium uppercase text-gray-500">At submission</p>
                {ne.submit ? (
                  <>
                    <p className="mt-1">IP: {ne.submit.ipAddress ?? "—"}</p>
                    <p>Approx. location: {loc(ne.submit)}</p>
                    <p>Browser: {ne.submit.browserName ?? "—"} / {ne.submit.osName ?? "—"}</p>
                    {ne.submit.networkChanged && (
                      <p className="text-yellow-700">Network address changed since exam open</p>
                    )}
                    {ne.submit.vpnOrProxySignal && (
                      <p className="text-yellow-700">VPN/proxy signal detected</p>
                    )}
                    <p className="mt-1 text-xs text-gray-400">
                      Captured {new Date(ne.submit.capturedAt).toLocaleString()}
                    </p>
                  </>
                ) : (
                  <p className="text-gray-400">Not recorded</p>
                )}
              </div>
            </div>
            <p className="rounded border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">
              {ne.networkEvidenceDisclaimer}
            </p>
          </div>
        );
      })()}

      {data.aiCameraIntegritySummary && (
        <div className="mt-8">
          <h2 className="text-lg font-medium">AI-assisted camera integrity signals</h2>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded border border-gray-200 p-3 text-center">
              <p className="text-2xl font-semibold">
                {data.aiCameraIntegritySummary.possiblePhoneCount}
              </p>
              <p className="text-xs text-gray-500">Possible phone visible</p>
            </div>
            <div className="rounded border border-gray-200 p-3 text-center">
              <p className="text-2xl font-semibold">
                {data.aiCameraIntegritySummary.possibleSecondPersonCount}
              </p>
              <p className="text-xs text-gray-500">Possible additional person visible</p>
            </div>
            <div className="rounded border border-gray-200 p-3 text-center">
              <p className="text-2xl font-semibold">{data.aiCameraIntegritySummary.noPersonCount}</p>
              <p className="text-xs text-gray-500">No person visible</p>
            </div>
            <div className="rounded border border-gray-200 p-3 text-center">
              <p className="text-2xl font-semibold">
                {data.aiCameraIntegritySummary.cameraBlockedOrDarkCount}
              </p>
              <p className="text-xs text-gray-500">Camera blocked/dark</p>
            </div>
          </div>
          <p className="mt-3 rounded border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">
            {data.aiCameraIntegritySummary.disclaimer}
          </p>
        </div>
      )}

      <h2 className="mt-8 text-lg font-medium">Integrity event timeline</h2>
      <div className="mt-3 overflow-x-auto rounded border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-left">
              <th className="p-2">Time</th>
              <th className="p-2">Event type</th>
              <th className="p-2">Severity</th>
              <th className="p-2">Message</th>
              <th className="p-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.events.length === 0 && (
              <tr>
                <td colSpan={5} className="p-4 text-center text-gray-500">
                  No integrity events recorded
                </td>
              </tr>
            )}
            {data.events.map((e, i) => (
              <tr key={i} className="border-b border-gray-100 align-top">
                <td className="whitespace-nowrap p-2">{new Date(e.occurredAt).toLocaleString()}</td>
                <td className="p-2">{e.eventLabel}</td>
                <td className="p-2">{severityBadge(e.severity)}</td>
                <td className="max-w-xs p-2">
                  {e.message}
                  {e.confidenceBand && (
                    <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                      {e.confidenceBand} confidence
                    </span>
                  )}
                </td>
                <td className="p-2">
                  {e.resolvedAt ? (
                    <span className="text-green-700">
                      Reviewed{e.resolvedByName ? ` by ${e.resolvedByName}` : ""}
                    </span>
                  ) : (
                    <span className="text-gray-500">Review recommended</span>
                  )}
                  {e.resolutionNote && (
                    <p className="mt-1 text-xs text-gray-500">Note: {e.resolutionNote}</p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
