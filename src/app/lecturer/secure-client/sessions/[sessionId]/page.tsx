"use client";

import { use as usePromise, useEffect, useState } from "react";
import Link from "next/link";

type SessionDetail = {
  id: string;
  examTitle: string;
  studentName: string;
  submissionId: string;
  clientType: string;
  status: string;
  verificationStatus: string;
  platform: string | null;
  clientVersion: string | null;
  startedAt: string;
  verifiedAt: string | null;
  lastHeartbeatAt: string | null;
  interruptedAt: string | null;
  recoveredAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  // Mandatory Tether Delivery for Final Examinations — Part 9 reporting.
  // assessmentType is the exam's current classification; the rest is the
  // FROZEN per-attempt policy actually enforced for this session.
  assessmentType: string;
  deliveryMode: string;
  displayPolicy: string;
  policyVersion: string;
  policySchemaVersion: number;
  // Production administration hardening v1, Part G — recovery admin UX.
  installationAttestationVerified: boolean;
  installationAttestationFailureReason: string | null;
  recoveryOfSessionId: string | null;
};

type PriorSession = {
  id: string;
  status: string;
  installationAttestationVerified: boolean;
  hadBoundInstallation: boolean;
  endedAt: string | null;
  endReason: string | null;
};

type Attestation = { id: string; overallStatus: string; serverReceivedAt: string; [key: string]: unknown };
type EventRow = { id: string; eventType: string; eventLevel: string; serverReceivedAt: string; metadata: unknown };
type RecoveryGrant = { id: string; issuedByName: string; issuedAt: string; expiresAt: string; consumedAt: string | null; revokedAt: string | null; reason: string };

// Single Display Requirement v1 — see docs/secure-client-foundation-seb-v1.md,
// "Display requirement", Part 7. This remains an integrity SIGNAL only —
// never automatic misconduct, never a mark change, never an auto-submit.
// Every other event type keeps the existing generic label transform below.
const DISPLAY_EVENT_LABELS: Record<string, string> = {
  ADDITIONAL_DISPLAY_PRESENT:
    "An additional display was reported by the secure exam client. The exam was paused until the display requirement was restored. Needs review.",
  DISPLAY_POLICY_RESTORED: "Display requirement restored — configuration restored.",
};

const ALTERNATIVE_EXPLANATIONS = [
  "a shared institutional or accommodation network",
  "a brief connectivity interruption",
  "an approved accessibility tool",
  "normal device/browser updates",
  "a legitimate need to switch devices during a sanctioned break",
];

/**
 * Production administration hardening v1, Part G — a plain-language,
 * NON-AUTHORITATIVE suggestion derived purely from facts the API already
 * returns. Never changes what buttons are enabled/disabled, never
 * auto-fills the reason field, never itself grants or denies anything —
 * the lecturer always makes the actual decision. Returns null when there
 * is genuinely nothing useful to say (e.g. a normal, unremarkable
 * session).
 */
function suggestedNextStep(detail: SessionDetail, priorSession: PriorSession | null): string | null {
  if (detail.status !== "RECOVERY_REQUIRED" && detail.installationAttestationFailureReason == null) return null;

  if (detail.installationAttestationFailureReason === "DEVICE_CHANGE_DETECTED") {
    return "A device change was detected on a resumed attempt. Consider confirming with the student what happened (a reasonable explanation is common) before deciding whether to issue a recovery grant.";
  }
  if (detail.status === "RECOVERY_REQUIRED" && priorSession && !priorSession.installationAttestationVerified) {
    return "The prior session was never verified, so there is no confirmed device history to compare against. A recovery grant here relies more on the student's own account of events.";
  }
  if (detail.status === "RECOVERY_REQUIRED") {
    return "This session is waiting on a lecturer decision. If the student's account of what happened is reasonable, a recovery grant lets them resume; if something looks inconsistent, escalating for further review is also an option.";
  }
  return null;
}

export default function SecureClientSessionDetailPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = usePromise(params);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [priorSession, setPriorSession] = useState<PriorSession | null>(null);
  const [attestations, setAttestations] = useState<Attestation[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [grants, setGrants] = useState<RecoveryGrant[]>([]);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    fetch(`/api/lecturer/secure-client/sessions/${sessionId}`)
      .then((r) => r.json())
      .then((d) => {
        setDetail(d.session ?? null);
        setPriorSession(d.priorSession ?? null);
        setAttestations(d.attestations ?? []);
        setEvents(d.events ?? []);
        setGrants(d.recoveryGrants ?? []);
      });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  async function issueRecoveryGrant() {
    if (!reason.trim()) return;
    const res = await fetch(`/api/lecturer/secure-client/sessions/${sessionId}/recovery-grant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    const body = await res.json();
    if (res.ok) {
      setMessage(`Recovery code (share with the student once): ${body.recoveryToken}`);
      setReason("");
      load();
    } else {
      setMessage(body.error ?? "Failed to issue recovery grant");
    }
  }

  async function grantOverride() {
    if (!reason.trim()) return;
    const res = await fetch(`/api/lecturer/secure-client/sessions/${sessionId}/override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    if (res.ok) {
      setMessage("Override granted.");
      setReason("");
      load();
    }
  }

  if (!detail) return <p className="p-6 text-lecturer-text-secondary">Loading…</p>;

  const timeline = [
    { at: detail.startedAt, label: "Session started" },
    detail.verifiedAt ? { at: detail.verifiedAt, label: "Client verified" } : null,
    detail.interruptedAt ? { at: detail.interruptedAt, label: "Interrupted" } : null,
    detail.recoveredAt ? { at: detail.recoveredAt, label: "Recovered" } : null,
    detail.endedAt ? { at: detail.endedAt, label: `Ended (${detail.endReason ?? "unspecified"})` } : null,
    ...events.map((e) => ({ at: e.serverReceivedAt, label: DISPLAY_EVENT_LABELS[e.eventType] ?? e.eventType.replaceAll("_", " ").toLowerCase() })),
  ]
    .filter((x): x is { at: string; label: string } => x != null)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  return (
    <div className="mx-auto max-w-3xl">
      {/* Pilot UI release readiness v1 — this page previously had no way
          back to the submission it belongs to except the browser Back
          button. */}
      <Link href={`/lecturer/submissions/${detail.submissionId}/evidence`} className="text-sm underline">
        ← Back to submission
      </Link>
      <h1 className="mt-2 text-[28px] font-bold text-lecturer-text-primary">Secure-client session</h1>
      {/* Production administration hardening v1, Part G — examTitle was
          already returned by the API but never rendered anywhere on this
          page; a lecturer reviewing several sessions had no way to tell
          which exam this one belonged to without navigating back. */}
      <p className="text-sm text-lecturer-text-secondary">{detail.examTitle}</p>
      <p className="mt-1 text-sm text-lecturer-text-secondary">
        Review client verification, device preflight and session continuity. These signals support lecturer review and do
        not by themselves establish misconduct.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <p className="text-xs text-lecturer-text-secondary">Student</p>
          <p className="font-medium">{detail.studentName}</p>
        </div>
        <div>
          <p className="text-xs text-lecturer-text-secondary">Client</p>
          <p className="font-medium">{detail.clientType}</p>
        </div>
        <div>
          <p className="text-xs text-lecturer-text-secondary">Status</p>
          <p className="font-medium">{detail.status.replaceAll("_", " ").toLowerCase()}</p>
        </div>
        <div>
          <p className="text-xs text-lecturer-text-secondary">Verification</p>
          <p className="font-medium">{detail.verificationStatus.replaceAll("_", " ").toLowerCase()}</p>
        </div>
        <div>
          <p className="text-xs text-lecturer-text-secondary">Client version</p>
          <p className="font-medium">{detail.clientVersion ?? "Unknown"}</p>
        </div>
        <div>
          <p className="text-xs text-lecturer-text-secondary">Assessment type</p>
          <p className="font-medium">{detail.assessmentType.replaceAll("_", " ").toLowerCase()}</p>
        </div>
        <div>
          <p className="text-xs text-lecturer-text-secondary">Required delivery mode</p>
          <p className="font-medium">{detail.deliveryMode.replaceAll("_", " ").toLowerCase()}</p>
        </div>
        <div>
          <p className="text-xs text-lecturer-text-secondary">Display policy</p>
          <p className="font-medium">{detail.displayPolicy.replaceAll("_", " ").toLowerCase()}</p>
        </div>
        <div>
          <p className="text-xs text-lecturer-text-secondary">Policy snapshot version</p>
          <p className="font-medium">
            {detail.policyVersion} (schema {detail.policySchemaVersion})
          </p>
        </div>
      </div>

      <h2 className="mt-6 text-sm font-semibold">Timeline</h2>
      <ul className="mt-2 space-y-1 text-sm">
        {timeline.map((entry, i) => (
          <li key={i} className="text-lecturer-text-primary">
            <span className="text-lecturer-text-muted">{new Date(entry.at).toLocaleString()}</span> — {entry.label}
          </li>
        ))}
      </ul>

      <h2 className="mt-6 text-sm font-semibold">Preflight / attestation results</h2>
      <ul className="mt-2 space-y-1 text-sm">
        {attestations.map((a) => (
          <li key={a.id} className="rounded border border-lecturer-border p-2">
            <span className="font-medium">{a.overallStatus}</span> — {new Date(a.serverReceivedAt).toLocaleString()}
          </li>
        ))}
        {attestations.length === 0 && <li className="text-xs text-lecturer-text-muted">No attestation recorded yet.</li>}
      </ul>

      <h2 className="mt-6 text-sm font-semibold">Recovery</h2>

      {/* Production administration hardening v1, Part G — recovery admin
          UX. Only rendered when this session actually supersedes an
          earlier one (recoveryOfSessionId set) — a first-ever launch has
          no prior session and this section is simply omitted. Every fact
          shown here was already computed server-side by the real
          recovery/attestation logic (tetherRecovery.ts,
          tetherAttestationRunner.ts) — this panel only DISPLAYS it, never
          decides anything on its own. */}
      {detail.recoveryOfSessionId && (
        <div className="mt-2 rounded border border-lecturer-border p-3 text-sm">
          <p className="font-medium">Prior session</p>
          {priorSession ? (
            <ul className="mt-1 space-y-0.5 text-xs text-lecturer-text-primary">
              <li>Status: {priorSession.status.replaceAll("_", " ").toLowerCase()}</li>
              <li>Installation verified: {priorSession.installationAttestationVerified ? "Yes" : "No"}</li>
              <li>Had a bound installation: {priorSession.hadBoundInstallation ? "Yes" : "No"}</li>
              {priorSession.endReason && <li>Ended: {priorSession.endReason}</li>}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-lecturer-text-secondary">Prior session record not found.</p>
          )}
          {detail.installationAttestationFailureReason === "DEVICE_CHANGE_DETECTED" && (
            <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              This attempt was made from a different installation than the one bound to the prior session. This is a
              factual signal, not evidence of misconduct — accessibility accommodations, device replacement, and shared
              lab machines are all legitimate reasons a device can change.
            </p>
          )}
        </div>
      )}

      <ul className="mt-2 space-y-1 text-sm">
        {grants.map((g) => (
          <li key={g.id} className="rounded border border-lecturer-border p-2">
            Issued by {g.issuedByName} at {new Date(g.issuedAt).toLocaleString()} — {g.reason}
            {g.consumedAt && " (consumed)"}
            {g.revokedAt && " (revoked)"}
          </li>
        ))}
        {grants.length === 0 && <li className="text-xs text-lecturer-text-muted">No recovery grant issued for this session.</li>}
      </ul>

      {/* Part G — a plain-language, clearly non-authoritative suggestion
          only, computed purely from facts already shown above. Never
          gates or auto-fills anything — the lecturer still must type a
          reason and click a button themselves for any action to occur. */}
      {suggestedNextStep(detail, priorSession) && (
        <p className="mt-2 rounded border border-lecturer-border bg-lecturer-border-subtle p-2 text-xs text-lecturer-text-primary">
          <span className="font-medium">Suggestion (not a decision):</span> {suggestedNextStep(detail, priorSession)}
        </p>
      )}

      <div className="mt-3 space-y-2">
        <textarea
          className="w-full rounded border border-lecturer-border p-2 text-sm"
          rows={2}
          placeholder="Reason (required for recovery grant or override)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="flex gap-2">
          <button onClick={issueRecoveryGrant} disabled={!reason.trim()} className="rounded border border-lecturer-border px-3 py-1.5 text-sm disabled:opacity-50">
            Issue recovery grant
          </button>
          <button onClick={grantOverride} disabled={!reason.trim()} className="rounded border border-lecturer-border px-3 py-1.5 text-sm disabled:opacity-50">
            Grant override
          </button>
        </div>
        {message && <p className="rounded border border-lecturer-border bg-lecturer-border-subtle p-2 text-xs">{message}</p>}
      </div>

      <div className="mt-6 rounded border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">
        <p className="font-medium">Alternative explanations to consider</p>
        <ul className="mt-1 list-disc pl-4">
          {ALTERNATIVE_EXPLANATIONS.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
        <p className="mt-2">
          A technical failure is not student misconduct. Lecturer judgement remains final and no grade is changed
          automatically by anything on this page.
        </p>
      </div>
    </div>
  );
}
