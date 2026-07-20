"use client";

/**
 * Controlled AI Brainstorming Assistance v1 — student panel. See
 * docs/controlled-ai-brainstorming-assistance-v1.md.
 *
 * Only ever rendered by the parent when aiAssistanceMode is
 * BRAINSTORM_ONLY for this exam (see src/app/student/exams/[id]/page.tsx)
 * — this component does not re-check that itself, since it has no access
 * to the exam's settings beyond what's passed in.
 */
import { useState } from "react";

type TranscriptEntry = {
  id: string;
  prompt: string;
  response: string | null;
  studentMessage: string | null;
  status: "APPROVED" | "FALLBACK" | "BLOCKED" | "FAILED" | "ERROR";
};

const STARTER_ACTIONS = [
  { label: "Help me understand the question", prompt: "Can you help me understand what this question is asking?" },
  { label: "Give me a starting point", prompt: "Can you give me a broad starting point for approaching this?" },
  { label: "Ask me a guiding question", prompt: "Can you ask me a guiding question to help me think this through?" },
  { label: "Help me organise my ideas", prompt: "Can you help me organise my ideas for this question?" },
  { label: "Challenge my reasoning", prompt: "Can you challenge my current reasoning on this question?" },
  { label: "Suggest what I should check", prompt: "What should I check or verify before I finalise my answer?" },
];

export function AiBrainstormPanel(props: {
  submissionId: string;
  questionId: string;
  currentResponseText: string | null;
}) {
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [customPrompt, setCustomPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [promptsRemainingForQuestion, setPromptsRemainingForQuestion] = useState<number | null>(null);
  const [promptsRemainingForAttempt, setPromptsRemainingForAttempt] = useState<number | null>(null);
  const [rateLimited, setRateLimited] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const atQuestionLimit = promptsRemainingForQuestion === 0;
  const atAttemptLimit = promptsRemainingForAttempt === 0;
  const disabled = loading || atQuestionLimit || atAttemptLimit;

  async function sendPrompt(prompt: string) {
    const trimmed = prompt.trim();
    // `disabled` (which includes `loading`) is the primary double-click
    // guard, but a client-generated idempotency key (Part 2 hardening)
    // is still sent with every request — it protects against a browser-
    // level retry of an already-sent request (e.g. a dropped connection)
    // that `disabled` alone can't catch, by letting the server recognise
    // and replay the original outcome instead of creating a second
    // interaction.
    if (!trimmed || disabled) return;
    const clientRequestId = crypto.randomUUID();
    setLoading(true);
    setRateLimited(false);
    try {
      const res = await fetch(
        `/api/submissions/${props.submissionId}/questions/${props.questionId}/ai-assistance`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            studentPrompt: trimmed,
            studentCurrentReasoning: props.currentResponseText || undefined,
            clientRequestId,
          }),
        },
      );
      const body = await res.json().catch(() => null);

      if (res.status === 429) {
        setRateLimited(true);
        return;
      }
      if (!res.ok) {
        setTranscript((prev) => [
          ...prev,
          {
            id: clientRequestId,
            prompt: trimmed,
            response: null,
            studentMessage: body?.error ?? "Something went wrong. Please try again.",
            status: "ERROR",
          },
        ]);
        return;
      }

      setPromptsRemainingForQuestion(body.promptsRemainingForQuestion ?? null);
      setPromptsRemainingForAttempt(body.promptsRemainingForAttempt ?? null);
      setTranscript((prev) => [
        ...prev,
        {
          id: clientRequestId,
          prompt: trimmed,
          response: body.response ?? null,
          studentMessage: body.studentMessage ?? null,
          status: body.status,
        },
      ]);
      setCustomPrompt("");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-3 rounded border border-indigo-200 bg-indigo-50/50">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium text-indigo-900"
      >
        <span>AI Brainstorming Assistant</span>
        <span className="text-xs font-normal text-indigo-700">{expanded ? "Hide" : "Show"}</span>
      </button>

      {expanded && (
        <div className="border-t border-indigo-200 px-3 py-3">
          <p className="text-xs text-indigo-900">
            This assistant can help you think through the task, but it will not provide the answer
            or write a response that you can submit. Interactions may be recorded as part of the
            assessment record.
          </p>

          <div className="mt-2 flex flex-wrap gap-2 text-xs text-indigo-800">
            {promptsRemainingForQuestion != null && (
              <span className="rounded bg-white px-2 py-0.5">
                {promptsRemainingForQuestion} prompt(s) left for this question
              </span>
            )}
            {promptsRemainingForAttempt != null && (
              <span className="rounded bg-white px-2 py-0.5">
                {promptsRemainingForAttempt} prompt(s) left for this attempt
              </span>
            )}
          </div>

          {(atQuestionLimit || atAttemptLimit) && (
            <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              You&apos;ve used all the assistance prompts available{" "}
              {atAttemptLimit ? "for this attempt" : "for this question"}.
            </p>
          )}
          {rateLimited && (
            <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              You&apos;re sending requests too quickly. Please wait a moment and try again.
            </p>
          )}

          <div className="mt-3 space-y-2">
            {transcript.map((entry) => (
              <div key={entry.id} className="rounded bg-white p-2 text-xs">
                <p className="font-medium text-gray-700">You: {entry.prompt}</p>
                {entry.response && <p className="mt-1 text-gray-800">Assistant: {entry.response}</p>}
                {entry.status === "BLOCKED" && entry.studentMessage && (
                  <p className="mt-1 text-amber-700">{entry.studentMessage}</p>
                )}
                {(entry.status === "ERROR" || entry.status === "FAILED") && entry.studentMessage && (
                  <p className="mt-1 text-red-600">{entry.studentMessage}</p>
                )}
              </div>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {STARTER_ACTIONS.map((action) => (
              <button
                key={action.label}
                type="button"
                disabled={disabled}
                onClick={() => sendPrompt(action.prompt)}
                className="rounded border border-indigo-300 bg-white px-2 py-1 text-xs text-indigo-800 disabled:opacity-50"
              >
                {action.label}
              </button>
            ))}
          </div>

          <div className="mt-2 flex gap-2">
            <input
              type="text"
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder="Or ask your own brainstorming question..."
              maxLength={1000}
              disabled={disabled}
              className="flex-1 rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-50"
            />
            <button
              type="button"
              disabled={disabled || !customPrompt.trim()}
              onClick={() => sendPrompt(customPrompt)}
              className="rounded border border-indigo-400 bg-indigo-600 px-3 py-1 text-xs text-white disabled:opacity-50"
            >
              {loading ? "Thinking..." : "Ask"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
