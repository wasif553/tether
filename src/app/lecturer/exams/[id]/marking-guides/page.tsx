"use client";

/**
 * AI Marking Assistance v1 — exam-level marking guide management. See
 * docs/ai-marking-assistance-v1.md.
 *
 * A marking guide belongs to the QUESTION, never any one student's
 * answer — configure it once here and it is reused automatically for
 * every student's answer to that question, by both "Get AI marking
 * suggestion" on an individual submission's grading page and the
 * exam-wide "Mark essays with AI" bulk action. Reads via the existing
 * GET /api/exams/[id] (lecturer branch already returns every Question
 * field, unfiltered, for the owning lecturer) — no new GET route.
 */
import { useEffect, useState, use as usePromise } from "react";
import { LecturerPageHeader, PrimaryButton, SecondaryButton } from "@/components/lecturer/LecturerPageHeader";
import { SectionCard } from "@/components/lecturer/SectionCard";
import { LoadingState, ErrorState } from "@/components/lecturer/EmptyState";

type EssayQuestion = {
  id: string;
  type: string;
  text: string;
  points: number;
  aiMarkingGuide: string | null;
};

type ExamData = {
  id: string;
  title: string;
  questions: EssayQuestion[];
};

const FIELD_CLASS =
  "w-full rounded-lg border border-lecturer-border px-2.5 py-1.5 text-sm text-lecturer-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent";

export default function MarkingGuidesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: examId } = usePromise(params);

  const [exam, setExam] = useState<ExamData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guides, setGuides] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/exams/${examId}`)
      .then(async (res) => {
        if (!res.ok) {
          setError("Could not load this exam.");
          return;
        }
        const body: ExamData = await res.json();
        setExam(body);
        const initial: Record<string, string> = {};
        body.questions
          .filter((q) => q.type === "ESSAY")
          .forEach((q) => {
            initial[q.id] = q.aiMarkingGuide ?? "";
          });
        setGuides(initial);
      })
      .catch(() => setError("Could not load this exam."));
  }, [examId]);

  const essayQuestions = exam?.questions.filter((q) => q.type === "ESSAY") ?? [];

  async function handleSave() {
    setSaving(true);
    setSaveMessage(null);
    try {
      const res = await fetch(`/api/lecturer/exams/${examId}/marking-guides`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guides: essayQuestions.map((q) => ({ questionId: q.id, aiMarkingGuide: guides[q.id] || null })),
        }),
      });
      setSaveMessage(res.ok ? "Marking guides saved." : "Failed to save marking guides. Try again.");
    } catch {
      setSaveMessage("Could not reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  }

  function handleCopyToAll(sourceQuestionId: string) {
    const text = guides[sourceQuestionId] ?? "";
    setGuides((prev) => {
      const next = { ...prev };
      essayQuestions.forEach((q) => {
        next[q.id] = text;
      });
      return next;
    });
  }

  if (error) return <ErrorState message={error} />;
  if (!exam) return <LoadingState label="Loading exam…" />;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <LecturerPageHeader
        breadcrumbs={[
          { label: "Dashboard", href: "/lecturer" },
          { label: exam.title, href: `/lecturer/exams/${examId}` },
          { label: "AI Marking Guides" },
        ]}
        title="AI Marking Guides"
        description="Configure an optional marking guide for each essay question once — it is reused automatically for every student's answer to that question."
      />

      {essayQuestions.length === 0 && (
        <SectionCard>
          <p className="text-sm text-lecturer-text-secondary">This exam has no essay questions.</p>
        </SectionCard>
      )}

      <div className="space-y-4">
        {essayQuestions.map((q, i) => (
          <SectionCard key={q.id}>
            <p className="text-sm text-lecturer-text-secondary">
              Question {i + 1} — {q.text}
            </p>
            <p className="mt-1 text-xs text-lecturer-text-secondary">{q.points} marks</p>
            <label className="mt-3 block text-sm font-medium text-lecturer-text-primary">Lecturer marking guide</label>
            <textarea
              rows={4}
              placeholder="Optional: describe your marking guide, rubric, expected points, or assessment criteria."
              className={`mt-1 ${FIELD_CLASS}`}
              value={guides[q.id] ?? ""}
              onChange={(e) => setGuides((prev) => ({ ...prev, [q.id]: e.target.value }))}
            />
            {essayQuestions.length > 1 && (
              <SecondaryButton type="button" onClick={() => handleCopyToAll(q.id)} className="mt-2 px-3 py-1.5 text-xs">
                Copy this guide to all essay questions
              </SecondaryButton>
            )}
          </SectionCard>
        ))}
      </div>

      {essayQuestions.length > 0 && (
        <div>
          <PrimaryButton onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save marking guides"}
          </PrimaryButton>
          {saveMessage && <p className="mt-2 text-sm text-lecturer-text-secondary">{saveMessage}</p>}
        </div>
      )}
    </div>
  );
}
