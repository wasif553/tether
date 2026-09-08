"use client";

import { useEffect, useState } from "react";
import {
  buildExamWatermarkLines,
  shortenSubmissionId,
  studentIdentifierForWatermark,
  type WatermarkStudentInfo,
} from "@/lib/examWatermark";

export type ExamWatermarkProps = {
  student: WatermarkStudentInfo;
  submissionId: string;
  /** How often the displayed timestamp refreshes, in ms. Defaults to 45s — within the requested 30–60s range. */
  refreshIntervalMs?: number;
};

// Fixed positions deliberately avoid the visible vertical stripes a regular grid creates.
// The first eight cover narrow viewports; the rest complete the desktop distribution.
const WATERMARK_TILE_POSITIONS = [
  { left: 14, top: 11 }, { left: 57, top: 14 }, { left: 88, top: 10 },
  { left: 31, top: 33 }, { left: 72, top: 30 },
  { left: 12, top: 55 }, { left: 50, top: 58 }, { left: 86, top: 53 },
  { left: 24, top: 19 }, { left: 76, top: 22 }, { left: 43, top: 42 },
  { left: 94, top: 39 }, { left: 27, top: 68 }, { left: 68, top: 72 },
  { left: 5, top: 82 }, { left: 48, top: 87 }, { left: 91, top: 84 },
  { left: 35, top: 96 },
] as const;
const WATERMARK_TILE_COUNT = WATERMARK_TILE_POSITIONS.length;

/**
 * Exam Watermark v1 — see docs/exam-watermark-v1.md. A visible,
 * low-opacity, diagonal, repeated watermark overlay for the exam question
 * area: a deterrence/traceability aid, never an access control. Purely
 * decorative — `pointer-events: none` so it can never intercept
 * clicks/typing, and `aria-hidden="true"` so assistive tech skips it
 * entirely. The parent element must be `position: relative` (or similar)
 * for this absolutely-positioned overlay to cover it correctly.
 */
export function ExamWatermark({ student, submissionId, refreshIntervalMs = 45_000 }: ExamWatermarkProps) {
  const [timestamp, setTimestamp] = useState<string>(() => new Date().toLocaleString());

  useEffect(() => {
    const interval = setInterval(() => setTimestamp(new Date().toLocaleString()), refreshIntervalMs);
    return () => clearInterval(interval);
  }, [refreshIntervalMs]);

  const text = buildExamWatermarkLines({
    studentIdentifier: studentIdentifierForWatermark(student),
    shortSubmissionId: shortenSubmissionId(submissionId),
    timestamp,
  }).join("\n");

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 select-none overflow-hidden">
      {WATERMARK_TILE_POSITIONS.slice(0, WATERMARK_TILE_COUNT).map((position, index) => (
          <div
            className={index < 8 ? "absolute" : "absolute hidden lg:block"}
            key={`${position.left}-${position.top}`}
            style={{ left: `${position.left}%`, top: `${position.top}%`, transform: "translate(-50%, -50%) rotate(-28deg)" }}
          >
            <p
              className="whitespace-pre-line text-center text-[10px] font-medium leading-tight text-gray-900"
              // Final minor UX refinements v1 — restored to the
              // original 0.1 (a prior pass had lightened this to 0.06
              // for legibility; that was reverted — the watermark must
              // remain clearly, darkly visible as an exam-integrity
              // deterrent). Purely a visual adjustment (see this
              // component's own doc comment: opacity is never read as
              // a signal anywhere).
              style={{ opacity: 0.1 }}
            >
              {text}
            </p>
          </div>
        ))}
    </div>
  );
}
