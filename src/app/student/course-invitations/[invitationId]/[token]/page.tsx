"use client";

/**
 * Tether Course Invitation + Acceptance v1 — see
 * docs/tether-course-invitation-acceptance-v1.md.
 *
 * Route protection: `/student/*` (including this route) requires an
 * authenticated STUDENT session via src/proxy.ts before this component
 * ever renders — an unauthenticated visitor is redirected to
 * `/login?callbackUrl=/student/course-invitations/[invitationId]/[token]`
 * and returned here after login (see src/lib/safeCallbackUrl.ts's
 * isSafeCourseInvitationCallbackUrl for the open-redirect guard on that
 * callback value).
 *
 * Shows no institution/course metadata before the preview call confirms
 * this invitation is valid AND bound to the currently logged-in
 * student's account. Clicking "Accept invitation" is the one deliberate
 * POST action (see the accept route) that ever changes
 * User.institutionId or creates a CourseEnrollment — nothing here
 * mutates on page load.
 */

import { useEffect, useState, use as usePromise } from "react";
import { useRouter } from "next/navigation";

type PreviewResult =
  | { ok: true; institutionName: string; course: { code: string; name: string } }
  | { ok: false; reason: string };

const REASON_MESSAGES: Record<string, string> = {
  unauthorized: "Please log in to view this invitation.",
  invalid: "This invitation is not valid or is no longer available.",
  wrong_account: "This invitation was issued to a different Tether account.",
  already_accepted: "This invitation has already been accepted.",
  expired: "This invitation has expired. Ask your lecturer for a new one.",
  revoked: "This invitation is no longer available.",
  different_institution: "This account is already linked to a different Tether institution.",
};

function messageFor(reason: string): string {
  return REASON_MESSAGES[reason] ?? "This invitation is not valid or is no longer available.";
}

export default function CourseInvitationPage({
  params,
}: {
  params: Promise<{ invitationId: string; token: string }>;
}) {
  const { invitationId, token } = usePromise(params);
  const router = useRouter();

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/course-invitations/${invitationId}/${token}`)
      .then((res) => res.json())
      .then((data: PreviewResult) => setPreview(data))
      .catch(() => setPreview({ ok: false, reason: "invalid" }))
      .finally(() => setLoading(false));
  }, [invitationId, token]);

  async function handleAccept() {
    setAccepting(true);
    setAcceptError(null);
    const res = await fetch(`/api/course-invitations/${invitationId}/${token}/accept`, {
      method: "POST",
    });
    const body = await res.json().catch(() => null);
    setAccepting(false);
    if (!res.ok || !body?.ok) {
      setAcceptError(messageFor(body?.reason ?? "invalid"));
      return;
    }
    router.replace("/student");
  }

  if (loading || !preview) {
    return <p className="mx-auto mt-16 max-w-md text-center text-gray-500">Loading...</p>;
  }

  if (!preview.ok) {
    return (
      <div className="mx-auto mt-16 max-w-md rounded border border-gray-200 p-6 text-center">
        <h1 className="text-lg font-medium">Course invitation</h1>
        <p className="mt-3 text-gray-700">{messageFor(preview.reason)}</p>
        <button
          onClick={() => router.push("/student")}
          className="mt-4 rounded border border-gray-300 px-3 py-1.5 text-sm"
        >
          Go to my dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-16 max-w-md rounded border border-gray-200 p-6 text-center">
      <h1 className="text-lg font-medium">You&apos;ve been invited to join</h1>
      <p className="mt-3 text-sm text-gray-500">{preview.institutionName}</p>
      <p className="mt-1 text-base font-medium">
        {preview.course.code} — {preview.course.name}
      </p>
      <button
        onClick={handleAccept}
        disabled={accepting}
        className="mt-6 w-full rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {accepting ? "Accepting..." : "Accept invitation"}
      </button>
      {acceptError && <p className="mt-2 text-sm text-red-600">{acceptError}</p>}
    </div>
  );
}
