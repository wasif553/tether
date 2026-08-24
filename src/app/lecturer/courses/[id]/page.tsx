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
import Link from "next/link";
import { LecturerPageHeader, PrimaryButton, SecondaryButton } from "@/components/lecturer/LecturerPageHeader";
import { SectionCard } from "@/components/lecturer/SectionCard";
import { StatusBadge, availabilityToneFor } from "@/components/lecturer/StatusBadge";
import { EmptyState, LoadingState } from "@/components/lecturer/EmptyState";
import { lecturerAvailabilityStatus } from "@/lib/lecturerDashboardGrouping";

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

type CourseExamSummary = {
  id: string;
  title: string;
  published: boolean;
  availableFrom: string | null;
  availableUntil: string | null;
  needsReviewCount: number;
  course: { id: string } | null;
  _count: { submissions: number };
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
  const [courseExams, setCourseExams] = useState<CourseExamSummary[] | null>(null);

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

  // Reuses the same /api/exams listing the dashboard already fetches —
  // no new backend endpoint. Filtered client-side to this course so the
  // course workspace can show "Exams in this course" without inventing
  // a per-course exams API.
  function loadCourseExams() {
    fetch("/api/exams?all=true")
      .then((res) => (res.ok ? res.json() : []))
      .then((rows: CourseExamSummary[]) => setCourseExams(rows.filter((exam) => exam.course?.id === id)))
      .catch(() => setCourseExams([]));
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    loadInvitations();
    loadCourseExams();
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

  if (loading) return <LoadingState label="Loading course…" />;
  if (!course) return <p className="text-sm text-[#B42318]">Course not found.</p>;

  const students = course.enrollments.filter((e) => e.role === "STUDENT");
  const lecturers = course.enrollments.filter((e) => e.role === "LECTURER");
  const pendingInvitations = invitations.filter((inv) => inv.status === "PENDING" || inv.status === "EXPIRED");

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <LecturerPageHeader
        breadcrumbs={[{ label: "Dashboard", href: "/lecturer" }, { label: "Courses", href: "/lecturer/courses" }, { label: course.code }]}
        title={`${course.code} — ${course.name}`}
        description={course.description ?? undefined}
      />

      <SectionCard title="Add a student" subtitle="Add a student using the email on their Tether account.">
        <div className="flex items-end gap-2">
          <input
            type="email"
            placeholder="student@example.com"
            className="flex-1 rounded-lg border border-lecturer-border px-3 py-2 text-sm text-lecturer-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <PrimaryButton type="button" onClick={addStudent} disabled={enrolling || !email.trim()}>
            {enrolling ? "Adding…" : "Add student"}
          </PrimaryButton>
        </div>

        {addState.kind === "error" && <p className="mt-2 text-sm text-[#B42318]">{addState.message}</p>}

        {addState.kind === "invitation_required" && (
          <div className="mt-3 rounded-lg border border-lecturer-border bg-lecturer-border-subtle/60 p-3">
            <p className="text-sm text-lecturer-text-primary">This student has a Tether account but is not yet linked to your institution.</p>
            <SecondaryButton type="button" onClick={() => createInvitation(addState.student.email)} disabled={creatingInviteFor === addState.student.email} className="mt-2 px-3 py-1.5">
              {creatingInviteFor === addState.student.email ? "Creating…" : "Create invitation"}
            </SecondaryButton>
          </div>
        )}

        {inviteError && <p className="mt-2 text-sm text-[#B42318]">{inviteError}</p>}
      </SectionCard>

      {pendingInvitations.length > 0 && (
        <SectionCard title={`Pending invitations (${pendingInvitations.length})`}>
          <div className="space-y-2">
            {pendingInvitations.map((inv) => (
              <div key={inv.id} className="rounded-lg border border-lecturer-border p-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-lecturer-text-primary">
                    {inv.student.name} — {inv.student.email}
                  </span>
                  <StatusBadge tone={inv.status === "EXPIRED" ? "neutral" : "warning"}>{inv.status === "EXPIRED" ? "Expired" : "Pending"}</StatusBadge>
                </div>
                <p className="mt-1 text-xs text-lecturer-text-secondary">Expires {new Date(inv.expiresAt).toLocaleString()}</p>

                {revealedInviteUrl?.invitationId === inv.id ? (
                  <div className="mt-2 rounded-lg border border-lecturer-border bg-lecturer-border-subtle/60 p-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        readOnly
                        value={revealedInviteUrl.url}
                        onFocus={(e) => e.target.select()}
                        className="flex-1 rounded border border-lecturer-border bg-lecturer-surface px-2 py-1 text-xs text-lecturer-text-primary"
                      />
                      <button
                        onClick={handleCopyInvite}
                        className="rounded border border-lecturer-border px-2 py-1 text-xs font-medium text-lecturer-text-primary hover:bg-lecturer-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                      >
                        {copiedInvite ? "Copied!" : "Copy link"}
                      </button>
                    </div>
                    <p className="mt-1 text-xs text-lecturer-text-secondary">Shown once — copy it now. The student must accept this invitation before joining the course.</p>
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-lecturer-text-secondary">Invitation pending.</p>
                )}

                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => regenerateInvitation(inv.id, inv.student.email)}
                    disabled={creatingInviteFor === inv.id}
                    className="rounded border border-lecturer-border px-2 py-1 text-xs font-medium text-lecturer-text-primary hover:bg-lecturer-border-subtle disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                  >
                    {creatingInviteFor === inv.id ? "Regenerating…" : "Regenerate invitation"}
                  </button>
                  <button
                    onClick={() => cancelInvitation(inv.id)}
                    disabled={cancellingId === inv.id}
                    className="rounded border border-lecturer-border px-2 py-1 text-xs font-medium text-[#B42318] hover:bg-[#FEF3F2] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                  >
                    {cancellingId === inv.id ? "Cancelling…" : "Cancel invitation"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      <SectionCard
        title="Exams in this course"
        actions={
          <>
            {/* Exam Archive Lifecycle v1 — this list already excludes archived exams (GET /api/exams excludes them server-side by default); this link is the explicit path to see them. */}
            <Link href="/lecturer/exams" className="text-sm font-medium text-lecturer-text-secondary hover:text-lecturer-text-primary">
              View archived
            </Link>
            <Link href="/lecturer" className="text-sm font-medium text-lecturer-accent hover:text-lecturer-accent-hover">
              New exam →
            </Link>
          </>
        }
      >
        {courseExams === null && <LoadingState label="Loading exams…" />}
        {courseExams !== null && courseExams.length === 0 && <EmptyState title="No exams yet" description="Create an exam from the dashboard and assign it to this course." />}
        {courseExams !== null && courseExams.length > 0 && (
          <div className="space-y-2">
            {courseExams.map((exam) => {
              const status = lecturerAvailabilityStatus(exam);
              return (
                <Link
                  key={exam.id}
                  href={`/lecturer/exams/${exam.id}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-lecturer-border p-3 text-sm transition-colors hover:border-lecturer-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                >
                  <span className="min-w-0 truncate font-medium text-lecturer-text-primary">{exam.title}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    {exam.needsReviewCount > 0 && <StatusBadge tone="neutral">{exam.needsReviewCount} signals</StatusBadge>}
                    <StatusBadge tone={availabilityToneFor(status)}>{status}</StatusBadge>
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </SectionCard>

      <SectionCard title={`Lecturers (${lecturers.length})`}>
        <div className="space-y-2">
          {lecturers.map((e) => (
            <div key={e.id} className="rounded-lg border border-lecturer-border p-3 text-sm text-lecturer-text-primary">
              {e.user.name} — {e.user.email}
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard title={`Students (${students.length})`}>
        {students.length === 0 ? (
          <EmptyState title="No students enrolled yet" />
        ) : (
          <div className="space-y-2">
            {students.map((e) => (
              <div key={e.id} className="flex items-center justify-between rounded-lg border border-lecturer-border p-3 text-sm">
                <span className="text-lecturer-text-primary">
                  {e.user.name} — {e.user.email}
                  {e.user.institutionStudentId && <span className="text-lecturer-text-secondary"> · ID: {e.user.institutionStudentId}</span>}
                </span>
                <button onClick={() => removeEnrolment(e.user.id)} className="text-xs font-medium text-[#B42318] underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B42318]">
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
