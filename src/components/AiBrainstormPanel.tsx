"use client";

/**
 * Controlled AI Brainstorming Assistance v1 — student panel. See
 * docs/controlled-ai-brainstorming-assistance-v1.md,
 * docs/question-scoped-brainstorm-sidebar-v1.md, and
 * docs/approved-exam-brainstorm-layout-v1.md.
 *
 * Only ever rendered by the parent when aiAssistanceMode is
 * BRAINSTORM_ONLY for this exam (see src/app/student/exams/[id]/page.tsx)
 * — this component does not re-check that itself, since it has no access
 * to the exam's settings beyond what's passed in.
 *
 * Question-scoped brainstorm sidebar v1 — every prior interaction for
 * THIS submission+question is loaded from the authoritative server
 * history (GET .../ai-assistance) on mount and whenever submissionId or
 * questionId changes, keyed by a request token so a fast Next/Previous
 * click can never let a stale response overwrite the now-current
 * question's transcript with the wrong one. Nothing here changes the
 * server-side guardrails, limits, or evidence semantics — this is a
 * pure read of what the server already enforces and already stored.
 *
 * Approved student exam + Brainstorm layout v2 — white panel, subtle
 * gray border, dark navy heading, teal accents, very pale teal
 * informational backgrounds, muted teal secondary text, dark
 * navy/teal primary Ask action (no purple/indigo). The sidebar
 * (`sidebar` prop true) treatment — sticky, always expanded, no mobile
 * toggle — activates at the approved >=1200px workspace breakpoint
 * (`min-[1200px]:`) rather than the default 1024px `lg:`, matching the
 * page's own 3-column grid threshold (see page.tsx).
 */
import { useEffect, useId, useRef, useState } from "react";
import { formatPromptsRemainingLabel } from "@/lib/brainstormCounterDisplay";

// RATE_LIMITED and NETWORK_ERROR are client-local only — never a status
// the server returns or persists. They exist so a 429 (rate limit) or a
// request that never reached the server (offline, DNS, connection reset)
// gets its OWN accurate, visibly-attached transcript entry, distinct from
// both a genuine provider failure (FAILED) and a guardrail redirect
// (BLOCKED/FALLBACK) — see the Brainstorm starter-action reliability
// follow-up below.
type TranscriptStatus = "APPROVED" | "FALLBACK" | "BLOCKED" | "FAILED" | "ERROR" | "RATE_LIMITED" | "NETWORK_ERROR";

type TranscriptEntry = {
  id: string;
  prompt: string;
  response: string | null;
  studentMessage: string | null;
  status: TranscriptStatus;
};

type HistoryResponse = {
  interactions: Array<{
    id: string;
    studentPrompt: string;
    response: string | null;
    studentMessage: string | null;
    status: "APPROVED" | "BLOCKED" | "FALLBACK" | "FAILED";
  }>;
  promptsRemainingForQuestion: number;
  promptsRemainingForAttempt: number;
  maxPromptsPerQuestion: number;
  maxPromptsPerAttempt: number;
};

// Exported so tests can exercise the exact strings production sends
// (rather than a hand-copied, driftable duplicate) — see
// aiAssistanceClassifier.test.ts and aiAssistance.routes.test.ts.
//
// Simplify Brainstorm actions — trimmed from six presets down to these
// two. The other four ("Give me a starting point", "Help me organise my
// ideas", "Challenge my reasoning", "Suggest what I should check") are
// deliberately removed from the panel, not merely hidden — a student can
// still ask for any of that via the free-text input, which reaches the
// exact same server pipeline (see aiAssistance.routes.test.ts's
// "Brainstorm starter actions use the exact same pipeline as a manually
// typed prompt"). Purely a UI simplification: no change to prompt
// construction, the safety verifier, or attempt accounting.
export const STARTER_ACTIONS = [
  { label: "Help me understand the question", prompt: "Can you help me understand what this question is asking?" },
  { label: "Ask me a guiding question", prompt: "Can you ask me a guiding question to help me think this through?" },
];

// A guardrail redirect (the assistant declining to hand over a final
// answer) is expected, correct behaviour — never styled like an error.
// Being rate-limited is ALSO expected, correct behaviour (never a
// provider/API failure) — pacing, not guidance, so it gets its own badge
// label below, but the same non-alarming (non-red) treatment. Only ERROR
// (a local fetch failure with a server-supplied message), FAILED (a
// genuine provider error), and NETWORK_ERROR (the request never reached
// the server at all) represent something actually going wrong.
const GUARDRAIL_STATUSES = new Set<TranscriptStatus>(["BLOCKED", "FALLBACK"]);
const PACING_STATUSES = new Set<TranscriptStatus>(["RATE_LIMITED"]);
const FAILURE_STATUSES = new Set<TranscriptStatus>(["ERROR", "FAILED", "NETWORK_ERROR"]);

export function discussingPreview(questionText: string): string {
  const collapsed = questionText.replace(/\s+/g, " ").trim();
  return collapsed.length > 70 ? `${collapsed.slice(0, 70)}…` : collapsed;
}

export function AiBrainstormPanel(props: {
  submissionId: string;
  questionId: string;
  currentResponseText: string | null;
  questionNumber: number;
  totalQuestions: number;
  questionText: string;
  /** True only for the desktop-sidebar call site (one-question-at-a-time mode) — see src/app/student/exams/[id]/page.tsx. Full-paper mode's inline-per-question panels leave this false and keep today's simple always-collapsible behaviour. */
  sidebar?: boolean;
}) {
  const inputId = useId();
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [customPrompt, setCustomPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [promptsRemainingForQuestion, setPromptsRemainingForQuestion] = useState<number | null>(null);
  const [promptsRemainingForAttempt, setPromptsRemainingForAttempt] = useState<number | null>(null);
  const [maxPromptsPerQuestion, setMaxPromptsPerQuestion] = useState<number | null>(null);
  const [maxPromptsPerAttempt, setMaxPromptsPerAttempt] = useState<number | null>(null);
  const [rateLimited, setRateLimited] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Race-condition guard (Part 12 — "Avoid race conditions"): only the
  // MOST RECENT history fetch is ever allowed to write state. A fast
  // Next/Previous can start a second fetch before the first resolves;
  // without this, the slower/first response could land after the
  // second and silently repaint the wrong question's transcript.
  const requestTokenRef = useRef(0);

  useEffect(() => {
    const myToken = ++requestTokenRef.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHistoryLoading(true);
    setTranscript([]);
    setCustomPrompt("");
    setRateLimited(false);

    fetch(`/api/submissions/${props.submissionId}/questions/${props.questionId}/ai-assistance`)
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((body: HistoryResponse) => {
        if (requestTokenRef.current !== myToken) return;
        setTranscript(
          body.interactions.map((entry) => ({
            id: entry.id,
            prompt: entry.studentPrompt,
            response: entry.response,
            studentMessage: entry.studentMessage,
            status: entry.status,
          })),
        );
        setPromptsRemainingForQuestion(body.promptsRemainingForQuestion);
        setPromptsRemainingForAttempt(body.promptsRemainingForAttempt);
        setMaxPromptsPerQuestion(body.maxPromptsPerQuestion);
        setMaxPromptsPerAttempt(body.maxPromptsPerAttempt);
      })
      .catch(() => {
        // Non-fatal — the panel still works for NEW prompts; prior
        // history for this question just can't be shown until reload.
      })
      .finally(() => {
        if (requestTokenRef.current !== myToken) return;
        setHistoryLoading(false);
      });
  }, [props.submissionId, props.questionId]);

  const atQuestionLimit = promptsRemainingForQuestion === 0;
  const atAttemptLimit = promptsRemainingForAttempt === 0;
  const disabled = sending || historyLoading || atQuestionLimit || atAttemptLimit;
  const exhaustedReasonId = `${inputId}-exhausted`;

  async function sendPrompt(prompt: string) {
    const trimmed = prompt.trim();
    // `disabled` (which includes `sending`) is the primary double-click
    // guard, but a client-generated idempotency key (Part 2 hardening)
    // is still sent with every request — it protects against a browser-
    // level retry of an already-sent request (e.g. a dropped connection)
    // that `disabled` alone can't catch, by letting the server recognise
    // and replay the original outcome instead of creating a second
    // interaction.
    if (!trimmed || disabled) return;
    const clientRequestId = crypto.randomUUID();
    setSending(true);
    setRateLimited(false);
    try {
      // Brainstorm starter-action reliability follow-up — this whole
      // block used to have NO catch around the fetch/body-parsing itself:
      // a genuine network failure (offline, DNS, connection reset) threw
      // an unhandled rejection that never reached the transcript, so the
      // click appeared to do nothing at all — easy to misread as "the
      // button/API isn't working" (see aiAssistance.routes.test.ts and
      // aiAssistanceClassifier.test.ts for confirmation that the SAME
      // pipeline, same body shape, is used for every starter action and
      // for a typed prompt — the wording was never the cause).
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
        // Rate limiting (submission-wide, content-independent — see
        // AI_ASSISTANCE_RATE_LIMIT_MAX_REQUESTS in aiAssistancePolicy.ts)
        // is expected, correct behaviour, never a provider/API failure.
        // Clicking through several starter buttons in quick succession —
        // a natural way to test "does each button work" — is the most
        // common way to hit this. Previously this only set a page-level
        // banner with NO per-click transcript entry, so the click looked
        // like it did nothing; now the student sees exactly what
        // happened, attached to the message they just sent.
        setRateLimited(true);
        setTranscript((prev) => [
          ...prev,
          {
            id: clientRequestId,
            prompt: trimmed,
            response: null,
            studentMessage: body?.error ?? "You're sending requests too quickly. Please wait a moment and try again.",
            status: "RATE_LIMITED",
          },
        ]);
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
      if (!body) throw new Error("Empty or malformed response body");

      setPromptsRemainingForQuestion(body.promptsRemainingForQuestion ?? null);
      setPromptsRemainingForAttempt(body.promptsRemainingForAttempt ?? null);
      setMaxPromptsPerQuestion(body.maxPromptsPerQuestion ?? null);
      setMaxPromptsPerAttempt(body.maxPromptsPerAttempt ?? null);
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
    } catch {
      // The request never reached the server at all (offline, DNS,
      // connection reset) or its response couldn't be understood —
      // distinct from FAILED (a genuine provider/verifier error the
      // SERVER reported) and from ERROR (a server-supplied error
      // message). Never silently swallowed — see the doc comment above
      // this try block.
      setTranscript((prev) => [
        ...prev,
        {
          id: clientRequestId,
          prompt: trimmed,
          response: null,
          studentMessage: "Could not reach the brainstorming assistant. Check your connection and try again.",
          status: "NETWORK_ERROR",
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  const remainingSummary =
    promptsRemainingForQuestion != null ? `${promptsRemainingForQuestion} prompt(s) remaining` : "";

  // Approved student exam + Brainstorm layout v1 — the sidebar
  // treatment (sticky, always expanded, no toggle) activates at the
  // same >=1200px threshold as the page's own 3-column grid
  // (min-[1200px]:, not the default 1024px lg:) — below it, Brainstorm
  // is the same collapsible section/drawer at every narrower tier.
  const bodyVisibilityClass = props.sidebar
    ? `${expanded ? "flex" : "hidden"} min-[1200px]:flex`
    : expanded
      ? "block"
      : "hidden";
  const containerClass = props.sidebar
    ? "rounded border border-gray-200 bg-white min-[1200px]:sticky min-[1200px]:top-4 min-[1200px]:flex min-[1200px]:max-h-[calc(100vh-2rem)] min-[1200px]:flex-col"
    : "mt-3 rounded border border-gray-200 bg-white";

  return (
    <section aria-label={`Tether Brainstorm, question ${props.questionNumber} of ${props.totalQuestions}`} className={containerClass}>
      {/* Mobile/narrow-screen compact toggle (Part 15) — a dedicated
          right-side panel at the approved >=1200px workspace needs no
          toggle at all (forced visible below via `min-[1200px]:flex`),
          so this control is hidden entirely at that width and above
          when acting as a sidebar. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={`flex w-full items-center justify-between px-3 py-2 text-left text-base font-medium text-slate-900 ${
          props.sidebar ? "min-[1200px]:hidden" : ""
        }`}
      >
        <span>Tether Brainstorm{remainingSummary ? ` · ${remainingSummary}` : ""}</span>
        <span className="text-xs font-normal text-teal-700">{expanded ? "Hide" : "Show"}</span>
      </button>

      <div className={`min-h-0 flex-col border-t border-gray-200 px-3 py-3 ${bodyVisibilityClass} ${props.sidebar ? "min-[1200px]:flex-1" : ""}`}>
        <div className="shrink-0">
          <h3 className="text-base font-semibold text-slate-900">✳ Tether Brainstorm</h3>
          <p className="text-sm text-teal-700">
            Question {props.questionNumber} of {props.totalQuestions}
          </p>
          <p className="mt-0.5 truncate text-sm text-slate-500" title={props.questionText}>
            Discussing: {discussingPreview(props.questionText)}
          </p>

          <div className="mt-2 rounded border border-teal-100 bg-teal-50 p-2">
            <p className="text-xs font-medium text-slate-900">AI brainstorming is allowed</p>
            <p className="text-xs text-teal-700">Guidance only · Interactions are recorded</p>
          </div>
          <details className="mt-1 text-xs">
            <summary className="cursor-pointer select-none text-teal-700 underline underline-offset-2 hover:text-teal-800">
              About AI assistance
            </summary>
            <p className="mt-1 text-slate-600">
              Use this assistant for guidance, planning and reasoning support during this assessment. It is
              restricted from providing final answers. Your prompts and the responses shown to you are
              recorded as part of this assessment.
            </p>
          </details>

          <div className="mt-2 rounded border border-gray-200 bg-white p-2 text-xs">
            <p className="font-medium text-slate-900">Prompts remaining</p>
            {/* Brainstorm counter clarity pass — "This question" and "This
                exam" are two genuinely independent limits (see
                src/lib/brainstormCounterDisplay.ts's own doc comment for
                why), each stated unambiguously as "N of M remaining" —
                never a bare "N / M" fraction, which reads as ambiguous
                (used vs. remaining) and, when a lecturer has configured
                both limits to the same value, can look like a display bug
                even though the two counts are computed independently. */}
            <div className="mt-1 flex items-center justify-between text-slate-700">
              <span>This question</span>
              <span className="font-mono font-semibold tabular-nums text-teal-700">
                {formatPromptsRemainingLabel(promptsRemainingForQuestion, maxPromptsPerQuestion)}
              </span>
            </div>
            <div className="flex items-center justify-between text-slate-700">
              <span>This exam</span>
              <span className="font-mono font-semibold tabular-nums text-teal-700">
                {formatPromptsRemainingLabel(promptsRemainingForAttempt, maxPromptsPerAttempt)}
              </span>
            </div>
          </div>

          {(atQuestionLimit || atAttemptLimit) && (
            <p id={exhaustedReasonId} role="status" className="mt-2 rounded border border-gray-200 bg-gray-50 p-2 text-xs text-gray-700">
              {atAttemptLimit ? "No AI prompts remaining for this exam" : "No prompts remaining for this question"}
              <br />
              You can continue answering normally.
            </p>
          )}
          {rateLimited && (
            <p role="status" className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              You&apos;re sending requests too quickly. Please wait a moment and try again.
            </p>
          )}
        </div>

        <div className={`mt-3 min-h-0 space-y-2 ${props.sidebar ? "min-[1200px]:flex-1 min-[1200px]:overflow-y-auto" : ""}`}>
          {historyLoading && <p className="text-xs text-slate-500">Loading brainstorming...</p>}
          {!historyLoading && transcript.length === 0 && (
            <div className="rounded border border-teal-100 bg-teal-50/60 p-2">
              <p className="text-xs text-slate-600">No brainstorming yet for this question.</p>
              <p className="text-xs text-slate-600">Try one of the suggestions below or ask your own.</p>
            </div>
          )}
          {!historyLoading &&
            transcript.map((entry) => {
              const isGuardrail = GUARDRAIL_STATUSES.has(entry.status);
              const isPacing = PACING_STATUSES.has(entry.status);
              const isFailure = FAILURE_STATUSES.has(entry.status);
              return (
                <div key={entry.id} className="space-y-1 rounded border border-gray-200 bg-white p-2 text-sm leading-[1.5]">
                  <p>
                    <span className="font-medium text-slate-700">You</span>
                    <span className="ml-1 text-slate-800">{entry.prompt}</span>
                  </p>
                  <div className="border-t border-gray-100 pt-1">
                    <p className="flex items-center gap-1.5">
                      <span className="font-medium text-slate-900">Tether</span>
                      {isGuardrail && (
                        <span className="rounded bg-teal-50 px-1.5 py-0.5 text-[10px] font-medium text-teal-700">
                          Guidance only
                        </span>
                      )}
                      {isPacing && (
                        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                          Please wait
                        </span>
                      )}
                    </p>
                    {entry.response && <p className="mt-0.5 text-slate-800">{entry.response}</p>}
                    {(isGuardrail || isPacing) && !entry.response && entry.studentMessage && (
                      <p className="mt-0.5 text-slate-800">{entry.studentMessage}</p>
                    )}
                    {isFailure && entry.studentMessage && <p className="mt-0.5 text-red-600">{entry.studentMessage}</p>}
                  </div>
                </div>
              );
            })}
        </div>

        <div className="mt-3 shrink-0">
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {STARTER_ACTIONS.map((action) => (
              <button
                key={action.label}
                type="button"
                disabled={disabled}
                aria-describedby={atQuestionLimit || atAttemptLimit ? exhaustedReasonId : undefined}
                onClick={() => sendPrompt(action.prompt)}
                className="rounded border border-gray-300 bg-white px-2 py-1 text-left text-[13px] text-slate-700 hover:border-teal-300 hover:bg-teal-50/50 disabled:opacity-50"
              >
                {action.label}
              </button>
            ))}
          </div>

          {/* Enter-to-submit — a single <form onSubmit> path (Part 6's own
              preferred implementation) rather than a separate onKeyDown
              handler: pressing Enter in this single-line input and
              clicking the "Ask" button both trigger this ONE onSubmit,
              so there is no second submission code path to keep in sync
              and no risk of a duplicate request from both firing at once.
              The submit button's own `disabled` expression (identical to
              the one already guarding the click handler below — empty/
              whitespace input, a request already in flight, or prompts
              exhausted) is reused as-is: per the HTML implicit-submission
              spec, a disabled default submit button also blocks Enter
              from submitting the form, so there is no separate Enter-
              specific validation to maintain. A plain single-line
              <input type="text"> does not treat an IME-composition-
              confirming Enter as a submit trigger either — native
              browser behaviour, not something this handler needs to
              guard against itself. */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendPrompt(customPrompt);
            }}
            className="mt-2 flex gap-2"
          >
            <label htmlFor={inputId} className="sr-only">
              Ask Tether Brainstorm a question
            </label>
            <input
              id={inputId}
              type="text"
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder="Ask your own question..."
              maxLength={1000}
              disabled={disabled}
              aria-describedby={atQuestionLimit || atAttemptLimit ? exhaustedReasonId : undefined}
              className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={disabled || !customPrompt.trim()}
              className="rounded border border-teal-700 bg-teal-700 px-3 py-1 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50"
            >
              {sending ? "Thinking..." : "Ask"}
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
