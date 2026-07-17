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

// A grid of repeated tiles reads clearly across the whole question area in
// a photo/screenshot without needing canvas or an image — plain CSS only.
const WATERMARK_TILE_COUNT = 24;

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
      <div className="grid h-full w-full grid-cols-2 gap-10 p-2 sm:grid-cols-3">
        {Array.from({ length: WATERMARK_TILE_COUNT }, (_, i) => (
          <div key={i} className="flex items-center justify-center" style={{ transform: "rotate(-28deg)" }}>
            <p
              className="whitespace-pre-line text-center text-[10px] font-medium leading-tight text-gray-900"
              style={{ opacity: 0.1 }}
            >
              {text}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
