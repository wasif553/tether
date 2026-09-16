"use client";

import { useEffect, useState } from "react";

type AccessType = "INTERNAL" | "TRIAL" | "FREE" | "PAID";
type EntitlementStatus = "ACTIVE" | "SUSPENDED" | "EXPIRED" | "GRACE";
type EffectiveStatus = EntitlementStatus | "NOT_STARTED";

// Institution Entitlement & Access Control v1 — see
// docs/institution-entitlement-v1.md.
type EntitlementSummary = {
  accessType: AccessType;
  status: EntitlementStatus;
  endsAt: string | null;
  graceEndsAt: string | null;
} | null;

type UsageSummary = {
  candidateUsage: number;
  candidateLimit: number | null;
  attemptUsage: number;
  attemptLimit: number | null;
};

type Institution = {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  plan: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  _count: { users: number; exams: number; ltiPlatforms: number };
  entitlement: EntitlementSummary;
  effectiveStatus: EffectiveStatus;
  usage: UsageSummary;
};

type FullEntitlement = {
  accessType: AccessType;
  status: EntitlementStatus;
  startsAt: string | null;
  endsAt: string | null;
  graceEndsAt: string | null;
  candidateLimit: number | null;
  attemptLimit: number | null;
  secureBrowserEnabled: boolean;
  aiBrainstormingEnabled: boolean;
  aiMarkingEnabled: boolean;
  analyticsEnabled: boolean;
  advancedReportingEnabled: boolean;
  internalNotes: string | null;
};

function effectiveStatusBadgeClass(status: EffectiveStatus): string {
  switch (status) {
    case "ACTIVE":
      return "bg-green-100 text-green-700";
    case "GRACE":
      return "bg-amber-100 text-amber-800";
    case "NOT_STARTED":
      return "bg-blue-100 text-blue-700";
    default:
      return "bg-red-100 text-red-700";
  }
}

function formatUsage(usage: number, limit: number | null): string {
  return `${usage} / ${limit === null ? "Unlimited" : limit}`;
}

function toDateInputValue(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

function fromDateInputValue(value: string): string | null {
  if (!value) return null;
  // Midnight UTC on the chosen calendar date — good enough for a
  // date-only field with no time-of-day meaning attached.
  return new Date(`${value}T00:00:00.000Z`).toISOString();
}

/** Per-institution entitlement editor (section 11) — fetches the full row (internalNotes included; PLATFORM_ADMIN-only page) on first expand, edits locally, PUTs the whole form back on Save. */
function EntitlementEditor({ institutionId, onSaved }: { institutionId: string; onSaved: () => void }) {
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FullEntitlement | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    fetch(`/api/platform/institutions/${institutionId}/entitlement`)
      .then((res) => res.json())
      .then((body: { entitlement: FullEntitlement | null; suggestedDefault: FullEntitlement | null }) => {
        if (cancelled) return;
        setForm(body.entitlement ?? body.suggestedDefault);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [institutionId]);

  async function handleSave() {
    if (!form) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    const res = await fetch(`/api/platform/institutions/${institutionId}/entitlement`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(typeof body?.error === "string" ? body.error : "Failed to save entitlement");
      return;
    }
    setSaved(true);
    onSaved();
  }

  if (loading || !form) {
    return <p className="mt-3 text-sm text-gray-500">Loading entitlement...</p>;
  }

  const featureFlags: Array<{ key: keyof FullEntitlement; label: string }> = [
    { key: "secureBrowserEnabled", label: "Secure Browser" },
    { key: "aiBrainstormingEnabled", label: "Controlled AI Brainstorming" },
    { key: "aiMarkingEnabled", label: "AI-assisted marking" },
    { key: "analyticsEnabled", label: "Analytics" },
    { key: "advancedReportingEnabled", label: "Advanced reporting" },
  ];

  return (
    <div className="mt-3 space-y-4 rounded border border-gray-200 bg-gray-50 p-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600">Access type</label>
          <select
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            value={form.accessType}
            onChange={(e) => setForm({ ...form, accessType: e.target.value as AccessType })}
          >
            <option value="INTERNAL">Internal</option>
            <option value="TRIAL">Trial</option>
            <option value="FREE">Free</option>
            <option value="PAID">Paid</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600">Status</label>
          <select
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value as EntitlementStatus })}
          >
            <option value="ACTIVE">Active</option>
            <option value="SUSPENDED">Suspended</option>
            <option value="GRACE">Grace</option>
            <option value="EXPIRED">Expired</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600">Start date (optional)</label>
          <input
            type="date"
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            value={toDateInputValue(form.startsAt)}
            onChange={(e) => setForm({ ...form, startsAt: fromDateInputValue(e.target.value) })}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600">End date (empty = no expiry)</label>
          <input
            type="date"
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            value={toDateInputValue(form.endsAt)}
            onChange={(e) => setForm({ ...form, endsAt: fromDateInputValue(e.target.value) })}
          />
        </div>
        {form.status === "GRACE" && (
          <div>
            <label className="block text-xs font-medium text-gray-600">Grace end date</label>
            <input
              type="date"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              value={toDateInputValue(form.graceEndsAt)}
              onChange={(e) => setForm({ ...form, graceEndsAt: fromDateInputValue(e.target.value) })}
            />
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600">Candidate limit (empty = unlimited)</label>
          <input
            type="number"
            min={1}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            value={form.candidateLimit ?? ""}
            onChange={(e) => setForm({ ...form, candidateLimit: e.target.value === "" ? null : Number(e.target.value) })}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600">Assessment-attempt limit (empty = unlimited)</label>
          <input
            type="number"
            min={1}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            value={form.attemptLimit ?? ""}
            onChange={(e) => setForm({ ...form, attemptLimit: e.target.value === "" ? null : Number(e.target.value) })}
          />
        </div>
      </div>

      <div>
        <span className="block text-xs font-medium text-gray-600">Licensed features</span>
        <div className="mt-1 grid grid-cols-2 gap-1">
          {featureFlags.map(({ key, label }) => (
            <label key={key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form[key] as boolean}
                onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-600">Internal notes (never shown to institution users)</label>
        <textarea
          className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          rows={2}
          value={form.internalNotes ?? ""}
          onChange={(e) => setForm({ ...form, internalNotes: e.target.value === "" ? null : e.target.value })}
        />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {saved && <p className="text-sm text-green-700">Entitlement saved.</p>}
      <button
        onClick={handleSave}
        disabled={saving}
        className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save entitlement"}
      </button>
    </div>
  );
}

type AuditLog = {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  institutionId: string | null;
  actor: { name: string; email: string } | null;
  createdAt: string;
};

export default function PlatformInstitutionsPage() {
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [domain, setDomain] = useState("");
  const [plan, setPlan] = useState("pilot");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [expandedEntitlementId, setExpandedEntitlementId] = useState<string | null>(null);

  const [inviteInstitutionId, setInviteInstitutionId] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePassword, setInvitePassword] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);

  const [studentInstitutionId, setStudentInstitutionId] = useState("");
  const [studentName, setStudentName] = useState("");
  const [studentEmail, setStudentEmail] = useState("");
  const [studentPassword, setStudentPassword] = useState("");
  const [studentInstitutionStudentId, setStudentInstitutionStudentId] = useState("");
  const [invitingStudent, setInvitingStudent] = useState(false);
  const [studentError, setStudentError] = useState<string | null>(null);
  const [studentSuccess, setStudentSuccess] = useState<string | null>(null);

  async function loadAll() {
    setLoading(true);
    const [instRes, logsRes] = await Promise.all([
      fetch("/api/platform/institutions"),
      fetch("/api/platform/audit-logs?limit=20"),
    ]);
    if (instRes.status === 401 || instRes.status === 403) {
      setAccessDenied(true);
      setLoading(false);
      return;
    }
    if (instRes.ok) setInstitutions(await instRes.json());
    if (logsRes.ok) setAuditLogs(await logsRes.json());
    setLoading(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);

    const res = await fetch("/api/platform/institutions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, slug, domain: domain || undefined, plan }),
    });

    setCreating(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setCreateError(typeof body?.error === "string" ? body.error : "Failed to create institution");
      return;
    }

    setName("");
    setSlug("");
    setDomain("");
    setPlan("pilot");
    await loadAll();
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteError(null);
    setInviteSuccess(null);
    if (!inviteInstitutionId) {
      setInviteError("Select an institution");
      return;
    }
    setInviting(true);

    const res = await fetch(`/api/platform/institutions/${inviteInstitutionId}/invite-lecturer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: inviteName, email: inviteEmail, password: invitePassword }),
    });

    setInviting(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setInviteError(typeof body?.error === "string" ? body.error : "Failed to invite lecturer");
      return;
    }

    setInviteSuccess(`Lecturer ${inviteEmail} created. Share the temporary password securely.`);
    setInviteName("");
    setInviteEmail("");
    setInvitePassword("");
    await loadAll();
  }

  async function handleInviteStudent(e: React.FormEvent) {
    e.preventDefault();
    setStudentError(null);
    setStudentSuccess(null);
    if (!studentInstitutionId) {
      setStudentError("Select an institution");
      return;
    }
    setInvitingStudent(true);

    const res = await fetch(`/api/platform/institutions/${studentInstitutionId}/invite-student`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: studentName,
        email: studentEmail,
        password: studentPassword,
        institutionStudentId: studentInstitutionStudentId || undefined,
      }),
    });

    setInvitingStudent(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setStudentError(typeof body?.error === "string" ? body.error : "Failed to invite student");
      return;
    }

    setStudentSuccess(`Student ${studentEmail} created. Share the temporary password securely.`);
    setStudentName("");
    setStudentEmail("");
    setStudentPassword("");
    setStudentInstitutionStudentId("");
    await loadAll();
  }

  if (accessDenied) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 text-gray-500">This page is only available to platform administrators.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Platform institutions</h1>
        <p className="mt-1 text-gray-500">
          Manage controlled pilot institutions and lecturer access.
        </p>
      </div>

      <section>
        <h2 className="text-lg font-medium">Institutions</h2>
        {loading && <p className="mt-2 text-gray-500">Loading...</p>}
        {!loading && institutions.length === 0 && (
          <p className="mt-2 text-gray-500">No institutions yet.</p>
        )}
        <div className="mt-3 space-y-3">
          {institutions.map((inst) => (
            <div key={inst.id} className="rounded border border-gray-200 p-4">
              <div className="flex items-center justify-between">
                <span className="font-medium">{inst.name}</span>
                {/* Institution Entitlement & Access Control v1 (hardening
                    pass, section 4) — the entitlement summary row below
                    is the ONE authoritative status indicator now.
                    Institution.active/plan are legacy fields with no
                    effect on access (see their label below) — showing a
                    second, independently-toggleable "Active/Inactive"
                    badge here would let it silently disagree with the
                    entitlement's own effective status, which is exactly
                    the dual-authority conflict this pass closes. */}
              </div>
              <p className="mt-1 text-sm text-gray-500">
                slug: {inst.slug} · domain: {inst.domain ?? "—"} · legacy plan label: {inst.plan} (informational
                only — superseded by entitlement below) · created {new Date(inst.createdAt).toLocaleDateString()}
              </p>
              <p className="mt-1 text-sm text-gray-500">
                {inst._count.users} users · {inst._count.exams} exams · {inst._count.ltiPlatforms} LTI
                platforms
              </p>

              {/* Institution Entitlement & Access Control v1, section 21 —
                  at-a-glance access summary: access type, effective
                  status, expiry, candidate/attempt usage vs limit. */}
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{inst.entitlement?.accessType ?? "—"}</span>
                <span className={`rounded px-2 py-0.5 text-xs ${effectiveStatusBadgeClass(inst.effectiveStatus)}`}>
                  {inst.effectiveStatus === "GRACE"
                    ? inst.entitlement?.graceEndsAt
                      ? `Grace until ${new Date(inst.entitlement.graceEndsAt).toLocaleDateString()}`
                      : "Grace"
                    : inst.effectiveStatus}
                </span>
                <span className="text-gray-500">{inst.entitlement?.endsAt ? new Date(inst.entitlement.endsAt).toLocaleDateString() : "No expiry"}</span>
                <span className="text-gray-500">{formatUsage(inst.usage.candidateUsage, inst.usage.candidateLimit)} candidates</span>
                <span className="text-gray-500">{formatUsage(inst.usage.attemptUsage, inst.usage.attemptLimit)} attempts</span>
              </div>

              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => setExpandedEntitlementId(expandedEntitlementId === inst.id ? null : inst.id)}
                  className="rounded border border-gray-300 px-3 py-1 text-sm hover:border-gray-500"
                >
                  {expandedEntitlementId === inst.id ? "Hide entitlement" : "Manage entitlement"}
                </button>
              </div>

              {expandedEntitlementId === inst.id && (
                <EntitlementEditor institutionId={inst.id} onSaved={loadAll} />
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-medium">Create institution</h2>
        <form onSubmit={handleCreate} className="mt-3 space-y-3 rounded border border-gray-200 p-4">
          <div>
            <label className="block text-sm font-medium">Name</label>
            <input
              required
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium">Slug</label>
            <input
              required
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="example-university"
            />
          </div>
          <div>
            <label className="block text-sm font-medium">Domain (optional)</label>
            <input
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="example.edu"
            />
          </div>
          <div>
            <label className="block text-sm font-medium">Plan</label>
            <input
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
            />
          </div>
          {createError && <p className="text-sm text-red-600">{createError}</p>}
          <button
            type="submit"
            disabled={creating}
            className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            {creating ? "Creating..." : "Create institution"}
          </button>
        </form>
      </section>

      <section>
        <h2 className="text-lg font-medium">Invite lecturer</h2>
        <form onSubmit={handleInvite} className="mt-3 space-y-3 rounded border border-gray-200 p-4">
          <div>
            <label className="block text-sm font-medium">Institution</label>
            <select
              required
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={inviteInstitutionId}
              onChange={(e) => setInviteInstitutionId(e.target.value)}
            >
              <option value="">Select an institution</option>
              {institutions.map((inst) => (
                <option key={inst.id} value={inst.id}>
                  {inst.name} ({inst.slug})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium">Lecturer name</label>
            <input
              required
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={inviteName}
              onChange={(e) => setInviteName(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium">Lecturer email</label>
            <input
              required
              type="email"
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium">Temporary password</label>
            <input
              required
              type="text"
              minLength={8}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={invitePassword}
              onChange={(e) => setInvitePassword(e.target.value)}
            />
          </div>
          <p className="text-sm text-amber-700">
            Share temporary passwords securely. Email sending is not implemented yet.
          </p>
          {inviteError && <p className="text-sm text-red-600">{inviteError}</p>}
          {inviteSuccess && <p className="text-sm text-green-700">{inviteSuccess}</p>}
          <button
            type="submit"
            disabled={inviting}
            className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            {inviting ? "Inviting..." : "Invite lecturer"}
          </button>
        </form>
      </section>

      <section>
        <h2 className="text-lg font-medium">Invite student</h2>
        <form onSubmit={handleInviteStudent} className="mt-3 space-y-3 rounded border border-gray-200 p-4">
          <div>
            <label className="block text-sm font-medium">Institution</label>
            <select
              required
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={studentInstitutionId}
              onChange={(e) => setStudentInstitutionId(e.target.value)}
            >
              <option value="">Select an institution</option>
              {institutions.map((inst) => (
                <option key={inst.id} value={inst.id}>
                  {inst.name} ({inst.slug})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium">Student name</label>
            <input
              required
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={studentName}
              onChange={(e) => setStudentName(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium">Student email</label>
            <input
              required
              type="email"
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={studentEmail}
              onChange={(e) => setStudentEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium">Temporary password</label>
            <input
              required
              type="text"
              minLength={8}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={studentPassword}
              onChange={(e) => setStudentPassword(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium">Institutional student ID (optional)</label>
            <input
              type="text"
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              placeholder="e.g. a roll number or SIS ID"
              value={studentInstitutionStudentId}
              onChange={(e) => setStudentInstitutionStudentId(e.target.value)}
            />
            <p className="mt-1 text-xs text-gray-500">
              Not a login credential. Used only for identification on exports and reports.
            </p>
          </div>
          <p className="text-sm text-amber-700">
            Share temporary passwords securely. Email sending is not implemented yet.
          </p>
          {studentError && <p className="text-sm text-red-600">{studentError}</p>}
          {studentSuccess && <p className="text-sm text-green-700">{studentSuccess}</p>}
          <button
            type="submit"
            disabled={invitingStudent}
            className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            {invitingStudent ? "Inviting..." : "Invite student"}
          </button>
        </form>
      </section>

      <section>
        <h2 className="text-lg font-medium">Recent platform audit logs</h2>
        <div className="mt-3 space-y-2">
          {auditLogs.length === 0 && <p className="text-gray-500">No audit log entries yet.</p>}
          {auditLogs.map((log) => (
            <div key={log.id} className="rounded border border-gray-200 p-3 text-sm">
              <span className="font-medium">{log.action}</span>{" "}
              <span className="text-gray-500">
                · institution {log.institutionId ?? "—"} · actor {log.actor?.email ?? log.id} ·{" "}
                {new Date(log.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
