"use client";

import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

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

  if (loading) return <p className="text-gray-500">Loading...</p>;
  if (!bank) return <p className="text-red-600">Question bank not found</p>;

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/lecturer/question-banks" className="text-sm underline">
        ← Back to question banks
      </Link>

      <div className="mt-3 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{bank.title}</h1>
          {bank.description && <p className="mt-1 text-gray-600">{bank.description}</p>}
          <p className="mt-1 text-sm text-gray-500">
            {[bank.subject, bank.courseCode].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setEditingMeta((v) => !v)}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            Edit bank details
          </button>
          <button onClick={handleDeleteBank} className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-600">
            Delete bank
          </button>
        </div>
      </div>

      {editingMeta && (
        <form onSubmit={handleSaveMeta} className="mt-4 space-y-3 rounded border border-gray-200 p-4">
          <div>
            <label className="block text-sm font-medium">Title</label>
            <input
              required
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={metaForm.title}
              onChange={(e) => setMetaForm({ ...metaForm, title: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-sm font-medium">Description</label>
            <textarea
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={metaForm.description}
              onChange={(e) => setMetaForm({ ...metaForm, description: e.target.value })}
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-sm font-medium">Subject</label>
              <input
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
                value={metaForm.subject}
                onChange={(e) => setMetaForm({ ...metaForm, subject: e.target.value })}
              />
            </div>
            <div className="flex-1">
              <label className="block text-sm font-medium">Course code</label>
              <input
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
                value={metaForm.courseCode}
                onChange={(e) => setMetaForm({ ...metaForm, courseCode: e.target.value })}
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={savingMeta}
            className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {savingMeta ? "Saving..." : "Save details"}
          </button>
        </form>
      )}

      <h2 className="mt-8 text-lg font-medium">Questions</h2>
      <div className="mt-3 space-y-3">
        {bank.questions.length === 0 && <p className="text-gray-500">No questions yet.</p>}
        {bank.questions.map((q) => (
          <div key={q.id} className="rounded border border-gray-200 p-3">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <span className="rounded bg-gray-100 px-2 py-0.5 text-xs">{q.type}</span>
                  {q.difficulty && (
                    <span className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
                      {q.difficulty}
                    </span>
                  )}
                  {q.topic && (
                    <span className="rounded bg-purple-100 px-2 py-0.5 text-xs text-purple-700">
                      {q.topic}
                    </span>
                  )}
                  <span>{q.points} pt(s)</span>
                </div>
                <p className="mt-1">{q.text}</p>
                {q.optionsJson && (
                  <ul className="mt-1 list-disc pl-5 text-sm text-gray-600">
                    {(JSON.parse(q.optionsJson) as string[]).map((o) => (
                      <li key={o}>{o}</li>
                    ))}
                  </ul>
                )}
                {q.correctAnswer && (
                  <p className="mt-1 text-sm text-green-700">Correct: {q.correctAnswer}</p>
                )}
                {q.sampleAnswer && (
                  <p className="mt-1 text-sm text-gray-500">Sample answer: {q.sampleAnswer}</p>
                )}
              </div>
              <button
                onClick={() => handleDeleteQuestion(q.id)}
                className="text-sm text-red-600 underline"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      <h2 className="mt-8 text-lg font-medium">Add question</h2>
      <form onSubmit={handleAddQuestion} className="mt-3 space-y-3 rounded border border-gray-200 p-4">
        <div>
          <label className="block text-sm font-medium">Type</label>
          <select
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            value={qType}
            onChange={(e) => setQType(e.target.value as BankQuestionType)}
          >
            <option value="MULTIPLE_CHOICE">Multiple choice</option>
            <option value="SHORT_ANSWER">Short answer</option>
            <option value="ESSAY">Essay</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium">Question text</label>
          <textarea
            required
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            value={qText}
            onChange={(e) => setQText(e.target.value)}
          />
        </div>
        {qType === "MULTIPLE_CHOICE" && (
          <>
            <div>
              <label className="block text-sm font-medium">Options (one per line)</label>
              <textarea
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
                value={qOptions}
                onChange={(e) => setQOptions(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-medium">Correct answer</label>
              <input
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
                value={qCorrect}
                onChange={(e) => setQCorrect(e.target.value)}
              />
            </div>
          </>
        )}
        {qType === "SHORT_ANSWER" && (
          <div>
            <label className="block text-sm font-medium">Correct answer</label>
            <input
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={qCorrect}
              onChange={(e) => setQCorrect(e.target.value)}
            />
          </div>
        )}
        {(qType === "SHORT_ANSWER" || qType === "ESSAY") && (
          <div>
            <label className="block text-sm font-medium">Sample answer (optional)</label>
            <textarea
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={qSampleAnswer}
              onChange={(e) => setQSampleAnswer(e.target.value)}
            />
          </div>
        )}
        <div className="flex gap-3">
          <div className="w-32">
            <label className="block text-sm font-medium">Points</label>
            <input
              type="number"
              min={1}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={qPoints}
              onChange={(e) => setQPoints(Number(e.target.value))}
            />
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium">Difficulty</label>
            <select
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={qDifficulty}
              onChange={(e) => setQDifficulty(e.target.value as "easy" | "medium" | "hard" | "")}
            >
              <option value="">(none)</option>
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium">Topic</label>
            <input
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={qTopic}
              onChange={(e) => setQTopic(e.target.value)}
            />
          </div>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={adding}
          className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {adding ? "Adding..." : "Add question"}
        </button>
      </form>
    </div>
  );
}
