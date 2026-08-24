"use client";

import { use as usePromise, useEffect, useState } from "react";
import Link from "next/link";

type MaskedKey = {
  id: string;
  keyType: string;
  fingerprint: string;
  platform: string | null;
  clientVersion: string | null;
  label: string | null;
  active: boolean;
  createdAt: string;
  revokedAt: string | null;
};

type Configuration = {
  id: string;
  provider: string;
  status: string;
  displayName: string | null;
  configurationVersion: number;
  configurationHash: string | null;
  startUrlTemplate: string | null;
  quitUrlTemplate: string | null;
  activatedAt: string | null;
  revokedAt: string | null;
  sebKeys: MaskedKey[];
};

type SessionRow = {
  id: string;
  studentName: string;
  submissionId: string;
  clientType: string;
  status: string;
  verificationStatus: string;
  startedAt: string;
  lastHeartbeatAt: string | null;
  interruptedAt: string | null;
  recoveredAt: string | null;
  reviewContextEventCount: number;
};

const STATUS_FILTERS = ["ALL", "ACTIVE", "PREFLIGHT", "ACTION_REQUIRED", "INTERRUPTED", "REJECTED", "ENDED"] as const;

export default function SecureClientConfigurationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [configurations, setConfigurations] = useState<Configuration[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]>("ALL");
  const [newKeyType, setNewKeyType] = useState<"BROWSER_EXAM_KEY" | "CONFIG_KEY">("BROWSER_EXAM_KEY");
  const [newKeyValue, setNewKeyValue] = useState("");
  const [newKeyPlatform, setNewKeyPlatform] = useState("");
  const [newKeyLabel, setNewKeyLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  function loadConfigurations() {
    fetch(`/api/lecturer/exams/${id}/secure-client/configuration`)
      .then((r) => r.json())
      .then((d) => setConfigurations(d.configurations ?? []));
  }
  function loadSessions() {
    const query = filter === "ALL" ? "" : `?status=${filter}`;
    fetch(`/api/lecturer/exams/${id}/secure-client/sessions${query}`)
      .then((r) => r.json())
      .then((d) => setSessions(d.sessions ?? []));
  }

  useEffect(() => {
    loadConfigurations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, filter]);

  const sebConfig = configurations.find((c) => c.provider === "SAFE_EXAM_BROWSER");

  async function createDraftIfNeeded() {
    if (sebConfig) return sebConfig.id;
    setError(null);
    const res = await fetch(`/api/lecturer/exams/${id}/secure-client/configuration`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "SAFE_EXAM_BROWSER" }),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(body.error ?? "Failed to create configuration");
      return null;
    }
    loadConfigurations();
    return body.configurationId as string;
  }

  async function addKey() {
    const configId = await createDraftIfNeeded();
    if (!configId) return;
    setError(null);
    const res = await fetch(`/api/lecturer/exams/${id}/secure-client/seb-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ configurationId: configId, keyType: newKeyType, rawKey: newKeyValue, platform: newKeyPlatform || undefined, label: newKeyLabel || undefined }),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(body.error ?? "Failed to add key");
      return;
    }
    setNewKeyValue("");
    setNewKeyPlatform("");
    setNewKeyLabel("");
    loadConfigurations();
  }

  async function revokeKey(keyId: string) {
    await fetch(`/api/lecturer/exams/${id}/secure-client/seb-keys/${keyId}`, { method: "DELETE" });
    loadConfigurations();
  }

  async function activate() {
    if (!sebConfig) return;
    setError(null);
    const res = await fetch(`/api/lecturer/exams/${id}/secure-client/configuration/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ configurationId: sebConfig.id }),
    });
    const body = await res.json();
    if (!res.ok) setError(body.error ?? "Failed to activate");
    loadConfigurations();
  }

  async function revoke() {
    if (!sebConfig) return;
    await fetch(`/api/lecturer/exams/${id}/secure-client/configuration/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ configurationId: sebConfig.id }),
    });
    loadConfigurations();
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link href={`/lecturer/exams/${id}`} className="text-sm text-lecturer-text-secondary">
        &larr; Back to exam settings
      </Link>
      <h1 className="mt-2 text-[28px] font-bold text-lecturer-text-primary">Secure-client session</h1>
      <p className="mt-1 text-sm text-lecturer-text-secondary">
        Review client verification, device preflight and session continuity. These signals support lecturer review and do
        not by themselves establish misconduct.
      </p>

      {error && <p className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-[#B42318]">{error}</p>}

      <section className="mt-6 rounded border border-lecturer-border p-4">
        <h2 className="text-sm font-semibold">Safe Exam Browser configuration</h2>
        <div className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <p className="text-xs text-lecturer-text-secondary">Status</p>
            <p className="font-medium">{sebConfig?.status ?? "Not configured"}</p>
          </div>
          <div>
            <p className="text-xs text-lecturer-text-secondary">Version</p>
            <p className="font-medium">{sebConfig?.configurationVersion ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs text-lecturer-text-secondary">Activated</p>
            <p className="font-medium">{sebConfig?.activatedAt ? new Date(sebConfig.activatedAt).toLocaleString() : "—"}</p>
          </div>
          <div>
            <p className="text-xs text-lecturer-text-secondary">Configuration hash</p>
            <p className="truncate font-mono text-xs">{sebConfig?.configurationHash ?? "—"}</p>
          </div>
        </div>

        <div className="mt-3 flex gap-2">
          {sebConfig?.status !== "ACTIVE" && (
            <button onClick={activate} className="rounded border border-lecturer-border px-3 py-1.5 text-sm">
              Activate
            </button>
          )}
          {sebConfig?.status === "ACTIVE" && (
            <button onClick={revoke} className="rounded border border-red-300 px-3 py-1.5 text-sm text-[#B42318]">
              Revoke
            </button>
          )}
        </div>

        <h3 className="mt-4 text-sm font-medium">Accepted Browser Exam Keys / Config Keys</h3>
        <p className="text-xs text-lecturer-text-secondary">Only a masked fingerprint is ever shown — full key values are never displayed after entry.</p>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-lecturer-text-secondary">
              <th className="py-1">Type</th>
              <th>Fingerprint</th>
              <th>Platform</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(sebConfig?.sebKeys ?? []).map((k) => (
              <tr key={k.id} className="border-t border-lecturer-border-subtle">
                <td className="py-1">{k.keyType}</td>
                <td className="font-mono text-xs">{k.fingerprint}</td>
                <td>{k.platform ?? "—"}</td>
                <td>{k.active ? "Active" : "Revoked"}</td>
                <td>
                  {k.active && (
                    <button onClick={() => revokeKey(k.id)} className="text-xs text-[#B42318]">
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {(sebConfig?.sebKeys ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="py-2 text-xs text-lecturer-text-muted">
                  No keys added yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <select value={newKeyType} onChange={(e) => setNewKeyType(e.target.value as "BROWSER_EXAM_KEY" | "CONFIG_KEY")} className="rounded border border-lecturer-border px-2 py-1 text-sm">
            <option value="BROWSER_EXAM_KEY">Browser Exam Key</option>
            <option value="CONFIG_KEY">Config Key</option>
          </select>
          <input
            className="rounded border border-lecturer-border px-2 py-1 text-sm"
            placeholder="Key value"
            value={newKeyValue}
            onChange={(e) => setNewKeyValue(e.target.value)}
          />
          <input
            className="rounded border border-lecturer-border px-2 py-1 text-sm"
            placeholder="Platform (optional)"
            value={newKeyPlatform}
            onChange={(e) => setNewKeyPlatform(e.target.value)}
          />
          <input
            className="rounded border border-lecturer-border px-2 py-1 text-sm"
            placeholder="Label (optional)"
            value={newKeyLabel}
            onChange={(e) => setNewKeyLabel(e.target.value)}
          />
        </div>
        <button onClick={addKey} disabled={newKeyValue.length < 8} className="mt-2 rounded border border-lecturer-border px-3 py-1.5 text-sm disabled:opacity-50">
          Add key
        </button>
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-semibold">Sessions</h2>
        <div className="mt-2 flex flex-wrap gap-1 text-xs">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded border px-2 py-1 ${filter === f ? "border-gray-500 bg-lecturer-border-subtle" : "border-lecturer-border"}`}
            >
              {f.charAt(0) + f.slice(1).toLowerCase().replaceAll("_", " ")}
            </button>
          ))}
        </div>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-lecturer-text-secondary">
              <th className="py-1">Student</th>
              <th>Client</th>
              <th>Status</th>
              <th>Verification</th>
              <th>Last heartbeat</th>
              <th>Review signals</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id} className="border-t border-lecturer-border-subtle">
                <td className="py-1">
                  <Link href={`/lecturer/secure-client/sessions/${s.id}`} className="text-lecturer-accent hover:underline">
                    {s.studentName}
                  </Link>
                </td>
                <td>{s.clientType}</td>
                <td>{s.status}</td>
                <td>{s.verificationStatus}</td>
                <td>{s.lastHeartbeatAt ? new Date(s.lastHeartbeatAt).toLocaleTimeString() : "—"}</td>
                <td>{s.reviewContextEventCount}</td>
              </tr>
            ))}
            {sessions.length === 0 && (
              <tr>
                <td colSpan={6} className="py-2 text-xs text-lecturer-text-muted">
                  No sessions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
