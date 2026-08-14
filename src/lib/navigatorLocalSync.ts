/**
 * Question-navigator immediate-local-synchronization (Tether v1.7.6). See
 * docs/one-question-delivery-v1.md / docs/question-navigator-v1.md.
 *
 * Physical testing found the top question navigator visually updates
 * roughly 2-3 seconds AFTER the new question is already on screen.
 * Confirmed cause: the exam page's navigator refresh always waited on a
 * full GET /api/submissions/[id]/question-navigator round trip AFTER
 * save-and-navigate's own response had already delivered everything
 * needed to update the CURRENT/ANSWERED/SKIPPED tiles and every tile's
 * locked/canNavigate state, using only the EXISTING pure navigation rules
 * in src/lib/questionNavigator.ts — no new server data, no extra request.
 *
 * Deliberately does NOT touch `progress` (answeredCount/unansweredCount/
 * flaggedCount/visitedCount): the client-facing navigator tile shape only
 * ever carries the already-collapsed `state` string (CURRENT/ANSWERED/
 * SKIPPED/NOT_VISITED), never the raw answered/visited booleans
 * summariseQuestionProgress needs server-side — recomputing counts
 * exactly here would require information this module was never given.
 * The existing background loadNavigator() refresh (unchanged, still runs
 * after every navigation) reconciles progress/counts and any other
 * server-only metadata shortly after — the navigator stays exactly what
 * it already was: a progress display, never a security source of truth.
 *
 * Pure, dependency-free — no DOM, no React, no fetch.
 */
import { canNavigateToQuestion, isMeaningfulAnswer, type QuestionDisplayState } from "@/lib/questionNavigator";

export type LocalNavigatorTile = {
  questionId: string;
  index: number;
  number: number;
  state: QuestionDisplayState;
  flaggedForReview: boolean;
  locked: boolean;
  canNavigate: boolean;
};

export type LocalNavigatorSnapshot = {
  submissionId: string;
  currentQuestionIndex: number;
  totalQuestions: number;
  settings: {
    showQuestionNavigator: boolean;
    allowQuestionJumping: boolean;
    allowBackNavigation: boolean;
    allowFlagForReview: boolean;
  };
  progress: {
    answeredCount: number;
    unansweredCount: number;
    flaggedCount: number;
    visitedCount: number;
  };
  questions: LocalNavigatorTile[];
};

export type ApplyLocalNavigatorTransitionParams = {
  /** The question the student is navigating AWAY from. */
  previousQuestionId: string;
  /**
   * The server-authoritative final text for that question — on a
   * combined save-and-navigate response this is ALWAYS
   * `result.authoritativeResponse` regardless of SAVED/CONFLICT (on
   * SAVED it equals the submitted text; on CONFLICT it's the server's
   * own kept text — see useResilientAutosave.ts's
   * resolveSaveAndNavigateAcknowledgement). For a clean (nothing-dirty)
   * navigation, this is simply the already-acknowledged local text.
   * Never the raw local draft blindly — a rejected/stale draft must
   * never be classified as this question's answered state.
   */
  previousAuthoritativeResponse: string | null;
  /** The question the student is navigating TO — this function is never called before the server's own response has already authorised the move. */
  newQuestionId: string;
  newIndex: number;
};

/**
 * Immediately derives the post-navigation navigator snapshot from the
 * PREVIOUS snapshot plus the just-completed navigation's own outcome — no
 * new fetch. Implements Part 8's exact steps: (1) currentQuestionIndex
 * moves to newIndex; (2)/(4) the previous CURRENT tile becomes ANSWERED
 * (meaningful response) or SKIPPED (empty/whitespace), the new tile
 * becomes CURRENT; every OTHER tile's `state` is left untouched (this
 * function has no new information about them); (5) locked/canNavigate are
 * recomputed for EVERY tile via the existing pure canNavigateToQuestion
 * rule — a pure function of index/currentIndex/settings alone, never
 * per-question answer data, so this is always exact, never approximate;
 * (6) flaggedForReview is preserved unchanged for every tile.
 */
export function applyLocalNavigatorTransition(
  snapshot: LocalNavigatorSnapshot,
  params: ApplyLocalNavigatorTransitionParams,
): LocalNavigatorSnapshot {
  const { previousQuestionId, previousAuthoritativeResponse, newQuestionId, newIndex } = params;
  const previousMeaningful = isMeaningfulAnswer("SHORT_ANSWER", previousAuthoritativeResponse);
  const questions = snapshot.questions.map((tile) => {
    let state = tile.state;
    if (tile.questionId === newQuestionId) {
      state = "CURRENT";
    } else if (tile.questionId === previousQuestionId) {
      state = previousMeaningful ? "ANSWERED" : "SKIPPED";
    }
    const authorisation = canNavigateToQuestion({
      targetIndex: tile.index,
      currentIndex: newIndex,
      totalQuestions: snapshot.totalQuestions,
      allowQuestionJumping: snapshot.settings.allowQuestionJumping,
      allowBackNavigation: snapshot.settings.allowBackNavigation,
      submissionInProgress: true,
    });
    return { ...tile, state, locked: !authorisation.allowed, canNavigate: authorisation.allowed };
  });
  return { ...snapshot, currentQuestionIndex: newIndex, questions };
}
