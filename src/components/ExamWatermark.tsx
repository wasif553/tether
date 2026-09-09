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

// Fixed positions deliberately avoid the visible vertical stripes a regular
// grid creates. Six staggered top bands (10/28/46/62/78/93%), three tiles
// each with a distinct left offset per band — no two bands share a left
// value, so no column ever lines up top-to-bottom. The first eight entries
// (two from each of bands A/B/D/F) cover narrow viewports; the remaining
// ten complete the desktop distribution.
const WATERMARK_TILE_POSITIONS = [
  { left: 15, top: 10 }, { left: 85, top: 10 },
  { left: 30, top: 28 }, { left: 95, top: 28 },
  { left: 22, top: 62 }, { left: 90, top: 62 },
  { left: 18, top: 93 }, { left: 87, top: 93 },
  { left: 50, top: 10 },
  { left: 65, top: 28 },
  { left: 8, top: 46 }, { left: 42, top: 46 }, { left: 78, top: 46 },
  { left: 57, top: 62 },
  { left: 5, top: 78 }, { left: 38, top: 78 }, { left: 72, top: 78 },
  { left: 52, top: 93 },
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
