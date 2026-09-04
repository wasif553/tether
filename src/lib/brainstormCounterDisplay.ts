/**
 * Brainstorm attempt-counter display — see
 * src/components/AiBrainstormPanel.tsx, "Prompts remaining" panel.
 *
 * Pure formatting only — no business logic. The two counts/limits this
 * formats (per-question and per-exam/per-attempt) are computed
 * server-side, independently, from two separate scoped queries (see
 * reserveInteractionSlot in src/lib/aiAssistanceRunner.ts:
 * promptsForQuestion counts AiAssistanceInteraction rows scoped to
 * {submissionId, questionId}; promptsForAttempt counts rows scoped to
 * {submissionId} only) and configured independently per exam
 * (Exam.secureSettings.aiAssistanceMaxPromptsPerQuestion, default 3;
 * aiAssistanceMaxPromptsPerAttempt, default 10 — see secureExam.ts).
 * Both limits are real and independently meaningful (a lecturer can
 * cap hints per-question AND cap total hints for the whole exam), so
 * this never collapses them into one counter — it exists purely to
 * remove the "12 / 15" ambiguity (is that used, or remaining?) a
 * lecturer configuring both limits to the same value can otherwise
 * produce two identical-looking fractions that read as a rendering bug
 * even though the underlying counts are genuinely independent.
 */
export function formatPromptsRemainingLabel(remaining: number | null | undefined, max: number | null | undefined): string {
  if (remaining == null || max == null) return "–";
  return `${remaining} of ${max} remaining`;
}
