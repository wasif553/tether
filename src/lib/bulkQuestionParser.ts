/**
 * Assessment Operations v1 — bulk question entry. See
 * docs/assessment-operations-v1.md for the accepted text format.
 *
 * Pure, dependency-free parsing/validation so the exact same logic runs
 * client-side (instant preview as the lecturer types) and server-side
 * (the API route re-parses the raw text itself rather than trusting a
 * client-computed result — the server is the only place that actually
 * persists anything).
 *
 * Format (one or more blocks, blank lines between blocks are optional):
 *
 *   QUESTION:
 *   What is 2 + 2?
 *   TYPE: MCQ
 *   OPTIONS:
 *   A. 3
 *   B. 4
 *   C. 5
 *   D. 6
 *   ANSWER: B
 *   POINTS: 1
 *
 * TYPE accepts MCQ (alias for MULTIPLE_CHOICE), SHORT_ANSWER, or ESSAY.
 * OPTIONS/ANSWER are required for MCQ only. POINTS defaults to 1 if
 * omitted.
 */

export type BulkQuestionType = "MULTIPLE_CHOICE" | "SHORT_ANSWER" | "ESSAY";

export type ParsedQuestionRow = {
  row: number;
  raw: string;
  type: BulkQuestionType | null;
  text: string;
  options: string[];
  correctAnswer: string | null;
  points: number | null;
  errors: string[];
};

export type BulkParseResult = {
  rows: ParsedQuestionRow[];
  validCount: number;
  invalidCount: number;
};

const TYPE_ALIASES: Record<string, BulkQuestionType> = {
  MCQ: "MULTIPLE_CHOICE",
  MULTIPLE_CHOICE: "MULTIPLE_CHOICE",
  SHORT_ANSWER: "SHORT_ANSWER",
  ESSAY: "ESSAY",
};

function splitIntoBlocks(input: string): string[] {
  const lines = input.split(/\r?\n/);
  const blocks: string[][] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    if (/^\s*QUESTION\s*:/i.test(line)) {
      if (current) blocks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current);

  return blocks.map((b) => b.join("\n").trim()).filter((b) => b.length > 0);
}

function parseBlock(block: string, row: number): ParsedQuestionRow {
  const lines = block.split(/\r?\n/);
  const errors: string[] = [];

  const textLines: string[] = [];
  let type: BulkQuestionType | null = null;
  const options: string[] = [];
  let correctAnswer: string | null = null;
  let points: number | null = null;

  let section: "text" | "options" | null = "text";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^QUESTION\s*:/i.test(line)) {
      const rest = line.replace(/^QUESTION\s*:/i, "").trim();
      if (rest) textLines.push(rest);
      section = "text";
      continue;
    }
    const typeMatch = line.match(/^TYPE\s*:\s*(.+)$/i);
    if (typeMatch) {
      const key = typeMatch[1].trim().toUpperCase();
      type = TYPE_ALIASES[key] ?? null;
      if (!type) errors.push(`Unknown TYPE "${typeMatch[1].trim()}" — expected MCQ, SHORT_ANSWER, or ESSAY`);
      section = null;
      continue;
    }
    if (/^OPTIONS\s*:/i.test(line)) {
      section = "options";
      continue;
    }
    const answerMatch = line.match(/^ANSWER\s*:\s*(.+)$/i);
    if (answerMatch) {
      correctAnswer = answerMatch[1].trim();
      section = null;
      continue;
    }
    const pointsMatch = line.match(/^POINTS\s*:\s*(.+)$/i);
    if (pointsMatch) {
      const n = Number(pointsMatch[1].trim());
      points = Number.isFinite(n) ? n : null;
      if (points == null) errors.push(`POINTS "${pointsMatch[1].trim()}" is not a number`);
      section = null;
      continue;
    }
    const optionMatch = line.match(/^([A-Z])\.\s*(.+)$/);
    if (section === "options" && optionMatch) {
      options.push(optionMatch[2].trim());
      continue;
    }
    if (section === "text" && line) {
      textLines.push(line);
    }
  }

  const text = textLines.join(" ").trim();
  if (!text) errors.push("Question text is required");
  if (!type) errors.push("TYPE is required (MCQ, SHORT_ANSWER, or ESSAY)");

  if (type === "MULTIPLE_CHOICE") {
    if (options.length < 2) errors.push("MCQ questions require at least 2 options");
    if (!correctAnswer) {
      errors.push("MCQ questions require ANSWER (a letter matching one of the options)");
    } else if (/^[A-Z]$/.test(correctAnswer)) {
      const index = correctAnswer.charCodeAt(0) - "A".charCodeAt(0);
      if (index < 0 || index >= options.length) {
        errors.push(`ANSWER "${correctAnswer}" does not match any listed option`);
      }
    } else if (!options.includes(correctAnswer)) {
      errors.push(`ANSWER "${correctAnswer}" does not match any listed option`);
    }
  }

  const resolvedPoints = points ?? 1;
  if (resolvedPoints <= 0 || !Number.isInteger(resolvedPoints)) {
    errors.push("POINTS must be a positive whole number");
  }

  // Resolve a letter answer (e.g. "B") to the literal option text, matching
  // how MCQ correctAnswer is stored/graded elsewhere in the app (see
  // src/app/api/lecturer/exams/[examId]/questions/bulk-import/route.ts).
  let resolvedCorrectAnswer = correctAnswer;
  if (type === "MULTIPLE_CHOICE" && correctAnswer && /^[A-Z]$/.test(correctAnswer)) {
    const index = correctAnswer.charCodeAt(0) - "A".charCodeAt(0);
    if (options[index]) resolvedCorrectAnswer = options[index];
  }

  return {
    row,
    raw: block,
    type,
    text,
    options,
    correctAnswer: type === "ESSAY" ? null : resolvedCorrectAnswer,
    points: resolvedPoints,
    errors,
  };
}

export function parseBulkQuestionsText(input: string): BulkParseResult {
  const blocks = splitIntoBlocks(input);
  const rows = blocks.map((block, i) => parseBlock(block, i + 1));
  const validCount = rows.filter((r) => r.errors.length === 0).length;
  return { rows, validCount, invalidCount: rows.length - validCount };
}

export const BULK_QUESTION_FORMAT_EXAMPLE = `QUESTION:
What is 2 + 2?
TYPE: MCQ
OPTIONS:
A. 3
B. 4
C. 5
D. 6
ANSWER: B
POINTS: 1

QUESTION:
Explain the difference between authentication and authorization.
TYPE: SHORT_ANSWER
POINTS: 5

QUESTION:
Discuss academic integrity risks in online exams.
TYPE: ESSAY
POINTS: 10`;
