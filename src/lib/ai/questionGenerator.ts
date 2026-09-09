import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export type QuestionKind = "MCQ" | "SHORT_ANSWER" | "ESSAY";
export type DifficultyLevel = "easy" | "medium" | "hard";

export interface GenerateQuestionsInput {
  sourceMaterial: string;
  subject: string;
  totalCount: number;
  difficulty: { easy: number; medium: number; hard: number };
  types: QuestionKind[];
  existingQuestions?: string[];
}

export interface GeneratedQuestion {
  type: QuestionKind;
  body: string;
  options?: string[];
  correctAnswer?: string;
  difficulty: DifficultyLevel;
  explanation: string;
}

export class AIGenerationError extends Error {}

/**
 * AI question-generation schema follow-up — production report: the
 * Anthropic call succeeds, but generated output is rejected by this
 * exact validator ("MCQ correctAnswer must be one of A/B/C/D",
 * "Invalid input: expected array, received null" for `options`). This IS
 * the one canonical output contract — the model prompt
 * (buildUserPrompt/buildSystemPrompt below), the structured-output JSON
 * schema (QUESTION_GENERATION_OUTPUT_SCHEMA below), and
 * src/app/api/lecturer/exams/[examId]/questions/bulk-import/route.ts (the
 * ONLY other importer of this schema) all describe the exact same shape.
 * Never create a second, parallel schema for either caller.
 */
const generatedQuestionSchema = z
  .object({
    type: z.enum(["MCQ", "SHORT_ANSWER", "ESSAY"]),
    body: z.string().min(1),
    options: z.array(z.string()).optional(),
    correctAnswer: z.string().optional(),
    difficulty: z.enum(["easy", "medium", "hard"]),
    explanation: z.string().min(1),
  })
  .superRefine((q, ctx) => {
    if (q.type === "MCQ") {
      if (!q.options || q.options.length !== 4) {
        ctx.addIssue({
          code: "custom",
          message: "MCQ questions must have exactly 4 options",
          path: ["options"],
        });
      }
      if (!q.correctAnswer || !["A", "B", "C", "D"].includes(q.correctAnswer)) {
        ctx.addIssue({
          code: "custom",
          message: 'MCQ correctAnswer must be one of "A", "B", "C", "D"',
          path: ["correctAnswer"],
        });
      }
    }
  });

export const generatedQuestionsSchema = z.array(generatedQuestionSchema);

// ---------------------------------------------------------------------------
// Difficulty allocation — schema follow-up, Part 10.
// ---------------------------------------------------------------------------

export type DifficultyAllocation = { easy: number; medium: number; hard: number };

/**
 * Converts a difficulty percentage mix into exact integer per-difficulty
 * counts that always sum to `totalCount` — never left for the model to
 * approximate from raw percentages. Largest-remainder apportionment
 * (Hamilton's method): floor each exact share, then hand out the
 * remaining units one at a time to the largest fractional remainders,
 * tie-broken by a fixed [easy, medium, hard] order for determinism (a
 * genuine tie must resolve the same way on every call, never depend on
 * sort stability or Math.random). `difficulty` is assumed to already sum
 * to 100 — the API route validates that before this is ever called.
 */
export function allocateDifficultyCounts(totalCount: number, difficulty: DifficultyAllocation): DifficultyAllocation {
  const keys: (keyof DifficultyAllocation)[] = ["easy", "medium", "hard"];
  const exact = keys.map((k) => (totalCount * difficulty[k]) / 100);
  const base = exact.map(Math.floor);
  const allocated = base.reduce((a, b) => a + b, 0);
  const remainder = totalCount - allocated;

  const result: DifficultyAllocation = { easy: base[0], medium: base[1], hard: base[2] };
  const byRemainderDesc = keys
    .map((key, i) => ({ key, frac: exact[i] - base[i], i }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let j = 0; j < remainder; j++) {
    result[byRemainderDesc[j].key] += 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Model configuration — schema follow-up, Part 12. This feature previously
// hardcoded "claude-sonnet-4-6" directly in the messages.create() call,
// unlike src/lib/aiAssistanceGenerator.ts's env-configurable
// ANTHROPIC_BRAINSTORM_MODEL. Mirrors that exact pattern with its own,
// separately-configurable variable — question generation is a genuinely
// different feature from student brainstorming (see
// aiAssistanceGenerator.ts's own doc comment: "each keeps its own model
// choice") and must never be forced to change together with it.
// ---------------------------------------------------------------------------

export const ANTHROPIC_QUESTION_GENERATOR_MODEL_DEFAULT = "claude-sonnet-5";

export function getAnthropicQuestionGeneratorModel(): string {
  return process.env.ANTHROPIC_QUESTION_GENERATOR_MODEL?.trim() || ANTHROPIC_QUESTION_GENERATOR_MODEL_DEFAULT;
}

// ---------------------------------------------------------------------------
// Structured output — schema follow-up, Part 4. The installed
// @anthropic-ai/sdk (see node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts,
// OutputConfig/JSONOutputFormat) already supports Claude's native
// schema-constrained JSON response mode via `output_config.format` on the
// standard (non-beta) messages.create() call — no new dependency. This
// guarantees the response is a JSON object shaped like
// { questions: [...] } with every field's TYPE correct (in particular:
// `options` can never come back as `null`, only a real — possibly empty —
// array, which is the literal root cause of the "expected array, received
// null" failure). It deliberately does NOT attempt to conditionally
// require `correctAnswer` to be exactly A/B/C/D only for MCQ — JSON
// Schema can express that via if/then, but reliability of conditional
// subschemas under this response mode isn't something a mocked unit test
// can verify against the real API, so that specific rule is enforced by
// the prompt instructions + normalizeGeneratedQuestion + the repair pass
// below instead, exactly like every other cross-field business rule this
// module already had to handle regardless of output mode.
// ---------------------------------------------------------------------------

const QUESTION_GENERATION_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["MCQ", "SHORT_ANSWER", "ESSAY"] },
          body: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          correctAnswer: { type: "string" },
          difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
          explanation: { type: "string" },
        },
        required: ["type", "body", "options", "correctAnswer", "difficulty", "explanation"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Prompts — schema follow-up, Part 3.
// ---------------------------------------------------------------------------

const TYPE_EXAMPLE: Record<QuestionKind, string> = {
  MCQ: JSON.stringify({
    type: "MCQ",
    body: "Which data structure retrieves elements in first-in-first-out order?",
    options: ["Stack", "Queue", "Binary tree", "Hash map"],
    correctAnswer: "B",
    difficulty: "easy",
    explanation: "A queue is defined by FIFO ordering, unlike a stack (LIFO).",
  }),
  SHORT_ANSWER: JSON.stringify({
    type: "SHORT_ANSWER",
    body: "What keyword defines a function in Python?",
    options: [],
    correctAnswer: "def",
    difficulty: "easy",
    explanation: "Python functions are declared with the `def` keyword.",
  }),
  ESSAY: JSON.stringify({
    type: "ESSAY",
    body: "Discuss the trade-offs between recursion and iteration.",
    options: [],
    correctAnswer:
      "Should cover: call-stack overhead vs readability, base-case correctness, tail-call behaviour, and when each approach is preferable.",
    difficulty: "hard",
    explanation: "Tests understanding of control-flow trade-offs, not a single fact.",
  }),
};

function buildSystemPrompt(subject: string): string {
  return `You are an expert assessment designer specializing in ${subject}. You write clear, unambiguous exam questions that accurately test understanding of source material. You always respond with strictly valid JSON and nothing else — no Markdown, no code fences, no explanatory prose before or after the JSON.`;
}

function buildUserPrompt(input: GenerateQuestionsInput, allocation: DifficultyAllocation): string {
  const { sourceMaterial, types, existingQuestions } = input;

  const lines = [
    `Generate exactly ${input.totalCount} exam questions from this material.`,
    `Required difficulty split (exact counts, not approximate percentages): easy: ${allocation.easy}, medium: ${allocation.medium}, hard: ${allocation.hard}. Together these must total exactly ${input.totalCount}.`,
    `Question types allowed: ${types.join(", ")}. Every single question's "type" field MUST be one of these — never return a type that was not requested, even if the source material suggests it.`,
    "",
    'Return ONLY a JSON object of the exact shape: { "questions": [ ... ] } — no markdown, no code fences, no preamble, no explanation, nothing before or after the JSON object.',
    "Each item in the questions array: { type, body, options, correctAnswer, difficulty, explanation }",
    "",
    "For MULTIPLE_CHOICE (\"MCQ\") questions:",
    "- options must be an array of EXACTLY four strings (the answer choices themselves, not letters or labels)",
    "- correctAnswer MUST be only a single capital letter: \"A\", \"B\", \"C\", or \"D\"",
    "- the letter corresponds to the (1-indexed as A=1st) position of the correct choice in the options array",
    "- never return the answer text itself in correctAnswer, never \"Option A\", never a number, never lowercase",
    `Example: ${TYPE_EXAMPLE.MCQ}`,
    "",
    "For SHORT_ANSWER and ESSAY questions:",
    "- options MUST be an empty array [] — never null, never omitted",
    "- SHORT_ANSWER correctAnswer: a concise model answer or marking reference (1-2 sentences)",
    "- ESSAY correctAnswer: marking guidance / key points a strong answer should cover (never a single fixed answer)",
  ];
  if (types.includes("SHORT_ANSWER")) lines.push(`Example: ${TYPE_EXAMPLE.SHORT_ANSWER}`);
  if (types.includes("ESSAY")) lines.push(`Example: ${TYPE_EXAMPLE.ESSAY}`);

  if (existingQuestions && existingQuestions.length > 0) {
    lines.push("", `Avoid these existing questions: ${existingQuestions.join(" | ")}`);
  }

  lines.push("", "Source material:", sourceMaterial);

  return lines.join("\n");
}

/** Repair pass (Part 6) — one bounded call, never a raw Zod dump sent to the model or the lecturer. */
function buildRepairPrompt(items: { raw: unknown; issues: string[] }[]): string {
  const lines = [
    `The following ${items.length} question object(s) failed validation against the required schema. Return ONLY a corrected JSON object of the exact shape { "questions": [ ... ] } containing exactly ${items.length} corrected question(s), in the same order — one corrected question per input question below.`,
    "",
    "Required schema (per question):",
    "{ type: \"MCQ\" | \"SHORT_ANSWER\" | \"ESSAY\", body: string, options: string[], correctAnswer: string, difficulty: \"easy\" | \"medium\" | \"hard\", explanation: string }",
    "- MCQ: options must be exactly 4 strings; correctAnswer must be exactly one capital letter A, B, C, or D (never the option text, never \"Option A\", never lowercase, never a number).",
    "- SHORT_ANSWER / ESSAY: options must be an empty array [], never null.",
    "",
  ];
  items.forEach((item, i) => {
    lines.push(`Question ${i + 1} — problems: ${item.issues.join("; ")}`);
    lines.push(`Question ${i + 1} — original: ${JSON.stringify(item.raw)}`);
    lines.push("");
  });
  lines.push("Return ONLY the corrected JSON object — no markdown, no explanation.");
  return lines.join("\n");
}

function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

// ---------------------------------------------------------------------------
// Normalization — schema follow-up, Part 5. Conservative, safe rewrites
// only: never fabricates missing MCQ options, never guesses an ambiguous
// correct answer. Runs BEFORE generatedQuestionSchema validation, so the
// schema itself stays exactly the strict canonical contract — this is a
// pre-pass, not a loosened schema.
// ---------------------------------------------------------------------------

/** True MCQ options that safely repair to A/B/C/D — the only source of a repaired answer is the model's OWN options array, never a fabricated guess. */
function normalizeMcqCorrectAnswer(raw: unknown, options: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();

  // "A", "a", "A." -> "A"
  const letterMatch = trimmed.match(/^([A-Da-d])\.?$/);
  if (letterMatch) return letterMatch[1].toUpperCase();

  // "Option A" / "option a" -> "A"
  const optionWordMatch = trimmed.match(/^option\s+([A-Da-d])\.?$/i);
  if (optionWordMatch) return optionWordMatch[1].toUpperCase();

  // The exact text of exactly one option -> that option's letter. Only
  // when the match is unambiguous (exactly one option matches) — an
  // answer that happens to equal two options' text (e.g. duplicate
  // options) is left untouched rather than guessed.
  if (Array.isArray(options)) {
    const normalizedTarget = trimmed.toLowerCase();
    const matchingIndexes = options
      .map((opt, i) => (typeof opt === "string" && opt.trim().toLowerCase() === normalizedTarget ? i : -1))
      .filter((i) => i >= 0);
    if (matchingIndexes.length === 1 && matchingIndexes[0] < 4) {
      return String.fromCharCode("A".charCodeAt(0) + matchingIndexes[0]);
    }
  }

  return raw;
}

function normalizeGeneratedQuestion(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const q = raw as Record<string, unknown>;
  const type = q.type;
  const next: Record<string, unknown> = { ...q };

  if (type === "SHORT_ANSWER" || type === "ESSAY") {
    // Do NOT fabricate options for MCQ — this normalization is
    // deliberately scoped to the two types that never need any.
    if (next.options === null || next.options === undefined) {
      next.options = [];
    }
  }

  if (type === "MCQ" && "correctAnswer" in q) {
    next.correctAnswer = normalizeMcqCorrectAnswer(q.correctAnswer, q.options);
  }

  return next;
}

// ---------------------------------------------------------------------------
// Validation against a specific request's allowed types (Part 11) — the
// exported generatedQuestionSchema/generatedQuestionsSchema stay
// request-agnostic (bulk-import re-validates without knowing what was
// originally requested); this additional, request-scoped check only
// applies during generation itself.
// ---------------------------------------------------------------------------

type ValidationOutcome =
  | { ok: true; question: GeneratedQuestion }
  | { ok: false; issues: string[] };

function validateAgainstRequest(raw: unknown, allowedTypes: QuestionKind[]): ValidationOutcome {
  const normalized = normalizeGeneratedQuestion(raw);
  const parsed = generatedQuestionSchema.safeParse(normalized);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  if (!allowedTypes.includes(parsed.data.type)) {
    return { ok: false, issues: [`type: "${parsed.data.type}" was not one of the requested question types (${allowedTypes.join(", ")})`] };
  }
  return { ok: true, question: parsed.data };
}

// ---------------------------------------------------------------------------
// Anthropic call
// ---------------------------------------------------------------------------

let cachedClient: Anthropic | undefined;

function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AIGenerationError("Missing required environment variable: ANTHROPIC_API_KEY");
  }
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

async function callModelForQuestions(system: string, userPrompt: string): Promise<unknown[]> {
  const client = getClient();

  let response;
  try {
    response = await client.messages.create({
      model: getAnthropicQuestionGeneratorModel(),
      max_tokens: 4096,
      // Live Preview follow-up — Anthropic rejects `temperature` for this
      // model with a 400 ("`temperature` is deprecated for this model").
      // Used by BOTH the initial generation call and the one bounded
      // repair call (generateQuestions() routes both through this one
      // function) — never pass it here, and never reintroduce it as a
      // per-call override on either. Rely on the model's own default; no
      // other sampling parameter is documented as required in its place.
      system,
      messages: [{ role: "user", content: userPrompt }],
      // Structured output (Part 4) — see QUESTION_GENERATION_OUTPUT_SCHEMA's
      // own doc comment.
      output_config: { format: { type: "json_schema", schema: QUESTION_GENERATION_OUTPUT_SCHEMA } },
    });
  } catch (err) {
    throw new AIGenerationError(`Anthropic API request failed: ${(err as Error).message}`);
  }

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new AIGenerationError("Anthropic response did not contain a text block");
  }

  const cleaned = stripMarkdownFences(textBlock.text);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cleaned);
  } catch (err) {
    throw new AIGenerationError(`Failed to parse model output as JSON: ${(err as Error).message}`);
  }

  // Defensive: accept either the requested { questions: [...] } wrapper
  // or a bare array, in case a future model/config ever ignores the
  // wrapper instruction.
  const items = Array.isArray(parsedJson)
    ? parsedJson
    : parsedJson && typeof parsedJson === "object" && Array.isArray((parsedJson as { questions?: unknown }).questions)
      ? (parsedJson as { questions: unknown[] }).questions
      : null;
  if (!items) {
    throw new AIGenerationError('Model output did not contain a "questions" array');
  }
  return items;
}

export type GenerateQuestionsResult = {
  questions: GeneratedQuestion[];
  requestedCount: number;
  producedCount: number;
  /** requestedCount - producedCount, floored at 0 — never negative even if the model returned more than requested. */
  failedCount: number;
};

/**
 * Generate -> normalize -> validate -> (one bounded repair pass for
 * whatever is still invalid) -> return whatever validated successfully.
 * Never throws merely because some (or even all) generated questions
 * failed validation after repair — a genuinely empty producedCount is a
 * valid, reportable outcome the caller (the API route) turns into a
 * clean, non-technical message. AIGenerationError is reserved for a hard
 * failure of the FIRST call itself (missing config, transport failure,
 * completely unparseable/missing-structure output) — there is nothing to
 * normalize, validate, or repair in that case.
 */
export async function generateQuestions(input: GenerateQuestionsInput): Promise<GenerateQuestionsResult> {
  const allocation = allocateDifficultyCounts(input.totalCount, input.difficulty);
  const system = buildSystemPrompt(input.subject);
  const userPrompt = buildUserPrompt(input, allocation);

  const rawItems = await callModelForQuestions(system, userPrompt);

  const valid: GeneratedQuestion[] = [];
  const invalid: { raw: unknown; issues: string[] }[] = [];
  for (const raw of rawItems) {
    const outcome = validateAgainstRequest(raw, input.types);
    if (outcome.ok) valid.push(outcome.question);
    else invalid.push({ raw, issues: outcome.issues });
  }

  if (invalid.length > 0) {
    try {
      const repairPrompt = buildRepairPrompt(invalid);
      const repairedRaw = await callModelForQuestions(system, repairPrompt);
      for (const raw of repairedRaw) {
        const outcome = validateAgainstRequest(raw, input.types);
        if (outcome.ok) valid.push(outcome.question);
        // Still invalid after the one bounded repair attempt: dropped,
        // never shown to the lecturer, never a raw Zod dump anywhere.
      }
    } catch {
      // The repair call itself failed (transport/parse) — the
      // already-valid questions from the initial attempt are still
      // returned; nothing from this catch block is ever surfaced.
    }
  }

  return {
    questions: valid,
    requestedCount: input.totalCount,
    producedCount: valid.length,
    failedCount: Math.max(0, input.totalCount - valid.length),
  };
}
