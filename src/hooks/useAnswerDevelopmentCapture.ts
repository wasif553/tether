"use client";

/**
 * Answer-Development Provenance v1 — client hook. See
 * docs/answer-development-provenance-v1.md.
 *
 * Thin, DOM-free adapter: owns no state beyond in-memory refs, delegates
 * every actual decision to the server (src/lib/answerDevelopment.ts via
 * the checkpoint route) — this hook never decides what "substantial"
 * means, it only decides WHEN to ask. THIS IS PROCESS EVIDENCE, NOT A
 * MISCONDUCT DETECTOR: never records individual keystrokes; a large
 * single-step text-length jump (a real paste always arrives as ONE
 * onChange event containing the whole inserted block, unlike typing,
 * which arrives as many single-character events) is used purely to
 * decide WHEN to checkpoint sooner than the next timer tick — never to
 * read clipboard contents directly (no Clipboard API is used anywhere
 * here).
 */
import { useCallback, useEffect, useRef } from "react";
import { LARGE_PASTE_MIN_INSERTED_CHARS } from "@/lib/answerDevelopmentThresholds";

export type AnswerDevelopmentCaptureOptions = {
  submissionId: string;
  enabled: boolean;
  intervalSeconds: number;
};

export type CheckpointSource = "AUTOSAVE" | "TIMER" | "PASTE" | "NAVIGATION" | "SUBMISSION" | "STUDENT_ACTION";

export function useAnswerDevelopmentCapture({ submissionId, enabled, intervalSeconds }: AnswerDevelopmentCaptureOptions) {
  const latestTextRef = useRef<Record<string, string>>({});
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const flushNow = useCallback(
    (questionId: string, text: string, source: CheckpointSource, pasteInsertedChars?: number) => {
      if (!enabledRef.current) return;
      fetch(`/api/submissions/${submissionId}/answer-development/checkpoint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questionId,
          response: text,
          source,
          clientRequestId: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
          pasteInsertedChars,
        }),
      }).catch(() => {
        // Never blocks the student — a missed checkpoint is not a lost
        // answer (the ordinary autosave path is completely independent).
      });
    },
    [submissionId],
  );

  const notifyTextChange = useCallback(
    (questionId: string, text: string) => {
      const prior = latestTextRef.current[questionId] ?? "";
      latestTextRef.current[questionId] = text;
      if (!enabledRef.current) return;
      const delta = text.length - prior.length;
      if (delta >= LARGE_PASTE_MIN_INSERTED_CHARS) {
        flushNow(questionId, text, "PASTE", delta);
      }
    },
    [flushNow],
  );

  const flushNavigation = useCallback(
    (questionId: string, text: string) => {
      flushNow(questionId, text, "NAVIGATION");
    },
    [flushNow],
  );

  const flushManual = useCallback(
    (questionId: string, text: string) => {
      flushNow(questionId, text, "STUDENT_ACTION");
    },
    [flushNow],
  );

  // Single periodic tick covers every question the student has touched —
  // simpler and just as correct as a per-question timer, and works
  // uniformly for both one-question-at-a-time and full-paper delivery.
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      for (const [questionId, text] of Object.entries(latestTextRef.current)) {
        flushNow(questionId, text, "TIMER");
      }
    }, Math.max(30, intervalSeconds) * 1000);
    return () => clearInterval(id);
  }, [enabled, intervalSeconds, flushNow]);

  return { notifyTextChange, flushNavigation, flushManual };
}
