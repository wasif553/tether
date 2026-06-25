"use client";

import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";

type Question = {
  id: string;
  type: "MULTIPLE_CHOICE" | "SHORT_ANSWER" | "ESSAY";
  text: string;
  options: string[] | null;
  correctAnswer: string | null;
  points: number;
  order: number;
};

type Exam = {
  id: string;
  title: string;
  description: string | null;
  durationMins: number;
  published: boolean;
  questions: Question[];
};

type GeneratedQuestion = {
  type: "MCQ" | "SHORT_ANSWER" | "ESSAY";
  body: string;
  options?: string[];
  correctAnswer?: string;
  difficulty: "easy" | "medium" | "hard";
  explanation: string;
};

const QUESTION_TYPE_LABELS: Record<GeneratedQuestion["type"], string> = {
  MCQ: "Multiple choice",
  SHORT_ANSWER: "Short answer",
  ESSAY: "Essay",
};

export default function LecturerExamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);

  const [exam, setExam] = useState<Exam | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [qType, setQType] = useState<Question["type"]>("MULTIPLE_CHOICE");
  const [qText, setQText] = useState("");
  const [qOptions, setQOptions] = useState("");
  const [qCorrect, setQCorrect] = useState("");
  const [qPoints, setQPoints] = useState(1);
  const [adding, setAdding] = useState(false);

  const [sourceMaterial, setSourceMaterial] = useState("");
  const [subject, setSubject] = useState("");
  const [totalCount, setTotalCount] = useState(10);
  const [easyPct, setEasyPct] = useState(34);
  const [mediumPct, setMediumPct] = useState(33);
  const [hardPct, setHardPct] = useState(33);
  const [selectedTypes, setSelectedTypes] = useState<GeneratedQuestion["type"][]>([
    "MCQ",
    "SHORT_ANSWER",
  ]);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<GeneratedQuestion[]>([]);
  const [included, setIncluded] = useState<boolean[]>([]);
  const [expandedExplanation, setExpandedExplanation] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);

  const [hasUngradedSubmissions, setHasUngradedSubmissions] = useState(false);
  const [markingEssays, setMarkingEssays] = useState(false);
  const [markEssaysMessage, setMarkEssaysMessage] = useState<string | null>(null);

  const difficultySum = easyPct + mediumPct + hardPct;

  async function loadExam() {
    setLoading(true);
    const res = await fetch(`/api/exams/${id}`);
    if (res.ok) setExam(await res.json());
    setLoading(false);
  }

  async function loadSubmissionStatus() {
    const res = await fetch(`/api/exams/${id}/submissions`);
    if (!res.ok) return;
    const submissions: Array<{ status: string }> = await res.json();
    setHasUngradedSubmissions(submissions.some((s) => s.status === "SUBMITTED"));
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadExam();
    loadSubmissionStatus();
  }, [id]);

  useEffect(() => {
    if (exam && !subject) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSubject(exam.title);
    }
  }, [exam, subject]);

  async function handleAddQuestion(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAdding(true);

    const res = await fetch(`/api/exams/${id}/questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: qType,
        text: qText,
        options:
          qType === "MULTIPLE_CHOICE"
            ? qOptions.split("\n").map((o) => o.trim()).filter(Boolean)
            : undefined,
        correctAnswer: qType === "ESSAY" ? undefined : qCorrect || undefined,
        points: qPoints,
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
    setQPoints(1);
    await loadExam();
  }

  async function handleDeleteQuestion(questionId: string) {
    await fetch(`/api/exams/${id}/questions/${questionId}`, { method: "DELETE" });
    await loadExam();
  }

  async function togglePublish() {
    if (!exam) return;
    const res = await fetch(`/api/exams/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ published: !exam.published }),
    });
    if (res.ok) await loadExam();
  }

  async function handleMarkEssays() {
    setMarkingEssays(true);
    setMarkEssaysMessage(null);

    const res = await fetch(`/api/lecturer/exams/${id}/ai-mark-essays`, { method: "POST" });

    setMarkingEssays(false);

    if (res.status === 502) {
      setMarkEssaysMessage("Anthropic API key not configured");
      return;
    }

    if (!res.ok) {
      setMarkEssaysMessage("Failed to mark essays with AI");
      return;
    }

    const result: { marked: number; skipped: number } = await res.json();
    setMarkEssaysMessage(
      result.marked > 0
        ? `${result.marked} essay(s) marked — review drafts below`
        : `No essays were marked (${result.skipped} skipped)`,
    );
    await loadSubmissionStatus();
  }

  function toggleType(type: GeneratedQuestion["type"]) {
    setSelectedTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  }

  async function handleGenerate() {
    setGenerateError(null);

    if (difficultySum !== 100) {
      setGenerateError("Difficulty percentages must sum to 100%");
      return;
    }
    if (selectedTypes.length === 0) {
      setGenerateError("Select at least one question type");
      return;
    }
    if (!sourceMaterial.trim()) {
      setGenerateError("Paste some source material or a topic to generate from");
      return;
    }

    setGenerating(true);
    setGenerated([]);
    setIncluded([]);

    const res = await fetch(`/api/lecturer/exams/${id}/generate-questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceMaterial,
        subject: subject || exam?.title || "General",
        totalCount,
        difficulty: { easy: easyPct, medium: mediumPct, hard: hardPct },
        types: selectedTypes,
        existingQuestions: exam?.questions.map((q) => q.text) ?? [],
      }),
    });

    setGenerating(false);

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      setGenerateError(
        typeof data.error === "string" ? data.error : "Failed to generate questions",
      );
      return;
    }

    setGenerated(data.questions ?? []);
    setIncluded(new Array((data.questions ?? []).length).fill(true));
  }

  async function handleAddSelected() {
    const selected = generated.filter((_, i) => included[i]);
    if (selected.length === 0) return;

    setImporting(true);

    const res = await fetch(`/api/lecturer/exams/${id}/questions/bulk-import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questions: selected }),
    });

    setImporting(false);

    if (!res.ok) {
      setGenerateError("Failed to add selected questions to the exam");
      return;
    }

    setGenerated([]);
    setIncluded([]);
    await loadExam();
  }

  if (loading) return <p className="text-gray-500">Loading...</p>;
  if (!exam) return <p className="text-red-600">Exam not found</p>;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{exam.title}</h1>
        <div className="flex gap-2">
          <Link
            href={`/lecturer/exams/${id}/submissions`}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            Submissions
          </Link>
          <Link
            href={`/lecturer/exams/${id}/analytics`}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            View analytics
          </Link>
          <Link
            href={`/lecturer/exams/${id}/integrity`}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            Review integrity events
          </Link>
          {exam.questions.some((q) => q.type === "ESSAY") && hasUngradedSubmissions && (
            <button
              onClick={handleMarkEssays}
              disabled={markingEssays}
              className="flex items-center gap-2 rounded border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {markingEssays && (
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
              )}
              {markingEssays ? "Marking..." : "Mark essays with AI"}
            </button>
          )}
          <button
            onClick={togglePublish}
            className={
              exam.published
                ? "rounded bg-gray-200 px-3 py-1.5 text-sm"
                : "rounded bg-black px-3 py-1.5 text-sm text-white"
            }
          >
            {exam.published ? "Unpublish" : "Publish"}
          </button>
        </div>
      </div>
      <p className="text-sm text-gray-500">{exam.durationMins} minutes</p>
      {markEssaysMessage && <p className="mt-2 text-sm text-gray-600">{markEssaysMessage}</p>}

      <h2 className="mt-8 text-lg font-medium">Questions</h2>
      <div className="mt-3 space-y-3">
        {exam.questions.length === 0 && (
          <p className="text-gray-500">No questions yet.</p>
        )}
        {exam.questions.map((q, i) => (
          <div key={q.id} className="rounded border border-gray-200 p-3">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm text-gray-500">
                  Q{i + 1} · {q.type} · {q.points} pt(s)
                </p>
                <p className="mt-1">{q.text}</p>
                {q.options && (
                  <ul className="mt-1 list-disc pl-5 text-sm text-gray-600">
                    {q.options.map((o) => (
                      <li key={o}>{o}</li>
                    ))}
                  </ul>
                )}
                {q.correctAnswer && (
                  <p className="mt-1 text-sm text-green-700">
                    Correct: {q.correctAnswer}
                  </p>
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

      <h2 className="mt-8 text-lg font-medium">Generate questions with AI</h2>
      <div className="mt-3 space-y-3 rounded border border-gray-200 p-4">
        <div>
          <label className="block text-sm font-medium">Source material or topic</label>
          <textarea
            rows={5}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            placeholder="Paste lecture notes, a textbook excerpt, or just describe a topic..."
            value={sourceMaterial}
            onChange={(e) => setSourceMaterial(e.target.value)}
          />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-sm font-medium">Subject</label>
            <input
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div className="w-32">
            <label className="block text-sm font-medium">Count</label>
            <input
              type="number"
              min={1}
              max={50}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={totalCount}
              onChange={(e) => setTotalCount(Number(e.target.value))}
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium">
            Difficulty mix{" "}
            <span className={difficultySum === 100 ? "text-gray-500" : "text-red-600"}>
              ({difficultySum}% total)
            </span>
          </label>
          <div className="mt-2 space-y-2">
            <div className="flex items-center gap-3">
              <span className="w-16 text-sm">Easy</span>
              <input
                type="range"
                min={0}
                max={100}
                className="flex-1"
                value={easyPct}
                onChange={(e) => setEasyPct(Number(e.target.value))}
              />
              <span className="w-10 text-right text-sm">{easyPct}%</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-16 text-sm">Medium</span>
              <input
                type="range"
                min={0}
                max={100}
                className="flex-1"
                value={mediumPct}
                onChange={(e) => setMediumPct(Number(e.target.value))}
              />
              <span className="w-10 text-right text-sm">{mediumPct}%</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-16 text-sm">Hard</span>
              <input
                type="range"
                min={0}
                max={100}
                className="flex-1"
                value={hardPct}
                onChange={(e) => setHardPct(Number(e.target.value))}
              />
              <span className="w-10 text-right text-sm">{hardPct}%</span>
            </div>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium">Question types</label>
          <div className="mt-1 flex gap-4">
            {(["MCQ", "SHORT_ANSWER", "ESSAY"] as const).map((type) => (
              <label key={type} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedTypes.includes(type)}
                  onChange={() => toggleType(type)}
                />
                {QUESTION_TYPE_LABELS[type]}
              </label>
            ))}
          </div>
        </div>

        {generateError && <p className="text-sm text-red-600">{generateError}</p>}

        <button
          onClick={handleGenerate}
          disabled={generating}
          className="flex items-center gap-2 rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {generating && (
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
          )}
          {generating ? "Generating..." : "Generate"}
        </button>

        {generated.length > 0 && (
          <div className="mt-4 space-y-3 border-t border-gray-200 pt-4">
            <p className="text-sm text-gray-500">
              {generated.length} question(s) generated — review and select which to add.
            </p>
            {generated.map((q, i) => (
              <div key={i} className="rounded border border-gray-200 p-3">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={included[i] ?? false}
                    onChange={(e) =>
                      setIncluded((prev) => {
                        const next = [...prev];
                        next[i] = e.target.checked;
                        return next;
                      })
                    }
                  />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                        {QUESTION_TYPE_LABELS[q.type]}
                      </span>
                      <span
                        className={
                          q.difficulty === "hard"
                            ? "rounded bg-red-100 px-2 py-0.5 text-xs text-red-700"
                            : q.difficulty === "medium"
                              ? "rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700"
                              : "rounded bg-green-100 px-2 py-0.5 text-xs text-green-700"
                        }
                      >
                        {q.difficulty}
                      </span>
                    </div>
                    <p className="mt-1">{q.body}</p>
                    {q.options && (
                      <ul className="mt-1 space-y-0.5 text-sm">
                        {q.options.map((opt, optIndex) => {
                          const label = String.fromCharCode(65 + optIndex);
                          const isCorrect = q.correctAnswer === label;
                          return (
                            <li
                              key={label}
                              className={isCorrect ? "font-medium text-green-700" : "text-gray-600"}
                            >
                              {label}. {opt} {isCorrect && "✓"}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {!q.options && q.correctAnswer && (
                      <p className="mt-1 text-sm text-green-700">Model answer: {q.correctAnswer}</p>
                    )}
                    <button
                      onClick={() => setExpandedExplanation(expandedExplanation === i ? null : i)}
                      className="mt-2 text-xs underline"
                    >
                      {expandedExplanation === i ? "Hide explanation" : "Show explanation"}
                    </button>
                    {expandedExplanation === i && (
                      <p className="mt-1 text-sm text-gray-500">{q.explanation}</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
            <button
              onClick={handleAddSelected}
              disabled={importing || included.every((v) => !v)}
              className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
            >
              {importing ? "Adding..." : "Add selected to exam"}
            </button>
          </div>
        )}
      </div>

      <h2 className="mt-8 text-lg font-medium">Add question</h2>
      <form onSubmit={handleAddQuestion} className="mt-3 space-y-3 rounded border border-gray-200 p-4">
        <div>
          <label className="block text-sm font-medium">Type</label>
          <select
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            value={qType}
            onChange={(e) => setQType(e.target.value as Question["type"])}
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
          <div>
            <label className="block text-sm font-medium">Options (one per line)</label>
            <textarea
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={qOptions}
              onChange={(e) => setQOptions(e.target.value)}
            />
          </div>
        )}
        {qType !== "ESSAY" && (
          <div>
            <label className="block text-sm font-medium">Correct answer</label>
            <input
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={qCorrect}
              onChange={(e) => setQCorrect(e.target.value)}
            />
          </div>
        )}
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
