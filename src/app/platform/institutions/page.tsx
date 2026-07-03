"use client";

import { useEffect, useState } from "react";

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
};

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

  async function handleToggleActive(institution: Institution) {
    const res = await fetch(`/api/platform/institutions/${institution.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !institution.active }),
    });
    if (res.ok) await loadAll();
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
                <span
                  className={
                    inst.active
                      ? "rounded bg-green-100 px-2 py-0.5 text-xs text-green-700"
                      : "rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                  }
                >
                  {inst.active ? "Active" : "Inactive"}
                </span>
              </div>
              <p className="mt-1 text-sm text-gray-500">
                slug: {inst.slug} · domain: {inst.domain ?? "—"} · plan: {inst.plan} · created{" "}
                {new Date(inst.createdAt).toLocaleDateString()}
              </p>
              <p className="mt-1 text-sm text-gray-500">
                {inst._count.users} users · {inst._count.exams} exams · {inst._count.ltiPlatforms} LTI
                platforms
              </p>
              <button
                onClick={() => handleToggleActive(inst)}
                className="mt-2 rounded border border-gray-300 px-3 py-1 text-sm hover:border-gray-500"
              >
                {inst.active ? "Deactivate" : "Activate"}
              </button>
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
