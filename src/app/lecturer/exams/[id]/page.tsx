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

type SecureSettings = {
  secureModeEnabled: boolean;
  requireFullscreen: boolean;
  blockCopyPaste: boolean;
  blockRightClick: boolean;
  trackWindowBlur: boolean;
  autoSubmitOnTimerEnd: boolean;
  allowLateSubmit: boolean;
  maxAttempts: number;
  showIntegrityWarningToStudent: boolean;
};

type Exam = {
  id: string;
  title: string;
  description: string | null;
  durationMins: number;
  published: boolean;
  questions: Question[];
  secureSettings: SecureSettings;
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

type LtiExamLink = {
  id: string;
  resourceLinkId: string;
  canvasCourseId: string | null;
  canvasAssignmentId: string | null;
  label: string | null;
  createdAt: string;
  platform: { issuer: string };
};

type LtiPlatformOption = {
  id: string;
  issuer: string;
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

  const [secureForm, setSecureForm] = useState<SecureSettings | null>(null);
  const [savingSecure, setSavingSecure] = useState(false);
  const [submissionCounts, setSubmissionCounts] = useState<{
    total: number;
    submitted: number;
    graded: number;
  } | null>(null);
  const [unresolvedHighRisk, setUnresolvedHighRisk] = useState<number | null>(null);

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

  const [ltiLinks, setLtiLinks] = useState<LtiExamLink[]>([]);
  const [platforms, setPlatforms] = useState<LtiPlatformOption[]>([]);
  const [linkForm, setLinkForm] = useState({
    platformId: "",
    resourceLinkId: "",
    canvasCourseId: "",
    canvasAssignmentId: "",
    label: "",
  });
  const [creatingLink, setCreatingLink] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const difficultySum = easyPct + mediumPct + hardPct;

  async function loadExam() {
    setLoading(true);
    const res = await fetch(`/api/exams/${id}`);
    if (res.ok) {
      const data: Exam = await res.json();
      setExam(data);
      setSecureForm(data.secureSettings);
    }
    setLoading(false);
  }

  async function loadSubmissionStatus() {
    const res = await fetch(`/api/exams/${id}/submissions`);
    if (!res.ok) return;
    const submissions: Array<{ status: string }> = await res.json();
    setHasUngradedSubmissions(submissions.some((s) => s.status === "SUBMITTED"));
    setSubmissionCounts({
      total: submissions.length,
      submitted: submissions.filter((s) => s.status === "SUBMITTED").length,
      graded: submissions.filter((s) => s.status === "GRADED").length,
    });
  }

  async function loadIntegrityOverview() {
    const res = await fetch(`/api/lecturer/exams/${id}/integrity-events`);
    if (!res.ok) return;
    const data: { unresolvedHighSeverityCount: number } = await res.json();
    setUnresolvedHighRisk(data.unresolvedHighSeverityCount);
  }

  async function loadLtiLinks() {
    const res = await fetch(`/api/lecturer/exams/${id}/lti-links`);
    if (res.ok) setLtiLinks(await res.json());
  }

  async function loadPlatforms() {
    const res = await fetch("/api/lecturer/lti-platforms");
    if (res.ok) setPlatforms(await res.json());
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadExam();
    loadSubmissionStatus();
    loadIntegrityOverview();
    loadLtiLinks();
    loadPlatforms();
  }, [id]);

  async function handleCreateLink(e: React.FormEvent) {
    e.preventDefault();
    setLinkError(null);
    setCreatingLink(true);

    const res = await fetch(`/api/lecturer/exams/${id}/lti-links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platformId: linkForm.platformId,
        resourceLinkId: linkForm.resourceLinkId,
        canvasCourseId: linkForm.canvasCourseId || undefined,
        canvasAssignmentId: linkForm.canvasAssignmentId || undefined,
        label: linkForm.label || undefined,
      }),
    });

    setCreatingLink(false);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setLinkError(typeof data.error === "string" ? data.error : "Failed to create Canvas link");
      return;
    }

    setLinkForm({ platformId: "", resourceLinkId: "", canvasCourseId: "", canvasAssignmentId: "", label: "" });
    await loadLtiLinks();
  }

  async function handleDeleteLink(linkId: string) {
    if (!confirm("Remove this Canvas link?")) return;
    await fetch(`/api/lecturer/exams/${id}/lti-links/${linkId}`, { method: "DELETE" });
    await loadLtiLinks();
  }

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

  async function handleSaveSecureSettings() {
    if (!secureForm) return;
    setSavingSecure(true);
    const res = await fetch(`/api/exams/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secureSettings: secureForm }),
    });
    setSavingSecure(false);
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
          <Link
            href={`/lecturer/exams/${id}/import-questions`}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            Import from question bank
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

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded border border-gray-200 p-3">
          <p className="text-xs uppercase text-gray-500">Secure Exam Mode</p>
          <p className="mt-1 text-sm">
            {exam.secureSettings.secureModeEnabled ? "Enabled" : "Disabled"}
          </p>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <p className="text-xs uppercase text-gray-500">Submissions</p>
          <p className="mt-1 text-sm">
            {submissionCounts ? `${submissionCounts.total} total` : "—"}
          </p>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <p className="text-xs uppercase text-gray-500">Pending grading</p>
          <p className="mt-1 text-sm">{submissionCounts ? submissionCounts.submitted : "—"}</p>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <p className="text-xs uppercase text-gray-500">Unresolved high-risk events</p>
          <p className={`mt-1 text-sm ${unresolvedHighRisk ? "text-red-600" : ""}`}>
            {unresolvedHighRisk != null ? unresolvedHighRisk : "—"}
          </p>
        </div>
      </div>

      <h2 className="mt-8 text-lg font-medium">Secure Exam Mode</h2>
      <p className="mt-1 text-sm text-gray-500">
        Secure Exam Mode records exam integrity signals for lecturer review. It does not
        automatically accuse students of misconduct.
      </p>
      {secureForm && (
        <div className="mt-3 space-y-3 rounded border border-gray-200 p-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={secureForm.secureModeEnabled}
              onChange={(e) => setSecureForm({ ...secureForm, secureModeEnabled: e.target.checked })}
            />
            Enable Secure Exam Mode
          </label>

          <div className="grid grid-cols-2 gap-2 pl-1 text-sm text-gray-700">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                disabled={!secureForm.secureModeEnabled}
                checked={secureForm.requireFullscreen}
                onChange={(e) => setSecureForm({ ...secureForm, requireFullscreen: e.target.checked })}
              />
              Require fullscreen
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                disabled={!secureForm.secureModeEnabled}
                checked={secureForm.trackWindowBlur}
                onChange={(e) => setSecureForm({ ...secureForm, trackWindowBlur: e.target.checked })}
              />
              Record tab/window switching
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                disabled={!secureForm.secureModeEnabled}
                checked={secureForm.blockCopyPaste}
                onChange={(e) => setSecureForm({ ...secureForm, blockCopyPaste: e.target.checked })}
              />
              Block copy/paste
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                disabled={!secureForm.secureModeEnabled}
                checked={secureForm.blockRightClick}
                onChange={(e) => setSecureForm({ ...secureForm, blockRightClick: e.target.checked })}
              />
              Block right click
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                disabled={!secureForm.secureModeEnabled}
                checked={secureForm.autoSubmitOnTimerEnd}
                onChange={(e) => setSecureForm({ ...secureForm, autoSubmitOnTimerEnd: e.target.checked })}
              />
              Auto-submit when time expires
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                disabled={!secureForm.secureModeEnabled}
                checked={secureForm.showIntegrityWarningToStudent}
                onChange={(e) =>
                  setSecureForm({ ...secureForm, showIntegrityWarningToStudent: e.target.checked })
                }
              />
              Student warning messages enabled
            </label>
          </div>

          <div className="flex items-center gap-3 pl-1">
            <label className="text-sm text-gray-700">Maximum attempts</label>
            <input
              type="number"
              min={1}
              max={1}
              disabled={!secureForm.secureModeEnabled}
              value={secureForm.maxAttempts}
              onChange={(e) => setSecureForm({ ...secureForm, maxAttempts: Number(e.target.value) })}
              className="w-20 rounded border border-gray-300 px-2 py-1 text-sm"
            />
            <span className="text-xs text-gray-400">(v1 supports 1 attempt only)</span>
          </div>

          <button
            onClick={handleSaveSecureSettings}
            disabled={savingSecure}
            className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {savingSecure ? "Saving..." : "Save Secure Exam Mode settings"}
          </button>
        </div>
      )}

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

      <h2 className="mt-8 text-lg font-medium">Canvas / LTI linking</h2>
      <p className="mt-1 text-sm text-gray-500">
        Link a Canvas assignment&apos;s resource link to this exam so students launching from
        Canvas land directly on it. Unlinked Canvas launches never connect to a random exam.
      </p>

      <div className="mt-3 space-y-3">
        {ltiLinks.length === 0 && (
          <p className="text-sm text-gray-500">No Canvas links yet.</p>
        )}
        {ltiLinks.map((link) => (
          <div key={link.id} className="rounded border border-gray-200 p-3 text-sm">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-medium">{link.label || "Canvas link"}</p>
                <p className="text-gray-500">Platform: {link.platform.issuer}</p>
                <p className="text-gray-500">Resource link ID: {link.resourceLinkId}</p>
                {link.canvasCourseId && <p className="text-gray-500">Course ID: {link.canvasCourseId}</p>}
                {link.canvasAssignmentId && (
                  <p className="text-gray-500">Assignment ID: {link.canvasAssignmentId}</p>
                )}
                <p className="text-gray-400">Created {new Date(link.createdAt).toLocaleDateString()}</p>
              </div>
              <button
                onClick={() => handleDeleteLink(link.id)}
                className="text-sm text-red-600 underline"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={handleCreateLink} className="mt-3 space-y-3 rounded border border-gray-200 p-4">
        <div>
          <label className="block text-sm font-medium">Canvas platform</label>
          <select
            required
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            value={linkForm.platformId}
            onChange={(e) => setLinkForm({ ...linkForm, platformId: e.target.value })}
          >
            <option value="">Select a platform...</option>
            {platforms.map((p) => (
              <option key={p.id} value={p.id}>
                {p.issuer}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium">Canvas resource link ID</label>
          <input
            required
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            value={linkForm.resourceLinkId}
            onChange={(e) => setLinkForm({ ...linkForm, resourceLinkId: e.target.value })}
          />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-sm font-medium">Canvas course ID (optional)</label>
            <input
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={linkForm.canvasCourseId}
              onChange={(e) => setLinkForm({ ...linkForm, canvasCourseId: e.target.value })}
            />
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium">Canvas assignment ID (optional)</label>
            <input
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={linkForm.canvasAssignmentId}
              onChange={(e) => setLinkForm({ ...linkForm, canvasAssignmentId: e.target.value })}
            />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium">Label (optional)</label>
          <input
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            value={linkForm.label}
            onChange={(e) => setLinkForm({ ...linkForm, label: e.target.value })}
          />
        </div>
        {linkError && <p className="text-sm text-red-600">{linkError}</p>}
        <button
          type="submit"
          disabled={creatingLink}
          className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {creatingLink ? "Linking..." : "Link Canvas resource"}
        </button>
      </form>
    </div>
  );
}
