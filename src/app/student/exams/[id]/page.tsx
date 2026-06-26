"use client";

import { useCallback, useEffect, useRef, useState, use as usePromise } from "react";
import { useRouter } from "next/navigation";

type Question = {
  id: string;
  type: "MULTIPLE_CHOICE" | "SHORT_ANSWER" | "ESSAY";
  text: string;
  options: string[] | null;
  points: number;
};

type Answer = {
  questionId: string;
  response: string | null;
  score?: number;
  feedback?: string;
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

type SubmissionData = {
  id: string;
  status: "IN_PROGRESS" | "SUBMITTED" | "GRADED";
  deadline: string;
  totalScore: number | null;
  exam: { id: string; title: string; questions: Question[]; secureSettings: SecureSettings };
  answers: Answer[];
};

type IntegrityEventType =
  | "FULLSCREEN_EXIT"
  | "WINDOW_BLUR"
  | "WINDOW_FOCUS_RETURN"
  | "COPY_ATTEMPT"
  | "PASTE_ATTEMPT"
  | "RIGHT_CLICK_ATTEMPT"
  | "NETWORK_OFFLINE"
  | "NETWORK_ONLINE"
  | "AUTOSAVE_FAILED"
  | "TIMER_EXPIRED";

type IntegritySeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH";

const DEBOUNCE_MS: Partial<Record<IntegrityEventType, number>> = {
  WINDOW_BLUR: 10_000,
  COPY_ATTEMPT: 5_000,
  PASTE_ATTEMPT: 5_000,
  AUTOSAVE_FAILED: 10_000,
};

const MESSAGES: Record<IntegrityEventType, string> = {
  FULLSCREEN_EXIT: "You exited fullscreen mode.",
  WINDOW_BLUR: "You switched away from the exam window.",
  WINDOW_FOCUS_RETURN: "You returned to the exam window.",
  COPY_ATTEMPT: "A copy action was attempted.",
  PASTE_ATTEMPT: "A paste action was attempted.",
  RIGHT_CLICK_ATTEMPT: "A right-click was attempted.",
  NETWORK_OFFLINE: "Your connection appears to be offline.",
  NETWORK_ONLINE: "Your connection is back online.",
  AUTOSAVE_FAILED: "A save attempt failed and was retried.",
  TIMER_EXPIRED: "The exam timer has expired.",
};

function severityFor(eventType: IntegrityEventType, settings: SecureSettings): IntegritySeverity {
  switch (eventType) {
    case "FULLSCREEN_EXIT":
      return settings.requireFullscreen ? "HIGH" : "MEDIUM";
    case "WINDOW_BLUR":
      return "MEDIUM";
    case "WINDOW_FOCUS_RETURN":
      return "INFO";
    case "COPY_ATTEMPT":
    case "PASTE_ATTEMPT":
      return settings.blockCopyPaste ? "MEDIUM" : "LOW";
    case "RIGHT_CLICK_ATTEMPT":
      return settings.blockRightClick ? "MEDIUM" : "LOW";
    case "NETWORK_OFFLINE":
      return "MEDIUM";
    case "NETWORK_ONLINE":
      return "INFO";
    case "AUTOSAVE_FAILED":
      return "MEDIUM";
    case "TIMER_EXPIRED":
      return "HIGH";
  }
}

export default function TakeExamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);
  const router = useRouter();

  const [data, setData] = useState<SubmissionData | null>(null);
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [remainingSecs, setRemainingSecs] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [gateAcknowledged, setGateAcknowledged] = useState(false);
  const [fullscreenDenied, setFullscreenDenied] = useState(false);
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const lastEventAt = useRef<Partial<Record<IntegrityEventType, number>>>({});
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch(`/api/submissions/${id}`)
      .then((res) => res.json())
      .then((d: SubmissionData) => {
        setData(d);
        const initial: Record<string, string> = {};
        d.answers.forEach((a) => {
          if (a.response != null) initial[a.questionId] = a.response;
        });
        setResponses(initial);
      });
  }, [id]);

  const secureSettings = data?.exam.secureSettings;
  const secureModeEnabled = secureSettings?.secureModeEnabled ?? false;

  const reportIntegrityEvent = useCallback(
    (eventType: IntegrityEventType) => {
      if (!data || data.status !== "IN_PROGRESS" || !secureSettings) return;

      const debounceMs = DEBOUNCE_MS[eventType];
      const now = Date.now();
      const last = lastEventAt.current[eventType];
      if (debounceMs && last && now - last < debounceMs) {
        return;
      }
      lastEventAt.current[eventType] = now;

      const severity = severityFor(eventType, secureSettings);
      const message = MESSAGES[eventType];

      fetch(`/api/submissions/${id}/integrity-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventType, severity, message, occurredAt: new Date().toISOString() }),
      }).catch(() => {
        // Reporting failures should never interrupt the exam session.
      });

      if (secureSettings.showIntegrityWarningToStudent && (severity === "MEDIUM" || severity === "HIGH")) {
        setBanner(`Exam integrity event recorded: ${message} Please remain in the exam window.`);
        if (bannerTimer.current) clearTimeout(bannerTimer.current);
        bannerTimer.current = setTimeout(() => setBanner(null), 8000);
      }
    },
    [data, id, secureSettings],
  );

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitMessage(null);
    const res = await fetch(`/api/submissions/${id}/submit`, { method: "POST" });
    setSubmitting(false);

    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      setSubmitMessage(
        typeof body.error === "string" ? body.error : "This exam can no longer be submitted.",
      );
      return;
    }

    if (res.ok) {
      const updated = await res.json();
      setData((prev) => (prev ? { ...prev, status: updated.status, totalScore: updated.totalScore } : prev));
      router.refresh();
    }
  }

  useEffect(() => {
    if (!data || data.status !== "IN_PROGRESS") return;
    const tick = () => {
      const secs = Math.max(0, Math.floor((new Date(data.deadline).getTime() - Date.now()) / 1000));
      setRemainingSecs(secs);
      if (secs === 0) {
        reportIntegrityEvent("TIMER_EXPIRED");
        if (data.exam.secureSettings.autoSubmitOnTimerEnd) handleSubmit();
      }
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    if (!data || data.status !== "IN_PROGRESS" || !secureModeEnabled || !secureSettings) return;

    const onFullscreenChange = () => {
      const active = Boolean(document.fullscreenElement);
      setIsFullscreen(active);
      if (!active) reportIntegrityEvent("FULLSCREEN_EXIT");
    };
    const onBlur = () => secureSettings.trackWindowBlur && reportIntegrityEvent("WINDOW_BLUR");
    const onFocus = () => secureSettings.trackWindowBlur && reportIntegrityEvent("WINDOW_FOCUS_RETURN");
    const onCopy = () => reportIntegrityEvent("COPY_ATTEMPT");
    const onPaste = () => reportIntegrityEvent("PASTE_ATTEMPT");
    const onContextMenu = () => reportIntegrityEvent("RIGHT_CLICK_ATTEMPT");
    const onOffline = () => reportIntegrityEvent("NETWORK_OFFLINE");
    const onOnline = () => reportIntegrityEvent("NETWORK_ONLINE");

    document.addEventListener("fullscreenchange", onFullscreenChange);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);
    document.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);

    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [data, secureModeEnabled, secureSettings, reportIntegrityEvent]);

  async function enterFullscreen(): Promise<boolean> {
    try {
      await document.documentElement.requestFullscreen();
      setFullscreenDenied(false);
      return true;
    } catch {
      setFullscreenDenied(true);
      return false;
    }
  }

  async function handleStartSecureExam() {
    if (secureSettings?.requireFullscreen) {
      const ok = await enterFullscreen();
      if (!ok) return; // stay on the checklist; never trap the student
    }
    setGateAcknowledged(true);
  }

  const saveAnswer = useCallback(
    (questionId: string, response: string) => {
      clearTimeout(saveTimers.current[questionId]);
      saveTimers.current[questionId] = setTimeout(() => {
        fetch(`/api/submissions/${id}/answers`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ questionId, response }),
        })
          .then((res) => {
            if (!res.ok && secureModeEnabled) reportIntegrityEvent("AUTOSAVE_FAILED");
          })
          .catch(() => {
            if (secureModeEnabled) reportIntegrityEvent("AUTOSAVE_FAILED");
          });
      }, 600);
    },
    [id, secureModeEnabled, reportIntegrityEvent],
  );

  function handleChange(questionId: string, value: string) {
    setResponses((prev) => ({ ...prev, [questionId]: value }));
    saveAnswer(questionId, value);
  }

  if (!data) return <p className="text-gray-500">Loading...</p>;

  if (data.status !== "IN_PROGRESS") {
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold">{data.exam.title}</h1>
        {data.status === "SUBMITTED" && (
          <p className="mt-4 text-gray-600">
            Submitted. Some answers require manual grading — check back later.
          </p>
        )}
        {data.status === "GRADED" && (
          <div className="mt-4">
            <p className="text-lg">
              Score: <span className="font-semibold">{data.totalScore}</span>
            </p>
            <div className="mt-4 space-y-3">
              {data.exam.questions.map((q) => {
                const answer = data.answers.find((a) => a.questionId === q.id);
                return (
                  <div key={q.id} className="rounded border border-gray-200 p-3">
                    <p className="text-sm text-gray-500">{q.points} pt(s)</p>
                    <p>{q.text}</p>
                    <p className="mt-1 text-sm text-gray-600">
                      Your answer: {answer?.response ?? "(no answer)"}
                    </p>
                    {answer?.score != null && (
                      <p className="text-sm text-green-700">Score: {answer.score}</p>
                    )}
                    {answer?.feedback && (
                      <p className="text-sm text-gray-500">Feedback: {answer.feedback}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (secureModeEnabled && !gateAcknowledged) {
    return (
      <div className="mx-auto max-w-lg">
        <h1 className="text-2xl font-semibold">{data.exam.title}</h1>
        <div className="mt-4 rounded border border-gray-200 p-4">
          <p className="font-medium">Before you begin</p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-gray-700">
            <li>The exam timer will start as soon as you begin and cannot be paused.</li>
            <li>Stay in the exam window for the duration of the exam.</li>
            <li>
              Fullscreen is {secureSettings?.requireFullscreen ? "required" : "recommended"} for
              this exam.
            </li>
            {(secureSettings?.blockCopyPaste || secureSettings?.blockRightClick) && (
              <li>Copy/paste and right-click may be restricted during this exam.</li>
            )}
            <li>Exam integrity signals (such as switching windows) may be recorded for lecturer review.</li>
            <li>Network interruptions during the exam may be logged.</li>
            <li>
              Your lecturer and institution make the final academic integrity decision — recorded
              signals are evidence for human review, not an automatic judgment.
            </li>
          </ul>

          {fullscreenDenied && (
            <p className="mt-3 text-sm text-red-600">
              Fullscreen was not enabled. Your browser may have blocked the request — try clicking
              the button again, or check your browser&apos;s permission prompt.
            </p>
          )}

          <button
            onClick={handleStartSecureExam}
            className="mt-4 rounded bg-black px-4 py-2 text-sm text-white"
          >
            Start secure exam
          </button>
          <a
            href="/privacy/student-exam-notice"
            target="_blank"
            rel="noreferrer"
            className="mt-3 block text-xs underline"
          >
            What does this record?
          </a>
        </div>
      </div>
    );
  }

  const minutes = remainingSecs != null ? Math.floor(remainingSecs / 60) : null;
  const seconds = remainingSecs != null ? remainingSecs % 60 : null;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{data.exam.title}</h1>
        {remainingSecs != null && (
          <span className="rounded bg-gray-100 px-3 py-1 font-mono text-sm">
            {String(minutes).padStart(2, "0")}:{String(seconds).padStart(2, "0")}
          </span>
        )}
      </div>

      {secureModeEnabled && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
          <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">
            Secure Exam Mode active
          </span>
          <span>Integrity events are logged for review.</span>
          {secureSettings?.requireFullscreen && !isFullscreen && (
            <>
              <span className="text-gray-500">Fullscreen required.</span>
              <button
                onClick={enterFullscreen}
                className="rounded border border-gray-300 bg-white px-2 py-1 text-xs"
              >
                Enter fullscreen
              </button>
            </>
          )}
          <a href="/privacy/student-exam-notice" target="_blank" rel="noreferrer" className="text-xs underline">
            What does this record?
          </a>
        </div>
      )}

      {banner && (
        <div className="mt-3 rounded border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
          {banner}
        </div>
      )}

      <div className="mt-6 space-y-4">
        {data.exam.questions.map((q, i) => (
          <div key={q.id} className="rounded border border-gray-200 p-4">
            <p className="text-sm text-gray-500">
              Q{i + 1} · {q.points} pt(s)
            </p>
            <p className="mt-1">{q.text}</p>

            {q.type === "MULTIPLE_CHOICE" && q.options && (
              <div className="mt-2 space-y-1">
                {q.options.map((opt) => (
                  <label key={opt} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={q.id}
                      value={opt}
                      checked={responses[q.id] === opt}
                      onChange={(e) => handleChange(q.id, e.target.value)}
                    />
                    {opt}
                  </label>
                ))}
              </div>
            )}

            {q.type === "SHORT_ANSWER" && (
              <input
                className="mt-2 w-full rounded border border-gray-300 px-3 py-2"
                value={responses[q.id] ?? ""}
                onChange={(e) => handleChange(q.id, e.target.value)}
              />
            )}

            {q.type === "ESSAY" && (
              <textarea
                rows={5}
                className="mt-2 w-full rounded border border-gray-300 px-3 py-2"
                value={responses[q.id] ?? ""}
                onChange={(e) => handleChange(q.id, e.target.value)}
              />
            )}
          </div>
        ))}
      </div>

      <button
        onClick={handleSubmit}
        disabled={submitting}
        className="mt-6 rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {submitting ? "Submitting..." : "Submit exam"}
      </button>
      {submitMessage && <p className="mt-2 text-sm text-red-600">{submitMessage}</p>}
    </div>
  );
}
