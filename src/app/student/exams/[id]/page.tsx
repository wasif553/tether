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

type SubmissionData = {
  id: string;
  status: "IN_PROGRESS" | "SUBMITTED" | "GRADED";
  deadline: string;
  totalScore: number | null;
  exam: { id: string; title: string; questions: Question[] };
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
  | "TIMER_EXPIRED";

type IntegritySeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH";

const EVENT_DETAILS: Record<
  IntegrityEventType,
  { severity: IntegritySeverity; message: string; debounceMs?: number }
> = {
  FULLSCREEN_EXIT: { severity: "MEDIUM", message: "You exited fullscreen mode." },
  WINDOW_BLUR: {
    severity: "LOW",
    message: "You switched away from the exam window.",
    debounceMs: 10_000,
  },
  WINDOW_FOCUS_RETURN: { severity: "INFO", message: "You returned to the exam window." },
  COPY_ATTEMPT: {
    severity: "MEDIUM",
    message: "A copy action was attempted.",
    debounceMs: 5_000,
  },
  PASTE_ATTEMPT: {
    severity: "MEDIUM",
    message: "A paste action was attempted.",
    debounceMs: 5_000,
  },
  RIGHT_CLICK_ATTEMPT: { severity: "LOW", message: "A right-click was attempted." },
  NETWORK_OFFLINE: { severity: "MEDIUM", message: "Your connection appears to be offline." },
  NETWORK_ONLINE: { severity: "INFO", message: "Your connection is back online." },
  TIMER_EXPIRED: { severity: "HIGH", message: "The exam timer has expired." },
};

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
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
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

  useEffect(() => {
    if (!data || data.status !== "IN_PROGRESS") return;
    const tick = () => {
      const secs = Math.max(
        0,
        Math.floor((new Date(data.deadline).getTime() - Date.now()) / 1000),
      );
      setRemainingSecs(secs);
      if (secs === 0) {
        reportIntegrityEvent("TIMER_EXPIRED");
        handleSubmit();
      }
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const reportIntegrityEvent = useCallback(
    (eventType: IntegrityEventType) => {
      if (!data || data.status !== "IN_PROGRESS") return;

      const details = EVENT_DETAILS[eventType];
      const now = Date.now();
      const last = lastEventAt.current[eventType];
      if (details.debounceMs && last && now - last < details.debounceMs) {
        return;
      }
      lastEventAt.current[eventType] = now;

      fetch(`/api/submissions/${id}/integrity-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType,
          severity: details.severity,
          message: details.message,
          occurredAt: new Date().toISOString(),
        }),
      }).catch(() => {
        // Reporting failures should never interrupt the exam session.
      });

      if (details.severity === "MEDIUM" || details.severity === "HIGH") {
        setBanner(
          `Exam integrity event recorded: ${details.message} Please remain in the exam window.`,
        );
        if (bannerTimer.current) clearTimeout(bannerTimer.current);
        bannerTimer.current = setTimeout(() => setBanner(null), 8000);
      }
    },
    [data, id],
  );

  useEffect(() => {
    if (!data || data.status !== "IN_PROGRESS") return;

    const onFullscreenChange = () => {
      const active = Boolean(document.fullscreenElement);
      setIsFullscreen(active);
      if (!active) reportIntegrityEvent("FULLSCREEN_EXIT");
    };
    const onBlur = () => reportIntegrityEvent("WINDOW_BLUR");
    const onFocus = () => reportIntegrityEvent("WINDOW_FOCUS_RETURN");
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
  }, [data, reportIntegrityEvent]);

  async function enterFullscreen() {
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      // Fullscreen may be unavailable in this browser/context; exam continues either way.
    }
  }

  const saveAnswer = useCallback(
    (questionId: string, response: string) => {
      clearTimeout(saveTimers.current[questionId]);
      saveTimers.current[questionId] = setTimeout(() => {
        fetch(`/api/submissions/${id}/answers`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ questionId, response }),
        });
      }, 600);
    },
    [id],
  );

  function handleChange(questionId: string, value: string) {
    setResponses((prev) => ({ ...prev, [questionId]: value }));
    saveAnswer(questionId, value);
  }

  async function handleSubmit() {
    setSubmitting(true);
    const res = await fetch(`/api/submissions/${id}/submit`, { method: "POST" });
    setSubmitting(false);
    if (res.ok) {
      const updated = await res.json();
      setData((prev) => (prev ? { ...prev, status: updated.status, totalScore: updated.totalScore } : prev));
      router.refresh();
    }
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

      <div className="mt-3 flex flex-wrap items-center gap-2 rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
        <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">
          Secure exam mode active
        </span>
        <span>Integrity events are logged for review.</span>
        {!isFullscreen && (
          <>
            <span className="text-gray-500">Fullscreen recommended.</span>
            <button
              onClick={enterFullscreen}
              className="rounded border border-gray-300 bg-white px-2 py-1 text-xs"
            >
              Enter fullscreen
            </button>
          </>
        )}
      </div>

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
    </div>
  );
}
