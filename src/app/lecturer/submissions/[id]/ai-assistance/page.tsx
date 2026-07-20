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
  promptNumberForQuestion: number;
  promptNumberForAttempt: number;
  policyVersion: string;
  createdAt: string;
};

type Review = {
  submissionId: string;
  student: { name: string; email: string };
  exam: { id: string; title: string };
  aiAssistanceEnabled: boolean;
  interactions: Interaction[];
};

const STATUS_LABELS: Record<string, string> = {
  APPROVED: "Approved",
  REGENERATED_APPROVED: "Approved (regenerated under stricter guidance)",
  FALLBACK: "Safe fallback shown",
  BLOCKED: "Request declined",
};

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

  if (error) return <p className="text-red-600">{error}</p>;
  if (!review) return <p>Loading...</p>;

  return (
    <div className="mx-auto max-w-3xl">
      <Link href={`/lecturer/exams/${review.exam.id}/submissions`} className="text-sm text-blue-600">
        &larr; Back to submissions
      </Link>
      <h1 className="mt-2 text-xl font-semibold">AI Brainstorming Assistance</h1>
      <p className="text-sm text-gray-600">
        {review.student.name} ({review.student.email}) — {review.exam.title}
      </p>
      <p className="mt-2 rounded border border-gray-200 bg-gray-50 p-2 text-xs text-gray-600">
        This is a record of an ALLOWED assessment resource, not an integrity violation. Permitted
        use never increases this student&apos;s integrity risk score.
      </p>

      {!review.aiAssistanceEnabled && (
        <p className="mt-4 text-sm text-gray-500">
          AI brainstorming assistance was not enabled for this attempt.
        </p>
      )}

      {review.aiAssistanceEnabled && review.interactions.length === 0 && (
        <p className="mt-4 text-sm text-gray-500">No assistance requests were made during this attempt.</p>
      )}

      <div className="mt-4 space-y-3">
        {review.interactions.map((interaction) => (
          <div key={interaction.id} className="rounded border border-gray-200 p-3">
            <div className="flex items-center justify-between text-xs text-gray-500">
              <span>
                Q: {interaction.questionText.slice(0, 60)}
                {interaction.questionText.length > 60 ? "..." : ""}
              </span>
              <span>{new Date(interaction.createdAt).toLocaleString()}</span>
            </div>
            <p className="mt-2 text-sm">
              <span className="font-medium">Student:</span> {interaction.studentPrompt}
            </p>
            {interaction.response && (
              <p className="mt-1 text-sm text-gray-700">
                <span className="font-medium">Assistant:</span> {interaction.response}
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <span className="rounded bg-gray-100 px-2 py-0.5">
                {STATUS_LABELS[interaction.status] ?? interaction.status}
              </span>
              <span className="rounded bg-gray-100 px-2 py-0.5">
                Prompt {interaction.promptNumberForQuestion} (question) / {interaction.promptNumberForAttempt} (attempt)
              </span>
              <span className="rounded bg-gray-100 px-2 py-0.5">Policy {interaction.policyVersion}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
