import { z } from "zod";

export const BANK_QUESTION_TYPES = ["MULTIPLE_CHOICE", "SHORT_ANSWER", "ESSAY"] as const;
export type BankQuestionType = (typeof BANK_QUESTION_TYPES)[number];

export const bankQuestionInputSchema = z
  .object({
    type: z.enum(BANK_QUESTION_TYPES),
    text: z.string().min(1),
    optionsJson: z.string().optional(),
    correctAnswer: z.string().optional(),
    sampleAnswer: z.string().optional(),
    points: z.number().int().min(1).default(1),
    difficulty: z.enum(["easy", "medium", "hard"]).optional(),
    topic: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === "MULTIPLE_CHOICE") {
      let parsedOptions: unknown;
      try {
        parsedOptions = data.optionsJson ? JSON.parse(data.optionsJson) : undefined;
      } catch {
        parsedOptions = undefined;
      }
      if (!Array.isArray(parsedOptions) || parsedOptions.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "optionsJson is required for MULTIPLE_CHOICE questions",
          path: ["optionsJson"],
        });
      }
      if (!data.correctAnswer) {
        ctx.addIssue({
          code: "custom",
          message: "correctAnswer is required for MULTIPLE_CHOICE questions",
          path: ["correctAnswer"],
        });
      }
    }
  });

export type BankQuestionInput = z.infer<typeof bankQuestionInputSchema>;

/**
 * Maps a stored BankQuestion row onto Prisma's Question.create() input,
 * producing a fully independent copy (no reference back to the bank row).
 */
export function mapBankQuestionToQuestionData(
  bankQuestion: {
    type: string;
    text: string;
    optionsJson: string | null;
    correctAnswer: string | null;
    points: number;
  },
  examId: string,
  order: number,
) {
  let options: string[] | undefined;
  if (bankQuestion.optionsJson) {
    try {
      const parsed = JSON.parse(bankQuestion.optionsJson);
      if (Array.isArray(parsed)) options = parsed;
    } catch {
      options = undefined;
    }
  }

  return {
    examId,
    type: bankQuestion.type as "MULTIPLE_CHOICE" | "SHORT_ANSWER" | "ESSAY",
    text: bankQuestion.text,
    options,
    correctAnswer: bankQuestion.correctAnswer ?? undefined,
    points: bankQuestion.points,
    order,
  };
}
