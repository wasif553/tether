"use client";

import { use as usePromise, useEffect, useState } from "react";

// Single Display Requirement v1 — see docs/secure-client-foundation-seb-v1.md,
// "Display requirement". Status/instruction text only — never a live
// pass/fail check computed in this browser (there is no trustworthy
// browser signal for connected/mirrored/extended displays).
type DisplayRequirement = {
  displayPolicy: "UNRESTRICTED" | "SINGLE_DISPLAY_REQUIRED";
  status: "NOT_APPLICABLE" | "ENFORCED_BY_SECURE_CLIENT" | "NOT_ENFORCEABLE_STANDARD_WEB";
  title: string | null;
  instruction: string | null;
};

type StatusResponse = {
  deliveryMode: string;
  studentPreflightRequired: boolean;
  displayRequirement: DisplayRequirement;
  session: { id: string; status: string; verificationStatus: string; clientType: string; lastHeartbeatAt: string | null } | null;
};

type PreflightResponse = { overallStatus: string; checks: Record<string, string>; deliveryMode: string; displayRequirement: DisplayRequirement };

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  READY: { label: "READY", className: "bg-green-100 text-green-800" },
  ACTION_REQUIRED: { label: "ACTION REQUIRED", className: "bg-amber-100 text-amber-800" },
  CANNOT_START: { label: "CANNOT START", className: "bg-gray-200 text-gray-800" },
  TECHNICAL_FAILURE: { label: "TECHNICAL ISSUE", className: "bg-gray-200 text-gray-800" },
  NOT_SUPPORTED: { label: "NOT APPLICABLE", className: "bg-gray-100 text-gray-600" },
};

export default function SecureClientCompatibilityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: examId } = usePromise(params);
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [preflight, setPreflight] = useState<PreflightResponse | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    fetch(`/api/exams/${examId}/submissions`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const inProgress = Array.isArray(d) ? d.find((s: { status: string }) => s.status === "IN_PROGRESS") : null;
        if (inProgress) setSubmissionId(inProgress.id);
      })
      .catch(() => {});
  }, [examId]);

  useEffect(() => {
    if (!submissionId) return;
    fetch(`/api/submissions/${submissionId}/secure-client/status`)
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
  }, [submissionId]);

  async function runCompatibilityCheck() {
    if (!submissionId) return;
    setChecking(true);
    try {
      const res = await fetch(`/api/submissions/${submissionId}/secure-client/preflight`, { method: "POST" });
      const body = await res.json();
      setPreflight(body);
    } finally {
      setChecking(false);
    }
  }

  const overall = preflight?.overallStatus ?? "NOT_SUPPORTED";
  const statusInfo = STATUS_LABELS[overall] ?? STATUS_LABELS.NOT_SUPPORTED;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold">Secure examination mode</h1>
      <p className="mt-2 rounded border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">
        Secure examination mode provides stronger controls and additional integrity evidence. It is designed to be
        cheat-resistant, but no examination technology can prevent every form of unauthorised assistance.
      </p>

      {status && (
        <div className="mt-4 rounded border border-gray-200 p-4">
          <p className="text-sm text-gray-600">Required delivery mode</p>
          <p className="text-lg font-medium">{status.deliveryMode.replaceAll("_", " ")}</p>
        </div>
      )}

      {status && status.displayRequirement.status !== "NOT_APPLICABLE" && (
        <div
          className={`mt-4 rounded border p-4 text-sm ${
            status.displayRequirement.status === "ENFORCED_BY_SECURE_CLIENT" ? "border-gray-200" : "border-amber-200 bg-amber-50"
          }`}
        >
          <p className="font-semibold">{status.displayRequirement.title}</p>
          <p className="mt-1 text-gray-700">{status.displayRequirement.instruction}</p>
          {status.displayRequirement.status === "ENFORCED_BY_SECURE_CLIENT" && (
            <p className="mt-1 text-xs text-gray-500">Enforced by the secure exam client.</p>
          )}
        </div>
      )}

      {status?.deliveryMode === "SEB_REQUIRED" || status?.deliveryMode === "SEB_OPTIONAL" ? (
        <>
          <div className="mt-4 rounded border border-gray-200 p-4">
            <h2 className="text-sm font-semibold">Safe Exam Browser</h2>
            <p className="mt-1 text-sm text-gray-600">
              Install Safe Exam Browser from the{" "}
              <a href="https://safeexambrowser.org/download_en.html" target="_blank" rel="noreferrer" className="text-blue-600 underline">
                official Safe Exam Browser website
              </a>{" "}
              or use your institution&apos;s provided package.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {submissionId && (
                <>
                  <a
                    href={`seb://${typeof window !== "undefined" ? window.location.host : ""}/api/submissions/${submissionId}/secure-client/seb-config`}
                    className="rounded border border-gray-300 px-3 py-1.5 text-sm"
                  >
                    Open in Safe Exam Browser
                  </a>
                  <a href={`/api/submissions/${submissionId}/secure-client/seb-config`} className="rounded border border-gray-300 px-3 py-1.5 text-sm">
                    Download exam configuration
                  </a>
                </>
              )}
              <button onClick={runCompatibilityCheck} disabled={checking || !submissionId} className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">
                {checking ? "Checking…" : "Run compatibility check"}
              </button>
            </div>
          </div>

          <div className={`mt-4 rounded border p-4 text-sm ${statusInfo.className}`} role="status" aria-live="polite">
            <p className="font-semibold">{statusInfo.label}</p>
            {overall === "CANNOT_START" && status.deliveryMode === "SEB_REQUIRED" && (
              <p className="mt-1">This examination requires Safe Exam Browser.</p>
            )}
            {overall === "TECHNICAL_FAILURE" && (
              <p className="mt-1">Tether could not complete the client check. Your answers have not been affected.</p>
            )}
            {overall === "ACTION_REQUIRED" && <p className="mt-1">Update Safe Exam Browser to an approved version, or check the requirements below.</p>}
          </div>

          {preflight && (
            <ul className="mt-2 space-y-1 text-sm">
              {Object.entries(preflight.checks).map(([key, value]) => (
                <li key={key} className="flex items-center justify-between rounded border border-gray-200 px-2 py-1">
                  <span>{key.replace(/([A-Z])/g, " $1").trim()}</span>
                  <span aria-label={`status: ${value}`}>{value}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="mt-4 text-sm text-gray-500">This exam does not require any additional client verification.</p>
      )}

      <p className="mt-6 text-xs text-gray-500">
        If you use assistive technology or need an accessibility accommodation, contact your lecturer — approved
        exceptions are recorded and honoured; you will not be blocked solely because a generic check flags your setup.
      </p>
    </div>
  );
}
