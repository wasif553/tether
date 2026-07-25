"use client";

import { use as usePromise, useEffect, useState } from "react";

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
};

type Attestation = { id: string; overallStatus: string; serverReceivedAt: string; [key: string]: unknown };
type EventRow = { id: string; eventType: string; eventLevel: string; serverReceivedAt: string; metadata: unknown };
type RecoveryGrant = { id: string; issuedByName: string; issuedAt: string; expiresAt: string; consumedAt: string | null; revokedAt: string | null; reason: string };

const ALTERNATIVE_EXPLANATIONS = [
  "a shared institutional or accommodation network",
  "a brief connectivity interruption",
  "an approved accessibility tool",
  "normal device/browser updates",
  "a legitimate need to switch devices during a sanctioned break",
];

export default function SecureClientSessionDetailPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = usePromise(params);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
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

  if (!detail) return <p className="p-6 text-gray-500">Loading…</p>;

  const timeline = [
    { at: detail.startedAt, label: "Session started" },
    detail.verifiedAt ? { at: detail.verifiedAt, label: "Client verified" } : null,
    detail.interruptedAt ? { at: detail.interruptedAt, label: "Interrupted" } : null,
    detail.recoveredAt ? { at: detail.recoveredAt, label: "Recovered" } : null,
    detail.endedAt ? { at: detail.endedAt, label: `Ended (${detail.endReason ?? "unspecified"})` } : null,
    ...events.map((e) => ({ at: e.serverReceivedAt, label: e.eventType.replaceAll("_", " ").toLowerCase() })),
  ]
    .filter((x): x is { at: string; label: string } => x != null)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">Secure-client session</h1>
      <p className="mt-1 text-sm text-gray-600">
        Review client verification, device preflight and session continuity. These signals support lecturer review and do
        not by themselves establish misconduct.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <p className="text-xs text-gray-500">Student</p>
          <p className="font-medium">{detail.studentName}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Client</p>
          <p className="font-medium">{detail.clientType}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Status</p>
          <p className="font-medium">{detail.status}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Verification</p>
          <p className="font-medium">{detail.verificationStatus}</p>
        </div>
      </div>

      <h2 className="mt-6 text-sm font-semibold">Timeline</h2>
      <ul className="mt-2 space-y-1 text-sm">
        {timeline.map((entry, i) => (
          <li key={i} className="text-gray-700">
            <span className="text-gray-400">{new Date(entry.at).toLocaleString()}</span> — {entry.label}
          </li>
        ))}
      </ul>

      <h2 className="mt-6 text-sm font-semibold">Preflight / attestation results</h2>
      <ul className="mt-2 space-y-1 text-sm">
        {attestations.map((a) => (
          <li key={a.id} className="rounded border border-gray-200 p-2">
            <span className="font-medium">{a.overallStatus}</span> — {new Date(a.serverReceivedAt).toLocaleString()}
          </li>
        ))}
        {attestations.length === 0 && <li className="text-xs text-gray-400">No attestation recorded yet.</li>}
      </ul>

      <h2 className="mt-6 text-sm font-semibold">Recovery</h2>
      <ul className="mt-2 space-y-1 text-sm">
        {grants.map((g) => (
          <li key={g.id} className="rounded border border-gray-200 p-2">
            Issued by {g.issuedByName} at {new Date(g.issuedAt).toLocaleString()} — {g.reason}
            {g.consumedAt && " (consumed)"}
            {g.revokedAt && " (revoked)"}
          </li>
        ))}
      </ul>

      <div className="mt-3 space-y-2">
        <textarea
          className="w-full rounded border border-gray-300 p-2 text-sm"
          rows={2}
          placeholder="Reason (required for recovery grant or override)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="flex gap-2">
          <button onClick={issueRecoveryGrant} disabled={!reason.trim()} className="rounded border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50">
            Request oral verification may assist — issue recovery grant
          </button>
          <button onClick={grantOverride} disabled={!reason.trim()} className="rounded border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50">
            Grant override
          </button>
        </div>
        {message && <p className="rounded border border-gray-200 bg-gray-50 p-2 text-xs">{message}</p>}
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
