"use client";

import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";
import {
  parseBulkQuestionsText,
  BULK_QUESTION_FORMAT_EXAMPLE,
  type BulkParseResult,
} from "@/lib/bulkQuestionParser";
import {
  createEmptyManualDraft,
  validateManualDraft,
  type ManualQuestionDraft,
} from "@/lib/manualQuestionDraft";
import {
  activeSafeExamControlLabels,
  safeExamModeStatusLabel,
  secureSettingsChanged,
} from "@/lib/secureExam";
import {
  EXAM_MODES,
  EXAM_MODE_LABELS,
  getExamModePreset,
  validateExamPolicy,
  buildLecturerExamPolicySummary,
  type ExamMode,
} from "@/lib/examPolicy";
import { buildStudentJoinLink } from "@/lib/examShareLink";

type Question = {
  id: string;
  type: "MULTIPLE_CHOICE" | "SHORT_ANSWER" | "ESSAY";
  text: string;
  options: string[] | null;
  correctAnswer: string | null;
  points: number;
  order: number;
  // Question Pools v1 — see docs/question-pools-v1.md. Null means "no pool."
  questionPoolId?: string | null;
};

// Question Pools v1 — see docs/question-pools-v1.md.
type QuestionPool = {
  id: string;
  name: string;
  description: string | null;
  drawCount: number | null;
  order: number;
  questionCount: number;
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
  requireCamera: boolean;
  showCameraPreview: boolean;
  cameraHeartbeatEnabled: boolean;
  cameraHeartbeatIntervalSeconds: number;
  recordCameraUnavailableEvents: boolean;
  blockKeyboardShortcuts: boolean;
  disableQuestionTextSelection: boolean;
  enforceFullscreenReturn: boolean;
  requireStudentVerification: boolean;
  enableAiCameraIntegrityChecks: boolean;
  captureAiViolationEvidence: boolean;
  enableExamWatermark: boolean;
  oneQuestionAtATime: boolean;
  allowBackNavigation: boolean;
  randomiseQuestionOrder: boolean;
  randomiseMcqOptionOrder: boolean;
  enableQuestionPools: boolean;
  questionPoolSelectionMode: "ALL_QUESTIONS" | "DRAW_FROM_POOLS";
  // Exam Design Policy v1 — see docs/exam-design-policy-v1.md.
  examMode: "CLOSED_BOOK" | "OPEN_BOOK" | "CUSTOM";
  calculatorAllowed: boolean;
  notesAllowed: boolean;
  internetAllowed: boolean;
  aiToolsAllowed: boolean;
};

type Exam = {
  id: string;
  title: string;
  description: string | null;
  durationMins: number;
  published: boolean;
  questions: Question[];
  secureSettings: SecureSettings;
  accessCodeRequired: boolean;
  courseId: string | null;
  assignmentMode: "COURSE" | "SELECTED_STUDENTS";
  availableFrom: string | null;
  availableUntil: string | null;
  marksReleasedAt: string | null;
  marksReleasedById: string | null;
};

type LecturerCourse = {
  id: string;
  name: string;
  code: string;
  enrollments?: { id: string; role: "STUDENT" | "LECTURER"; user: { id: string; name: string; email: string } }[];
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
  const [loadError, setLoadError] = useState<string | null>(null);

  const [secureForm, setSecureForm] = useState<SecureSettings | null>(null);
  // Exam Design Policy v1 — see docs/exam-design-policy-v1.md. Holds a
  // pending preset proposal until the lecturer explicitly confirms it —
  // selecting Closed-book/Open-book never silently overwrites existing
  // settings.
  const [pendingPreset, setPendingPreset] = useState<ExamMode | null>(null);

  // Temporary dev-only diagnostic (see loadExam above) — logs secureForm
  // (and therefore what the toggles below will render as `checked`)
  // every time it changes. Remove once the production/local mismatch is
  // resolved.
  useEffect(() => {
    if (
      process.env.NODE_ENV === "development" &&
      typeof window !== "undefined" &&
      window.localStorage.getItem("sesSecureSettingsDebug") === "true"
    ) {
      console.log("[sesSecureSettingsDebug] secureForm state (drives toggle checked props):", secureForm);
    }
  }, [secureForm]);

  const [savingSecure, setSavingSecure] = useState(false);
  const [secureSaveMessage, setSecureSaveMessage] = useState<string | null>(null);
  const [accessCodeInput, setAccessCodeInput] = useState("");
  const [savingAccessCode, setSavingAccessCode] = useState(false);
  const [accessCodeMessage, setAccessCodeMessage] = useState<string | null>(null);
  const [submissionCounts, setSubmissionCounts] = useState<{
    total: number;
    submitted: number;
    graded: number;
  } | null>(null);
  const [unresolvedHighRisk, setUnresolvedHighRisk] = useState<number | null>(null);

  // Question Pools v1 — see docs/question-pools-v1.md.
  const [pools, setPools] = useState<QuestionPool[]>([]);
  const [newPoolName, setNewPoolName] = useState("");
  const [newPoolDrawCount, setNewPoolDrawCount] = useState("");
  const [poolsMessage, setPoolsMessage] = useState<string | null>(null);

  // Course, Enrolment, Exam Assignment, Scheduling v1 — see
  // docs/course-enrolment-and-exam-assignment.md.
  const [courses, setCourses] = useState<LecturerCourse[]>([]);
  const [courseStudents, setCourseStudents] = useState<{ id: string; name: string; email: string }[]>([]);
  const [courseId, setCourseId] = useState<string>("");
  const [assignmentMode, setAssignmentMode] = useState<"COURSE" | "SELECTED_STUDENTS">("COURSE");
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const [availableFrom, setAvailableFrom] = useState("");
  const [availableUntil, setAvailableUntil] = useState("");
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleMessage, setScheduleMessage] = useState<string | null>(null);

  // Safe Exam Deep Link v1 — see docs/course-enrolment-and-exam-assignment.md.
  const [copiedJoinLink, setCopiedJoinLink] = useState(false);
  const joinLinkUrl =
    typeof window !== "undefined" ? buildStudentJoinLink(window.location.origin, id) : "";

  async function handleCopyJoinLink() {
    try {
      await navigator.clipboard.writeText(joinLinkUrl);
      setCopiedJoinLink(true);
      setTimeout(() => setCopiedJoinLink(false), 2000);
    } catch {
      // Clipboard API can be denied/unavailable — the input field itself
      // is selectable as a fallback, so this failure is silent.
    }
  }

  const [manualDrafts, setManualDrafts] = useState<ManualQuestionDraft[]>([createEmptyManualDraft()]);
  const [manualErrors, setManualErrors] = useState<Record<number, string[]>>({});
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSuccess, setAddSuccess] = useState<string | null>(null);

  const [bulkText, setBulkText] = useState("");
  const [bulkPreview, setBulkPreview] = useState<BulkParseResult | null>(null);
  const [bulkSaveToBankId, setBulkSaveToBankId] = useState("");
  const [bulkBanks, setBulkBanks] = useState<{ id: string; title: string }[]>([]);
  const [bulkImporting, setBulkImporting] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<{ created: number; bankSaved: number; warning?: string } | null>(
    null,
  );

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
  const [savingMarksRelease, setSavingMarksRelease] = useState(false);
  const [marksReleaseMessage, setMarksReleaseMessage] = useState<string | null>(null);

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

  async function loadExam(options: { preserveSecureForm?: boolean } = {}) {
    setLoading(true);
    const res = await fetch(`/api/exams/${id}`).catch(() => null);
    if (!res) {
      setLoadError("Could not load this exam — check your connection and try refreshing the page.");
      setLoading(false);
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setLoadError(
        typeof body?.error === "string"
          ? body.error
          : `Could not load this exam (status ${res.status}). Try refreshing the page.`,
      );
      setLoading(false);
      return;
    }
    setLoadError(null);
    const data: Exam = await res.json();
    // Temporary dev-only diagnostic for the production secureSettings
    // display investigation — never fires outside NODE_ENV=development,
    // and only when explicitly opted in via localStorage. Remove once
    // the production/local mismatch is resolved.
    if (
      process.env.NODE_ENV === "development" &&
      typeof window !== "undefined" &&
      window.localStorage.getItem("sesSecureSettingsDebug") === "true"
    ) {
      console.log("[sesSecureSettingsDebug] raw exam.secureSettings from GET /api/exams/[id]:", data.secureSettings);
    }
    setExam(data);
    if (!options.preserveSecureForm) {
      setSecureForm(data.secureSettings);
    }
    setCourseId(data.courseId ?? "");
    setAssignmentMode(data.assignmentMode ?? "COURSE");
    setAvailableFrom(data.availableFrom ? data.availableFrom.slice(0, 16) : "");
    setAvailableUntil(data.availableUntil ? data.availableUntil.slice(0, 16) : "");
    setLoading(false);
  }

  async function loadCourses() {
    const res = await fetch("/api/courses");
    if (res.ok) setCourses(await res.json());
  }

  // Question Pools v1 — see docs/question-pools-v1.md.
  async function loadPools() {
    const res = await fetch(`/api/exams/${id}/question-pools`);
    if (res.ok) setPools(await res.json());
  }

  async function handleCreatePool() {
    if (!newPoolName.trim()) return;
    setPoolsMessage(null);
    const res = await fetch(`/api/exams/${id}/question-pools`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newPoolName.trim(),
        drawCount: newPoolDrawCount ? Number(newPoolDrawCount) : null,
      }),
    });
    if (res.ok) {
      setNewPoolName("");
      setNewPoolDrawCount("");
      loadPools();
    } else {
      const body = await res.json().catch(() => null);
      setPoolsMessage(typeof body?.error === "string" ? body.error : "Could not create pool.");
    }
  }

  async function handleUpdatePoolDrawCount(poolId: string, drawCount: number | null) {
    await fetch(`/api/exams/${id}/question-pools/${poolId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drawCount }),
    });
    loadPools();
  }

  async function handleDeletePool(poolId: string) {
    await fetch(`/api/exams/${id}/question-pools/${poolId}`, { method: "DELETE" });
    loadPools();
    loadExam({ preserveSecureForm: true });
  }

  async function handleAssignQuestionPool(questionId: string, questionPoolId: string | null) {
    await fetch(`/api/exams/${id}/questions/${questionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionPoolId }),
    });
    loadExam({ preserveSecureForm: true });
    loadPools();
  }

  async function loadCourseStudents(selectedCourseId: string) {
    if (!selectedCourseId) {
      setCourseStudents([]);
      return;
    }
    const res = await fetch(`/api/courses/${selectedCourseId}`);
    if (!res.ok) {
      setCourseStudents([]);
      return;
    }
    const data: LecturerCourse = await res.json();
    setCourseStudents(
      (data.enrollments ?? []).filter((e) => e.role === "STUDENT").map((e) => e.user),
    );
  }

  async function saveSchedule() {
    setSavingSchedule(true);
    setScheduleMessage(null);
    const res = await fetch(`/api/exams/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        courseId: courseId || null,
        assignmentMode,
        selectedStudentIds: assignmentMode === "SELECTED_STUDENTS" ? selectedStudentIds : undefined,
        availableFrom: availableFrom ? new Date(availableFrom).toISOString() : null,
        availableUntil: availableUntil ? new Date(availableUntil).toISOString() : null,
      }),
    });
    setSavingSchedule(false);
    if (res.ok) {
      setScheduleMessage("Saved.");
      loadExam();
    } else {
      const body = await res.json().catch(() => null);
      setScheduleMessage(typeof body?.error === "string" ? body.error : "Failed to save.");
    }
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
    loadCourses();
    loadPools();
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadCourseStudents(courseId);
  }, [courseId]);

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

  function updateManualDraft(index: number, patch: Partial<ManualQuestionDraft>) {
    setManualDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }

  function updateManualDraftOption(index: number, optionIndex: number, value: string) {
    setManualDrafts((prev) =>
      prev.map((d, i) => {
        if (i !== index) return d;
        const options = [...d.options];
        options[optionIndex] = value;
        return { ...d, options };
      }),
    );
  }

  function addManualDraftCard() {
    setManualDrafts((prev) => [...prev, createEmptyManualDraft()]);
  }

  function removeManualDraftCard(index: number) {
    setManualDrafts((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  async function handleSaveManualQuestions() {
    setAddError(null);
    setAddSuccess(null);

    const errorsByIndex: Record<number, string[]> = {};
    manualDrafts.forEach((draft, i) => {
      const errors = validateManualDraft(draft);
      if (errors.length > 0) errorsByIndex[i] = errors;
    });
    setManualErrors(errorsByIndex);
    if (Object.keys(errorsByIndex).length > 0) return;

    setAdding(true);
    const res = await fetch(`/api/lecturer/exams/${id}/bulk-questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questions: manualDrafts }),
    });
    setAdding(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setAddError(typeof body?.error === "string" ? body.error : "Failed to add questions");
      return;
    }

    const body = await res.json();
    setAddSuccess(`${body.created} question${body.created === 1 ? "" : "s"} added.`);
    setManualDrafts([createEmptyManualDraft()]);
    setManualErrors({});
    await loadExam({ preserveSecureForm: true });
  }

  function handlePreviewBulkQuestions() {
    setBulkResult(null);
    setBulkError(null);
    setBulkPreview(parseBulkQuestionsText(bulkText));
    if (bulkBanks.length === 0) {
      fetch("/api/lecturer/question-banks")
        .then((res) => (res.ok ? res.json() : []))
        .then((banks) => setBulkBanks(Array.isArray(banks) ? banks : []))
        .catch(() => {});
    }
  }

  async function handleImportBulkQuestions() {
    if (!bulkPreview || bulkPreview.invalidCount > 0 || bulkPreview.rows.length === 0) return;
    setBulkImporting(true);
    setBulkError(null);
    setBulkResult(null);

    const res = await fetch(`/api/lecturer/exams/${id}/bulk-questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: bulkText,
        saveToBankId: bulkSaveToBankId || undefined,
      }),
    });

    setBulkImporting(false);

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (data?.rows) setBulkPreview({ rows: data.rows, validCount: 0, invalidCount: data.rows.length });
      setBulkError(typeof data?.error === "string" ? data.error : "Failed to import questions");
      return;
    }

    setBulkResult(data);
    setBulkText("");
    setBulkPreview(null);
    await loadExam({ preserveSecureForm: true });
  }

  async function handleDeleteQuestion(questionId: string) {
    await fetch(`/api/exams/${id}/questions/${questionId}`, { method: "DELETE" });
    await loadExam({ preserveSecureForm: true });
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
    setSecureSaveMessage(null);
    const res = await fetch(`/api/exams/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secureSettings: secureForm }),
    });
    setSavingSecure(false);
    if (res.ok) {
      setSecureSaveMessage("Safe exam settings saved.");
      await loadExam();
    } else {
      setSecureSaveMessage("Safe exam settings could not be saved. Please try again.");
    }
  }

  async function handleSetAccessCode() {
    if (!accessCodeInput.trim()) return;
    setSavingAccessCode(true);
    setAccessCodeMessage(null);
    const res = await fetch(`/api/exams/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessCode: accessCodeInput.trim() }),
    });
    setSavingAccessCode(false);
    if (res.ok) {
      setAccessCodeInput("");
      setAccessCodeMessage("Access code enabled.");
      await loadExam();
    } else {
      setAccessCodeMessage("Failed to set access code.");
    }
  }

  async function handleClearAccessCode() {
    setSavingAccessCode(true);
    setAccessCodeMessage(null);
    const res = await fetch(`/api/exams/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessCode: null }),
    });
    setSavingAccessCode(false);
    if (res.ok) {
      setAccessCodeMessage("Access code removed.");
      await loadExam();
    } else {
      setAccessCodeMessage("Failed to remove access code.");
    }
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

  async function handleReleaseMarks() {
    if (!exam) return;
    if (
      !confirm(
        "Students will be able to see their marks for this exam. This does not change the recorded marks.",
      )
    ) {
      return;
    }

    setSavingMarksRelease(true);
    setMarksReleaseMessage(null);
    const res = await fetch(`/api/lecturer/exams/${id}/marks-release`, { method: "POST" });
    setSavingMarksRelease(false);

    if (!res.ok) {
      setMarksReleaseMessage("Failed to release marks.");
      return;
    }
    setMarksReleaseMessage("Marks released to students.");
    await loadExam();
  }

  async function handleHideMarks() {
    setSavingMarksRelease(true);
    setMarksReleaseMessage(null);
    const res = await fetch(`/api/lecturer/exams/${id}/marks-release`, { method: "DELETE" });
    setSavingMarksRelease(false);

    if (!res.ok) {
      setMarksReleaseMessage("Failed to hide marks.");
      return;
    }
    setMarksReleaseMessage("Marks hidden from students.");
    await loadExam();
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
    await loadExam({ preserveSecureForm: true });
  }

  if (loading) return <p className="text-gray-500">Loading...</p>;
  if (!exam) {
    return (
      <div className="mx-auto max-w-lg">
        <p className="text-red-600">{loadError ?? "Exam not found"}</p>
        {loadError && (
          <button
            onClick={() => loadExam()}
            className="mt-2 rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            Try again
          </button>
        )}
      </div>
    );
  }

  const hasUnsavedSecureChanges =
    secureForm != null && secureSettingsChanged(exam.secureSettings, secureForm);
  const safeModeStatus = safeExamModeStatusLabel(exam.secureSettings);
  const activeSafeModeControls = activeSafeExamControlLabels(exam.secureSettings);

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
            href={`/lecturer/exams/${id}/similarity`}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            Similarity review
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
      <div className="mt-4 rounded border border-gray-200 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">
              {exam.marksReleasedAt ? "Marks released" : "Marks not released"}
            </p>
            <p className="text-sm text-gray-500">
              {exam.marksReleasedAt
                ? `Released ${new Date(exam.marksReleasedAt).toLocaleString()}`
                : "Students cannot see scores or feedback until marks are released."}
            </p>
          </div>
          {exam.marksReleasedAt ? (
            <button
              type="button"
              onClick={handleHideMarks}
              disabled={savingMarksRelease}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {savingMarksRelease ? "Saving..." : "Hide marks from students"}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleReleaseMarks}
              disabled={savingMarksRelease}
              className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {savingMarksRelease ? "Saving..." : "Release marks to students"}
            </button>
          )}
        </div>
        {marksReleaseMessage && (
          <p className="mt-2 text-sm text-gray-600">{marksReleaseMessage}</p>
        )}
      </div>
      {markEssaysMessage && <p className="mt-2 text-sm text-gray-600">{markEssaysMessage}</p>}

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded border border-gray-200 p-3">
          <p className="text-xs uppercase text-gray-500">Safe Exam Mode</p>
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

      {/* Exam Design Policy v1 — see docs/exam-design-policy-v1.md. Kept
          compact and separate from the full secure-settings form below —
          this section is about WHAT resources are permitted, not the
          technical enforcement controls. */}
      <h2 className="mt-8 text-lg font-medium">Exam conditions and permitted resources</h2>
      {secureForm && (
        <div className="mt-3 space-y-4 rounded border border-gray-200 p-4">
          <div>
            <p className="text-sm font-medium">Exam format</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {EXAM_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    if (mode === secureForm.examMode) return;
                    if (mode === "CUSTOM") {
                      setSecureForm({ ...secureForm, examMode: "CUSTOM" });
                      setPendingPreset(null);
                      return;
                    }
                    // Closed-book/Open-book propose a preset — never
                    // applied until the lecturer explicitly confirms it.
                    setPendingPreset(mode);
                  }}
                  className={`rounded px-3 py-1.5 text-sm ${
                    secureForm.examMode === mode
                      ? "bg-black text-white"
                      : "border border-gray-300 text-gray-700"
                  }`}
                >
                  {EXAM_MODE_LABELS[mode]}
                </button>
              ))}
            </div>
            {secureForm.examMode === "CLOSED_BOOK" && (
              <p className="mt-2 text-xs text-gray-500">
                Students must complete the assessment without unauthorised external resources.
                Stronger secure-exam controls are recommended.
              </p>
            )}
            {secureForm.examMode === "OPEN_BOOK" && (
              <p className="mt-2 text-xs text-gray-500">
                Students may use only the resources explicitly permitted below. Answer
                originality and application remain subject to review.
              </p>
            )}
          </div>

          {pendingPreset && (
            <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm">
              <p className="font-medium text-amber-900">
                Apply the {EXAM_MODE_LABELS[pendingPreset]} preset?
              </p>
              <p className="mt-1 text-xs text-amber-800">
                {getExamModePreset(pendingPreset)?.description}
              </p>
              <ul className="mt-2 list-disc pl-5 text-xs text-amber-800">
                <li>Calculator: {getExamModePreset(pendingPreset)?.resources.calculatorAllowed ? "allowed" : "not allowed"}</li>
                <li>Notes: {getExamModePreset(pendingPreset)?.resources.notesAllowed ? "allowed" : "not allowed"}</li>
                <li>Internet: {getExamModePreset(pendingPreset)?.resources.internetAllowed ? "allowed" : "not allowed"}</li>
                <li>AI tools: {getExamModePreset(pendingPreset)?.resources.aiToolsAllowed ? "allowed" : "not allowed"}</li>
              </ul>
              <p className="mt-2 text-xs text-amber-800">
                You can change any of these afterwards — applying a preset never locks the
                settings.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const preset = getExamModePreset(pendingPreset);
                    if (preset) {
                      setSecureForm({
                        ...secureForm,
                        examMode: pendingPreset,
                        ...preset.resources,
                        ...preset.recommendedSecureControls,
                      });
                    }
                    setPendingPreset(null);
                  }}
                  className="rounded bg-black px-3 py-1.5 text-xs text-white"
                >
                  Apply preset
                </button>
                <button
                  type="button"
                  onClick={() => setPendingPreset(null)}
                  className="rounded border border-gray-300 px-3 py-1.5 text-xs"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div>
            <p className="text-sm font-medium">Permitted resources</p>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={secureForm.calculatorAllowed}
                  onChange={(e) => setSecureForm({ ...secureForm, calculatorAllowed: e.target.checked })}
                />
                Calculator
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={secureForm.notesAllowed}
                  onChange={(e) => setSecureForm({ ...secureForm, notesAllowed: e.target.checked })}
                />
                Notes
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={secureForm.internetAllowed}
                  onChange={(e) => setSecureForm({ ...secureForm, internetAllowed: e.target.checked })}
                />
                Internet
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={secureForm.aiToolsAllowed}
                  onChange={(e) => setSecureForm({ ...secureForm, aiToolsAllowed: e.target.checked })}
                />
                AI tools
              </label>
            </div>
            <p className="mt-2 text-xs text-gray-500">
              {secureForm.aiToolsAllowed
                ? "Students may use AI tools according to the assessment instructions. AI-use answer signals will not be treated as policy violations by themselves."
                : "AI-use review signals may be considered alongside other evidence, but they do not prove that AI was used."}
            </p>
          </div>

          {(() => {
            const warnings = validateExamPolicy(
              {
                examMode: secureForm.examMode,
                calculatorAllowed: secureForm.calculatorAllowed,
                notesAllowed: secureForm.notesAllowed,
                internetAllowed: secureForm.internetAllowed,
                aiToolsAllowed: secureForm.aiToolsAllowed,
              },
              secureForm,
            );
            return warnings.length > 0 ? (
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                <p className="font-medium">Policy warnings (advisory only)</p>
                <ul className="mt-1 list-disc pl-5">
                  {warnings.map((w) => (
                    <li key={w.code}>{w.message}</li>
                  ))}
                </ul>
              </div>
            ) : null;
          })()}

          {(() => {
            const summary = buildLecturerExamPolicySummary(
              {
                examMode: secureForm.examMode,
                calculatorAllowed: secureForm.calculatorAllowed,
                notesAllowed: secureForm.notesAllowed,
                internetAllowed: secureForm.internetAllowed,
                aiToolsAllowed: secureForm.aiToolsAllowed,
              },
              secureForm,
            );
            return (
              <div className="rounded border border-gray-200 bg-gray-50 p-3 text-xs">
                <p className="text-sm font-medium">{summary.examModeLabel}</p>
                {summary.allowed.length > 0 && (
                  <p className="mt-1">
                    <span className="font-medium">Allowed:</span> {summary.allowed.join(", ")}
                  </p>
                )}
                {summary.notAllowed.length > 0 && (
                  <p className="mt-0.5">
                    <span className="font-medium">Not allowed:</span> {summary.notAllowed.join(", ")}
                  </p>
                )}
                {summary.secureControls.length > 0 && (
                  <p className="mt-0.5">
                    <span className="font-medium">Secure controls:</span>{" "}
                    {summary.secureControls.join(", ")}
                  </p>
                )}
              </div>
            );
          })()}

          <button
            onClick={handleSaveSecureSettings}
            disabled={savingSecure}
            className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {savingSecure ? "Saving..." : "Save exam conditions"}
          </button>
        </div>
      )}

      <h2 className="mt-8 text-lg font-medium">Safe Exam Mode</h2>
      <p className="mt-1 text-sm text-gray-500">
        Safe Exam Mode records exam integrity signals for lecturer review. It does not
        automatically accuse students of misconduct.
      </p>
      {secureForm && (
        <div className="mt-3 space-y-3 rounded border border-gray-200 p-4">
          <div className="rounded border border-gray-200 bg-gray-50 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={
                  exam.secureSettings.secureModeEnabled
                    ? "rounded bg-green-100 px-2 py-0.5 text-sm font-medium text-green-700"
                    : "rounded bg-gray-200 px-2 py-0.5 text-sm font-medium text-gray-700"
                }
              >
                {safeModeStatus}
              </span>
              {hasUnsavedSecureChanges && (
                <span className="rounded bg-amber-100 px-2 py-0.5 text-sm text-amber-800">
                  Unsaved safe exam changes
                </span>
              )}
            </div>
            {activeSafeModeControls.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {activeSafeModeControls.map((label) => (
                  <span key={label} className="rounded bg-white px-2 py-0.5 text-xs text-gray-700">
                    {label}
                  </span>
                ))}
              </div>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={secureForm.secureModeEnabled}
              onChange={(e) => setSecureForm({ ...secureForm, secureModeEnabled: e.target.checked })}
            />
            Enable Safe Exam Mode
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

          <div className="border-t border-gray-200 pt-3">
            <h3 className="text-sm font-medium">Browser-level friction</h3>
            <p className="mt-1 text-xs text-gray-500">
              Browser-level friction makes casual attempts to leave or copy exam content harder
              and records integrity signals for lecturer review. A normal browser cannot fully
              lock the student&apos;s device or close other tabs. Full lockdown requires a
              dedicated lockdown browser.
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2 pl-1 text-sm text-gray-700">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={!secureForm.secureModeEnabled}
                  checked={secureForm.blockCopyPaste}
                  onChange={(e) => setSecureForm({ ...secureForm, blockCopyPaste: e.target.checked })}
                />
                Block copy, cut, and paste
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={!secureForm.secureModeEnabled}
                  checked={secureForm.blockRightClick}
                  onChange={(e) => setSecureForm({ ...secureForm, blockRightClick: e.target.checked })}
                />
                Block right-click/context menu
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={!secureForm.secureModeEnabled}
                  checked={secureForm.blockKeyboardShortcuts}
                  onChange={(e) =>
                    setSecureForm({ ...secureForm, blockKeyboardShortcuts: e.target.checked })
                  }
                />
                Block selected keyboard shortcuts where supported
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={!secureForm.secureModeEnabled}
                  checked={secureForm.disableQuestionTextSelection}
                  onChange={(e) =>
                    setSecureForm({ ...secureForm, disableQuestionTextSelection: e.target.checked })
                  }
                />
                Disable text selection on question content
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={!secureForm.secureModeEnabled}
                  checked={secureForm.enforceFullscreenReturn}
                  onChange={(e) =>
                    setSecureForm({ ...secureForm, enforceFullscreenReturn: e.target.checked })
                  }
                />
                Re-enforce fullscreen after exit
              </label>
            </div>
          </div>

          <div className="border-t border-gray-200 pt-3">
            <h3 className="text-sm font-medium">Camera monitoring</h3>
            <p className="mt-1 text-xs text-gray-500">
              Camera Monitoring v1 checks whether the student&apos;s camera is available during a
              secure exam. It records camera availability signals for lecturer review. It does not
              store video recordings or automatically decide misconduct.
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2 pl-1 text-sm text-gray-700">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={!secureForm.secureModeEnabled}
                  checked={secureForm.requireCamera}
                  onChange={(e) => setSecureForm({ ...secureForm, requireCamera: e.target.checked })}
                />
                Require camera before exam starts
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={!secureForm.secureModeEnabled}
                  checked={secureForm.showCameraPreview}
                  onChange={(e) =>
                    setSecureForm({ ...secureForm, showCameraPreview: e.target.checked })
                  }
                />
                Show camera preview to student
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={!secureForm.secureModeEnabled}
                  checked={secureForm.cameraHeartbeatEnabled}
                  onChange={(e) =>
                    setSecureForm({ ...secureForm, cameraHeartbeatEnabled: e.target.checked })
                  }
                />
                Enable camera heartbeat during exam
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={!secureForm.secureModeEnabled}
                  checked={secureForm.recordCameraUnavailableEvents}
                  onChange={(e) =>
                    setSecureForm({ ...secureForm, recordCameraUnavailableEvents: e.target.checked })
                  }
                />
                Record camera unavailable events
              </label>
            </div>
            <div className="mt-2 flex items-center gap-3 pl-1">
              <label className="text-sm text-gray-700">Camera check interval (seconds)</label>
              <input
                type="number"
                min={10}
                max={300}
                disabled={!secureForm.secureModeEnabled || !secureForm.cameraHeartbeatEnabled}
                value={secureForm.cameraHeartbeatIntervalSeconds}
                onChange={(e) =>
                  setSecureForm({
                    ...secureForm,
                    cameraHeartbeatIntervalSeconds: Number(e.target.value),
                  })
                }
                className="w-20 rounded border border-gray-300 px-2 py-1 text-sm"
              />
            </div>
          </div>

          <div>
            <h3 className="font-medium">Student verification and AI integrity checks</h3>
            <p className="mt-1 text-sm text-gray-500">
              This is not live proctoring. AI camera checks run locally on the student&apos;s
              device. Video is not recorded, streamed, or stored. Signals are indicators for
              lecturer review only.
            </p>
            <div className="mt-2 space-y-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={!secureForm.secureModeEnabled}
                  checked={secureForm.requireStudentVerification}
                  onChange={(e) =>
                    setSecureForm({ ...secureForm, requireStudentVerification: e.target.checked })
                  }
                />
                Require student verification before exam
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={!secureForm.secureModeEnabled}
                  checked={secureForm.enableAiCameraIntegrityChecks}
                  onChange={(e) =>
                    setSecureForm({
                      ...secureForm,
                      enableAiCameraIntegrityChecks: e.target.checked,
                      // Evidence capture has no effect without AI camera
                      // checks enabled — turn it off too rather than leave
                      // a silently-inert setting checked.
                      captureAiViolationEvidence: e.target.checked
                        ? secureForm.captureAiViolationEvidence
                        : false,
                    })
                  }
                />
                Enable AI-assisted camera integrity checks
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  disabled={!secureForm.secureModeEnabled || !secureForm.enableAiCameraIntegrityChecks}
                  checked={secureForm.captureAiViolationEvidence}
                  onChange={(e) =>
                    setSecureForm({ ...secureForm, captureAiViolationEvidence: e.target.checked })
                  }
                />
                <span>
                  Save evidence frame for phone or second-person warnings
                  <span className="mt-0.5 block text-xs font-normal text-gray-500">
                    When enabled, the system saves a single low-resolution camera frame only when
                    a possible phone or second person is detected. No video is recorded. Off by
                    default.
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div className="border-t border-gray-200 pt-3">
            <h3 className="text-sm font-medium">Exam watermark</h3>
            <p className="mt-1 text-xs text-gray-500">
              A low-friction deterrent, not an access control. It discourages screenshots, photos,
              sharing, and uploading exam content to AI tools, and adds traceability if content is
              shared — it does not guarantee AI tools will refuse to answer, and does not prevent
              copying on its own.
            </p>
            <label className="mt-2 flex items-start gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                className="mt-0.5"
                disabled={!secureForm.secureModeEnabled}
                checked={secureForm.enableExamWatermark}
                onChange={(e) => setSecureForm({ ...secureForm, enableExamWatermark: e.target.checked })}
              />
              <span>
                Show exam watermark
                <span className="mt-0.5 block text-xs font-normal text-gray-500">
                  Displays a low-opacity watermark with student and attempt details to discourage
                  copying, screenshots, sharing, and uploading exam content to AI tools.
                </span>
              </span>
            </label>
          </div>

          <div className="border-t border-gray-200 pt-3">
            <h3 className="text-sm font-medium">Question delivery</h3>
            <p className="mt-1 text-xs text-gray-500">
              Reduces exposure of the full exam paper. A low-friction control, not a guarantee —
              it does not make cheating impossible, and works alongside the other controls above.
            </p>
            <label className="mt-2 flex items-start gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                className="mt-0.5"
                disabled={!secureForm.secureModeEnabled}
                checked={secureForm.oneQuestionAtATime}
                onChange={(e) => setSecureForm({ ...secureForm, oneQuestionAtATime: e.target.checked })}
              />
              <span>
                Show one question at a time
                <span className="mt-0.5 block text-xs font-normal text-gray-500">
                  Students see one question at a time instead of the full exam paper.
                </span>
              </span>
            </label>
            <div className="mt-2 space-y-2 pl-6">
              <label className="flex items-start gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  disabled={!secureForm.secureModeEnabled || !secureForm.oneQuestionAtATime}
                  checked={secureForm.allowBackNavigation}
                  onChange={(e) =>
                    setSecureForm({ ...secureForm, allowBackNavigation: e.target.checked })
                  }
                />
                <span>
                  Allow students to go back to previous questions
                  <span className="mt-0.5 block text-xs font-normal text-gray-500">
                    If disabled, students cannot return to earlier questions after moving forward.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  disabled={!secureForm.secureModeEnabled || !secureForm.oneQuestionAtATime}
                  checked={secureForm.randomiseQuestionOrder}
                  onChange={(e) =>
                    setSecureForm({ ...secureForm, randomiseQuestionOrder: e.target.checked })
                  }
                />
                <span>
                  Randomise question order
                  <span className="mt-0.5 block text-xs font-normal text-gray-500">
                    Each student receives a stable question order for their attempt.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  disabled={!secureForm.secureModeEnabled || !secureForm.oneQuestionAtATime}
                  checked={secureForm.randomiseMcqOptionOrder}
                  onChange={(e) =>
                    setSecureForm({ ...secureForm, randomiseMcqOptionOrder: e.target.checked })
                  }
                />
                <span>
                  Randomise MCQ option order
                  <span className="mt-0.5 block text-xs font-normal text-gray-500">
                    Multiple-choice options are shown in a stable random order for each student
                    attempt.
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div className="border-t border-gray-200 pt-3">
            <h3 className="text-sm font-medium">Question pools</h3>
            <p className="mt-1 text-xs text-gray-500">
              Create a larger set of questions and draw a smaller random selection for each
              student attempt.
            </p>
            <label className="mt-2 flex items-start gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                className="mt-0.5"
                disabled={!secureForm.secureModeEnabled}
                checked={secureForm.enableQuestionPools}
                onChange={(e) =>
                  setSecureForm({
                    ...secureForm,
                    enableQuestionPools: e.target.checked,
                    // Turning pools off also turns off drawing — a
                    // silently-inert "drawing" setting with no pools UI
                    // visible would be confusing.
                    questionPoolSelectionMode: e.target.checked
                      ? secureForm.questionPoolSelectionMode
                      : "ALL_QUESTIONS",
                  })
                }
              />
              <span>Enable question pools</span>
            </label>
            <label className="mt-2 flex items-start gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                className="mt-0.5"
                disabled={!secureForm.secureModeEnabled || !secureForm.enableQuestionPools}
                checked={secureForm.questionPoolSelectionMode === "DRAW_FROM_POOLS"}
                onChange={(e) =>
                  setSecureForm({
                    ...secureForm,
                    questionPoolSelectionMode: e.target.checked ? "DRAW_FROM_POOLS" : "ALL_QUESTIONS",
                  })
                }
              />
              <span>
                Draw a random selection for each student attempt
                <span className="mt-0.5 block text-xs font-normal text-gray-500">
                  Each student receives a stable random selection from each pool. This is a
                  deterrent, not a guarantee that answer sharing is impossible.
                </span>
              </span>
            </label>
          </div>

          <button
            onClick={handleSaveSecureSettings}
            disabled={savingSecure}
            className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {savingSecure ? "Saving..." : "Save Safe Exam Mode settings"}
          </button>
          {secureSaveMessage && (
            <p className="text-sm text-gray-600">{secureSaveMessage}</p>
          )}
        </div>
      )}

      <h2 className="mt-8 text-lg font-medium">Course, assignment &amp; schedule</h2>
      <div className="mt-3 space-y-3 rounded border border-gray-200 p-4">
        <p className="text-sm text-gray-600">
          Assign this exam to a course, or leave it unassigned to keep it
          visible to the whole institution (legacy behaviour).
        </p>
        <div>
          <label className="text-sm font-medium">Course</label>
          <select
            className="mt-1 block w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
            value={courseId}
            onChange={(e) => setCourseId(e.target.value)}
          >
            <option value="">No course (institution-wide)</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
        </div>
        {courseId && (
          <div>
            <label className="text-sm font-medium">Assign to</label>
            <div className="mt-1 flex gap-4 text-sm">
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  checked={assignmentMode === "COURSE"}
                  onChange={() => setAssignmentMode("COURSE")}
                />
                Whole course
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  checked={assignmentMode === "SELECTED_STUDENTS"}
                  onChange={() => setAssignmentMode("SELECTED_STUDENTS")}
                />
                Selected students
              </label>
            </div>
          </div>
        )}
        {courseId && assignmentMode === "SELECTED_STUDENTS" && (
          <div>
            <label className="text-sm font-medium">Selected students</label>
            <div className="mt-1 max-h-40 overflow-y-auto rounded border border-gray-200 p-2">
              {courseStudents.length === 0 && (
                <p className="text-sm text-gray-500">No students enrolled in this course yet.</p>
              )}
              {courseStudents.map((s) => (
                <label key={s.id} className="flex items-center gap-2 py-0.5 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedStudentIds.includes(s.id)}
                    onChange={(e) =>
                      setSelectedStudentIds((prev) =>
                        e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id),
                      )
                    }
                  />
                  {s.name} — {s.email}
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium">Available from</label>
            <input
              type="datetime-local"
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
              value={availableFrom}
              onChange={(e) => setAvailableFrom(e.target.value)}
            />
          </div>
          <div>
            <label className="text-sm font-medium">Available until</label>
            <input
              type="datetime-local"
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
              value={availableUntil}
              onChange={(e) => setAvailableUntil(e.target.value)}
            />
          </div>
        </div>
        <button
          onClick={saveSchedule}
          disabled={savingSchedule}
          className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {savingSchedule ? "Saving..." : "Save course & schedule"}
        </button>
        {scheduleMessage && <p className="text-sm text-gray-600">{scheduleMessage}</p>}
      </div>

      <h2 className="mt-8 text-lg font-medium">Share exam link</h2>
      <div className="mt-3 space-y-3 rounded border border-gray-200 p-4">
        {!exam.published ? (
          <p className="text-sm text-amber-700">
            Publish this exam before sharing the link — unpublished exams cannot be accessed by
            students.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <input
                readOnly
                type="text"
                value={joinLinkUrl}
                className="flex-1 rounded border border-gray-300 bg-gray-50 px-3 py-1.5 text-sm"
                onFocus={(e) => e.target.select()}
              />
              <button
                onClick={handleCopyJoinLink}
                className="rounded border border-gray-300 px-3 py-1.5 text-sm"
              >
                {copiedJoinLink ? "Copied!" : "Copy link"}
              </button>
            </div>
            <p className="text-xs text-gray-500">
              Students must be logged in to access this link. If this exam requires an access
              code, students will still need to enter it after opening the link. This link does
              not grant access on its own — it only works for students who are already authorized
              to take this exam.
            </p>
            {courseId && (
              <p className="text-xs text-gray-500">
                {assignmentMode === "SELECTED_STUDENTS"
                  ? "Only students assigned to this exam will be able to access it via this link."
                  : `Only students enrolled in ${
                      courses.find((c) => c.id === courseId)?.name ?? "this course"
                    } will be able to access it via this link.`}
              </p>
            )}
          </>
        )}
      </div>

      <h2 className="mt-8 text-lg font-medium">Exam access code</h2>
      <div className="mt-3 space-y-3 rounded border border-gray-200 p-4">
        <p className="text-sm text-gray-600">
          Students must enter this code before starting the exam.
        </p>
        <p className="text-sm">
          Status:{" "}
          <span
            className={
              exam.accessCodeRequired
                ? "rounded bg-green-100 px-2 py-0.5 text-xs text-green-700"
                : "rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
            }
          >
            {exam.accessCodeRequired ? "Access code enabled" : "No access code"}
          </span>
        </p>
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label className="block text-sm font-medium">
              {exam.accessCodeRequired ? "New access code" : "Exam access code"}
            </label>
            <input
              type="text"
              minLength={4}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={accessCodeInput}
              onChange={(e) => setAccessCodeInput(e.target.value)}
              placeholder="e.g. ROOM-204"
            />
          </div>
          <button
            onClick={handleSetAccessCode}
            disabled={savingAccessCode || !accessCodeInput.trim()}
            className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {savingAccessCode ? "Saving..." : "Set access code"}
          </button>
          {exam.accessCodeRequired && (
            <button
              onClick={handleClearAccessCode}
              disabled={savingAccessCode}
              className="rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
            >
              Clear
            </button>
          )}
        </div>
        {accessCodeMessage && <p className="text-sm text-gray-600">{accessCodeMessage}</p>}
      </div>

      <h2 className="mt-8 text-lg font-medium">Export results</h2>
      <div className="mt-3 space-y-3 rounded border border-gray-200 p-4">
        <div>
          <p className="text-sm font-medium">Full marks report</p>
          <p className="text-xs text-gray-500">
            Every column: scores, integrity risk level, access code/camera settings, and notes.
            For lecturer/institution use.
          </p>
          <div className="mt-2 flex gap-2">
            <a
              href={`/api/lecturer/exams/${id}/export/marks-csv`}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm"
            >
              Export marks CSV
            </a>
            <a
              href={`/api/lecturer/exams/${id}/export/marks-xlsx`}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm"
            >
              Export marks Excel
            </a>
          </div>
        </div>
        <div>
          <p className="text-sm font-medium">Canvas/IRM marks upload export</p>
          <p className="text-xs text-gray-500">
            Marks-only — no integrity signals, no access code data. For uploading to Canvas or an
            institutional marks system.
          </p>
          <div className="mt-2 flex gap-2">
            <a
              href={`/api/lecturer/exams/${id}/export/upload-csv`}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm"
            >
              Export upload-ready CSV
            </a>
            <a
              href={`/api/lecturer/exams/${id}/export/upload-xlsx`}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm"
            >
              Export upload-ready Excel
            </a>
          </div>
        </div>
        <div>
          <p className="text-sm font-medium">PDF report</p>
          <p className="text-xs text-gray-500">
            A human-readable summary with marks table and integrity summary, suitable for
            printing or filing.
          </p>
          <div className="mt-2">
            <a
              href={`/api/lecturer/exams/${id}/export/report-pdf`}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm"
            >
              Export PDF report
            </a>
          </div>
        </div>
      </div>

      {secureForm?.enableQuestionPools && (
        <>
          <h2 className="mt-8 text-lg font-medium">Question pools</h2>
          <p className="mt-1 text-sm text-gray-500">
            Create a larger set of questions and draw a smaller random selection for each student
            attempt.
          </p>
          <div className="mt-3 space-y-2">
            {pools.length === 0 && <p className="text-gray-500">No pools yet.</p>}
            {pools.map((pool) => (
              <div key={pool.id} className="rounded border border-gray-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{pool.name}</p>
                    <p className="text-xs text-gray-500">{pool.questionCount} question(s) in pool</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-600">Draw this many questions from this pool</label>
                    <input
                      type="number"
                      min={0}
                      defaultValue={pool.drawCount ?? ""}
                      placeholder="all"
                      className="w-16 rounded border border-gray-300 px-2 py-1 text-sm"
                      onBlur={(e) =>
                        handleUpdatePoolDrawCount(
                          pool.id,
                          e.target.value === "" ? null : Number(e.target.value),
                        )
                      }
                    />
                    <button
                      onClick={() => handleDeletePool(pool.id)}
                      className="text-sm text-red-600 underline"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {pool.drawCount != null && pool.drawCount > pool.questionCount && (
                  <p className="mt-2 text-xs text-amber-700">
                    This pool has fewer questions than the draw count. Students will receive all
                    available questions from this pool.
                  </p>
                )}
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2 rounded border border-gray-200 p-3">
            <div>
              <label className="block text-xs text-gray-600">Pool name</label>
              <input
                value={newPoolName}
                onChange={(e) => setNewPoolName(e.target.value)}
                className="rounded border border-gray-300 px-2 py-1 text-sm"
                placeholder="e.g. Programming basics"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600">Draw this many questions from this pool</label>
              <input
                type="number"
                min={0}
                value={newPoolDrawCount}
                onChange={(e) => setNewPoolDrawCount(e.target.value)}
                className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
                placeholder="all"
              />
            </div>
            <button
              onClick={handleCreatePool}
              disabled={!newPoolName.trim()}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50"
            >
              Add pool
            </button>
          </div>
          {poolsMessage && <p className="mt-2 text-sm text-red-600">{poolsMessage}</p>}
        </>
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
                {secureForm?.enableQuestionPools && pools.length > 0 && (
                  <div className="mt-2">
                    <label className="text-xs text-gray-600">Question pool</label>
                    <select
                      className="ml-2 rounded border border-gray-300 px-2 py-1 text-xs"
                      value={q.questionPoolId ?? ""}
                      onChange={(e) => handleAssignQuestionPool(q.id, e.target.value || null)}
                    >
                      <option value="">No pool</option>
                      {pools.map((pool) => (
                        <option key={pool.id} value={pool.id}>
                          {pool.name}
                        </option>
                      ))}
                    </select>
                  </div>
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

      <h2 className="mt-8 text-lg font-medium">Add multiple questions</h2>
      <div className="mt-3 space-y-3 rounded border border-gray-200 p-4">
        <p className="text-sm text-gray-600">
          Paste one or more questions in the format below, then preview before importing. Nothing
          is saved until you click &quot;Import questions&quot;, and if any question has an error
          nothing is saved.
        </p>
        <details className="rounded border border-gray-200 p-2 text-sm">
          <summary className="cursor-pointer font-medium">Show accepted format</summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-gray-700">
            {BULK_QUESTION_FORMAT_EXAMPLE}
          </pre>
        </details>
        {exam.published && (
          <p className="text-sm text-amber-700">
            This exam is published — imported questions will be visible/available to students
            immediately.
          </p>
        )}
        <textarea
          rows={10}
          className="w-full rounded border border-gray-300 px-3 py-2 font-mono text-xs"
          placeholder="QUESTION:&#10;What is 2 + 2?&#10;TYPE: MCQ&#10;OPTIONS:&#10;A. 3&#10;B. 4&#10;ANSWER: B&#10;POINTS: 1"
          value={bulkText}
          onChange={(e) => {
            setBulkText(e.target.value);
            setBulkPreview(null);
            setBulkResult(null);
          }}
        />
        <button
          onClick={handlePreviewBulkQuestions}
          disabled={!bulkText.trim()}
          className="rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
        >
          Preview
        </button>

        {bulkPreview && (
          <div className="space-y-2">
            <p className="text-sm">
              {bulkPreview.validCount} valid, {bulkPreview.invalidCount} with errors (
              {bulkPreview.rows.length} total)
            </p>
            {bulkPreview.rows.map((row) => (
              <div
                key={row.row}
                className={`rounded border p-2 text-sm ${
                  row.errors.length > 0 ? "border-red-300 bg-red-50" : "border-gray-200"
                }`}
              >
                <p className="text-xs text-gray-500">
                  Question {row.row} {row.type ? `· ${row.type}` : ""} {row.points ? `· ${row.points} pt(s)` : ""}
                </p>
                <p className="mt-1">{row.text || <em className="text-gray-400">(no text)</em>}</p>
                {row.errors.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-red-700">
                    {row.errors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}

            {bulkBanks.length > 0 && (
              <div>
                <label className="block text-sm font-medium">
                  Also save to question bank (optional)
                </label>
                <select
                  className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  value={bulkSaveToBankId}
                  onChange={(e) => setBulkSaveToBankId(e.target.value)}
                >
                  <option value="">Don&apos;t save to a bank</option>
                  {bulkBanks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.title}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <button
              onClick={handleImportBulkQuestions}
              disabled={bulkImporting || bulkPreview.invalidCount > 0 || bulkPreview.rows.length === 0}
              className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {bulkImporting ? "Importing..." : `Import ${bulkPreview.validCount} question(s)`}
            </button>
          </div>
        )}

        {bulkError && <p className="text-sm text-red-600">{bulkError}</p>}
        {bulkResult && (
          <div className="text-sm text-green-700">
            <p>
              Imported {bulkResult.created} question(s)
              {bulkResult.bankSaved > 0 && ` and saved ${bulkResult.bankSaved} to the question bank`}.
            </p>
            {bulkResult.warning && <p className="text-amber-700">{bulkResult.warning}</p>}
          </div>
        )}
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

      <h2 className="mt-8 text-lg font-medium">Add questions</h2>
      <div className="mt-3 space-y-3">
        {manualDrafts.map((draft, index) => (
          <div key={index} className="rounded border border-gray-200 p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Question {index + 1}</p>
              {manualDrafts.length > 1 && (
                <button
                  onClick={() => removeManualDraftCard(index)}
                  className="text-xs text-red-600 underline"
                >
                  Remove
                </button>
              )}
            </div>
            <div className="mt-2 space-y-3">
              <div>
                <label className="block text-sm font-medium">Type</label>
                <select
                  className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
                  value={draft.type}
                  onChange={(e) =>
                    updateManualDraft(index, { type: e.target.value as ManualQuestionDraft["type"] })
                  }
                >
                  <option value="MULTIPLE_CHOICE">Multiple choice</option>
                  <option value="SHORT_ANSWER">Short answer</option>
                  <option value="ESSAY">Essay</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium">Question text</label>
                <textarea
                  className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
                  value={draft.text}
                  onChange={(e) => updateManualDraft(index, { text: e.target.value })}
                />
              </div>
              {draft.type === "MULTIPLE_CHOICE" && (
                <div>
                  <label className="block text-sm font-medium">Options</label>
                  <div className="mt-1 space-y-2">
                    {draft.options.map((opt, optIndex) => (
                      <input
                        key={optIndex}
                        placeholder={`Option ${String.fromCharCode(65 + optIndex)}`}
                        className="w-full rounded border border-gray-300 px-3 py-2"
                        value={opt}
                        onChange={(e) => updateManualDraftOption(index, optIndex, e.target.value)}
                      />
                    ))}
                  </div>
                  <label className="mt-2 block text-sm font-medium">Correct answer</label>
                  <input
                    placeholder="Must match one of the options above"
                    className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
                    value={draft.correctAnswer}
                    onChange={(e) => updateManualDraft(index, { correctAnswer: e.target.value })}
                  />
                </div>
              )}
              {draft.type === "SHORT_ANSWER" && (
                <div>
                  <label className="block text-sm font-medium">Correct answer (optional)</label>
                  <input
                    className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
                    value={draft.correctAnswer}
                    onChange={(e) => updateManualDraft(index, { correctAnswer: e.target.value })}
                  />
                </div>
              )}
              <div className="w-32">
                <label className="block text-sm font-medium">Points</label>
                <input
                  type="number"
                  min={1}
                  className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
                  value={draft.points}
                  onChange={(e) => updateManualDraft(index, { points: Number(e.target.value) })}
                />
              </div>
              {manualErrors[index] && manualErrors[index].length > 0 && (
                <ul className="list-disc pl-5 text-sm text-red-600">
                  {manualErrors[index].map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ))}

        <button
          onClick={addManualDraftCard}
          className="rounded border border-gray-300 px-4 py-2 text-sm"
        >
          + Add another question
        </button>

        <div className="pt-2">
          <button
            onClick={handleSaveManualQuestions}
            disabled={adding}
            className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            {adding ? "Saving..." : "Save all questions"}
          </button>
        </div>

        {addError && <p className="text-sm text-red-600">{addError}</p>}
        {addSuccess && <p className="text-sm text-green-700">{addSuccess}</p>}
      </div>

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
