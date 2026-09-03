"use client";

import { useEffect, useState, use as usePromise } from "react";
import { useRouter } from "next/navigation";
import { LecturerPageHeader, PrimaryButton, SecondaryButton } from "@/components/lecturer/LecturerPageHeader";
import { SectionCard } from "@/components/lecturer/SectionCard";
import { StatusBadge } from "@/components/lecturer/StatusBadge";
import { EmptyState, LoadingState } from "@/components/lecturer/EmptyState";

type BankQuestionType = "MULTIPLE_CHOICE" | "SHORT_ANSWER" | "ESSAY";

type BankQuestion = {
  id: string;
  type: BankQuestionType;
  text: string;
  optionsJson: string | null;
  correctAnswer: string | null;
  sampleAnswer: string | null;
  points: number;
  difficulty: "easy" | "medium" | "hard" | null;
  topic: string | null;
};

type Bank = {
  id: string;
  title: string;
  description: string | null;
  subject: string | null;
  courseCode: string | null;
  questions: BankQuestion[];
};

type LecturerExamOption = { id: string; title: string };
type ExamPoolOption = { id: string; name: string };

const FIELD_CLASS = "mt-1 w-full rounded-lg border border-lecturer-border px-3 py-2 text-sm text-lecturer-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent";
const LABEL_CLASS = "block text-sm font-medium text-lecturer-text-primary";

export default function QuestionBankDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);
  const router = useRouter();

  const [bank, setBank] = useState<Bank | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingMeta, setEditingMeta] = useState(false);
  const [metaForm, setMetaForm] = useState({ title: "", description: "", subject: "", courseCode: "" });
  const [savingMeta, setSavingMeta] = useState(false);

  const [qType, setQType] = useState<BankQuestionType>("MULTIPLE_CHOICE");
  const [qText, setQText] = useState("");
  const [qOptions, setQOptions] = useState("");
  const [qCorrect, setQCorrect] = useState("");
  const [qSampleAnswer, setQSampleAnswer] = useState("");
  const [qPoints, setQPoints] = useState(1);
  const [qDifficulty, setQDifficulty] = useState<"easy" | "medium" | "hard" | "">("");
  const [qTopic, setQTopic] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Question Bank / Exam Pools redesign v1 — search/filter over this
  // bank's own questions (client-side; the bank is already fully loaded).
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<BankQuestionType | "">("");
  const [difficultyFilter, setDifficultyFilter] = useState<"easy" | "medium" | "hard" | "">("");

  // Inline edit of an existing bank question (PATCH /questions/[questionId]).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    type: BankQuestionType;
    text: string;
    options: string;
    correctAnswer: string;
    sampleAnswer: string;
    points: number;
    difficulty: "easy" | "medium" | "hard" | "";
    topic: string;
  } | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);

  // "Add to exam" picker (per section 9: exam picker + delivery choice).
  const [addToExamRowId, setAddToExamRowId] = useState<string | null>(null);
  const [lecturerExams, setLecturerExams] = useState<LecturerExamOption[]>([]);
  const [addToExamExamId, setAddToExamExamId] = useState("");
  const [addToExamPools, setAddToExamPools] = useState<ExamPoolOption[]>([]);
  const [addToExamPoolId, setAddToExamPoolId] = useState("");
  const [addToExamSubmitting, setAddToExamSubmitting] = useState(false);
  const [addToExamMessage, setAddToExamMessage] = useState<string | null>(null);

  async function loadBank() {
    setLoading(true);
    const res = await fetch(`/api/lecturer/question-banks/${id}`);
    if (res.ok) {
      const data = await res.json();
      setBank(data);
      setMetaForm({
        title: data.title,
        description: data.description ?? "",
        subject: data.subject ?? "",
        courseCode: data.courseCode ?? "",
      });
    }
    setLoading(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadBank();
  }, [id]);

  async function handleSaveMeta(e: React.FormEvent) {
    e.preventDefault();
    setSavingMeta(true);

    const res = await fetch(`/api/lecturer/question-banks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metaForm),
    });

    setSavingMeta(false);
    if (res.ok) {
      setEditingMeta(false);
      await loadBank();
    }
  }

  async function handleDeleteBank() {
    if (!confirm("Delete this question bank and all its questions? This cannot be undone.")) return;
    const res = await fetch(`/api/lecturer/question-banks/${id}`, { method: "DELETE" });
    if (res.ok) router.push("/lecturer/question-banks");
  }

  async function handleAddQuestion(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAdding(true);

    const res = await fetch(`/api/lecturer/question-banks/${id}/questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: qType,
        text: qText,
        optionsJson:
          qType === "MULTIPLE_CHOICE"
            ? JSON.stringify(qOptions.split("\n").map((o) => o.trim()).filter(Boolean))
            : undefined,
        correctAnswer: qType === "ESSAY" ? undefined : qCorrect || undefined,
        sampleAnswer: qType !== "MULTIPLE_CHOICE" ? qSampleAnswer || undefined : undefined,
        points: qPoints,
        difficulty: qDifficulty || undefined,
        topic: qTopic || undefined,
      }),
    });

    setAdding(false);

    if (!res.ok) {
      setError("Failed to add question");
      return;
    }

    setQText("");
    setQOptions("");
    setQCorrect("");
    setQSampleAnswer("");
    setQPoints(1);
    setQDifficulty("");
    setQTopic("");
    await loadBank();
  }

  async function handleDeleteQuestion(questionId: string) {
    if (!confirm("Delete this question?")) return;
    await fetch(`/api/lecturer/question-banks/${id}/questions/${questionId}`, { method: "DELETE" });
    await loadBank();
  }

  function startEditQuestion(q: BankQuestion) {
    setEditingId(q.id);
    setEditForm({
      type: q.type,
      text: q.text,
      options: q.optionsJson ? (JSON.parse(q.optionsJson) as string[]).join("\n") : "",
      correctAnswer: q.correctAnswer ?? "",
      sampleAnswer: q.sampleAnswer ?? "",
      points: q.points,
      difficulty: q.difficulty ?? "",
      topic: q.topic ?? "",
    });
  }

  async function handleSaveEdit(questionId: string) {
    if (!editForm) return;
    setSavingEdit(true);
    const res = await fetch(`/api/lecturer/question-banks/${id}/questions/${questionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: editForm.type,
        text: editForm.text,
        // The underlying PATCH route treats a nullish value as "keep the
        // existing value" (it merges with `??`), so an explicit clear
        // isn't possible here — send `undefined` (omitted key) rather
        // than `null` to avoid a schema-validation error on an
        // otherwise-valid clear attempt.
        optionsJson:
          editForm.type === "MULTIPLE_CHOICE"
            ? JSON.stringify(editForm.options.split("\n").map((o) => o.trim()).filter(Boolean))
            : undefined,
        correctAnswer: editForm.type === "ESSAY" ? undefined : editForm.correctAnswer || undefined,
        sampleAnswer: editForm.type !== "MULTIPLE_CHOICE" ? editForm.sampleAnswer || undefined : undefined,
        points: editForm.points,
        difficulty: editForm.difficulty || undefined,
        topic: editForm.topic || undefined,
      }),
    });
    setSavingEdit(false);
    if (res.ok) {
      setEditingId(null);
      setEditForm(null);
      await loadBank();
    }
  }

  // Duplicate — a plain client-side copy through the existing create
  // endpoint. Never touches any exam; this is entirely bank-local, so no
  // new backend route or schema field is needed for it.
  async function handleDuplicateQuestion(q: BankQuestion) {
    setDuplicatingId(q.id);
    try {
      await fetch(`/api/lecturer/question-banks/${id}/questions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: q.type,
          text: q.text,
          optionsJson: q.optionsJson ?? undefined,
          correctAnswer: q.correctAnswer ?? undefined,
          sampleAnswer: q.sampleAnswer ?? undefined,
          points: q.points,
          difficulty: q.difficulty ?? undefined,
          topic: q.topic ?? undefined,
        }),
      });
      await loadBank();
    } finally {
      setDuplicatingId(null);
    }
  }

  async function ensureLecturerExamsLoaded() {
    if (lecturerExams.length > 0) return;
    const res = await fetch("/api/exams");
    if (res.ok) {
      const data = await res.json();
      setLecturerExams(Array.isArray(data) ? data.map((e: { id: string; title: string }) => ({ id: e.id, title: e.title })) : []);
    }
  }

  async function openAddToExam(questionId: string) {
    setAddToExamRowId(addToExamRowId === questionId ? null : questionId);
    setAddToExamMessage(null);
    setAddToExamExamId("");
    setAddToExamPools([]);
    setAddToExamPoolId("");
    await ensureLecturerExamsLoaded();
  }

  async function handleSelectAddToExamExam(examId: string) {
    setAddToExamExamId(examId);
    setAddToExamPoolId("");
    setAddToExamPools([]);
    if (!examId) return;
    const res = await fetch(`/api/exams/${examId}/question-pools`);
    if (res.ok) setAddToExamPools(await res.json());
  }

  async function handleSubmitAddToExam(bankQuestionId: string) {
    if (!addToExamExamId) return;
    setAddToExamSubmitting(true);
    setAddToExamMessage(null);
    const delivery = addToExamPoolId
      ? { kind: "EXISTING_POOL" as const, poolId: addToExamPoolId }
      : { kind: "REQUIRED" as const };
    const res = await fetch(`/api/lecturer/exams/${addToExamExamId}/questions/from-bank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bankId: id, bankQuestionIds: [bankQuestionId], delivery }),
    });
    setAddToExamSubmitting(false);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setAddToExamMessage("Could not add this question to the exam.");
      return;
    }
    setAddToExamMessage(
      data?.skippedAsDuplicate?.length > 0
        ? "This question is already in that exam."
        : "Added to the exam.",
    );
    setAddToExamRowId(null);
  }

  if (loading) return <LoadingState label="Loading question bank…" />;
  if (!bank) return <p className="text-sm text-[#B42318]">Question bank not found</p>;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <LecturerPageHeader
        breadcrumbs={[{ label: "Dashboard", href: "/lecturer" }, { label: "Question Banks", href: "/lecturer/question-banks" }, { label: bank.title }]}
        title={bank.title}
        description={[bank.description, [bank.subject, bank.courseCode].filter(Boolean).join(" · ")].filter(Boolean).join(" — ") || undefined}
        actions={
          <>
            <SecondaryButton type="button" onClick={() => setEditingMeta((v) => !v)}>
              Edit bank details
            </SecondaryButton>
            <button
              onClick={handleDeleteBank}
              className="rounded-lg border border-[#FDA29B] px-4 py-2 text-sm font-medium text-[#B42318] hover:bg-[#FEF3F2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B42318]"
            >
              Delete bank
            </button>
          </>
        }
      />

      {editingMeta && (
        <SectionCard>
          <form onSubmit={handleSaveMeta} className="space-y-3">
            <div>
              <label className={LABEL_CLASS}>Title</label>
              <input required className={FIELD_CLASS} value={metaForm.title} onChange={(e) => setMetaForm({ ...metaForm, title: e.target.value })} />
            </div>
            <div>
              <label className={LABEL_CLASS}>Description</label>
              <textarea className={FIELD_CLASS} value={metaForm.description} onChange={(e) => setMetaForm({ ...metaForm, description: e.target.value })} />
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className={LABEL_CLASS}>Subject</label>
                <input className={FIELD_CLASS} value={metaForm.subject} onChange={(e) => setMetaForm({ ...metaForm, subject: e.target.value })} />
              </div>
              <div className="flex-1">
                <label className={LABEL_CLASS}>Course code</label>
                <input className={FIELD_CLASS} value={metaForm.courseCode} onChange={(e) => setMetaForm({ ...metaForm, courseCode: e.target.value })} />
              </div>
            </div>
            <PrimaryButton type="submit" disabled={savingMeta}>
              {savingMeta ? "Saving…" : "Save details"}
            </PrimaryButton>
          </form>
        </SectionCard>
      )}

      <SectionCard title="Questions">
        <div className="mb-3 flex flex-wrap gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search questions..."
            className="flex-1 rounded-lg border border-lecturer-border px-3 py-1.5 text-sm text-lecturer-text-primary"
          />
          <select
            className="rounded-lg border border-lecturer-border px-2 py-1.5 text-sm"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as BankQuestionType | "")}
          >
            <option value="">All types</option>
            <option value="MULTIPLE_CHOICE">Multiple choice</option>
            <option value="SHORT_ANSWER">Short answer</option>
            <option value="ESSAY">Essay</option>
          </select>
          <select
            className="rounded-lg border border-lecturer-border px-2 py-1.5 text-sm"
            value={difficultyFilter}
            onChange={(e) => setDifficultyFilter(e.target.value as "easy" | "medium" | "hard" | "")}
          >
            <option value="">All difficulties</option>
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </select>
        </div>
        <div className="space-y-3">
          {bank.questions.length === 0 && <EmptyState title="No questions yet" />}
          {bank.questions
            .filter((q) => !typeFilter || q.type === typeFilter)
            .filter((q) => !difficultyFilter || q.difficulty === difficultyFilter)
            .filter((q) => !search || q.text.toLowerCase().includes(search.toLowerCase()))
            .map((q) => (
            <div key={q.id} className="rounded-lg border border-lecturer-border p-3">
              {editingId === q.id && editForm ? (
                <div className="space-y-3">
                  <div>
                    <label className={LABEL_CLASS}>Question text</label>
                    <textarea className={FIELD_CLASS} value={editForm.text} onChange={(e) => setEditForm({ ...editForm, text: e.target.value })} />
                  </div>
                  {editForm.type === "MULTIPLE_CHOICE" && (
                    <>
                      <div>
                        <label className={LABEL_CLASS}>Options (one per line)</label>
                        <textarea className={FIELD_CLASS} value={editForm.options} onChange={(e) => setEditForm({ ...editForm, options: e.target.value })} />
                      </div>
                      <div>
                        <label className={LABEL_CLASS}>Correct answer</label>
                        <input className={FIELD_CLASS} value={editForm.correctAnswer} onChange={(e) => setEditForm({ ...editForm, correctAnswer: e.target.value })} />
                      </div>
                    </>
                  )}
                  {editForm.type === "SHORT_ANSWER" && (
                    <div>
                      <label className={LABEL_CLASS}>Correct answer</label>
                      <input className={FIELD_CLASS} value={editForm.correctAnswer} onChange={(e) => setEditForm({ ...editForm, correctAnswer: e.target.value })} />
                    </div>
                  )}
                  <div className="flex gap-3">
                    <div className="w-32">
                      <label className={LABEL_CLASS}>Points</label>
                      <input type="number" min={1} className={FIELD_CLASS} value={editForm.points} onChange={(e) => setEditForm({ ...editForm, points: Number(e.target.value) })} />
                    </div>
                    <div className="flex-1">
                      <label className={LABEL_CLASS}>Difficulty</label>
                      <select className={FIELD_CLASS} value={editForm.difficulty} onChange={(e) => setEditForm({ ...editForm, difficulty: e.target.value as "easy" | "medium" | "hard" | "" })}>
                        <option value="">(none)</option>
                        <option value="easy">Easy</option>
                        <option value="medium">Medium</option>
                        <option value="hard">Hard</option>
                      </select>
                    </div>
                    <div className="flex-1">
                      <label className={LABEL_CLASS}>Topic</label>
                      <input className={FIELD_CLASS} value={editForm.topic} onChange={(e) => setEditForm({ ...editForm, topic: e.target.value })} />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <PrimaryButton type="button" onClick={() => handleSaveEdit(q.id)} disabled={savingEdit}>
                      {savingEdit ? "Saving…" : "Save"}
                    </PrimaryButton>
                    <SecondaryButton type="button" onClick={() => { setEditingId(null); setEditForm(null); }}>
                      Cancel
                    </SecondaryButton>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-sm text-lecturer-text-secondary">
                      <StatusBadge tone="neutral">{q.type}</StatusBadge>
                      {q.difficulty && <StatusBadge tone="info">{q.difficulty}</StatusBadge>}
                      {q.topic && <StatusBadge tone="accent">{q.topic}</StatusBadge>}
                      <span>{q.points} pt(s)</span>
                    </div>
                    <p className="mt-1 text-sm text-lecturer-text-primary">{q.text}</p>
                    {q.optionsJson && (
                      <ul className="mt-1 list-disc pl-5 text-sm text-lecturer-text-secondary">
                        {(JSON.parse(q.optionsJson) as string[]).map((o) => (
                          <li key={o}>{o}</li>
                        ))}
                      </ul>
                    )}
                    {q.correctAnswer && <p className="mt-1 text-sm text-[#067647]">Correct: {q.correctAnswer}</p>}
                    {q.sampleAnswer && <p className="mt-1 text-sm text-lecturer-text-secondary">Sample answer: {q.sampleAnswer}</p>}

                    {addToExamRowId === q.id && (
                      <div className="mt-3 flex flex-wrap items-center gap-2 rounded border border-lecturer-border bg-lecturer-border-subtle/40 p-2">
                        <select
                          className="rounded border border-lecturer-border px-2 py-1 text-xs"
                          value={addToExamExamId}
                          onChange={(e) => void handleSelectAddToExamExam(e.target.value)}
                        >
                          <option value="">Choose an exam...</option>
                          {lecturerExams.map((e) => (
                            <option key={e.id} value={e.id}>
                              {e.title}
                            </option>
                          ))}
                        </select>
                        {addToExamExamId && (
                          <select
                            className="rounded border border-lecturer-border px-2 py-1 text-xs"
                            value={addToExamPoolId}
                            onChange={(e) => setAddToExamPoolId(e.target.value)}
                          >
                            <option value="">Always included (required)</option>
                            {addToExamPools.map((p) => (
                              <option key={p.id} value={p.id}>
                                Pool: {p.name}
                              </option>
                            ))}
                          </select>
                        )}
                        <button
                          onClick={() => void handleSubmitAddToExam(q.id)}
                          disabled={!addToExamExamId || addToExamSubmitting}
                          className="rounded bg-lecturer-accent px-2 py-1 text-xs text-white disabled:opacity-50"
                        >
                          {addToExamSubmitting ? "Adding..." : "Add"}
                        </button>
                        {addToExamMessage && <span className="text-xs text-lecturer-text-secondary">{addToExamMessage}</span>}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1 text-sm">
                    <button onClick={() => startEditQuestion(q)} className="font-medium text-lecturer-text-primary underline underline-offset-2">
                      Edit
                    </button>
                    <button onClick={() => void handleDuplicateQuestion(q)} disabled={duplicatingId === q.id} className="font-medium text-lecturer-text-primary underline underline-offset-2 disabled:opacity-50">
                      {duplicatingId === q.id ? "Duplicating…" : "Duplicate"}
                    </button>
                    <button onClick={() => void openAddToExam(q.id)} className="font-medium text-lecturer-accent underline underline-offset-2">
                      Add to exam
                    </button>
                    <button onClick={() => handleDeleteQuestion(q.id)} className="font-medium text-[#B42318] underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B42318]">
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Add question">
        <form onSubmit={handleAddQuestion} className="space-y-3">
          <div>
            <label className={LABEL_CLASS}>Type</label>
            <select className={FIELD_CLASS} value={qType} onChange={(e) => setQType(e.target.value as BankQuestionType)}>
              <option value="MULTIPLE_CHOICE">Multiple choice</option>
              <option value="SHORT_ANSWER">Short answer</option>
              <option value="ESSAY">Essay</option>
            </select>
          </div>
          <div>
            <label className={LABEL_CLASS}>Question text</label>
            <textarea required className={FIELD_CLASS} value={qText} onChange={(e) => setQText(e.target.value)} />
          </div>
          {qType === "MULTIPLE_CHOICE" && (
            <>
              <div>
                <label className={LABEL_CLASS}>Options (one per line)</label>
                <textarea className={FIELD_CLASS} value={qOptions} onChange={(e) => setQOptions(e.target.value)} />
              </div>
              <div>
                <label className={LABEL_CLASS}>Correct answer</label>
                <input className={FIELD_CLASS} value={qCorrect} onChange={(e) => setQCorrect(e.target.value)} />
              </div>
            </>
          )}
          {qType === "SHORT_ANSWER" && (
            <div>
              <label className={LABEL_CLASS}>Correct answer</label>
              <input className={FIELD_CLASS} value={qCorrect} onChange={(e) => setQCorrect(e.target.value)} />
            </div>
          )}
          {(qType === "SHORT_ANSWER" || qType === "ESSAY") && (
            <div>
              <label className={LABEL_CLASS}>Sample answer (optional)</label>
              <textarea className={FIELD_CLASS} value={qSampleAnswer} onChange={(e) => setQSampleAnswer(e.target.value)} />
            </div>
          )}
          <div className="flex gap-3">
            <div className="w-32">
              <label className={LABEL_CLASS}>Points</label>
              <input type="number" min={1} className={FIELD_CLASS} value={qPoints} onChange={(e) => setQPoints(Number(e.target.value))} />
            </div>
            <div className="flex-1">
              <label className={LABEL_CLASS}>Difficulty</label>
              <select className={FIELD_CLASS} value={qDifficulty} onChange={(e) => setQDifficulty(e.target.value as "easy" | "medium" | "hard" | "")}>
                <option value="">(none)</option>
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
              </select>
            </div>
            <div className="flex-1">
              <label className={LABEL_CLASS}>Topic</label>
              <input className={FIELD_CLASS} value={qTopic} onChange={(e) => setQTopic(e.target.value)} />
            </div>
          </div>
          {error && <p className="text-sm text-[#B42318]">{error}</p>}
          <PrimaryButton type="submit" disabled={adding}>
            {adding ? "Adding…" : "Add question"}
          </PrimaryButton>
        </form>
      </SectionCard>
    </div>
  );
}
