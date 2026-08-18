"use client";

/**
 * Standalone Exam Link v1 — see docs/standalone-exam-link-v1.md.
 *
 * This is the invitation-acceptance landing page — the ONLY place the
 * invitation token in the URL is ever used. Route protection: `/student/*`
 * (including this route) requires an authenticated STUDENT session via
 * src/proxy.ts before this component ever renders — an unauthenticated
 * visitor is redirected to
 * `/login?callbackUrl=/student/exams/join/[examId]/invite/[token]` and
 * returned here after login (see src/lib/safeCallbackUrl.ts's
 * isSafeJoinWithInviteCallbackUrl for the open-redirect guard on that
 * callback value, and the existing plain-join-link callback for the
 * established precedent this follows).
 *
 * Deliberately shows NO exam metadata before acceptance — not the exam
 * title, not why a token might be invalid — beyond the minimum safe
 * "you have been invited" framing. Clicking "Accept invitation" is the
 * one deliberate, POST-only action that calls
 * POST /api/exams/[id]/standalone-invite/accept and creates the
 * ExamAssignment; nothing here mutates on page load. Once accepted (or
 * if the student already holds this exam's assignment from a previous
 * visit), this page hands off to the ordinary
 * /student/exams/join/[examId] page — the exact same convenience launch
 * flow every other student uses from here on, with no further
 * dependency on the token.
 */

import { useState, use as usePromise } from "react";
import { useRouter } from "next/navigation";

export default function JoinWithInvitePage({
  params,
}: {
  params: Promise<{ examId: string; token: string }>;
}) {
  const { examId, token } = usePromise(params);
  const router = useRouter();

  const [status, setStatus] = useState<"idle" | "accepting" | "invalid">("idle");

  async function handleAccept() {
    setStatus("accepting");
    const res = await fetch(`/api/exams/${examId}/standalone-invite/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) {
      setStatus("invalid");
      return;
    }
    router.replace(`/student/exams/join/${examId}`);
  }

  if (status === "invalid") {
    return (
      <div className="mx-auto mt-16 max-w-md rounded border border-gray-200 p-6 text-center">
        <h1 className="text-lg font-medium">Exam invitation</h1>
        <p className="mt-3 text-gray-700">
          This exam invitation is not valid or is no longer available.
        </p>
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
      <h1 className="text-lg font-medium">Exam invitation</h1>
      <p className="mt-3 text-gray-700">You have been invited to this exam.</p>
      <button
        onClick={handleAccept}
        disabled={status === "accepting"}
        className="mt-4 w-full rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {status === "accepting" ? "Accepting..." : "Accept invitation"}
      </button>
    </div>
  );
}
