"use client";

/**
 * Tether Secure Client Foundation v1 — MOCK client development
 * simulator. See docs/secure-client-foundation-seb-v1.md and Part 13 of
 * the spec.
 *
 * DEVELOPMENT SIMULATOR ONLY — never a verified production client. No OS
 * restriction claims, no real process scanning, no capture blocking, no
 * installer, no code-signing claim. Every "warning" scenario below is a
 * hand-constructed test payload, not a real device check. The backend
 * independently refuses to issue a mock launch manifest outside an
 * authorised development/test context (Part 9/13) — this page simply
 * calls the same real APIs a genuine client would.
 */
import { use as usePromise, useState } from "react";

type Manifest = { manifestId: string; nonce: string; submissionId: string; [key: string]: unknown };

export default function MockSecureClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: submissionId } = usePromise(params);
  const [log, setLog] = useState<string[]>([]);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  function appendLog(line: string) {
    setLog((prev) => [...prev, `${new Date().toLocaleTimeString()} — ${line}`]);
  }

  async function launch() {
    const res = await fetch(`/api/submissions/${submissionId}/secure-client/mock-launch`, { method: "POST" });
    const body = await res.json();
    if (!res.ok) {
      appendLog(`Launch unavailable: ${body.error}`);
      return;
    }
    setManifest(body.manifest);
    setSignature(body.signature);
    appendLog("Manifest issued.");
  }

  async function consume(overrides: Partial<Manifest> = {}, useSignature = signature) {
    if (!manifest) return;
    const payload = { ...manifest, ...overrides };
    const res = await fetch(`/api/secure-client/launch/${payload.manifestId}/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest: payload, signature: useSignature }),
    });
    const body = await res.json();
    if (res.ok) {
      setSessionId(body.sessionId);
      appendLog(`Consumed — session ${body.sessionId}.`);
    } else {
      appendLog(`Consume rejected: ${body.code ?? body.error}`);
    }
  }

  async function attest(scenario: string, checks: Record<string, string>, extra: Record<string, boolean> = {}) {
    if (!sessionId) return;
    const res = await fetch(`/api/secure-client/sessions/${sessionId}/attestation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "MockOS", clientVersion: "0.0.0-mock", checks, required: Object.fromEntries(Object.keys(checks).map((k) => [k, true])), ...extra }),
    });
    const body = await res.json();
    appendLog(`${scenario}: overallStatus=${body.overallStatus ?? body.error}`);
  }

  async function heartbeat() {
    if (!sessionId) return;
    await fetch(`/api/secure-client/sessions/${sessionId}/heartbeat`, { method: "POST" });
    appendLog("Heartbeat sent.");
  }

  async function interrupt() {
    if (!sessionId) return;
    await fetch(`/api/secure-client/sessions/${sessionId}/interrupt`, { method: "POST" });
    appendLog("Interruption reported.");
  }

  async function recover() {
    if (!sessionId) return;
    const res = await fetch(`/api/secure-client/sessions/${sessionId}/recover`, { method: "POST" });
    const body = await res.json();
    appendLog(`Recover: ${body.status ?? body.error}`);
  }

  async function end() {
    if (!sessionId) return;
    await fetch(`/api/secure-client/sessions/${sessionId}/end`, { method: "POST" });
    appendLog("Session ended.");
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="rounded border-2 border-dashed border-amber-400 bg-amber-50 p-3 text-sm text-amber-900">
        <p className="font-semibold">Development simulator</p>
        <p>Not a verified production client. Never available in Production. No real device checks are performed.</p>
      </div>

      <h1 className="mt-4 text-xl font-semibold">Mock Tether Secure Client</h1>

      <div className="mt-4 flex flex-wrap gap-2">
        <button onClick={launch} className="rounded border border-gray-300 px-3 py-1.5 text-sm">
          1. Request launch manifest
        </button>
        <button onClick={() => consume()} disabled={!manifest} className="rounded border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50">
          2. Consume manifest (valid)
        </button>
        <button onClick={() => consume()} disabled={!manifest} className="rounded border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50">
          Replay same manifest (should be rejected)
        </button>
        <button
          onClick={() => consume({}, "invalid-signature-bytes")}
          disabled={!manifest}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50"
        >
          Consume with invalid signature
        </button>
        <button
          onClick={() => consume({ expiresAt: new Date(Date.now() - 1000).toISOString() })}
          disabled={!manifest}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50"
        >
          Consume expired manifest
        </button>
      </div>

      <h2 className="mt-4 text-sm font-semibold">Attestation scenarios</h2>
      <div className="mt-2 flex flex-wrap gap-2">
        <button onClick={() => attest("Ready", { displayCheck: "PASS" })} disabled={!sessionId} className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-50">
          Ready
        </button>
        <button onClick={() => attest("Additional display", { displayCheck: "FAIL" })} disabled={!sessionId} className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-50">
          Additional display
        </button>
        <button onClick={() => attest("Unsupported version", {}, { versionUnsupported: true })} disabled={!sessionId} className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-50">
          Unsupported client version
        </button>
        <button onClick={() => attest("Remote session warning", { remoteSession: "WARNING" })} disabled={!sessionId} className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-50">
          Remote-session warning
        </button>
        <button onClick={() => attest("VM warning", { virtualMachine: "WARNING" })} disabled={!sessionId} className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-50">
          Virtual-machine warning
        </button>
        <button onClick={() => attest("Prohibited process warning", { processCheck: "WARNING" })} disabled={!sessionId} className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-50">
          Prohibited-process warning
        </button>
      </div>

      <h2 className="mt-4 text-sm font-semibold">Session lifecycle</h2>
      <div className="mt-2 flex flex-wrap gap-2">
        <button onClick={heartbeat} disabled={!sessionId} className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-50">
          Send heartbeat
        </button>
        <button onClick={interrupt} disabled={!sessionId} className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-50">
          Simulate interruption
        </button>
        <button onClick={recover} disabled={!sessionId} className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-50">
          Recover
        </button>
        <button onClick={end} disabled={!sessionId} className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-50">
          End session
        </button>
      </div>

      <h2 className="mt-4 text-sm font-semibold">Log</h2>
      <ul className="mt-2 space-y-0.5 rounded border border-gray-200 p-2 text-xs">
        {log.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
