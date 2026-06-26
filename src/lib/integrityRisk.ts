/**
 * Deterministic, non-AI integrity risk scoring (Secure Exam Mode v1, Part 6).
 * This is a fixed, transparent point system — not a model — and exists only
 * to help a lecturer prioritize review. It is never shown to students and
 * never used to automatically determine a grade or misconduct outcome.
 */

export type Severity = "INFO" | "LOW" | "MEDIUM" | "HIGH";

export const SEVERITY_WEIGHTS: Record<Severity, number> = {
  INFO: 0,
  LOW: 1,
  MEDIUM: 3,
  HIGH: 7,
};

export type RiskLevel = "CLEAN" | "LOW" | "MEDIUM" | "HIGH";

export function computeRiskScore(events: Array<{ severity: Severity }>): number {
  return events.reduce((sum, e) => sum + SEVERITY_WEIGHTS[e.severity], 0);
}

export function riskLevelForScore(score: number): RiskLevel {
  if (score <= 0) return "CLEAN";
  if (score <= 4) return "LOW";
  if (score <= 12) return "MEDIUM";
  return "HIGH";
}

export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = {
  CLEAN: "Clean",
  LOW: "Low integrity risk",
  MEDIUM: "Medium integrity risk",
  HIGH: "High integrity risk",
};
