import { prisma } from "@/lib/prisma";

export const PASS_THRESHOLD_PCT = 50;
export const REVIEW_THRESHOLD_PCT = 40;

export function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function scorePercentage(score: number, maxScore: number): number | null {
  if (maxScore <= 0) return null;
  return (score / maxScore) * 100;
}

export function passRatePct(
  scoresPct: number[],
  threshold: number = PASS_THRESHOLD_PCT,
): number | null {
  if (scoresPct.length === 0) return null;
  const passed = scoresPct.filter((s) => s >= threshold).length;
  return (passed / scoresPct.length) * 100;
}

export function completionRatePct(submitted: number, started: number): number | null {
  if (started <= 0) return null;
  return (submitted / started) * 100;
}

export type ScoreBand = { band: string; min: number; max: number; count: number };

export function scoreDistributionBands(scoresPct: number[]): ScoreBand[] {
  const bands: ScoreBand[] = [];
  for (let min = 0; min < 100; min += 10) {
    const max = min === 90 ? 100 : min + 9;
    bands.push({ band: `${min}-${max}`, min, max, count: 0 });
  }
  for (const score of scoresPct) {
    const clamped = Math.min(100, Math.max(0, score));
    const index = clamped === 100 ? 9 : Math.floor(clamped / 10);
    bands[index].count += 1;
  }
  return bands;
}

export function reviewRecommendation(params: {
  attempts: number;
  correctRatePct: number | null;
  averageScorePct: number | null;
}): { reviewRecommended: boolean; reviewReason: string | null } {
  const { attempts, correctRatePct, averageScorePct } = params;

  if (attempts === 0) {
    return { reviewRecommended: false, reviewReason: null };
  }

  if (correctRatePct != null && correctRatePct < REVIEW_THRESHOLD_PCT) {
    return {
      reviewRecommended: true,
      reviewReason: `Only ${Math.round(correctRatePct)}% of students answered correctly`,
    };
  }

  if (averageScorePct != null && averageScorePct < REVIEW_THRESHOLD_PCT) {
    return {
      reviewRecommended: true,
      reviewReason: `Average score is ${Math.round(averageScorePct)}%, well below the class average`,
    };
  }

  return { reviewRecommended: false, reviewReason: null };
}

export type ExamAnalytics = {
  summary: {
    totalStudentsStarted: number;
    totalSubmitted: number;
    totalGraded: number;
    averageScorePct: number | null;
    medianScorePct: number | null;
    highestScorePct: number | null;
    lowestScorePct: number | null;
    passRatePct: number | null;
    completionRatePct: number | null;
    pendingGradingCount: number;
  };
  scoreDistribution: ScoreBand[];
  questionAnalytics: Array<{
    questionId: string;
    questionText: string;
    questionType: string;
    maxScore: number;
    attempts: number;
    correctRatePct: number | null;
    averageScorePct: number | null;
    averageTimeSpentSeconds: number | null;
    reviewRecommended: boolean;
    reviewReason: string | null;
  }>;
  studentResults: Array<{
    submissionId: string;
    studentName: string;
    studentEmail: string;
    status: string;
    scorePct: number | null;
    totalScore: number | null;
    maxScore: number | null;
    submittedAt: string | null;
    gradedAt: string | null;
  }>;
  integritySummary: {
    totalEvents: number;
    highSeverityEvents: number;
    mediumSeverityEvents: number;
    lowSeverityEvents: number;
    unresolvedEvents: number;
    studentsWithEvents: number;
  };
  insights: Array<{
    severity: "INFO" | "WARNING" | "HIGH";
    title: string;
    description: string;
    recommendedAction: string;
  }>;
};

export type IntegritySummary = ExamAnalytics["integritySummary"];

export function summarizeIntegrityEvents(
  events: Array<{ severity: "INFO" | "LOW" | "MEDIUM" | "HIGH"; studentId: string; resolvedAt: Date | null }>,
): IntegritySummary {
  return {
    totalEvents: events.length,
    highSeverityEvents: events.filter((e) => e.severity === "HIGH").length,
    mediumSeverityEvents: events.filter((e) => e.severity === "MEDIUM").length,
    lowSeverityEvents: events.filter((e) => e.severity === "LOW").length,
    unresolvedEvents: events.filter((e) => e.resolvedAt == null).length,
    studentsWithEvents: new Set(events.map((e) => e.studentId)).size,
  };
}

export class ExamNotFoundError extends Error {}

export async function calculateExamAnalytics(examId: string): Promise<ExamAnalytics> {
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: {
      questions: { orderBy: { order: "asc" } },
      submissions: {
        include: { student: true, answers: true },
        orderBy: { startedAt: "desc" },
      },
    },
  });

  if (!exam) throw new ExamNotFoundError(`Exam ${examId} not found`);

  const maxScore = exam.questions.reduce((sum, q) => sum + q.points, 0);

  const totalStudentsStarted = exam.submissions.length;
  const finalizedSubmissions = exam.submissions.filter((s) => s.status !== "IN_PROGRESS");
  const totalSubmitted = finalizedSubmissions.length;
  const gradedSubmissions = exam.submissions.filter((s) => s.status === "GRADED");
  const totalGraded = gradedSubmissions.length;
  const pendingGradingCount = exam.submissions.filter((s) => s.status === "SUBMITTED").length;

  const gradedScoresPct = gradedSubmissions
    .map((s) => (s.totalScore != null ? scorePercentage(s.totalScore, maxScore) : null))
    .filter((v): v is number => v != null);

  const summary: ExamAnalytics["summary"] = {
    totalStudentsStarted,
    totalSubmitted,
    totalGraded,
    averageScorePct: average(gradedScoresPct),
    medianScorePct: median(gradedScoresPct),
    highestScorePct: gradedScoresPct.length ? Math.max(...gradedScoresPct) : null,
    lowestScorePct: gradedScoresPct.length ? Math.min(...gradedScoresPct) : null,
    passRatePct: passRatePct(gradedScoresPct),
    completionRatePct: completionRatePct(totalSubmitted, totalStudentsStarted),
    pendingGradingCount,
  };

  const scoreDistribution = scoreDistributionBands(gradedScoresPct);

  const finalizedAnswersByQuestion = new Map<string, typeof exam.submissions[number]["answers"]>();
  for (const submission of finalizedSubmissions) {
    for (const answer of submission.answers) {
      const list = finalizedAnswersByQuestion.get(answer.questionId) ?? [];
      list.push(answer);
      finalizedAnswersByQuestion.set(answer.questionId, list);
    }
  }

  const questionAnalytics = exam.questions.map((question) => {
    const answers = finalizedAnswersByQuestion.get(question.id) ?? [];
    const attempts = answers.filter((a) => a.response != null && a.response !== "").length;

    const isAutoGraded = question.type === "MULTIPLE_CHOICE" || question.type === "SHORT_ANSWER";
    const correctAnswers = answers.filter((a) => a.isCorrect != null);
    const correctRatePct =
      isAutoGraded && correctAnswers.length > 0
        ? (correctAnswers.filter((a) => a.isCorrect).length / correctAnswers.length) * 100
        : null;

    const scoredAnswers = answers.filter((a) => a.score != null);
    const averageScorePct =
      question.points > 0 && scoredAnswers.length > 0
        ? average(scoredAnswers.map((a) => ((a.score ?? 0) / question.points) * 100))
        : null;

    const timedAnswers = answers.filter((a) => a.timeSpentSeconds != null);
    const averageTimeSpentSeconds =
      timedAnswers.length > 0
        ? average(timedAnswers.map((a) => a.timeSpentSeconds as number))
        : null;

    const { reviewRecommended, reviewReason } = reviewRecommendation({
      attempts,
      correctRatePct,
      averageScorePct,
    });

    return {
      questionId: question.id,
      questionText: question.text,
      questionType: question.type,
      maxScore: question.points,
      attempts,
      correctRatePct,
      averageScorePct,
      averageTimeSpentSeconds,
      reviewRecommended,
      reviewReason,
    };
  });

  const studentResults = exam.submissions.map((submission) => {
    const scorePct =
      submission.totalScore != null ? scorePercentage(submission.totalScore, maxScore) : null;
    return {
      submissionId: submission.id,
      studentName: submission.student.name,
      studentEmail: submission.student.email,
      status: submission.status,
      scorePct,
      totalScore: submission.totalScore,
      maxScore: submission.totalScore != null ? maxScore : null,
      submittedAt: submission.submittedAt?.toISOString() ?? null,
      gradedAt: submission.gradedAt?.toISOString() ?? null,
    };
  });

  const integrityEvents = await prisma.integrityEvent.findMany({ where: { examId } });
  const integritySummary = summarizeIntegrityEvents(integrityEvents);

  const insights = buildInsights(summary, questionAnalytics, integritySummary);

  return {
    summary,
    scoreDistribution,
    questionAnalytics,
    studentResults,
    integritySummary,
    insights,
  };
}

export function buildInsights(
  summary: ExamAnalytics["summary"],
  questionAnalytics: ExamAnalytics["questionAnalytics"],
  integritySummary: ExamAnalytics["integritySummary"],
): ExamAnalytics["insights"] {
  const insights: ExamAnalytics["insights"] = [];

  if (summary.totalStudentsStarted === 0) {
    insights.push({
      severity: "INFO",
      title: "No data yet",
      description: "No students have started this exam.",
      recommendedAction: "Share the exam with students once it's published.",
    });
    return insights;
  }

  if (summary.averageScorePct != null && summary.averageScorePct < REVIEW_THRESHOLD_PCT) {
    insights.push({
      severity: "WARNING",
      title: "Low average score",
      description: `The average score is ${Math.round(summary.averageScorePct)}%, below the ${REVIEW_THRESHOLD_PCT}% threshold.`,
      recommendedAction: "Review the exam difficulty and check flagged questions below.",
    });
  }

  if (summary.completionRatePct != null && summary.completionRatePct < 50) {
    insights.push({
      severity: "WARNING",
      title: "Low completion rate",
      description: `Only ${Math.round(summary.completionRatePct)}% of students who started have submitted.`,
      recommendedAction: "Check whether the exam window, duration, or access is causing drop-off.",
    });
  }

  const flaggedQuestions = questionAnalytics.filter((q) => q.reviewRecommended);
  if (flaggedQuestions.length > 0) {
    insights.push({
      severity: "HIGH",
      title: "Questions needing review",
      description: `${flaggedQuestions.length} question(s) have low correct or average scores.`,
      recommendedAction: "Check the question analysis table for wording or difficulty issues.",
    });
  }

  if (summary.pendingGradingCount > 0) {
    insights.push({
      severity: summary.pendingGradingCount >= 5 ? "WARNING" : "INFO",
      title: "Pending grading",
      description: `${summary.pendingGradingCount} submission(s) are waiting for manual grading.`,
      recommendedAction: "Grade the remaining essay/short-answer responses to finalize scores.",
    });
  }

  if (
    summary.averageScorePct != null &&
    summary.averageScorePct >= 75 &&
    summary.completionRatePct != null &&
    summary.completionRatePct >= 75
  ) {
    insights.push({
      severity: "INFO",
      title: "Strong overall performance",
      description: `Average score is ${Math.round(summary.averageScorePct)}% with ${Math.round(summary.completionRatePct)}% completion.`,
      recommendedAction: "No action needed — this exam is performing well.",
    });
  }

  if (integritySummary.highSeverityEvents > 0) {
    insights.push({
      severity: "HIGH",
      title: "High-severity integrity events require review.",
      description: `${integritySummary.highSeverityEvents} high-severity exam behaviour signal(s) were recorded.`,
      recommendedAction: "Open the integrity review page to check the flagged sessions.",
    });
  }

  if (integritySummary.unresolvedEvents > 0) {
    insights.push({
      severity: "WARNING",
      title: "Some integrity events have not yet been reviewed.",
      description: `${integritySummary.unresolvedEvents} integrity event(s) are awaiting review.`,
      recommendedAction: "Review and resolve outstanding events on the integrity review page.",
    });
  }

  if (integritySummary.totalEvents === 0 && summary.totalStudentsStarted > 0) {
    insights.push({
      severity: "INFO",
      title: "No integrity events were recorded for this exam.",
      description: "No exam behaviour signals were logged during this exam.",
      recommendedAction: "No action needed.",
    });
  }

  return insights;
}
