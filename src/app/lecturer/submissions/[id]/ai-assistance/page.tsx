"use client";

/**
 * Controlled AI Brainstorming Assistance v1 — lecturer read-only review.
 * See docs/controlled-ai-brainstorming-assistance-v1.md.
 *
 * Shows exactly the approved/blocked/regenerated transcript already safe
 * for a student to see — never the hidden rubric, model answer, rejected
 * candidate text (never stored), verifier system prompts, or provider
 * credentials. Permitted use here is never scored or treated as an
 * integrity signal.
 */
import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";

type Interaction = {
  id: string;
  questionId: string;
  questionText: string;
  studentPrompt: string;
  response: string | null;
  status: string;
  wasRegenerated: boolean;
  promptNumberForQuestion: number;
  promptNumberForAttempt: number;
  policyVersion: string;
  createdAt: string;
};

type ReviewSummary = {
  totalRequests: number;
  guidanceShownCount: number;
  declinedCount: number;
  failedCount: number;
  questionsUsedCount: number;
};

type Review = {
  submissionId: string;
  student: { name: string; email: string };
  exam: { id: string; title: string };
  aiAssistanceEnabled: boolean;
  summary: ReviewSummary;
  interactions: Interaction[];
};

const STATUS_LABELS: Record<string, string> = {
  APPROVED: "Guidance shown",
  FALLBACK: "Guidance shown",
  BLOCKED: "Request declined",
  FAILED: "Could not be completed",
};

function statusLabel(interaction: Interaction): string {
  const base = STATUS_LABELS[interaction.status] ?? interaction.status;
  if (interaction.status === "APPROVED" && interaction.wasRegenerated) {
    return `${base} (regenerated under stricter guidance)`;
  }
  if (interaction.status === "FALLBACK") {
    return `${base} (standard guidance response)`;
  }
  return base;
}

export default function AiAssistanceReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/lecturer/submissions/${id}/ai-assistance`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? "Failed to load");
        }
        return res.json();
      })
      .then(setReview)
      .catch((err) => setError(err.message));
  }, [id]);

  if (error) return <p className="mx-auto max-w-3xl text-sm text-red-600">{error}</p>;
  if (!review) return <p className="mx-auto max-w-3xl text-sm text-[#667085]">Loading…</p>;

  const { summary } = review;

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href={`/lecturer/exams/${review.exam.id}/submissions/${review.submissionId}`}
        className="rounded text-sm font-medium text-[#2563EB] hover:text-[#1D4ED8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
      >
        &larr; Back to submission
      </Link>

      <p className="mt-3 text-sm font-medium text-[#667085]">Controlled AI activity</p>
      <h1 className="mt-1 text-2xl font-bold text-[#101828]">{review.student.name}</h1>
      <p className="mt-1 text-sm text-[#667085]">
        {review.student.email} · {review.exam.title}
      </p>

      <p className="mt-3 rounded-lg border border-[#E4E7EC] bg-[#F9FAFB] p-3 text-xs text-[#667085]">
        Tether Controlled AI was an allowed assessment resource for this attempt. Its permitted use
        is not an integrity violation.
      </p>

      {!review.aiAssistanceEnabled && (
        <p className="mt-4 text-sm text-[#667085]">Tether Controlled AI was not enabled for this attempt.</p>
      )}

      {review.aiAssistanceEnabled && (
        <div className="mt-4 rounded-xl border border-[#E4E7EC] bg-white p-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <p className="text-xs font-medium text-[#667085]">Requests</p>
              <p className="mt-0.5 text-xl font-bold text-[#101828]">{summary.totalRequests}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-[#667085]">Guidance shown</p>
              <p className="mt-0.5 text-xl font-bold text-[#101828]">{summary.guidanceShownCount}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-[#667085]">Declined</p>
              <p className="mt-0.5 text-xl font-bold text-[#101828]">{summary.declinedCount}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-[#667085]">Questions used</p>
              <p className="mt-0.5 text-xl font-bold text-[#101828]">{summary.questionsUsedCount}</p>
            </div>
          </div>
        </div>
      )}

      {review.aiAssistanceEnabled && review.interactions.length === 0 && (
        <p className="mt-4 text-sm text-[#667085]">No assistance requests were made during this attempt.</p>
      )}

      {review.interactions.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold text-[#101828]">AI interaction record</h2>
          <div className="mt-2 space-y-3">
            {review.interactions.map((interaction) => (
              <div key={interaction.id} className="rounded-xl border border-[#E4E7EC] bg-white p-4">
                <div className="flex items-center justify-between gap-3 text-xs text-[#667085]">
                  <span>
                    {interaction.questionText.slice(0, 80)}
                    {interaction.questionText.length > 80 ? "…" : ""}
                  </span>
                  <span className="shrink-0">{new Date(interaction.createdAt).toLocaleString()}</span>
                </div>
                <p className="mt-2 text-sm text-[#101828]">
                  <span className="font-medium">Student request:</span> {interaction.studentPrompt}
                </p>
                {interaction.response && (
                  <p className="mt-1 text-sm text-[#101828]">
                    <span className="font-medium">Tether guidance:</span> {interaction.response}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-[#F2F4F7] px-2 py-0.5 font-medium text-[#667085]">
                    {statusLabel(interaction)}
                  </span>
                  <span className="rounded-full bg-[#F2F4F7] px-2 py-0.5 text-[#667085]">
                    Prompt {interaction.promptNumberForQuestion} of this question ·{" "}
                    {interaction.promptNumberForAttempt} of this attempt
                  </span>
                  <details>
                    <summary className="cursor-pointer text-[#98A2B3]">Policy details</summary>
                    <span className="ml-1 text-[#98A2B3]">Policy {interaction.policyVersion}</span>
                  </details>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
