"use client";

import { useEffect, useState, useRef, use as usePromise } from "react";
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
import {
  resolveDisplayRequirementUiState,
  resolveDeliveryModeForSingleDisplayRequired,
  isDisplayPolicySaveBlocked,
  isDisplayPolicyCombinationValid,
} from "@/lib/secureClientPolicy";
import {
  ASSESSMENT_TYPES,
  ASSESSMENT_TYPE_LABELS,
  applyMandatoryFinalExaminationPolicy,
  type AssessmentType,
} from "@/lib/assessmentType";
import {
  lecturerAvailabilityStatus,
  type LecturerAvailabilityStatus,
} from "@/lib/lecturerDashboardGrouping";
import {
  resolveEffectiveExamDurationMins,
  type ExamTimeAccommodationMode,
} from "@/lib/examTimeAccommodation";
import { MetricCard } from "@/components/lecturer/MetricCard";
import { QuestionBankIcon, SubmissionsIcon, IntegrityIcon, ReportsIcon } from "@/components/lecturer/icons";
import { ExamActionsMenu } from "@/components/lecturer/ExamActionsMenu";

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
  // Mandatory Tether Delivery for Final Examinations — see
  // src/lib/assessmentType.ts.
  assessmentType: AssessmentType;
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
  // Question Navigator v1 — see docs/question-navigator-v1.md.
  showQuestionNavigator: boolean;
  allowQuestionJumping: boolean;
  allowFlagForReview: boolean;
  // Controlled AI Brainstorming Assistance v1 — see
  // docs/controlled-ai-brainstorming-assistance-v1.md.
  aiAssistanceMode: "DISABLED" | "BRAINSTORM_ONLY";
  aiAssistanceMaxPromptsPerQuestion: number;
  aiAssistanceMaxPromptsPerAttempt: number;
  aiAssistanceMaxResponseCharacters: number;
  aiAssistanceAllowConceptExplanations: boolean;
  aiAssistanceAllowAnswerPlanning: boolean;
  aiAssistanceAllowReasoningFeedback: boolean;
  aiAssistanceAllowProgrammingConceptHelp: boolean;
  // Screen-share Evidence Mode v1 — see docs/screen-share-evidence-v1.md.
  screenShareMode: "OFF" | "REQUIRED";
  screenShareCaptureEvidence: boolean;
  screenShareEvidenceIntervalSeconds: number;
  screenShareMaxEvidenceFrames: number;
  // Answer-Development Provenance v1 — see
  // docs/answer-development-provenance-v1.md.
  answerProvenanceMode: "OFF" | "BASIC" | "DETAILED";
  answerVersionIntervalSeconds: number;
  answerVersionMinimumCharacterChange: number;
  answerVersionMaximumPerQuestion: number;
  capturePasteMetadata: boolean;
  captureDeletionRewriteMetadata: boolean;
  enableOutlineWorkspace: boolean;
  enableCalculationWorkspace: boolean;
  enableCodeWorkspace: boolean;
  captureCodeRunHistory: boolean;
  requireAiSourceDeclaration: boolean;
  allowStudentDevelopmentReview: boolean;
  // Tether Secure Client Foundation + Safe Exam Browser Compatibility v1
  // — see docs/secure-client-foundation-seb-v1.md.
  deliveryMode: "STANDARD_WEB" | "MONITORED_WEB" | "SEB_OPTIONAL" | "SEB_REQUIRED" | "TETHER_CLIENT_OPTIONAL" | "TETHER_CLIENT_REQUIRED";
  requireSebBrowserExamKey: boolean;
  requireSebConfigKey: boolean;
  requireDisplayCheck: boolean;
  secureClientMaximumDisplays: number;
  // Single Display Requirement v1 — see docs/secure-client-foundation-seb-v1.md,
  // "Display requirement". The one lecturer-facing control for
  // additional/mirrored/extended display restriction.
  displayPolicy: "UNRESTRICTED" | "SINGLE_DISPLAY_REQUIRED";
  secureClientLecturerOverrideAllowed: boolean;
};

// Tether Secure Client Foundation + Safe Exam Browser Compatibility v1 —
// hardening pass. Booleans only, computed server-side from
// VERCEL_ENV/feature flags/institution allowlist — see
// src/lib/secureClientAvailability.ts. Never something this page decides
// on its own.
type SecureClientAvailability = {
  tetherClientOptionalAvailable: boolean;
  tetherClientRequiredAvailable: boolean;
  sebOptionalAvailable: boolean;
  sebRequiredAvailable: boolean;
};

/** Lecturer-facing label for a delivery mode — the single source of truth for this page's radio-card titles, so the auto-switch notice below always names the mode using the exact same label the lecturer sees on the radio itself. */
function deliveryModeLabel(mode: SecureSettings["deliveryMode"]): string {
  switch (mode) {
    case "STANDARD_WEB":
      return "Standard web";
    case "MONITORED_WEB":
      return "Monitored web";
    case "TETHER_CLIENT_REQUIRED":
      return "Tether Secure Browser — required";
    case "TETHER_CLIENT_OPTIONAL":
      return "Tether Secure Browser — optional";
    case "SEB_REQUIRED":
      return "Safe Exam Browser — required";
    case "SEB_OPTIONAL":
      return "Safe Exam Browser — optional";
  }
}

type Exam = {
  id: string;
  title: string;
  description: string | null;
  durationMins: number;
  published: boolean;
  questions: Question[];
  secureSettings: SecureSettings;
  secureClientAvailability: SecureClientAvailability;
  accessCodeRequired: boolean;
  courseId: string | null;
  assignmentMode: "COURSE" | "SELECTED_STUDENTS" | "STANDALONE";
  availableFrom: string | null;
  availableUntil: string | null;
  marksReleasedAt: string | null;
  marksReleasedById: string | null;
  // Standalone Exam Link v1 — see docs/standalone-exam-link-v1.md.
  standaloneInviteEnabled: boolean;
  // Exam Archive Lifecycle v1 — see docs/exam-archive-lifecycle-v1.md.
  archivedAt: string | null;
};

type LecturerCourse = {
  id: string;
  name: string;
  code: string;
  enrollments?: { id: string; role: "STUDENT" | "LECTURER"; user: { id: string; name: string; email: string } }[];
};

// Individual Exam Timing & Accommodations v1 — see
// src/lib/examTimeAccommodation.ts and
// docs/exam-time-accommodations-v1.md.
type TimeAccommodation = {
  id: string;
  studentId: string;
  name: string;
  email: string;
  institutionStudentId: string | null;
  adjustmentMode: ExamTimeAccommodationMode;
  adjustmentValue: number;
  effectiveDurationMins: number;
  hasInProgressAttempt: boolean;
};

type EligibleStudent = { id: string; name: string; email: string; institutionStudentId: string | null };

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

// Exam Workspace UI v1 (Pass 1 — shell/navigation only). Purely a
// presentation grouping of sections that already exist further down this
// same file — no new routes, no new API calls, nothing removed.
type WorkspaceTab = "overview" | "security" | "questions" | "delivery" | "integrations";

const WORKSPACE_TABS: { id: WorkspaceTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "security", label: "Security" },
  { id: "questions", label: "Questions" },
  { id: "delivery", label: "Access & delivery" },
  { id: "integrations", label: "Integrations" },
];

function countLabel(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

const AVAILABILITY_PILL_STYLES: Record<LecturerAvailabilityStatus, string> = {
  Open: "bg-[#ECFDF3] text-[#067647]",
  Scheduled: "bg-[#EFF6FF] text-lecturer-accent-hover",
  Draft: "bg-[#F2F4F7] text-lecturer-text-secondary",
  Closed: "bg-[#F2F4F7] text-lecturer-text-secondary",
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

  // Exam Workspace UI v1 (Pass 1) — which workspace tab is showing. All
  // tab panels stay mounted (see `hidden` below) so switching tabs never
  // resets any of the form state further down this component.
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("overview");

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
  // Single Display Requirement v1 availability-gating fix — transient
  // notice shown when enabling "Single display required" auto-switches
  // deliveryMode (see resolveDeliveryModeForSingleDisplayRequired).
  // Cleared on any further deliveryMode/displayPolicy edit so it never
  // lingers describing a switch that no longer reflects the draft.
  const [displayPolicyAutoSwitchNotice, setDisplayPolicyAutoSwitchNotice] = useState<string | null>(null);
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

  // Standalone Exam Link v1 — see docs/standalone-exam-link-v1.md. `audience`
  // is a view-only 3-way selector (derived from exam.assignmentMode/courseId
  // on load) that decides which of the three sub-panels below is shown; it
  // never itself switches the exam's server-side mode. Only clicking
  // "Generate link" actually flips assignmentMode to STANDALONE (via POST
  // .../standalone-invite), and only "Save course & schedule" with the
  // Course/Institution-wide panel showing flips it back — exactly mirroring
  // the two existing, already-authoritative server actions.
  const [audience, setAudience] = useState<"INSTITUTION" | "COURSE" | "STANDALONE">("INSTITUTION");
  // The plaintext invitation link is only ever known for the lifetime of
  // this page load, right after a Generate/Regenerate call — never
  // refetchable afterwards (the server only stores a hash). null after a
  // reload even if exam.standaloneInviteEnabled is true.
  const [standaloneInviteUrl, setStandaloneInviteUrl] = useState<string | null>(null);
  const [generatingInvite, setGeneratingInvite] = useState(false);
  const [disablingInvite, setDisablingInvite] = useState(false);
  const [inviteMessage, setInviteMessage] = useState<string | null>(null);
  const [copiedInviteLink, setCopiedInviteLink] = useState(false);

  // Individual Exam Timing & Accommodations v1 — see
  // src/lib/examTimeAccommodation.ts and
  // docs/exam-time-accommodations-v1.md.
  const [durationInput, setDurationInput] = useState("");
  const durationInitialized = useRef(false);
  const [savingDuration, setSavingDuration] = useState(false);
  const [durationMessage, setDurationMessage] = useState<string | null>(null);
  const [accommodations, setAccommodations] = useState<TimeAccommodation[]>([]);
  const [eligibleStudents, setEligibleStudents] = useState<EligibleStudent[]>([]);
  const [accommodationsLoaded, setAccommodationsLoaded] = useState(false);
  const [showAccommodationForm, setShowAccommodationForm] = useState(false);
  const [editingAccommodationStudentId, setEditingAccommodationStudentId] = useState<string | null>(null);
  const [accommodationStudentId, setAccommodationStudentId] = useState("");
  const [accommodationMode, setAccommodationMode] = useState<ExamTimeAccommodationMode>("PERCENT_EXTRA");
  const [accommodationValue, setAccommodationValue] = useState("25");
  const [savingAccommodation, setSavingAccommodation] = useState(false);
  const [accommodationFormError, setAccommodationFormError] = useState<string | null>(null);
  const [accommodationsMessage, setAccommodationsMessage] = useState<string | null>(null);

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
    // assignmentMode here drives only the Course sub-panel's Whole
    // course/Selected students radios — STANDALONE is tracked separately
    // via `audience` below, never assigned into this state (its type
    // deliberately excludes STANDALONE).
    setAssignmentMode(data.assignmentMode === "SELECTED_STUDENTS" ? "SELECTED_STUDENTS" : "COURSE");
    setAudience(data.assignmentMode === "STANDALONE" ? "STANDALONE" : data.courseId ? "COURSE" : "INSTITUTION");
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

  // Individual Exam Timing & Accommodations v1 — see
  // src/lib/examTimeAccommodation.ts.
  async function loadTimeAccommodations() {
    const res = await fetch(`/api/exams/${id}/time-accommodations`);
    if (res.ok) {
      const data = await res.json();
      setAccommodations(data.accommodations);
      setEligibleStudents(data.eligibleStudents);
    }
    setAccommodationsLoaded(true);
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
    // Standalone Exam Link v1 — see docs/standalone-exam-link-v1.md. When
    // the Standalone panel is showing, this button only ever touches the
    // schedule window — courseId/assignmentMode are deliberately omitted
    // from the request so a stray click here can never downgrade a
    // STANDALONE exam back to COURSE/institution-wide (that only ever
    // happens by explicitly choosing the Institution-wide or Course
    // audience option and saving from there).
    const body: Record<string, unknown> = {
      availableFrom: availableFrom ? new Date(availableFrom).toISOString() : null,
      availableUntil: availableUntil ? new Date(availableUntil).toISOString() : null,
    };
    if (audience !== "STANDALONE") {
      body.courseId = audience === "COURSE" ? courseId || null : null;
      body.assignmentMode = audience === "COURSE" ? assignmentMode : "COURSE";
      if (audience === "COURSE" && assignmentMode === "SELECTED_STUDENTS") {
        body.selectedStudentIds = selectedStudentIds;
      }
    }
    const res = await fetch(`/api/exams/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

  // Standalone Exam Link v1 — see docs/standalone-exam-link-v1.md. POST
  // is used for both first-generate and regenerate — every call issues a
  // brand-new token and atomically switches the exam to STANDALONE
  // (clearing courseId server-side). The returned plaintext is shown
  // exactly once, here — it is never requested or stored again after
  // this response.
  async function handleGenerateInvite() {
    setGeneratingInvite(true);
    setInviteMessage(null);
    const res = await fetch(`/api/exams/${id}/standalone-invite`, { method: "POST" });
    setGeneratingInvite(false);
    if (!res.ok) {
      setInviteMessage("Failed to generate invitation link.");
      return;
    }
    const data: { inviteUrl: string } = await res.json();
    setStandaloneInviteUrl(
      typeof window !== "undefined" ? `${window.location.origin}${data.inviteUrl}` : data.inviteUrl,
    );
    setAudience("STANDALONE");
    loadExam();
  }

  async function handleCopyInviteLink() {
    if (!standaloneInviteUrl) return;
    try {
      await navigator.clipboard.writeText(standaloneInviteUrl);
      setCopiedInviteLink(true);
      setTimeout(() => setCopiedInviteLink(false), 2000);
    } catch {
      // Clipboard access can fail (permissions, non-secure context) —
      // the link is still visible and selectable in the input above.
    }
  }

  async function handleDisableInvite() {
    setDisablingInvite(true);
    setInviteMessage(null);
    const res = await fetch(`/api/exams/${id}/standalone-invite`, { method: "DELETE" });
    setDisablingInvite(false);
    if (!res.ok) {
      setInviteMessage("Failed to disable invitation link.");
      return;
    }
    setStandaloneInviteUrl(null);
    setInviteMessage("Disabled — this link no longer grants new access. Students who already accepted keep their access.");
    loadExam();
  }

  // Individual Exam Timing & Accommodations v1 — see
  // src/lib/examTimeAccommodation.ts and
  // docs/exam-time-accommodations-v1.md. Reuses the EXISTING
  // PATCH /api/exams/[id] endpoint — no new endpoint just for duration.
  // Never alters an already-started attempt: see
  // resolveSubmissionTimingPolicy in src/lib/assessmentLifecycle.ts.
  async function handleSaveDuration() {
    const parsed = Number(durationInput);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      setDurationMessage("Duration must be a positive whole number of minutes.");
      return;
    }
    setSavingDuration(true);
    setDurationMessage(null);
    const res = await fetch(`/api/exams/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ durationMins: parsed }),
    });
    setSavingDuration(false);
    if (res.ok) {
      setDurationMessage("Standard duration saved. Existing attempts keep the duration they started with — this applies to new attempts only.");
      await loadExam({ preserveSecureForm: true });
      // Re-fetch accommodations so every row's effectiveDurationMins is
      // recalculated server-side (by the same pure resolver) against the
      // newly saved standard duration — the "Standard time" column above
      // already updates via loadExam, but the "Effective time" column
      // comes from this separate response and would otherwise go stale.
      // Never recomputed client-side — the server/pure resolver remains
      // the single source of truth.
      await loadTimeAccommodations();
    } else {
      const body = await res.json().catch(() => null);
      setDurationMessage(typeof body?.error === "string" ? body.error : "Failed to save duration.");
    }
  }

  function handleOpenAddAccommodation() {
    setEditingAccommodationStudentId(null);
    setAccommodationStudentId("");
    setAccommodationMode("PERCENT_EXTRA");
    setAccommodationValue("25");
    setAccommodationFormError(null);
    setShowAccommodationForm(true);
  }

  function handleOpenEditAccommodation(accommodation: TimeAccommodation) {
    setEditingAccommodationStudentId(accommodation.studentId);
    setAccommodationStudentId(accommodation.studentId);
    setAccommodationMode(accommodation.adjustmentMode);
    setAccommodationValue(String(accommodation.adjustmentValue));
    setAccommodationFormError(null);
    setShowAccommodationForm(true);
  }

  function handleCancelAccommodationForm() {
    setShowAccommodationForm(false);
    setEditingAccommodationStudentId(null);
    setAccommodationFormError(null);
  }

  async function handleSaveAccommodation() {
    if (!accommodationStudentId) {
      setAccommodationFormError("Choose a student.");
      return;
    }
    const value = Number(accommodationValue);
    if (!Number.isInteger(value) || value <= 0) {
      setAccommodationFormError("Enter a positive whole number.");
      return;
    }
    setSavingAccommodation(true);
    setAccommodationFormError(null);
    const res = await fetch(`/api/exams/${id}/time-accommodations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentId: accommodationStudentId,
        adjustmentMode: accommodationMode,
        adjustmentValue: value,
      }),
    });
    setSavingAccommodation(false);
    if (res.ok) {
      setShowAccommodationForm(false);
      setEditingAccommodationStudentId(null);
      setAccommodationsMessage("Accommodation saved.");
      await loadTimeAccommodations();
    } else {
      const body = await res.json().catch(() => null);
      setAccommodationFormError(typeof body?.error === "string" ? body.error : "Failed to save accommodation.");
    }
  }

  async function handleRemoveAccommodation(accommodation: TimeAccommodation) {
    if (!confirm(`Remove ${accommodation.name}'s time accommodation? Their next attempt will use the standard exam duration.`)) return;
    setAccommodationsMessage(null);
    const res = await fetch(`/api/exams/${id}/time-accommodations/${accommodation.id}`, { method: "DELETE" });
    if (res.ok) {
      setAccommodationsMessage("Accommodation removed.");
      await loadTimeAccommodations();
    } else {
      setAccommodationsMessage("Failed to remove accommodation.");
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
    loadTimeAccommodations();
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
    if (exam && !durationInitialized.current) {
      durationInitialized.current = true;
      setDurationInput(String(exam.durationMins));
    }
  }, [exam]);

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
    if (!secureForm || !exam) return;
    // Single Display Requirement v1 — prefer preventing the invalid
    // combination client-side rather than only relying on the server's
    // 400 (which still applies regardless — see PATCH /api/exams/[id]).
    // isDisplayPolicySaveBlocked also blocks the availability-gating case
    // this fix adds: a previously-valid SEB_REQUIRED/SEB_OPTIONAL +
    // SINGLE_DISPLAY_REQUIRED combination whose SEB availability has
    // since been withdrawn — even if the disabled radio were bypassed via
    // manipulated client state, this check still blocks the save.
    if (
      isDisplayPolicySaveBlocked({
        deliveryMode: secureForm.deliveryMode,
        displayPolicy: secureForm.displayPolicy,
        sebOptionalAvailable: exam.secureClientAvailability.sebOptionalAvailable,
        sebRequiredAvailable: exam.secureClientAvailability.sebRequiredAvailable,
        tetherClientRequiredAvailable: exam.secureClientAvailability.tetherClientRequiredAvailable,
        tetherClientOptionalAvailable: exam.secureClientAvailability.tetherClientOptionalAvailable,
      })
    ) {
      setSecureSaveMessage(
        secureForm.deliveryMode !== "SEB_REQUIRED" && secureForm.deliveryMode !== "SEB_OPTIONAL"
          ? "Single display required needs Safe Exam Browser delivery — choose a Safe Exam Browser delivery mode or remove the display requirement."
          : "Single display required cannot be saved because Safe Exam Browser is not currently enabled for this institution or environment.",
      );
      return;
    }
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
      const body = await res.json().catch(() => null);
      setSecureSaveMessage(typeof body?.error === "string" ? body.error : "Safe exam settings could not be saved. Please try again.");
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

  if (loading) return <p className="text-lecturer-text-secondary">Loading...</p>;
  if (!exam) {
    return (
      <div className="mx-auto max-w-lg">
        <p className="text-[#B42318]">{loadError ?? "Exam not found"}</p>
        {loadError && (
          <button
            onClick={() => loadExam()}
            className="mt-2 rounded border border-lecturer-border px-3 py-1.5 text-sm"
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
  // Single Display Requirement v1 availability-gating fix — the SAME
  // authoritative availability result already used to disable the
  // SEB_OPTIONAL/SEB_REQUIRED delivery-mode radios above, reused here so
  // the "Single display required" control can never invite a lecturer
  // into a state the server will reject (see
  // src/lib/secureClientPolicy.ts, resolveDisplayRequirementUiState).
  // storedDisplayPolicy comes from exam.secureSettings (the persisted
  // value), not secureForm (the lecturer's unsaved draft), so this
  // correctly distinguishes "SEB unavailable, nothing at stake" from
  // "SEB unavailable, but SINGLE_DISPLAY_REQUIRED is already saved".
  const displayRequirementUiState = resolveDisplayRequirementUiState({
    storedDisplayPolicy: exam.secureSettings.displayPolicy,
    sebOptionalAvailable: exam.secureClientAvailability.sebOptionalAvailable,
    sebRequiredAvailable: exam.secureClientAvailability.sebRequiredAvailable,
    tetherClientRequiredAvailable: exam.secureClientAvailability.tetherClientRequiredAvailable,
    tetherClientOptionalAvailable: exam.secureClientAvailability.tetherClientOptionalAvailable,
  });

  // Mandatory Tether Delivery for Final Examinations — see
  // src/lib/assessmentType.ts. Drives the locked/auto-selected Exam
  // delivery and Display requirement controls below: once Final
  // examination is chosen, Tether Secure Browser required + Single
  // display required are not really independent choices any more, they
  // follow automatically and cannot be downgraded through this form.
  const isFinalExamLocked = secureForm?.assessmentType === "FINAL_EXAMINATION";

  // Exam Workspace UI v1 (Pass 1) — derived purely from data already
  // loaded on this page. lecturerAvailabilityStatus is the SAME
  // Draft/Scheduled/Open/Closed classification the Lecturer Dashboard
  // already uses, so the workspace header never invents new lifecycle
  // vocabulary.
  const workspaceAvailabilityStatus = lecturerAvailabilityStatus({
    published: exam.published,
    availableFrom: exam.availableFrom,
    availableUntil: exam.availableUntil,
    needsReviewCount: unresolvedHighRisk ?? 0,
  });
  const workspaceCourse = exam.courseId ? courses.find((c) => c.id === exam.courseId) : undefined;
  // Standalone Exam Link v1 — see docs/standalone-exam-link-v1.md.
  const workspaceAudienceLabel =
    exam.assignmentMode === "STANDALONE"
      ? "Standalone exam link"
      : workspaceCourse
        ? `${workspaceCourse.code} — ${workspaceCourse.name}`
        : "No course assigned";
  const workspaceAvailabilityLine = (() => {
    if (workspaceAvailabilityStatus === "Draft") {
      return "Not published — students cannot access this exam yet.";
    }
    if (workspaceAvailabilityStatus === "Scheduled") {
      return exam.availableFrom ? `Opens ${new Date(exam.availableFrom).toLocaleString()}.` : "Scheduled.";
    }
    if (workspaceAvailabilityStatus === "Closed") {
      return exam.availableUntil
        ? `Closed — was available until ${new Date(exam.availableUntil).toLocaleString()}.`
        : "Closed.";
    }
    return exam.availableUntil
      ? `Open now — closes ${new Date(exam.availableUntil).toLocaleString()}.`
      : "Open now — no closing date set.";
  })();

  return (
    <div className="mx-auto max-w-none">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold text-lecturer-text-primary sm:text-3xl">{exam.title}</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-lecturer-text-secondary">
            <span>{workspaceAudienceLabel}</span>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${AVAILABILITY_PILL_STYLES[workspaceAvailabilityStatus]}`}
            >
              {workspaceAvailabilityStatus}
            </span>
          </p>
          <p className="mt-1 text-sm text-lecturer-text-secondary">{workspaceAvailabilityLine}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!exam.archivedAt && exam.questions.some((q) => q.type === "ESSAY") && hasUngradedSubmissions && (
            <button
              onClick={handleMarkEssays}
              disabled={markingEssays}
              className="flex items-center gap-2 rounded-lg border border-lecturer-border bg-lecturer-surface px-4 py-2 text-sm font-medium text-lecturer-text-primary hover:bg-lecturer-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent focus-visible:ring-offset-2 disabled:opacity-50"
            >
              {markingEssays && (
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-lecturer-text-muted border-t-transparent" />
              )}
              {markingEssays ? "Marking..." : "Mark essays with AI"}
            </button>
          )}
          {!exam.archivedAt && (
            <button
              onClick={togglePublish}
              className={
                exam.published
                  ? "rounded-lg border border-lecturer-border bg-lecturer-surface px-4 py-2 text-sm font-medium text-lecturer-text-primary hover:bg-lecturer-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent focus-visible:ring-offset-2"
                  : "rounded-lg bg-lecturer-accent px-4 py-2 text-sm font-semibold text-white hover:bg-lecturer-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent focus-visible:ring-offset-2"
              }
            >
              {exam.published ? "Unpublish" : "Publish"}
            </button>
          )}
          <ExamActionsMenu
            examId={exam.id}
            examTitle={exam.title}
            archived={Boolean(exam.archivedAt)}
            deletable={!exam.published && (submissionCounts?.total ?? 0) === 0}
            href={`/lecturer/exams/${exam.id}`}
            onChanged={loadExam}
          />
        </div>
      </div>
      {markEssaysMessage && <p className="mt-2 text-sm text-lecturer-text-secondary">{markEssaysMessage}</p>}

      {exam.archivedAt && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-lecturer-border bg-lecturer-border-subtle/60 p-4">
          <div>
            <p className="text-sm font-semibold text-lecturer-text-primary">Archived exam</p>
            <p className="mt-0.5 text-sm text-lecturer-text-secondary">Restore this exam to make changes.</p>
          </div>
          <ExamActionsMenu
            examId={exam.id}
            examTitle={exam.title}
            archived
            deletable={false}
            href={`/lecturer/exams/${exam.id}`}
            onChanged={loadExam}
          />
        </div>
      )}

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Questions" value={exam.questions.length} icon={<QuestionBankIcon className="h-[18px] w-[18px]" />} />
        <MetricCard label="Submissions" value={submissionCounts ? submissionCounts.total : "—"} accent="info" icon={<SubmissionsIcon className="h-[18px] w-[18px]" />} />
        <MetricCard
          label="Needs review"
          value={unresolvedHighRisk != null ? unresolvedHighRisk : "—"}
          accent={unresolvedHighRisk ? "warning" : "neutral"}
          icon={<IntegrityIcon className="h-[18px] w-[18px]" />}
        />
        <MetricCard label="Duration" value={`${exam.durationMins} min`} icon={<ReportsIcon className="h-[18px] w-[18px]" />} />
      </div>

      <div
        role="tablist"
        aria-label="Exam workspace sections"
        className="mt-6 flex gap-1 overflow-x-auto border-b border-lecturer-border"
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
          e.preventDefault();
          const currentIndex = WORKSPACE_TABS.findIndex((t) => t.id === activeTab);
          let nextIndex = currentIndex;
          if (e.key === "ArrowRight") nextIndex = (currentIndex + 1) % WORKSPACE_TABS.length;
          if (e.key === "ArrowLeft") nextIndex = (currentIndex - 1 + WORKSPACE_TABS.length) % WORKSPACE_TABS.length;
          if (e.key === "Home") nextIndex = 0;
          if (e.key === "End") nextIndex = WORKSPACE_TABS.length - 1;
          const nextTab = WORKSPACE_TABS[nextIndex];
          setActiveTab(nextTab.id);
          document.getElementById(`workspace-tab-${nextTab.id}`)?.focus();
        }}
      >
        {WORKSPACE_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`workspace-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`workspace-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent ${
              activeTab === tab.id
                ? "border-lecturer-accent text-lecturer-accent"
                : "border-transparent text-lecturer-text-secondary hover:text-lecturer-text-primary"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        id="workspace-panel-overview"
        role="tabpanel"
        aria-labelledby="workspace-tab-overview"
        hidden={activeTab !== "overview"}
        className="mt-6"
      >
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <section className="rounded-xl border border-lecturer-border bg-lecturer-surface p-5">
              <h2 className="text-base font-semibold text-lecturer-text-primary">Exam status</h2>
              <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <dt className="text-xs font-medium text-lecturer-text-secondary">Lifecycle</dt>
                  <dd className="mt-1 text-sm font-medium text-lecturer-text-primary">
                    {exam.published ? "Published" : "Draft"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-lecturer-text-secondary">Safe Exam Mode</dt>
                  <dd className="mt-1 text-sm font-medium text-lecturer-text-primary">{safeModeStatus}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-lecturer-text-secondary">Pending grading</dt>
                  <dd className="mt-1 text-sm font-medium text-lecturer-text-primary">
                    {submissionCounts ? submissionCounts.submitted : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-lecturer-text-secondary">Marks released</dt>
                  <dd className="mt-1 text-sm font-medium text-lecturer-text-primary">
                    {exam.marksReleasedAt ? "Yes" : "No"}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="rounded-xl border border-lecturer-border bg-lecturer-surface p-5">
              <h2 className="text-base font-semibold text-lecturer-text-primary">Availability</h2>
              <p className="mt-2 text-sm text-lecturer-text-secondary">{workspaceAvailabilityLine}</p>
              <p className="mt-1 text-sm text-lecturer-text-secondary">
                {workspaceCourse
                  ? `Assigned to ${workspaceCourse.code} — ${workspaceCourse.name}.`
                  : "Not assigned to a course — visible institution-wide."}
              </p>
              <p className="mt-3 text-xs text-lecturer-text-muted">
                To change dates, course assignment, or the access code, use the Access &amp; delivery tab.
              </p>
            </section>

            <section className="rounded-xl border border-lecturer-border bg-lecturer-surface p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-lecturer-text-primary">
                    {exam.marksReleasedAt ? "Marks released" : "Marks not released"}
                  </h2>
                  <p className="mt-1 text-sm text-lecturer-text-secondary">
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
                    className="rounded-lg border border-lecturer-border bg-lecturer-surface px-4 py-2 text-sm font-medium text-lecturer-text-primary hover:bg-lecturer-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent disabled:opacity-50"
                  >
                    {savingMarksRelease ? "Saving..." : "Hide marks from students"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleReleaseMarks}
                    disabled={savingMarksRelease}
                    className="rounded-lg bg-lecturer-accent px-4 py-2 text-sm font-semibold text-white hover:bg-lecturer-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent disabled:opacity-50"
                  >
                    {savingMarksRelease ? "Saving..." : "Release marks to students"}
                  </button>
                )}
              </div>
              {marksReleaseMessage && <p className="mt-2 text-sm text-lecturer-text-secondary">{marksReleaseMessage}</p>}
            </section>
          </div>

          <div className="space-y-6">
            <section className="rounded-xl border border-lecturer-border bg-lecturer-surface p-5">
              <h2 className="text-base font-semibold text-lecturer-text-primary">Needs attention</h2>
              {unresolvedHighRisk ? (
                <Link
                  href={`/lecturer/exams/${id}/integrity`}
                  className="mt-3 block rounded-lg border border-[#FEDF89] bg-[#FFFAEB] p-3 text-sm text-[#92400E] hover:border-[#D97706] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                >
                  {countLabel(unresolvedHighRisk, "unresolved high-risk integrity signal")} — review now →
                </Link>
              ) : (
                <p className="mt-3 text-sm text-lecturer-text-secondary">Nothing needs your attention right now.</p>
              )}
              {hasUngradedSubmissions && (
                <p className="mt-2 text-sm text-lecturer-text-secondary">There are ungraded submissions waiting for review.</p>
              )}
            </section>

            <section className="rounded-xl border border-lecturer-border bg-lecturer-surface p-5">
              <h2 className="text-base font-semibold text-lecturer-text-primary">Quick actions</h2>
              <div className="mt-3 space-y-1">
                <Link
                  href={`/lecturer/exams/${id}/submissions`}
                  className="block rounded-lg px-3 py-2 text-sm font-medium text-lecturer-text-primary hover:bg-lecturer-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                >
                  Submissions
                </Link>
                <Link
                  href={`/lecturer/exams/${id}/analytics`}
                  className="block rounded-lg px-3 py-2 text-sm font-medium text-lecturer-text-primary hover:bg-lecturer-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                >
                  View analytics
                </Link>
                <Link
                  href={`/lecturer/exams/${id}/integrity`}
                  className="block rounded-lg px-3 py-2 text-sm font-medium text-lecturer-text-primary hover:bg-lecturer-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                >
                  Review integrity events
                </Link>
                <Link
                  href={`/lecturer/exams/${id}/similarity`}
                  className="block rounded-lg px-3 py-2 text-sm font-medium text-lecturer-text-primary hover:bg-lecturer-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                >
                  Similarity review
                </Link>
                <Link
                  href={`/lecturer/exams/${id}/collusion-analysis`}
                  className="block rounded-lg px-3 py-2 text-sm font-medium text-lecturer-text-primary hover:bg-lecturer-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                >
                  Cohort integrity analysis
                </Link>
                <Link
                  href={`/lecturer/exams/${id}/import-questions`}
                  className="block rounded-lg px-3 py-2 text-sm font-medium text-lecturer-text-primary hover:bg-lecturer-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                >
                  Import from question bank
                </Link>
              </div>
            </section>
          </div>
        </div>
      </div>

      <div
        id="workspace-panel-security"
        role="tabpanel"
        aria-labelledby="workspace-tab-security"
        hidden={activeTab !== "security"}
        className="mt-6"
      >

      {/* Exam Design Policy v1 — see docs/exam-design-policy-v1.md. Kept
          compact and separate from the full secure-settings form below —
          this section is about WHAT resources are permitted, not the
          technical enforcement controls. */}
      <h2 className="mt-8 text-lg font-semibold text-lecturer-text-primary">Exam conditions and permitted resources</h2>
      {secureForm && (
        <div className="mt-3 space-y-4 rounded border border-lecturer-border bg-lecturer-surface p-4">
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
                      ? "bg-lecturer-accent hover:bg-lecturer-accent-hover text-white"
                      : "border border-lecturer-border text-lecturer-text-primary"
                  }`}
                >
                  {EXAM_MODE_LABELS[mode]}
                </button>
              ))}
            </div>
            {secureForm.examMode === "CLOSED_BOOK" && (
              <p className="mt-2 text-xs text-lecturer-text-secondary">
                Students must complete the assessment without unauthorised external resources.
                Stronger secure-exam controls are recommended.
              </p>
            )}
            {secureForm.examMode === "OPEN_BOOK" && (
              <p className="mt-2 text-xs text-lecturer-text-secondary">
                Students may use only the resources explicitly permitted below. Answer
                originality and application remain subject to review.
              </p>
            )}
          </div>

          {pendingPreset && (
            <div className="rounded border border-amber-200 bg-[#FFFAEB] p-3 text-sm">
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
                <li>External AI tools: {getExamModePreset(pendingPreset)?.resources.aiToolsAllowed ? "allowed" : "not allowed"}</li>
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
                  className="rounded bg-lecturer-accent hover:bg-lecturer-accent-hover px-3 py-1.5 text-xs text-white"
                >
                  Apply preset
                </button>
                <button
                  type="button"
                  onClick={() => setPendingPreset(null)}
                  className="rounded border border-lecturer-border px-3 py-1.5 text-xs"
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
                External AI tools
              </label>
            </div>
            <p className="mt-2 text-xs text-lecturer-text-secondary">
              Set whether the assessment permits AI tools outside Tether Controlled AI (below). This is a
              policy statement, not a technical block — Tether does not prevent a student from opening an
              external AI tool in another window.
            </p>
            <p className="mt-1 text-xs text-lecturer-text-secondary">
              {secureForm.aiToolsAllowed
                ? "Students may use external AI tools according to the assessment instructions. AI-use answer signals will not be treated as policy violations by themselves."
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
              <div className="rounded border border-amber-200 bg-[#FFFAEB] p-3 text-xs text-amber-800">
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
              <div className="rounded border border-lecturer-border bg-lecturer-border-subtle p-3 text-xs">
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
            className="rounded bg-lecturer-accent hover:bg-lecturer-accent-hover px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {savingSecure ? "Saving..." : "Save exam conditions"}
          </button>
        </div>
      )}

      <h2 className="mt-8 text-lg font-semibold text-lecturer-text-primary">Safe Exam Mode</h2>
      <p className="mt-1 text-sm text-lecturer-text-secondary">
        Safe Exam Mode records exam integrity signals for lecturer review. It does not
        automatically accuse students of misconduct.
      </p>
      {secureForm && (
        <div className="mt-3 space-y-3 rounded border border-lecturer-border bg-lecturer-surface p-4">
          <div className="rounded border border-lecturer-border bg-lecturer-border-subtle p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={
                  exam.secureSettings.secureModeEnabled
                    ? "rounded bg-green-100 px-2 py-0.5 text-sm font-medium text-green-700"
                    : "rounded bg-gray-200 px-2 py-0.5 text-sm font-medium text-lecturer-text-primary"
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
                  <span key={label} className="rounded bg-lecturer-surface px-2 py-0.5 text-xs text-lecturer-text-primary">
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

          <div className="grid grid-cols-2 gap-2 pl-1 text-sm text-lecturer-text-primary">
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
            <label className="text-sm text-lecturer-text-primary">Maximum attempts</label>
            <input
              type="number"
              min={1}
              max={1}
              disabled={!secureForm.secureModeEnabled}
              value={secureForm.maxAttempts}
              onChange={(e) => setSecureForm({ ...secureForm, maxAttempts: Number(e.target.value) })}
              className="w-20 rounded border border-lecturer-border px-2 py-1 text-sm"
            />
            <span className="text-xs text-gray-400">(v1 supports 1 attempt only)</span>
          </div>

          <div className="border-t border-lecturer-border pt-3">
            <h3 className="text-sm font-medium">Browser-level friction</h3>
            <p className="mt-1 text-xs text-lecturer-text-secondary">
              Browser-level friction makes casual attempts to leave or copy exam content harder
              and records integrity signals for lecturer review. A normal browser cannot fully
              lock the student&apos;s device or close other tabs. Full lockdown requires a
              dedicated lockdown browser.
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2 pl-1 text-sm text-lecturer-text-primary">
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

          <div className="border-t border-lecturer-border pt-3">
            <h3 className="text-sm font-medium">Camera monitoring</h3>
            <p className="mt-1 text-xs text-lecturer-text-secondary">
              Camera Monitoring v1 checks whether the student&apos;s camera is available during a
              secure exam. It records camera availability signals for lecturer review. It does not
              store video recordings or automatically decide misconduct.
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2 pl-1 text-sm text-lecturer-text-primary">
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
              <label className="text-sm text-lecturer-text-primary">Camera check interval (seconds)</label>
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
                className="w-20 rounded border border-lecturer-border px-2 py-1 text-sm"
              />
            </div>
          </div>

          <div>
            <h3 className="font-medium">Student verification and AI integrity checks</h3>
            <p className="mt-1 text-sm text-lecturer-text-secondary">
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
                  <span className="mt-0.5 block text-xs font-normal text-lecturer-text-secondary">
                    When enabled, the system saves a single low-resolution camera frame only when
                    a possible phone or second person is detected. No video is recorded. Off by
                    default.
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div className="border-t border-lecturer-border pt-3">
            <h3 className="text-sm font-medium">Exam watermark</h3>
            <p className="mt-1 text-xs text-lecturer-text-secondary">
              A low-friction deterrent, not an access control. It discourages screenshots, photos,
              sharing, and uploading exam content to AI tools, and adds traceability if content is
              shared — it does not guarantee AI tools will refuse to answer, and does not prevent
              copying on its own.
            </p>
            <label className="mt-2 flex items-start gap-2 text-sm text-lecturer-text-primary">
              <input
                type="checkbox"
                className="mt-0.5"
                disabled={!secureForm.secureModeEnabled}
                checked={secureForm.enableExamWatermark}
                onChange={(e) => setSecureForm({ ...secureForm, enableExamWatermark: e.target.checked })}
              />
              <span>
                Show exam watermark
                <span className="mt-0.5 block text-xs font-normal text-lecturer-text-secondary">
                  Displays a low-opacity watermark with student and attempt details to discourage
                  copying, screenshots, sharing, and uploading exam content to AI tools.
                </span>
              </span>
            </label>
          </div>

          <div className="border-t border-lecturer-border pt-3">
            <h3 className="text-sm font-medium">Question delivery</h3>
            <p className="mt-1 text-xs text-lecturer-text-secondary">
              Reduces exposure of the full exam paper. A low-friction control, not a guarantee —
              it does not make cheating impossible, and works alongside the other controls above.
            </p>
            <label className="mt-2 flex items-start gap-2 text-sm text-lecturer-text-primary">
              <input
                type="checkbox"
                className="mt-0.5"
                disabled={!secureForm.secureModeEnabled}
                checked={secureForm.oneQuestionAtATime}
                onChange={(e) => setSecureForm({ ...secureForm, oneQuestionAtATime: e.target.checked })}
              />
              <span>
                Show one question at a time
                <span className="mt-0.5 block text-xs font-normal text-lecturer-text-secondary">
                  Students see one question at a time instead of the full exam paper.
                </span>
              </span>
            </label>
            <div className="mt-2 space-y-2 pl-6">
              <label className="flex items-start gap-2 text-sm text-lecturer-text-primary">
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
                  <span className="mt-0.5 block text-xs font-normal text-lecturer-text-secondary">
                    If disabled, students cannot return to earlier questions after moving forward.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm text-lecturer-text-primary">
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
                  <span className="mt-0.5 block text-xs font-normal text-lecturer-text-secondary">
                    Each student receives a stable question order for their attempt.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm text-lecturer-text-primary">
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
                  <span className="mt-0.5 block text-xs font-normal text-lecturer-text-secondary">
                    Multiple-choice options are shown in a stable random order for each student
                    attempt.
                  </span>
                </span>
              </label>
            </div>
          </div>

          {/* Question Navigator v1 — see docs/question-navigator-v1.md. */}
          <div className="border-t border-lecturer-border pt-3">
            <h3 className="text-sm font-medium">Question navigator</h3>
            <label className="mt-2 flex items-start gap-2 text-sm text-lecturer-text-primary">
              <input
                type="checkbox"
                className="mt-0.5"
                disabled={!secureForm.secureModeEnabled}
                checked={secureForm.showQuestionNavigator}
                onChange={(e) => setSecureForm({ ...secureForm, showQuestionNavigator: e.target.checked })}
              />
              <span>
                Show question navigator
                <span className="mt-0.5 block text-xs font-normal text-lecturer-text-secondary">
                  Show students a numbered question grid with answered, skipped and flagged
                  states.
                </span>
              </span>
            </label>
            <div className="mt-2 space-y-2 pl-6">
              <label className="flex items-start gap-2 text-sm text-lecturer-text-primary">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  disabled={!secureForm.secureModeEnabled}
                  checked={secureForm.allowQuestionJumping}
                  onChange={(e) => setSecureForm({ ...secureForm, allowQuestionJumping: e.target.checked })}
                />
                <span>
                  Allow students to jump between questions
                  <span className="mt-0.5 block text-xs font-normal text-lecturer-text-secondary">
                    Students may select a future question directly. Returning to earlier
                    questions still depends on the back-navigation setting.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm text-lecturer-text-primary">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  disabled={!secureForm.secureModeEnabled}
                  checked={secureForm.allowFlagForReview}
                  onChange={(e) => setSecureForm({ ...secureForm, allowFlagForReview: e.target.checked })}
                />
                <span>
                  Allow students to flag questions for review
                  <span className="mt-0.5 block text-xs font-normal text-lecturer-text-secondary">
                    Students may mark questions to revisit before submitting.
                  </span>
                </span>
              </label>
            </div>

            {secureForm.showQuestionNavigator && (
              <div className="mt-3 rounded border border-lecturer-border bg-lecturer-border-subtle p-3 text-xs text-lecturer-text-primary">
                <p className="font-medium">Question navigator: Shown</p>
                <p>Direct jumping: {secureForm.allowQuestionJumping ? "Allowed" : "Not allowed"}</p>
                <p>Back navigation: {secureForm.allowBackNavigation ? "Allowed" : "Not allowed"}</p>
                <p>Flag for review: {secureForm.allowFlagForReview ? "Allowed" : "Not allowed"}</p>
              </div>
            )}

            {secureForm.showQuestionNavigator && !secureForm.allowQuestionJumping && (
              <p className="mt-2 rounded border border-amber-200 bg-[#FFFAEB] p-2 text-xs text-amber-800">
                The navigator will show progress, but students must use the existing Next and
                Previous controls.
              </p>
            )}
            {secureForm.allowQuestionJumping && !secureForm.allowBackNavigation && (
              <p className="mt-2 rounded border border-amber-200 bg-[#FFFAEB] p-2 text-xs text-amber-800">
                Students may skip forward, but they cannot return to earlier questions.
              </p>
            )}
            {secureForm.allowFlagForReview && !secureForm.allowBackNavigation && (
              <p className="mt-2 rounded border border-amber-200 bg-[#FFFAEB] p-2 text-xs text-amber-800">
                Students may flag earlier questions, but they may not be able to reopen them
                after moving forward.
              </p>
            )}
          </div>

          {/* Controlled AI Brainstorming Assistance v1 — see
              docs/controlled-ai-brainstorming-assistance-v1.md. This is an
              ALLOWED assessment resource, not a secure-mode control — kept
              enabled/disabled independently of secureModeEnabled, and
              deliberately never coupled to aiToolsAllowed above (separate,
              independently-stored settings — see the "Permitted resources"
              section). Commercial polish pass — product-facing name is
              "Tether Controlled AI"; the underlying values
              (DISABLED/BRAINSTORM_ONLY) and every limit/capability field
              are unchanged. */}
          <div className="border-t border-lecturer-border pt-3">
            <h3 className="text-sm font-medium">Tether Controlled AI</h3>
            <p className="mt-1 text-xs text-lecturer-text-secondary">
              Allow students to use Tether&apos;s restricted assistant for question clarification,
              planning and reasoning support. It does not provide final answers. Student prompts
              and responses are retained for lecturer review.
            </p>
            <div className="mt-2 flex gap-4">
              <label className="flex items-center gap-2 text-sm text-lecturer-text-primary">
                <input
                  type="radio"
                  name="aiAssistanceMode"
                  checked={secureForm.aiAssistanceMode === "DISABLED"}
                  onChange={() => setSecureForm({ ...secureForm, aiAssistanceMode: "DISABLED" })}
                />
                Off
              </label>
              <label className="flex items-center gap-2 text-sm text-lecturer-text-primary">
                <input
                  type="radio"
                  name="aiAssistanceMode"
                  checked={secureForm.aiAssistanceMode === "BRAINSTORM_ONLY"}
                  onChange={() => setSecureForm({ ...secureForm, aiAssistanceMode: "BRAINSTORM_ONLY" })}
                />
                Controlled guidance
              </label>
            </div>

            {secureForm.aiAssistanceMode === "BRAINSTORM_ONLY" && (
              <div className="mt-3 space-y-3">
                <div className="rounded border border-lecturer-border bg-lecturer-border-subtle p-3 text-xs text-lecturer-text-primary">
                  <p className="font-medium">Controlled guidance enabled</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    <li>Up to {secureForm.aiAssistanceMaxPromptsPerQuestion} request(s) per question</li>
                    <li>Up to {secureForm.aiAssistanceMaxPromptsPerAttempt} request(s) per attempt</li>
                    <li>Responses limited to {secureForm.aiAssistanceMaxResponseCharacters} characters</li>
                    <li>Prompts and responses retained for review</li>
                  </ul>
                </div>

                <details className="rounded border border-lecturer-border">
                  <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-lecturer-text-primary">
                    Advanced Controlled AI settings
                  </summary>
                  <div className="space-y-3 border-t border-lecturer-border p-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <label className="text-xs text-lecturer-text-primary">
                        Max prompts per question
                        <input
                          type="number"
                          min={1}
                          max={20}
                          className="mt-1 w-full rounded border border-lecturer-border px-2 py-1 text-sm"
                          value={secureForm.aiAssistanceMaxPromptsPerQuestion}
                          onChange={(e) =>
                            setSecureForm({
                              ...secureForm,
                              aiAssistanceMaxPromptsPerQuestion: Math.max(1, Number(e.target.value) || 1),
                            })
                          }
                        />
                      </label>
                      <label className="text-xs text-lecturer-text-primary">
                        Max prompts per attempt
                        <input
                          type="number"
                          min={1}
                          max={100}
                          className="mt-1 w-full rounded border border-lecturer-border px-2 py-1 text-sm"
                          value={secureForm.aiAssistanceMaxPromptsPerAttempt}
                          onChange={(e) =>
                            setSecureForm({
                              ...secureForm,
                              aiAssistanceMaxPromptsPerAttempt: Math.max(1, Number(e.target.value) || 1),
                            })
                          }
                        />
                      </label>
                      <label className="text-xs text-lecturer-text-primary">
                        Max response length (characters)
                        <input
                          type="number"
                          min={200}
                          max={4000}
                          step={100}
                          className="mt-1 w-full rounded border border-lecturer-border px-2 py-1 text-sm"
                          value={secureForm.aiAssistanceMaxResponseCharacters}
                          onChange={(e) =>
                            setSecureForm({
                              ...secureForm,
                              aiAssistanceMaxResponseCharacters: Math.max(200, Number(e.target.value) || 200),
                            })
                          }
                        />
                      </label>
                    </div>

                    <div className="space-y-2">
                      <label className="flex items-start gap-2 text-sm text-lecturer-text-primary">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={secureForm.aiAssistanceAllowConceptExplanations}
                          onChange={(e) =>
                            setSecureForm({ ...secureForm, aiAssistanceAllowConceptExplanations: e.target.checked })
                          }
                        />
                        <span>Allow concept explanations</span>
                      </label>
                      <label className="flex items-start gap-2 text-sm text-lecturer-text-primary">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={secureForm.aiAssistanceAllowAnswerPlanning}
                          onChange={(e) =>
                            setSecureForm({ ...secureForm, aiAssistanceAllowAnswerPlanning: e.target.checked })
                          }
                        />
                        <span>Allow answer planning (structuring an approach, not the wording)</span>
                      </label>
                      <label className="flex items-start gap-2 text-sm text-lecturer-text-primary">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={secureForm.aiAssistanceAllowReasoningFeedback}
                          onChange={(e) =>
                            setSecureForm({ ...secureForm, aiAssistanceAllowReasoningFeedback: e.target.checked })
                          }
                        />
                        <span>Allow feedback on the student&apos;s own reasoning</span>
                      </label>
                      <label className="flex items-start gap-2 text-sm text-lecturer-text-primary">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={secureForm.aiAssistanceAllowProgrammingConceptHelp}
                          onChange={(e) =>
                            setSecureForm({ ...secureForm, aiAssistanceAllowProgrammingConceptHelp: e.target.checked })
                          }
                        />
                        <span>Allow programming-concept assistance (no complete code)</span>
                      </label>
                    </div>

                    <p className="text-xs text-lecturer-text-secondary">
                      It is restricted from providing the correct answer, correct MCQ option, marking
                      rubric, or a submission-ready response — see
                      docs/controlled-ai-brainstorming-assistance-v1.md.
                    </p>
                  </div>
                </details>
              </div>
            )}
          </div>

          {/* Screen-share Evidence Mode v1 — see
              docs/screen-share-evidence-v1.md. An INTEGRITY-REVIEW
              feature, not an automatic cheating detector — kept
              independent of secureModeEnabled, same as AI Brainstorming
              Assistance above. */}
          <div className="border-t border-lecturer-border pt-3">
            <h3 className="text-sm font-medium">Screen-share evidence</h3>
            <label className="mt-2 flex items-start gap-2 text-sm text-lecturer-text-primary">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={secureForm.screenShareMode === "REQUIRED"}
                onChange={(e) =>
                  setSecureForm({
                    ...secureForm,
                    screenShareMode: e.target.checked ? "REQUIRED" : "OFF",
                    screenShareCaptureEvidence: e.target.checked ? secureForm.screenShareCaptureEvidence : false,
                  })
                }
              />
              <span>
                Require students to share their entire screen
                <span className="mt-0.5 block text-xs font-normal text-lecturer-text-secondary">
                  Students must share their entire display while completing this exam. Tether
                  records sharing interruptions and may save limited evidence frames for lecturer
                  review.
                </span>
              </span>
            </label>

            {secureForm.screenShareMode === "REQUIRED" && (
              <div className="mt-3 space-y-3 pl-6">
                <label className="flex items-start gap-2 text-sm text-lecturer-text-primary">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={secureForm.screenShareCaptureEvidence}
                    onChange={(e) => setSecureForm({ ...secureForm, screenShareCaptureEvidence: e.target.checked })}
                  />
                  <span>Save limited screen evidence frames</span>
                </label>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="text-xs text-lecturer-text-primary">
                    Evidence interval (seconds)
                    <input
                      type="number"
                      min={30}
                      max={300}
                      step={10}
                      disabled={!secureForm.screenShareCaptureEvidence}
                      className="mt-1 w-full rounded border border-lecturer-border px-2 py-1 text-sm disabled:opacity-50"
                      value={secureForm.screenShareEvidenceIntervalSeconds}
                      onChange={(e) =>
                        setSecureForm({
                          ...secureForm,
                          screenShareEvidenceIntervalSeconds: Math.min(300, Math.max(30, Number(e.target.value) || 60)),
                        })
                      }
                    />
                  </label>
                  <label className="text-xs text-lecturer-text-primary">
                    Max evidence frames per attempt
                    <input
                      type="number"
                      min={1}
                      max={50}
                      disabled={!secureForm.screenShareCaptureEvidence}
                      className="mt-1 w-full rounded border border-lecturer-border px-2 py-1 text-sm disabled:opacity-50"
                      value={secureForm.screenShareMaxEvidenceFrames}
                      onChange={(e) =>
                        setSecureForm({
                          ...secureForm,
                          screenShareMaxEvidenceFrames: Math.min(50, Math.max(1, Number(e.target.value) || 20)),
                        })
                      }
                    />
                  </label>
                </div>

                <div className="rounded border border-lecturer-border bg-lecturer-border-subtle p-3 text-xs text-lecturer-text-primary">
                  <p className="font-medium">Screen-share evidence: Enabled</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    <li>No audio is recorded.</li>
                    <li>Continuous screen video is never recorded or uploaded.</li>
                    <li>
                      {secureForm.screenShareCaptureEvidence
                        ? `Up to ${secureForm.screenShareMaxEvidenceFrames} low-resolution evidence frame(s), at most one every ${secureForm.screenShareEvidenceIntervalSeconds}s, are stored privately.`
                        : "No evidence frames are saved — only sharing start/stop/interruption signals are recorded."}
                    </li>
                    <li>Frames and signals are review evidence, not automatic misconduct findings.</li>
                    <li>Browser and operating-system limitations apply — see docs/screen-share-evidence-v1.md.</li>
                  </ul>
                </div>
              </div>
            )}
          </div>

          {/* Answer-Development Provenance v1 — see
              docs/answer-development-provenance-v1.md. This is process
              evidence, not a misconduct detector. */}
          <div className="border-t border-lecturer-border pt-3">
            <h3 className="text-sm font-medium">Answer-development provenance</h3>
            <p className="mt-1 text-xs text-lecturer-text-secondary">
              Preserve readable answer-development checkpoints for lecturer review. Never records individual keystrokes.
            </p>
            <label className="mt-2 block text-sm text-lecturer-text-primary">
              <span>Mode</span>
              <select
                className="mt-1 block w-full rounded border border-lecturer-border px-2 py-1 text-sm"
                value={secureForm.answerProvenanceMode}
                onChange={(e) => setSecureForm({ ...secureForm, answerProvenanceMode: e.target.value as SecureSettings["answerProvenanceMode"] })}
              >
                <option value="OFF">Off</option>
                <option value="BASIC">Basic (checkpoints only)</option>
                <option value="DETAILED">Detailed (checkpoints + optional workspaces)</option>
              </select>
            </label>

            {secureForm.answerProvenanceMode !== "OFF" && (
              <div className="mt-3 space-y-3 pl-6">
                <div className="grid grid-cols-3 gap-2 text-sm text-lecturer-text-primary">
                  <label>
                    <span className="text-xs text-lecturer-text-secondary">Interval (s)</span>
                    <input
                      type="number"
                      min={30}
                      max={300}
                      className="mt-1 w-full rounded border border-lecturer-border px-2 py-1 text-sm"
                      value={secureForm.answerVersionIntervalSeconds}
                      onChange={(e) =>
                        setSecureForm({
                          ...secureForm,
                          answerVersionIntervalSeconds: Math.min(300, Math.max(30, Number(e.target.value) || 60)),
                        })
                      }
                    />
                  </label>
                  <label>
                    <span className="text-xs text-lecturer-text-secondary">Min. change (chars)</span>
                    <input
                      type="number"
                      min={20}
                      max={1000}
                      className="mt-1 w-full rounded border border-lecturer-border px-2 py-1 text-sm"
                      value={secureForm.answerVersionMinimumCharacterChange}
                      onChange={(e) =>
                        setSecureForm({
                          ...secureForm,
                          answerVersionMinimumCharacterChange: Math.min(1000, Math.max(20, Number(e.target.value) || 80)),
                        })
                      }
                    />
                  </label>
                  <label>
                    <span className="text-xs text-lecturer-text-secondary">Max checkpoints/question</span>
                    <input
                      type="number"
                      min={5}
                      max={100}
                      className="mt-1 w-full rounded border border-lecturer-border px-2 py-1 text-sm"
                      value={secureForm.answerVersionMaximumPerQuestion}
                      onChange={(e) =>
                        setSecureForm({
                          ...secureForm,
                          answerVersionMaximumPerQuestion: Math.min(100, Math.max(5, Number(e.target.value) || 40)),
                        })
                      }
                    />
                  </label>
                </div>

                <label className="flex items-start gap-2 text-sm text-lecturer-text-primary">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={secureForm.capturePasteMetadata}
                    onChange={(e) => setSecureForm({ ...secureForm, capturePasteMetadata: e.target.checked })}
                  />
                  <span>Capture paste metadata (size, timing — never clipboard contents on their own)</span>
                </label>
                <label className="flex items-start gap-2 text-sm text-lecturer-text-primary">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={secureForm.captureDeletionRewriteMetadata}
                    onChange={(e) => setSecureForm({ ...secureForm, captureDeletionRewriteMetadata: e.target.checked })}
                  />
                  <span>Capture deletion/rewrite metadata</span>
                </label>
                <label className="flex items-start gap-2 text-sm text-lecturer-text-primary">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={secureForm.allowStudentDevelopmentReview}
                    onChange={(e) => setSecureForm({ ...secureForm, allowStudentDevelopmentReview: e.target.checked })}
                  />
                  <span>Allow students to review their own development history</span>
                </label>

                {secureForm.answerProvenanceMode === "DETAILED" && (
                  <div className="space-y-2 border-t border-gray-100 pt-2">
                    <p className="text-xs font-medium text-lecturer-text-secondary">Detailed-mode workspaces</p>
                    <label className="flex items-start gap-2 text-sm text-lecturer-text-primary">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={secureForm.enableOutlineWorkspace}
                        onChange={(e) => setSecureForm({ ...secureForm, enableOutlineWorkspace: e.target.checked })}
                      />
                      <span>Outline workspace</span>
                    </label>
                    <label className="flex items-start gap-2 text-sm text-lecturer-text-primary">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={secureForm.enableCalculationWorkspace}
                        onChange={(e) => setSecureForm({ ...secureForm, enableCalculationWorkspace: e.target.checked })}
                      />
                      <span>Calculation working area</span>
                    </label>
                    <label className="flex items-start gap-2 text-sm text-lecturer-text-primary">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={secureForm.enableCodeWorkspace}
                        onChange={(e) =>
                          setSecureForm({
                            ...secureForm,
                            enableCodeWorkspace: e.target.checked,
                            captureCodeRunHistory: e.target.checked ? secureForm.captureCodeRunHistory : false,
                          })
                        }
                      />
                      <span>
                        Code working area <span className="text-xs text-lecturer-text-secondary">(execution is not available — see docs)</span>
                      </span>
                    </label>
                    {secureForm.enableCodeWorkspace && (
                      <label className="flex items-start gap-2 pl-6 text-sm text-lecturer-text-primary">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={secureForm.captureCodeRunHistory}
                          onChange={(e) => setSecureForm({ ...secureForm, captureCodeRunHistory: e.target.checked })}
                        />
                        <span>Record code-run requests (no code is actually executed)</span>
                      </label>
                    )}
                    <label className="flex items-start gap-2 text-sm text-lecturer-text-primary">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={secureForm.requireAiSourceDeclaration}
                        onChange={(e) => setSecureForm({ ...secureForm, requireAiSourceDeclaration: e.target.checked })}
                      />
                      <span>Require a source/AI-use declaration before submission</span>
                    </label>
                  </div>
                )}

                <div className="rounded border border-lecturer-border bg-lecturer-border-subtle p-3 text-xs text-lecturer-text-primary">
                  <p className="font-medium">Answer-development provenance: Enabled</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    <li>Individual keystrokes are never recorded.</li>
                    <li>Readable answer-version checkpoints and process events are process evidence, not proof of misconduct.</li>
                    <li>Lecturer judgement remains final; no grade is automatically changed.</li>
                  </ul>
                </div>
              </div>
            )}
          </div>

          {/* Mandatory Tether Delivery for Final Examinations — see
              src/lib/assessmentType.ts. Placed before Exam delivery/
              security configuration: for a final examination, delivery
              mode and display policy are not independent choices — they
              follow automatically from this classification and are
              locked below. */}
          <div className="border-t border-lecturer-border pt-3">
            <h3 className="text-sm font-medium">Assessment type</h3>
            <p className="mt-1 text-xs text-lecturer-text-secondary">
              Classify this assessment. Final examinations must be delivered through Tether Secure Browser.
            </p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {ASSESSMENT_TYPES.map((type) => (
                <label
                  key={type}
                  className={`cursor-pointer rounded border p-3 text-sm ${secureForm.assessmentType === type ? "border-gray-500 bg-lecturer-border-subtle" : "border-lecturer-border"}`}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="assessmentType"
                      checked={secureForm.assessmentType === type}
                      onChange={() => {
                        // Automatically select + lock Tether Secure Browser
                        // required and Single display required the moment
                        // Final examination is chosen — see
                        // applyMandatoryFinalExaminationPolicy. A no-op for
                        // every other assessment type, so switching between
                        // Practice/Quiz/Mid-semester never touches delivery
                        // settings.
                        setSecureForm(applyMandatoryFinalExaminationPolicy(type, { ...secureForm, assessmentType: type }));
                        setDisplayPolicyAutoSwitchNotice(null);
                      }}
                    />
                    <span className="font-medium">{ASSESSMENT_TYPE_LABELS[type]}</span>
                    {type === "FINAL_EXAMINATION" && (
                      <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-medium text-white">Required for final examinations</span>
                    )}
                  </div>
                </label>
              ))}
            </div>
            {isFinalExamLocked && (
              <div className="mt-2 rounded border border-blue-200 bg-lecturer-accent-subtle p-2 text-xs text-blue-800">
                <p className="font-medium">Final examinations must be delivered through Tether Secure Browser.</p>
                <p className="mt-0.5">Students must use a verified Tether Secure Browser session and a compliant single-display setup.</p>
              </div>
            )}
            {/* Mandatory Tether Delivery for Final Examinations — Part 6:
                per-attempt policy snapshots are frozen at submission-start
                time and are never retroactively rewritten (see
                buildSecureClientPolicySnapshot in secureClientPolicy.ts).
                A lecturer changing classification/policy on an exam that
                already has submissions must be told that plainly, since
                the save itself will silently only affect NEW attempts. */}
            {!!submissionCounts && submissionCounts.total > 0 && (
              <div className="mt-2 rounded border border-amber-200 bg-[#FFFAEB] p-2 text-xs text-amber-800">
                <p className="font-medium">
                  This exam already has {submissionCounts.total} submission{submissionCounts.total === 1 ? "" : "s"}.
                </p>
                <p className="mt-0.5">
                  Existing attempts keep the delivery and display policy that was in effect when they started. Changes made
                  here apply only to new attempts — start a new exam version or attempt cycle to bring existing attempts
                  under the mandatory policy.
                </p>
              </div>
            )}
          </div>

          {/* Tether Secure Client Foundation + Safe Exam Browser
              Compatibility v1 — see
              docs/secure-client-foundation-seb-v1.md. Cheat-resistant,
              never cheat-proof/impossible to bypass. */}
          <div className="border-t border-lecturer-border pt-3">
            <h3 className="text-sm font-medium">Exam delivery</h3>
            <p className="mt-1 text-xs text-lecturer-text-secondary">
              Choose how students access this exam. The web examination platform remains fully functional in every mode.
            </p>
            {isFinalExamLocked && (
              <p className="mt-1 text-xs text-lecturer-text-secondary">Other delivery modes are unavailable for final examinations.</p>
            )}
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(
                [
                  {
                    value: "STANDARD_WEB",
                    title: "Standard web",
                    desc: "For ordinary assessments using normal browser delivery.",
                    disabled: isFinalExamLocked || false,
                    needsValidationNotice: false,
                    disabledReason: isFinalExamLocked ? "Not available for final examinations." : null,
                  },
                  {
                    value: "MONITORED_WEB",
                    title: "Monitored web",
                    desc: "Uses Tether's existing camera, screen-sharing and integrity evidence.",
                    disabled: isFinalExamLocked || false,
                    needsValidationNotice: false,
                    disabledReason: isFinalExamLocked ? "Not available for final examinations." : null,
                  },
                  // Lecturer availability fix — Tether Secure Browser is
                  // the first-party, generally-available production
                  // client (see src/lib/secureClientAvailability.ts,
                  // tetherClientRequiredAvailable) and the primary Tether
                  // workflow — Safe Exam Browser is not. This option was
                  // previously missing from this list entirely; only the
                  // still-experimental TETHER_CLIENT_OPTIONAL mode below
                  // was ever offered.
                  //
                  // Mandatory Tether Delivery for Final Examinations — once
                  // locked, this option is never itself "disabled" from the
                  // lecturer's perspective (it IS the mandatory choice,
                  // always checked); the radio input is disabled only so it
                  // cannot be toggled OFF, matching "lock this setting so
                  // the lecturer cannot downgrade it."
                  {
                    value: "TETHER_CLIENT_REQUIRED",
                    title: "Tether Secure Browser — required",
                    desc: "Students must open this examination in Tether Secure Browser.",
                    disabled: !exam.secureClientAvailability.tetherClientRequiredAvailable || isFinalExamLocked,
                    needsValidationNotice: false,
                    disabledReason: isFinalExamLocked ? null : "Temporarily disabled for this environment.",
                    lockedBadge: isFinalExamLocked,
                  },
                  {
                    value: "TETHER_CLIENT_OPTIONAL",
                    title: "Tether Secure Browser — optional",
                    desc: "Students may open this examination in Tether Secure Browser, or continue in an ordinary browser.",
                    disabled: !exam.secureClientAvailability.tetherClientOptionalAvailable || isFinalExamLocked,
                    needsValidationNotice: false,
                    disabledReason: isFinalExamLocked ? "Not available for final examinations." : "Not enabled for this environment.",
                  },
                  {
                    value: "SEB_OPTIONAL",
                    title: "Safe Exam Browser — optional",
                    desc: "Students may use an approved Safe Exam Browser configuration.",
                    disabled: isFinalExamLocked || !exam.secureClientAvailability.sebOptionalAvailable,
                    needsValidationNotice: true,
                    disabledReason: isFinalExamLocked ? "Not available for final examinations." : "Not enabled for this institution in this environment.",
                  },
                  {
                    value: "SEB_REQUIRED",
                    title: "Safe Exam Browser — required",
                    desc: "Students must use an approved Safe Exam Browser configuration.",
                    disabled: isFinalExamLocked || !exam.secureClientAvailability.sebRequiredAvailable,
                    needsValidationNotice: true,
                    disabledReason: isFinalExamLocked ? "Not available for final examinations." : "Not enabled for this institution in this environment.",
                  },
                ] as Array<{
                  value: SecureSettings["deliveryMode"];
                  title: string;
                  desc: string;
                  disabled: boolean;
                  needsValidationNotice: boolean;
                  disabledReason: string | null;
                  lockedBadge?: boolean;
                }>
              ).map((option) => {
                const checked = isFinalExamLocked ? option.value === "TETHER_CLIENT_REQUIRED" : secureForm.deliveryMode === option.value;
                return (
                  <label
                    key={option.value}
                    className={`rounded border p-3 text-sm ${checked ? "border-gray-500 bg-lecturer-border-subtle" : "border-lecturer-border"} ${option.disabled ? "opacity-50" : "cursor-pointer"}`}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="deliveryMode"
                        disabled={option.disabled}
                        checked={checked}
                        onChange={() => {
                          setSecureForm({ ...secureForm, deliveryMode: option.value });
                          setDisplayPolicyAutoSwitchNotice(null);
                        }}
                      />
                      <span className="font-medium">{option.title}</span>
                      {option.lockedBadge && (
                        <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-medium text-white">Required for final examinations</span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-lecturer-text-secondary">{option.desc}</p>
                    {/* Real Safe Exam Browser client compatibility has not yet
                        been validated against this backend — never claim
                        "production verified" here regardless of whether the
                        mode is currently selectable. Tether Secure Browser is
                        the validated first-party client, so neither Tether
                        option shows this notice. */}
                    {option.needsValidationNotice && (
                      <p className="mt-1 text-xs text-[#B54708]">Compatibility validation required.</p>
                    )}
                    {option.disabled && option.disabledReason && <p className="mt-1 text-xs text-[#B54708]">{option.disabledReason}</p>}
                  </label>
                );
              })}
            </div>

            {/* Single Display Requirement v1 — see
                docs/secure-client-foundation-seb-v1.md, "Display
                requirement". Visible for every delivery mode (not just
                SEB) so the invalid STANDARD_WEB/MONITORED_WEB combination
                below can actually be surfaced and blocked, rather than
                hidden where a lecturer could never see why saving fails. */}
            <div className="mt-3 pl-1">
              <p className="text-sm font-medium">Display requirement</p>
              <div className="mt-1 flex flex-col gap-1.5">
                <label
                  className={`flex items-start gap-2 text-sm text-lecturer-text-primary ${isFinalExamLocked || displayRequirementUiState.unrestrictedDisabled ? "opacity-50" : ""}`}
                >
                  <input
                    type="radio"
                    name="displayPolicy"
                    className="mt-0.5"
                    disabled={isFinalExamLocked || displayRequirementUiState.unrestrictedDisabled}
                    checked={!isFinalExamLocked && secureForm.displayPolicy === "UNRESTRICTED"}
                    onChange={() => {
                      setSecureForm({ ...secureForm, displayPolicy: "UNRESTRICTED" });
                      setDisplayPolicyAutoSwitchNotice(null);
                    }}
                  />
                  <span>
                    No display restriction
                    <span className="mt-0.5 block text-xs font-normal text-lecturer-text-secondary">
                      Students may use the displays permitted by their device and exam client.
                    </span>
                  </span>
                </label>
                <label
                  className={`flex items-start gap-2 text-sm text-lecturer-text-primary ${isFinalExamLocked || displayRequirementUiState.singleDisplayRequiredDisabled ? "opacity-50" : ""}`}
                >
                  <input
                    type="radio"
                    name="displayPolicy"
                    className="mt-0.5"
                    disabled={isFinalExamLocked || displayRequirementUiState.singleDisplayRequiredDisabled}
                    checked={isFinalExamLocked || secureForm.displayPolicy === "SINGLE_DISPLAY_REQUIRED"}
                    onChange={() => {
                      // Availability-gating fix: this handler can only ever
                      // fire while the radio is enabled (singleDisplayRequiredDisabled
                      // === false, i.e. displayRequirementUiState.kind ===
                      // "AVAILABLE"), so at least one SEB mode is available
                      // here — resolveDeliveryModeForSingleDisplayRequired's
                      // "neither available" branch is unreachable via this
                      // path, only relevant to callers that skip the disabled check.
                      const { deliveryMode, changed } = resolveDeliveryModeForSingleDisplayRequired({
                        currentDeliveryMode: secureForm.deliveryMode,
                        sebOptionalAvailable: exam.secureClientAvailability.sebOptionalAvailable,
                        sebRequiredAvailable: exam.secureClientAvailability.sebRequiredAvailable,
                        tetherClientRequiredAvailable: exam.secureClientAvailability.tetherClientRequiredAvailable,
                        tetherClientOptionalAvailable: exam.secureClientAvailability.tetherClientOptionalAvailable,
                      });
                      setSecureForm({ ...secureForm, displayPolicy: "SINGLE_DISPLAY_REQUIRED", deliveryMode });
                      setDisplayPolicyAutoSwitchNotice(
                        changed ? `Exam delivery switched to "${deliveryModeLabel(deliveryMode)}" because single display required needs a display-aware exam client.` : null,
                      );
                    }}
                  />
                  <span>
                    Single display required
                    {isFinalExamLocked && (
                      <span className="ml-1.5 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-medium text-white">Required for final examinations</span>
                    )}
                    <span className="mt-0.5 block text-xs font-normal text-lecturer-text-secondary">
                      Tether Secure Browser checks Windows display topology before and during the examination.
                    </span>
                  </span>
                </label>
              </div>
              {/* Concise, general Standard-web limitation only — the
                  institution/environment-specific "why is it unavailable
                  right now" fact lives solely in the notice below
                  (displayRequirementUiState.notice), never repeated here,
                  so the two no longer say the same thing twice. */}
              <p className="mt-1.5 text-xs text-lecturer-text-secondary">
                Standard web exams cannot reliably verify connected, mirrored or extended displays.
              </p>
              {displayPolicyAutoSwitchNotice && (
                <p className="mt-1.5 rounded border border-blue-200 bg-lecturer-accent-subtle p-2 text-xs text-blue-800">
                  {displayPolicyAutoSwitchNotice}
                </p>
              )}
              {/* Only shown when a display-aware exam client is actually
                  available — if none were, displayRequirementUiState.notice
                  below already explains why, and telling the lecturer to
                  "choose Tether/SEB above" would repeat the exact
                  contradiction this fix removes. This covers the ordinary
                  (non-manipulated) path where a lecturer enables Single
                  display required — which auto-switches deliveryMode to a
                  compatible mode — and then separately switches
                  deliveryMode back to Standard/Monitored web via the
                  radios above. This IS a genuine, actionable validation
                  error (unlike the notice below), so it stays red. Never
                  shown when Tether Secure Browser required is already
                  selected — that combination is valid, so this must not
                  contradict it with a stale SEB-only warning. */}
              {displayRequirementUiState.kind === "AVAILABLE" &&
                secureForm.displayPolicy === "SINGLE_DISPLAY_REQUIRED" &&
                !isDisplayPolicyCombinationValid(secureForm.deliveryMode, "SINGLE_DISPLAY_REQUIRED") && (
                  <p className="mt-1.5 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">
                    Single display required needs a display-aware exam client. Choose &quot;Tether Secure Browser —
                    required&quot;, &quot;Tether Secure Browser — optional&quot;, &quot;Safe Exam Browser —
                    required&quot;, or &quot;Safe Exam Browser — optional&quot; above before saving, or this setting
                    will be rejected.
                  </p>
                )}
              {/* Neither UNAVAILABLE nor STORED_BUT_UNAVAILABLE is a
                  lecturer-caused validation error — both are ordinary
                  environment/institution availability facts, so this is
                  styled as an amber/informational notice, never a red
                  error (Standard web + No display restriction remains a
                  perfectly valid, saveable configuration in the
                  UNAVAILABLE case). */}
              {displayRequirementUiState.notice && (
                <p className="mt-1.5 rounded border border-amber-200 bg-[#FFFAEB] p-2 text-xs text-amber-800">
                  <span className="block font-medium">{displayRequirementUiState.notice.title}</span>
                  {displayRequirementUiState.notice.message}
                </p>
              )}
            </div>

            {(secureForm.deliveryMode === "SEB_OPTIONAL" || secureForm.deliveryMode === "SEB_REQUIRED") && (
              <div className="mt-3 space-y-2 pl-1">
                <label className="flex items-start gap-2 text-sm text-lecturer-text-primary">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={secureForm.requireSebBrowserExamKey}
                    onChange={(e) => setSecureForm({ ...secureForm, requireSebBrowserExamKey: e.target.checked })}
                  />
                  <span>Require Browser Exam Key verification</span>
                </label>
                <label className="flex items-start gap-2 text-sm text-lecturer-text-primary">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={secureForm.requireSebConfigKey}
                    onChange={(e) => setSecureForm({ ...secureForm, requireSebConfigKey: e.target.checked })}
                  />
                  <span>Require Config Key verification</span>
                </label>
                <label className="flex items-start gap-2 text-sm text-lecturer-text-primary">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={secureForm.secureClientLecturerOverrideAllowed}
                    onChange={(e) => setSecureForm({ ...secureForm, secureClientLecturerOverrideAllowed: e.target.checked })}
                  />
                  <span>Allow lecturer override (e.g. for approved accessibility exceptions)</span>
                </label>
                <Link
                  href={`/lecturer/exams/${id}/secure-client`}
                  className="mt-2 inline-block rounded border border-lecturer-border px-3 py-1.5 text-sm"
                >
                  Manage Safe Exam Browser configuration &amp; sessions
                </Link>
                <p className="rounded border border-amber-100 bg-[#FFFAEB] p-3 text-xs text-amber-800">
                  Secure examination mode provides stronger controls and additional integrity evidence. It is designed to be
                  cheat-resistant, but no examination technology can prevent every form of unauthorised assistance.
                </p>
              </div>
            )}
          </div>

          <div className="border-t border-lecturer-border pt-3">
            <h3 className="text-sm font-medium">Question pools</h3>
            <p className="mt-1 text-xs text-lecturer-text-secondary">
              Create a larger set of questions and draw a smaller random selection for each
              student attempt.
            </p>
            <label className="mt-2 flex items-start gap-2 text-sm text-lecturer-text-primary">
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
            <label className="mt-2 flex items-start gap-2 text-sm text-lecturer-text-primary">
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
                <span className="mt-0.5 block text-xs font-normal text-lecturer-text-secondary">
                  Each student receives a stable random selection from each pool. This is a
                  deterrent, not a guarantee that answer sharing is impossible.
                </span>
              </span>
            </label>
          </div>

          <button
            onClick={handleSaveSecureSettings}
            disabled={savingSecure}
            className="rounded bg-lecturer-accent hover:bg-lecturer-accent-hover px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {savingSecure ? "Saving..." : "Save Safe Exam Mode settings"}
          </button>
          {secureSaveMessage && (
            <p className="text-sm text-lecturer-text-secondary">{secureSaveMessage}</p>
          )}
        </div>
      )}
      </div>

      <div
        id="workspace-panel-delivery"
        role="tabpanel"
        aria-labelledby="workspace-tab-delivery"
        hidden={activeTab !== "delivery"}
        className="mt-6"
      >
      <h2 className="mt-8 text-lg font-semibold text-lecturer-text-primary">Course, assignment &amp; schedule</h2>
      <div className="mt-3 space-y-3 rounded border border-lecturer-border bg-lecturer-surface p-4">
        <p className="text-sm text-lecturer-text-secondary">
          Choose who can access this exam: the whole institution, a
          specific course, or individual students you invite directly via
          a standalone link.
        </p>
        <div>
          <label className="text-sm font-medium">Audience</label>
          <div className="mt-1 flex flex-col gap-2 text-sm">
            <label className="flex items-start gap-2">
              <input
                type="radio"
                className="mt-0.5"
                checked={audience === "INSTITUTION"}
                onChange={() => setAudience("INSTITUTION")}
              />
              <span>
                Institution-wide (legacy)
                <span className="block text-xs text-lecturer-text-secondary">Visible to every student in your institution.</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                className="mt-0.5"
                checked={audience === "COURSE"}
                onChange={() => setAudience("COURSE")}
              />
              <span>
                Course
                <span className="block text-xs text-lecturer-text-secondary">Assign to a course you teach.</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                className="mt-0.5"
                checked={audience === "STANDALONE"}
                onChange={() => setAudience("STANDALONE")}
              />
              <span>
                Standalone exam link
                <span className="block text-xs text-lecturer-text-secondary">
                  Invite individual students directly — no course or institution membership required.
                </span>
              </span>
            </label>
          </div>
        </div>
        {audience === "COURSE" && (
          <div>
            <label className="text-sm font-medium">Course</label>
            <select
              className="mt-1 block w-full rounded border border-lecturer-border px-3 py-1.5 text-sm"
              value={courseId}
              onChange={(e) => setCourseId(e.target.value)}
            >
              <option value="">Select a course</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {audience === "COURSE" && courseId && (
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
        {audience === "COURSE" && courseId && assignmentMode === "SELECTED_STUDENTS" && (
          <div>
            <label className="text-sm font-medium">Selected students</label>
            <div className="mt-1 max-h-40 overflow-y-auto rounded border border-lecturer-border bg-lecturer-surface p-2">
              {courseStudents.length === 0 && (
                <p className="text-sm text-lecturer-text-secondary">No students enrolled in this course yet.</p>
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
        {audience === "STANDALONE" && (
          <div className="rounded border border-lecturer-border bg-lecturer-border-subtle p-3">
            {!standaloneInviteUrl && !exam.standaloneInviteEnabled && (
              <>
                <p className="text-sm text-lecturer-text-secondary">
                  Generate a secure link to invite individual students to this exam. A
                  student who opens the link and accepts gets access — no course or
                  institution membership needed, and no other student can see this exam.
                </p>
                <button
                  onClick={handleGenerateInvite}
                  disabled={generatingInvite}
                  className="mt-2 rounded border border-lecturer-border px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  {generatingInvite ? "Generating..." : "Generate link"}
                </button>
              </>
            )}
            {standaloneInviteUrl && (
              <>
                <p className="text-sm font-medium">Invitation link</p>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={standaloneInviteUrl}
                    onFocus={(e) => e.target.select()}
                    className="flex-1 rounded border border-lecturer-border px-2 py-1.5 text-xs"
                  />
                  <button
                    onClick={handleCopyInviteLink}
                    className="rounded border border-lecturer-border px-3 py-1.5 text-xs"
                  >
                    {copiedInviteLink ? "Copied!" : "Copy link"}
                  </button>
                </div>
                <p className="mt-1 text-xs text-[#B54708]">
                  This link is shown once. Copy it now — it cannot be recovered after you
                  leave or reload this page.
                </p>
              </>
            )}
            {!standaloneInviteUrl && exam.standaloneInviteEnabled && (
              <p className="text-sm text-lecturer-text-primary">Invitation link active.</p>
            )}
            {exam.standaloneInviteEnabled && (
              <div className="mt-3 flex gap-2">
                <button
                  onClick={handleGenerateInvite}
                  disabled={generatingInvite}
                  className="rounded border border-lecturer-border px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  {generatingInvite ? "Generating..." : "Regenerate link"}
                </button>
                <button
                  onClick={handleDisableInvite}
                  disabled={disablingInvite}
                  className="rounded border border-lecturer-border px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  {disablingInvite ? "Disabling..." : "Disable"}
                </button>
              </div>
            )}
            {inviteMessage && <p className="mt-2 text-sm text-lecturer-text-secondary">{inviteMessage}</p>}
          </div>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium">Available from</label>
            <input
              type="datetime-local"
              className="mt-1 block w-full rounded border border-lecturer-border px-3 py-1.5 text-sm"
              value={availableFrom}
              onChange={(e) => setAvailableFrom(e.target.value)}
            />
          </div>
          <div>
            <label className="text-sm font-medium">Available until</label>
            <input
              type="datetime-local"
              className="mt-1 block w-full rounded border border-lecturer-border px-3 py-1.5 text-sm"
              value={availableUntil}
              onChange={(e) => setAvailableUntil(e.target.value)}
            />
          </div>
        </div>
        <button
          onClick={saveSchedule}
          disabled={savingSchedule}
          className="rounded bg-lecturer-accent hover:bg-lecturer-accent-hover px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {savingSchedule ? "Saving..." : "Save course & schedule"}
        </button>
        {scheduleMessage && <p className="text-sm text-lecturer-text-secondary">{scheduleMessage}</p>}
      </div>

      <h2 className="mt-8 text-lg font-semibold text-lecturer-text-primary">Exam duration</h2>
      <div className="mt-3 space-y-3 rounded border border-lecturer-border bg-lecturer-surface p-4">
        <div>
          <label className="text-sm font-medium">Standard duration</label>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="number"
              min={1}
              value={durationInput}
              onChange={(e) => setDurationInput(e.target.value)}
              className="w-24 rounded border border-lecturer-border px-3 py-1.5 text-sm"
            />
            <span className="text-sm text-lecturer-text-secondary">minutes</span>
          </div>
          <p className="mt-1 text-xs text-lecturer-text-secondary">
            Applies to students without an individual time accommodation.
          </p>
        </div>
        <p className="text-xs text-lecturer-text-secondary">
          Existing attempts keep the duration they started with. This change applies to new attempts only.
        </p>
        <button
          onClick={handleSaveDuration}
          disabled={savingDuration}
          className="rounded bg-lecturer-accent hover:bg-lecturer-accent-hover px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {savingDuration ? "Saving..." : "Save duration"}
        </button>
        {durationMessage && <p className="text-sm text-lecturer-text-secondary">{durationMessage}</p>}
      </div>

      <h2 className="mt-8 text-lg font-semibold text-lecturer-text-primary">Time accommodations</h2>
      <p className="mt-1 text-sm text-lecturer-text-secondary">
        Provide approved individual time adjustments without changing the standard exam duration. For example, an
        approved Learning Access Plan.
      </p>
      <div className="mt-3 space-y-3 rounded border border-lecturer-border bg-lecturer-surface p-4">
        {accommodations.length === 0 ? (
          <p className="text-sm text-lecturer-text-secondary">
            {accommodationsLoaded ? "No time accommodations yet." : "Loading..."}
          </p>
        ) : (
          <div className="space-y-2">
            {accommodations.map((a) => (
              <div key={a.id} className="rounded border border-lecturer-border p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{a.name}</p>
                    <p className="text-xs text-lecturer-text-secondary">{a.email}</p>
                    {a.hasInProgressAttempt && (
                      <p className="mt-1 text-xs text-[#B54708]">
                        This student already has an active attempt. Its current duration will not change. This
                        accommodation will apply to a future attempt.
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-4 text-right">
                    <div>
                      <p className="text-xs text-lecturer-text-secondary">Adjustment</p>
                      <p>
                        {a.adjustmentMode === "PERCENT_EXTRA"
                          ? `+${a.adjustmentValue}%`
                          : a.adjustmentMode === "EXTRA_MINUTES"
                            ? `+${a.adjustmentValue} minutes`
                            : `${a.adjustmentValue} min total`}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-lecturer-text-secondary">Standard time</p>
                      <p>{exam.durationMins} min</p>
                    </div>
                    <div>
                      <p className="text-xs text-lecturer-text-secondary">Effective time</p>
                      <p className="font-medium">{a.effectiveDurationMins} min</p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <button
                        type="button"
                        onClick={() => handleOpenEditAccommodation(a)}
                        className="text-sm text-lecturer-accent-hover underline"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveAccommodation(a)}
                        className="text-xs text-[#B42318] underline"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        {accommodationsMessage && <p className="text-sm text-lecturer-text-secondary">{accommodationsMessage}</p>}

        {!showAccommodationForm ? (
          <button
            type="button"
            onClick={handleOpenAddAccommodation}
            className="rounded border border-lecturer-border px-4 py-2 text-sm"
          >
            + Add accommodation
          </button>
        ) : (
          <div className="rounded border border-lecturer-border bg-lecturer-border-subtle p-3">
            <p className="text-sm font-medium">
              {editingAccommodationStudentId ? "Edit accommodation" : "Add accommodation"}
            </p>
            <div className="mt-2 space-y-3">
              <div>
                <label className="block text-sm font-medium">Student</label>
                <select
                  disabled={editingAccommodationStudentId != null}
                  value={accommodationStudentId}
                  onChange={(e) => setAccommodationStudentId(e.target.value)}
                  className="mt-1 w-full rounded border border-lecturer-border px-3 py-1.5 text-sm disabled:bg-lecturer-border-subtle"
                >
                  <option value="">Select a student...</option>
                  {eligibleStudents.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} — {s.email}
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-xs text-lecturer-text-secondary">Standard duration: {exam.durationMins} minutes</p>
              <div>
                <label className="block text-sm font-medium">Time adjustment</label>
                <div className="mt-1 flex flex-wrap gap-3 text-sm">
                  {[25, 50, 100].map((pct) => (
                    <label key={pct} className="flex items-center gap-1">
                      <input
                        type="radio"
                        checked={accommodationMode === "PERCENT_EXTRA" && accommodationValue === String(pct)}
                        onChange={() => {
                          setAccommodationMode("PERCENT_EXTRA");
                          setAccommodationValue(String(pct));
                        }}
                      />
                      +{pct}%
                    </label>
                  ))}
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      checked={accommodationMode === "EXTRA_MINUTES"}
                      onChange={() => {
                        setAccommodationMode("EXTRA_MINUTES");
                        setAccommodationValue("30");
                      }}
                    />
                    Extra minutes
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      checked={accommodationMode === "TOTAL_DURATION"}
                      onChange={() => {
                        setAccommodationMode("TOTAL_DURATION");
                        setAccommodationValue(String(exam.durationMins));
                      }}
                    />
                    Custom total duration
                  </label>
                </div>
              </div>

              {accommodationMode === "EXTRA_MINUTES" && (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={accommodationValue}
                    onChange={(e) => setAccommodationValue(e.target.value)}
                    className="w-24 rounded border border-lecturer-border px-3 py-1.5 text-sm"
                  />
                  <span className="text-sm text-lecturer-text-secondary">minutes extra</span>
                </div>
              )}
              {accommodationMode === "TOTAL_DURATION" && (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={accommodationValue}
                    onChange={(e) => setAccommodationValue(e.target.value)}
                    className="w-24 rounded border border-lecturer-border px-3 py-1.5 text-sm"
                  />
                  <span className="text-sm text-lecturer-text-secondary">minutes total</span>
                </div>
              )}

              {(() => {
                const value = Number(accommodationValue);
                if (!Number.isInteger(value) || value <= 0) return null;
                let effective: number | null = null;
                try {
                  effective = resolveEffectiveExamDurationMins({
                    standardDurationMins: exam.durationMins,
                    accommodation: { adjustmentMode: accommodationMode, adjustmentValue: value },
                  });
                } catch {
                  effective = null;
                }
                if (effective == null) return null;
                return (
                  <div className="rounded border border-lecturer-border bg-lecturer-surface p-3">
                    <p className="text-xs text-lecturer-text-secondary">Effective exam duration</p>
                    <p className="text-lg font-semibold">{effective} minutes</p>
                  </div>
                );
              })()}

              {accommodationFormError && <p className="text-sm text-[#B42318]">{accommodationFormError}</p>}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSaveAccommodation}
                  disabled={savingAccommodation}
                  className="rounded bg-lecturer-accent hover:bg-lecturer-accent-hover px-4 py-2 text-sm text-white disabled:opacity-50"
                >
                  {savingAccommodation ? "Saving..." : "Save accommodation"}
                </button>
                <button
                  type="button"
                  onClick={handleCancelAccommodationForm}
                  className="rounded border border-lecturer-border px-4 py-2 text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <h2 className="mt-8 text-lg font-semibold text-lecturer-text-primary">Share exam link</h2>
      <div className="mt-3 space-y-3 rounded border border-lecturer-border bg-lecturer-surface p-4">
        {!exam.published ? (
          <p className="text-sm text-[#B54708]">
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
                className="flex-1 rounded border border-lecturer-border bg-lecturer-border-subtle px-3 py-1.5 text-sm"
                onFocus={(e) => e.target.select()}
              />
              <button
                onClick={handleCopyJoinLink}
                className="rounded border border-lecturer-border px-3 py-1.5 text-sm"
              >
                {copiedJoinLink ? "Copied!" : "Copy link"}
              </button>
            </div>
            <p className="text-xs text-lecturer-text-secondary">
              Students must be logged in to access this link. If this exam requires an access
              code, students will still need to enter it after opening the link. This link does
              not grant access on its own — it only works for students who are already authorized
              to take this exam.
            </p>
            {exam.assignmentMode === "STANDALONE" ? (
              <p className="text-xs text-lecturer-text-secondary">
                This exam uses a standalone invitation link. This ordinary link only works
                for students who have already accepted an invitation — see &quot;Standalone
                exam link&quot; above to invite new students.
              </p>
            ) : (
              courseId && (
                <p className="text-xs text-lecturer-text-secondary">
                  {assignmentMode === "SELECTED_STUDENTS"
                    ? "Only students assigned to this exam will be able to access it via this link."
                    : `Only students enrolled in ${
                        courses.find((c) => c.id === courseId)?.name ?? "this course"
                      } will be able to access it via this link.`}
                </p>
              )
            )}
          </>
        )}
      </div>

      <h2 className="mt-8 text-lg font-semibold text-lecturer-text-primary">Exam access code</h2>
      <div className="mt-3 space-y-3 rounded border border-lecturer-border bg-lecturer-surface p-4">
        <p className="text-sm text-lecturer-text-secondary">
          Students must enter this code before starting the exam.
        </p>
        <p className="text-sm">
          Status:{" "}
          <span
            className={
              exam.accessCodeRequired
                ? "rounded bg-green-100 px-2 py-0.5 text-xs text-green-700"
                : "rounded bg-lecturer-border-subtle px-2 py-0.5 text-xs text-lecturer-text-secondary"
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
              className="mt-1 w-full rounded border border-lecturer-border px-3 py-2"
              value={accessCodeInput}
              onChange={(e) => setAccessCodeInput(e.target.value)}
              placeholder="e.g. ROOM-204"
            />
          </div>
          <button
            onClick={handleSetAccessCode}
            disabled={savingAccessCode || !accessCodeInput.trim()}
            className="rounded bg-lecturer-accent hover:bg-lecturer-accent-hover px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {savingAccessCode ? "Saving..." : "Set access code"}
          </button>
          {exam.accessCodeRequired && (
            <button
              onClick={handleClearAccessCode}
              disabled={savingAccessCode}
              className="rounded border border-lecturer-border px-4 py-2 text-sm disabled:opacity-50"
            >
              Clear
            </button>
          )}
        </div>
        {accessCodeMessage && <p className="text-sm text-lecturer-text-secondary">{accessCodeMessage}</p>}
      </div>

      <h2 className="mt-8 text-lg font-semibold text-lecturer-text-primary">Export results</h2>
      <div className="mt-3 space-y-3 rounded border border-lecturer-border bg-lecturer-surface p-4">
        <div>
          <p className="text-sm font-medium">Full marks report</p>
          <p className="text-xs text-lecturer-text-secondary">
            Every column: scores, integrity risk level, access code/camera settings, and notes.
            For lecturer/institution use.
          </p>
          <div className="mt-2 flex gap-2">
            <a
              href={`/api/lecturer/exams/${id}/export/marks-csv`}
              className="rounded border border-lecturer-border px-3 py-1.5 text-sm"
            >
              Export marks CSV
            </a>
            <a
              href={`/api/lecturer/exams/${id}/export/marks-xlsx`}
              className="rounded border border-lecturer-border px-3 py-1.5 text-sm"
            >
              Export marks Excel
            </a>
          </div>
        </div>
        <div>
          <p className="text-sm font-medium">Canvas/IRM marks upload export</p>
          <p className="text-xs text-lecturer-text-secondary">
            Marks-only — no integrity signals, no access code data. For uploading to Canvas or an
            institutional marks system.
          </p>
          <div className="mt-2 flex gap-2">
            <a
              href={`/api/lecturer/exams/${id}/export/upload-csv`}
              className="rounded border border-lecturer-border px-3 py-1.5 text-sm"
            >
              Export upload-ready CSV
            </a>
            <a
              href={`/api/lecturer/exams/${id}/export/upload-xlsx`}
              className="rounded border border-lecturer-border px-3 py-1.5 text-sm"
            >
              Export upload-ready Excel
            </a>
          </div>
        </div>
        <div>
          <p className="text-sm font-medium">PDF report</p>
          <p className="text-xs text-lecturer-text-secondary">
            A human-readable summary with marks table and integrity summary, suitable for
            printing or filing.
          </p>
          <div className="mt-2">
            <a
              href={`/api/lecturer/exams/${id}/export/report-pdf`}
              className="rounded border border-lecturer-border px-3 py-1.5 text-sm"
            >
              Export PDF report
            </a>
          </div>
        </div>
      </div>
      </div>

      <div
        id="workspace-panel-questions"
        role="tabpanel"
        aria-labelledby="workspace-tab-questions"
        hidden={activeTab !== "questions"}
        className="mt-6"
      >
      {secureForm?.enableQuestionPools && (
        <>
          <h2 className="mt-8 text-lg font-semibold text-lecturer-text-primary">Question pools</h2>
          <p className="mt-1 text-sm text-lecturer-text-secondary">
            Create a larger set of questions and draw a smaller random selection for each student
            attempt.
          </p>
          <div className="mt-3 space-y-2">
            {pools.length === 0 && <p className="text-lecturer-text-secondary">No pools yet.</p>}
            {pools.map((pool) => (
              <div key={pool.id} className="rounded border border-lecturer-border bg-lecturer-surface p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{pool.name}</p>
                    <p className="text-xs text-lecturer-text-secondary">{pool.questionCount} question(s) in pool</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-lecturer-text-secondary">Draw this many questions from this pool</label>
                    <input
                      type="number"
                      min={0}
                      defaultValue={pool.drawCount ?? ""}
                      placeholder="all"
                      className="w-16 rounded border border-lecturer-border px-2 py-1 text-sm"
                      onBlur={(e) =>
                        handleUpdatePoolDrawCount(
                          pool.id,
                          e.target.value === "" ? null : Number(e.target.value),
                        )
                      }
                    />
                    <button
                      onClick={() => handleDeletePool(pool.id)}
                      className="text-sm text-[#B42318] underline"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {pool.drawCount != null && pool.drawCount > pool.questionCount && (
                  <p className="mt-2 text-xs text-[#B54708]">
                    This pool has fewer questions than the draw count. Students will receive all
                    available questions from this pool.
                  </p>
                )}
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2 rounded border border-lecturer-border bg-lecturer-surface p-3">
            <div>
              <label className="block text-xs text-lecturer-text-secondary">Pool name</label>
              <input
                value={newPoolName}
                onChange={(e) => setNewPoolName(e.target.value)}
                className="rounded border border-lecturer-border px-2 py-1 text-sm"
                placeholder="e.g. Programming basics"
              />
            </div>
            <div>
              <label className="block text-xs text-lecturer-text-secondary">Draw this many questions from this pool</label>
              <input
                type="number"
                min={0}
                value={newPoolDrawCount}
                onChange={(e) => setNewPoolDrawCount(e.target.value)}
                className="w-24 rounded border border-lecturer-border px-2 py-1 text-sm"
                placeholder="all"
              />
            </div>
            <button
              onClick={handleCreatePool}
              disabled={!newPoolName.trim()}
              className="rounded border border-lecturer-border px-3 py-1.5 text-sm disabled:opacity-50"
            >
              Add pool
            </button>
          </div>
          {poolsMessage && <p className="mt-2 text-sm text-[#B42318]">{poolsMessage}</p>}
        </>
      )}

      <h2 className="mt-8 text-lg font-semibold text-lecturer-text-primary">Questions</h2>
      <div className="mt-3 space-y-3">
        {exam.questions.length === 0 && (
          <p className="text-lecturer-text-secondary">No questions yet.</p>
        )}
        {exam.questions.map((q, i) => (
          <div key={q.id} className="rounded border border-lecturer-border bg-lecturer-surface p-3">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm text-lecturer-text-secondary">
                  Q{i + 1} · {q.type} · {q.points} pt(s)
                </p>
                <p className="mt-1">{q.text}</p>
                {q.options && (
                  <ul className="mt-1 list-disc pl-5 text-sm text-lecturer-text-secondary">
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
                    <label className="text-xs text-lecturer-text-secondary">Question pool</label>
                    <select
                      className="ml-2 rounded border border-lecturer-border px-2 py-1 text-xs"
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
                className="text-sm text-[#B42318] underline"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      <h2 className="mt-8 text-lg font-semibold text-lecturer-text-primary">Add multiple questions</h2>
      <div className="mt-3 space-y-3 rounded border border-lecturer-border bg-lecturer-surface p-4">
        <p className="text-sm text-lecturer-text-secondary">
          Paste one or more questions in the format below, then preview before importing. Nothing
          is saved until you click &quot;Import questions&quot;, and if any question has an error
          nothing is saved.
        </p>
        <details className="rounded border border-lecturer-border bg-lecturer-surface p-2 text-sm">
          <summary className="cursor-pointer font-medium">Show accepted format</summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-lecturer-text-primary">
            {BULK_QUESTION_FORMAT_EXAMPLE}
          </pre>
        </details>
        {exam.published && (
          <p className="text-sm text-[#B54708]">
            This exam is published — imported questions will be visible/available to students
            immediately.
          </p>
        )}
        <textarea
          rows={10}
          className="w-full rounded border border-lecturer-border px-3 py-2 font-mono text-xs"
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
          className="rounded border border-lecturer-border px-4 py-2 text-sm disabled:opacity-50"
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
                  row.errors.length > 0 ? "border-red-300 bg-red-50" : "border-lecturer-border"
                }`}
              >
                <p className="text-xs text-lecturer-text-secondary">
                  Question {row.row} {row.type ? `· ${row.type}` : ""} {row.points ? `· ${row.points} pt(s)` : ""}
                </p>
                <p className="mt-1">{row.text || <em className="text-gray-400">(no text)</em>}</p>
                {row.errors.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-[#B42318]">
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
                  className="mt-1 w-full rounded border border-lecturer-border px-3 py-2 text-sm"
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
              className="rounded bg-lecturer-accent hover:bg-lecturer-accent-hover px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {bulkImporting ? "Importing..." : `Import ${bulkPreview.validCount} question(s)`}
            </button>
          </div>
        )}

        {bulkError && <p className="text-sm text-[#B42318]">{bulkError}</p>}
        {bulkResult && (
          <div className="text-sm text-green-700">
            <p>
              Imported {bulkResult.created} question(s)
              {bulkResult.bankSaved > 0 && ` and saved ${bulkResult.bankSaved} to the question bank`}.
            </p>
            {bulkResult.warning && <p className="text-[#B54708]">{bulkResult.warning}</p>}
          </div>
        )}
      </div>

      <h2 className="mt-8 text-lg font-semibold text-lecturer-text-primary">Generate questions with AI</h2>
      <div className="mt-3 space-y-3 rounded border border-lecturer-border bg-lecturer-surface p-4">
        <div>
          <label className="block text-sm font-medium">Source material or topic</label>
          <textarea
            rows={5}
            className="mt-1 w-full rounded border border-lecturer-border px-3 py-2"
            placeholder="Paste lecture notes, a textbook excerpt, or just describe a topic..."
            value={sourceMaterial}
            onChange={(e) => setSourceMaterial(e.target.value)}
          />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-sm font-medium">Subject</label>
            <input
              className="mt-1 w-full rounded border border-lecturer-border px-3 py-2"
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
              className="mt-1 w-full rounded border border-lecturer-border px-3 py-2"
              value={totalCount}
              onChange={(e) => setTotalCount(Number(e.target.value))}
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium">
            Difficulty mix{" "}
            <span className={difficultySum === 100 ? "text-lecturer-text-secondary" : "text-[#B42318]"}>
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

        {generateError && <p className="text-sm text-[#B42318]">{generateError}</p>}

        <button
          onClick={handleGenerate}
          disabled={generating}
          className="flex items-center gap-2 rounded bg-lecturer-accent hover:bg-lecturer-accent-hover px-4 py-2 text-white disabled:opacity-50"
        >
          {generating && (
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
          )}
          {generating ? "Generating..." : "Generate"}
        </button>

        {generated.length > 0 && (
          <div className="mt-4 space-y-3 border-t border-lecturer-border pt-4">
            <p className="text-sm text-lecturer-text-secondary">
              {generated.length} question(s) generated — review and select which to add.
            </p>
            {generated.map((q, i) => (
              <div key={i} className="rounded border border-lecturer-border bg-lecturer-surface p-3">
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
                      <span className="rounded bg-lecturer-border-subtle px-2 py-0.5 text-xs text-lecturer-text-secondary">
                        {QUESTION_TYPE_LABELS[q.type]}
                      </span>
                      <span
                        className={
                          q.difficulty === "hard"
                            ? "rounded bg-red-100 px-2 py-0.5 text-xs text-[#B42318]"
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
                              className={isCorrect ? "font-medium text-green-700" : "text-lecturer-text-secondary"}
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
                      <p className="mt-1 text-sm text-lecturer-text-secondary">{q.explanation}</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
            <button
              onClick={handleAddSelected}
              disabled={importing || included.every((v) => !v)}
              className="rounded bg-lecturer-accent hover:bg-lecturer-accent-hover px-4 py-2 text-white disabled:opacity-50"
            >
              {importing ? "Adding..." : "Add selected to exam"}
            </button>
          </div>
        )}
      </div>

      <h2 className="mt-8 text-lg font-semibold text-lecturer-text-primary">Add questions</h2>
      <div className="mt-3 space-y-3">
        {manualDrafts.map((draft, index) => (
          <div key={index} className="rounded border border-lecturer-border bg-lecturer-surface p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Question {index + 1}</p>
              {manualDrafts.length > 1 && (
                <button
                  onClick={() => removeManualDraftCard(index)}
                  className="text-xs text-[#B42318] underline"
                >
                  Remove
                </button>
              )}
            </div>
            <div className="mt-2 space-y-3">
              <div>
                <label className="block text-sm font-medium">Type</label>
                <select
                  className="mt-1 w-full rounded border border-lecturer-border px-3 py-2"
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
                  className="mt-1 w-full rounded border border-lecturer-border px-3 py-2"
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
                        className="w-full rounded border border-lecturer-border px-3 py-2"
                        value={opt}
                        onChange={(e) => updateManualDraftOption(index, optIndex, e.target.value)}
                      />
                    ))}
                  </div>
                  <label className="mt-2 block text-sm font-medium">Correct answer</label>
                  <input
                    placeholder="Must match one of the options above"
                    className="mt-1 w-full rounded border border-lecturer-border px-3 py-2"
                    value={draft.correctAnswer}
                    onChange={(e) => updateManualDraft(index, { correctAnswer: e.target.value })}
                  />
                </div>
              )}
              {draft.type === "SHORT_ANSWER" && (
                <div>
                  <label className="block text-sm font-medium">Correct answer (optional)</label>
                  <input
                    className="mt-1 w-full rounded border border-lecturer-border px-3 py-2"
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
                  className="mt-1 w-full rounded border border-lecturer-border px-3 py-2"
                  value={draft.points}
                  onChange={(e) => updateManualDraft(index, { points: Number(e.target.value) })}
                />
              </div>
              {manualErrors[index] && manualErrors[index].length > 0 && (
                <ul className="list-disc pl-5 text-sm text-[#B42318]">
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
          className="rounded border border-lecturer-border px-4 py-2 text-sm"
        >
          + Add another question
        </button>

        <div className="pt-2">
          <button
            onClick={handleSaveManualQuestions}
            disabled={adding}
            className="rounded bg-lecturer-accent hover:bg-lecturer-accent-hover px-4 py-2 text-white disabled:opacity-50"
          >
            {adding ? "Saving..." : "Save all questions"}
          </button>
        </div>

        {addError && <p className="text-sm text-[#B42318]">{addError}</p>}
        {addSuccess && <p className="text-sm text-green-700">{addSuccess}</p>}
      </div>
      </div>

      <div
        id="workspace-panel-integrations"
        role="tabpanel"
        aria-labelledby="workspace-tab-integrations"
        hidden={activeTab !== "integrations"}
        className="mt-6"
      >
      <h2 className="mt-8 text-lg font-semibold text-lecturer-text-primary">Canvas / LTI linking</h2>
      <p className="mt-1 text-sm text-lecturer-text-secondary">
        Link a Canvas assignment&apos;s resource link to this exam so students launching from
        Canvas land directly on it. Unlinked Canvas launches never connect to a random exam.
      </p>

      <div className="mt-3 space-y-3">
        {ltiLinks.length === 0 && (
          <p className="text-sm text-lecturer-text-secondary">No Canvas links yet.</p>
        )}
        {ltiLinks.map((link) => (
          <div key={link.id} className="rounded border border-lecturer-border bg-lecturer-surface p-3 text-sm">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-medium">{link.label || "Canvas link"}</p>
                <p className="text-lecturer-text-secondary">Platform: {link.platform.issuer}</p>
                <p className="text-lecturer-text-secondary">Resource link ID: {link.resourceLinkId}</p>
                {link.canvasCourseId && <p className="text-lecturer-text-secondary">Course ID: {link.canvasCourseId}</p>}
                {link.canvasAssignmentId && (
                  <p className="text-lecturer-text-secondary">Assignment ID: {link.canvasAssignmentId}</p>
                )}
                <p className="text-gray-400">Created {new Date(link.createdAt).toLocaleDateString()}</p>
              </div>
              <button
                onClick={() => handleDeleteLink(link.id)}
                className="text-sm text-[#B42318] underline"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={handleCreateLink} className="mt-3 space-y-3 rounded border border-lecturer-border bg-lecturer-surface p-4">
        <div>
          <label className="block text-sm font-medium">Canvas platform</label>
          <select
            required
            className="mt-1 w-full rounded border border-lecturer-border px-3 py-2"
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
            className="mt-1 w-full rounded border border-lecturer-border px-3 py-2"
            value={linkForm.resourceLinkId}
            onChange={(e) => setLinkForm({ ...linkForm, resourceLinkId: e.target.value })}
          />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-sm font-medium">Canvas course ID (optional)</label>
            <input
              className="mt-1 w-full rounded border border-lecturer-border px-3 py-2"
              value={linkForm.canvasCourseId}
              onChange={(e) => setLinkForm({ ...linkForm, canvasCourseId: e.target.value })}
            />
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium">Canvas assignment ID (optional)</label>
            <input
              className="mt-1 w-full rounded border border-lecturer-border px-3 py-2"
              value={linkForm.canvasAssignmentId}
              onChange={(e) => setLinkForm({ ...linkForm, canvasAssignmentId: e.target.value })}
            />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium">Label (optional)</label>
          <input
            className="mt-1 w-full rounded border border-lecturer-border px-3 py-2"
            value={linkForm.label}
            onChange={(e) => setLinkForm({ ...linkForm, label: e.target.value })}
          />
        </div>
        {linkError && <p className="text-sm text-[#B42318]">{linkError}</p>}
        <button
          type="submit"
          disabled={creatingLink}
          className="rounded bg-lecturer-accent hover:bg-lecturer-accent-hover px-4 py-2 text-white disabled:opacity-50"
        >
          {creatingLink ? "Linking..." : "Link Canvas resource"}
        </button>
      </form>
      </div>
    </div>
  );
}
