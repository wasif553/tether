"use client";

/**
 * Tether Course Invitation + Acceptance v1 — see
 * docs/tether-course-invitation-acceptance-v1.md. "Add a student" now
 * distinguishes: already same-institution (immediate enrolment, as
 * before), no Tether account at all (clear message, no account ever
 * created here), and has a Tether account but no institution yet (offer
 * "Create invitation" instead of silently claiming them).
 */

import { useEffect, useState, use as usePromise } from "react";

type Enrollment = {
  id: string;
  role: "STUDENT" | "LECTURER";
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    institutionStudentId: string | null;
  };
};

type CourseDetail = {
  id: string;
  name: string;
  code: string;
  description: string | null;
  enrollments: Enrollment[];
};

type InvitationRow = {
  id: string;
  student: { id: string; name: string; email: string };
  status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

type AddStudentState =
  | { kind: "idle" }
  | { kind: "invitation_required"; student: { id: string; name: string; email: string } }
  | { kind: "error"; message: string };

export default function CourseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [addState, setAddState] = useState<AddStudentState>({ kind: "idle" });

  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [creatingInviteFor, setCreatingInviteFor] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  // The plaintext invitation link is only ever known for the lifetime of
  // this page load, right after a Create/Regenerate call — never
  // refetchable afterwards (the server only stores a hash). null after a
  // reload even for an invitation that is still pending.
  const [revealedInviteUrl, setRevealedInviteUrl] = useState<{ invitationId: string; url: string } | null>(null);
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  function load() {
    setLoading(true);
    fetch(`/api/courses/${id}`)
      .then((res) => res.json())
      .then(setCourse)
      .finally(() => setLoading(false));
  }

  function loadInvitations() {
    fetch(`/api/courses/${id}/invitations`)
      .then((res) => (res.ok ? res.json() : []))
      .then((rows: InvitationRow[]) => setInvitations(rows))
      .catch(() => setInvitations([]));
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    loadInvitations();
  }, [id]);

  async function addStudent() {
    setEnrolling(true);
    setAddState({ kind: "idle" });
    const res = await fetch(`/api/courses/${id}/enrolments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, role: "STUDENT" }),
    });
    const body = await res.json().catch(() => null);
    setEnrolling(false);

    if (res.ok && body?.status === "enrolled") {
      setEmail("");
      setAddState({ kind: "idle" });
      load();
      return;
    }
    if (res.ok && body?.code === "INVITATION_REQUIRED") {
      setAddState({ kind: "invitation_required", student: body.student });
      return;
    }
    setAddState({
      kind: "error",
      message: typeof body?.error === "string" ? body.error : "Failed to add student.",
    });
  }

  async function createInvitation(studentEmail: string) {
    setCreatingInviteFor(studentEmail);
    setInviteError(null);
    const res = await fetch(`/api/courses/${id}/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: studentEmail }),
    });
    const body = await res.json().catch(() => null);
    setCreatingInviteFor(null);
    if (!res.ok) {
      setInviteError(typeof body?.error === "string" ? body.error : "Failed to create invitation.");
      return;
    }
    setRevealedInviteUrl({
      invitationId: body.invitationId,
      url: typeof window !== "undefined" ? `${window.location.origin}${body.invitationUrl}` : body.invitationUrl,
    });
    setAddState({ kind: "idle" });
    setEmail("");
    loadInvitations();
  }

  async function regenerateInvitation(invitationId: string, studentEmail: string) {
    setCreatingInviteFor(invitationId);
    setInviteError(null);
    const res = await fetch(`/api/courses/${id}/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: studentEmail }),
    });
    const body = await res.json().catch(() => null);
    setCreatingInviteFor(null);
    if (!res.ok) {
      setInviteError(typeof body?.error === "string" ? body.error : "Failed to regenerate invitation.");
      return;
    }
    setRevealedInviteUrl({
      invitationId: body.invitationId,
      url: typeof window !== "undefined" ? `${window.location.origin}${body.invitationUrl}` : body.invitationUrl,
    });
    loadInvitations();
  }

  async function cancelInvitation(invitationId: string) {
    setCancellingId(invitationId);
    await fetch(`/api/courses/${id}/invitations/${invitationId}`, { method: "DELETE" });
    setCancellingId(null);
    if (revealedInviteUrl?.invitationId === invitationId) setRevealedInviteUrl(null);
    loadInvitations();
  }

  async function handleCopyInvite() {
    if (!revealedInviteUrl) return;
    try {
      await navigator.clipboard.writeText(revealedInviteUrl.url);
      setCopiedInvite(true);
      setTimeout(() => setCopiedInvite(false), 2000);
    } catch {
      // Clipboard access can fail — the link is still visible/selectable.
    }
  }

  async function removeEnrolment(userId: string) {
    await fetch(`/api/courses/${id}/enrolments/${userId}`, { method: "DELETE" });
    load();
  }

  if (loading) return <p className="text-gray-500">Loading...</p>;
  if (!course) return <p className="text-red-600">Course not found.</p>;

  const students = course.enrollments.filter((e) => e.role === "STUDENT");
  const lecturers = course.enrollments.filter((e) => e.role === "LECTURER");
  const pendingInvitations = invitations.filter((inv) => inv.status === "PENDING" || inv.status === "EXPIRED");

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">
        {course.code} — {course.name}
      </h1>
      {course.description && <p className="mt-1 text-gray-600">{course.description}</p>}

      <div className="mt-6 rounded border border-gray-200 p-4">
        <h2 className="font-medium">Add a student</h2>
        <p className="mt-1 text-sm text-gray-500">
          Add a student using the email on their Tether account.
        </p>
        <div className="mt-3 flex items-end gap-2">
          <input
            type="email"
            placeholder="student@example.com"
            className="flex-1 rounded border border-gray-300 px-3 py-1.5 text-sm"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button
            onClick={addStudent}
            disabled={enrolling || !email.trim()}
            className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {enrolling ? "Adding..." : "Add student"}
          </button>
        </div>

        {addState.kind === "error" && (
          <p className="mt-2 text-sm text-red-600">{addState.message}</p>
        )}

        {addState.kind === "invitation_required" && (
          <div className="mt-3 rounded border border-gray-200 bg-gray-50 p-3">
            <p className="text-sm text-gray-700">
              This student has a Tether account but is not yet linked to your institution.
            </p>
            <button
              onClick={() => createInvitation(addState.student.email)}
              disabled={creatingInviteFor === addState.student.email}
              className="mt-2 rounded border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {creatingInviteFor === addState.student.email ? "Creating..." : "Create invitation"}
            </button>
          </div>
        )}

        {inviteError && <p className="mt-2 text-sm text-red-600">{inviteError}</p>}
      </div>

      {pendingInvitations.length > 0 && (
        <>
          <h2 className="mt-6 text-lg font-medium">Pending invitations ({pendingInvitations.length})</h2>
          <div className="mt-2 space-y-2">
            {pendingInvitations.map((inv) => (
              <div key={inv.id} className="rounded border border-gray-200 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span>
                    {inv.student.name} — {inv.student.email}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      inv.status === "EXPIRED" ? "bg-gray-200 text-gray-700" : "bg-amber-100 text-amber-800"
                    }`}
                  >
                    {inv.status === "EXPIRED" ? "Expired" : "Pending"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Expires {new Date(inv.expiresAt).toLocaleString()}
                </p>

                {revealedInviteUrl?.invitationId === inv.id ? (
                  <div className="mt-2 rounded border border-gray-200 bg-gray-50 p-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        readOnly
                        value={revealedInviteUrl.url}
                        onFocus={(e) => e.target.select()}
                        className="flex-1 rounded border border-gray-300 px-2 py-1 text-xs"
                      />
                      <button
                        onClick={handleCopyInvite}
                        className="rounded border border-gray-300 px-2 py-1 text-xs"
                      >
                        {copiedInvite ? "Copied!" : "Copy link"}
                      </button>
                    </div>
                    <p className="mt-1 text-xs text-gray-500">
                      Shown once — copy it now. The student must accept this invitation before joining the course.
                    </p>
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-gray-500">Invitation pending.</p>
                )}

                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => regenerateInvitation(inv.id, inv.student.email)}
                    disabled={creatingInviteFor === inv.id}
                    className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-50"
                  >
                    {creatingInviteFor === inv.id ? "Regenerating..." : "Regenerate invitation"}
                  </button>
                  <button
                    onClick={() => cancelInvitation(inv.id)}
                    disabled={cancellingId === inv.id}
                    className="rounded border border-gray-300 px-2 py-1 text-xs text-red-600 disabled:opacity-50"
                  >
                    {cancellingId === inv.id ? "Cancelling..." : "Cancel invitation"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="mt-6 text-lg font-medium">Lecturers ({lecturers.length})</h2>
      <div className="mt-2 space-y-2">
        {lecturers.map((e) => (
          <div key={e.id} className="rounded border border-gray-200 p-3 text-sm">
            {e.user.name} — {e.user.email}
          </div>
        ))}
      </div>

      <h2 className="mt-6 text-lg font-medium">Students ({students.length})</h2>
      <div className="mt-2 space-y-2">
        {students.length === 0 && <p className="text-gray-500">No students enrolled yet.</p>}
        {students.map((e) => (
          <div
            key={e.id}
            className="flex items-center justify-between rounded border border-gray-200 p-3 text-sm"
          >
            <span>
              {e.user.name} — {e.user.email}
              {e.user.institutionStudentId && (
                <span className="text-gray-500"> · ID: {e.user.institutionStudentId}</span>
              )}
            </span>
            <button
              onClick={() => removeEnrolment(e.user.id)}
              className="text-xs text-red-600 underline"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
