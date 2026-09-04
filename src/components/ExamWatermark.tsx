"use client";

import { useEffect, useState } from "react";
import {
  buildExamWatermarkLines,
  buildWatermarkTilePositions,
  shortenSubmissionId,
  studentIdentifierForWatermark,
  type WatermarkStudentInfo,
  type WatermarkTilePosition,
} from "@/lib/examWatermark";

export type ExamWatermarkProps = {
  student: WatermarkStudentInfo;
  submissionId: string;
  /** How often the displayed timestamp refreshes, in ms. Defaults to 45s — within the requested 30–60s range. */
  refreshIntervalMs?: number;
};

// Watermark layout refinement — see docs/exam-watermark-v1.md,
// "Distributed layout". Two independent tile SETS (not one set scaled
// down) — desktop gets more, smaller tiles; mobile/tablet gets fewer,
// larger ones, per "reduce density rather than shrinking into
// unreadable noise." Toggled purely via Tailwind responsive classes
// (both render; CSS hides one) so there is no client-only viewport
// detection and therefore no hydration mismatch.
const DESKTOP_TILES = buildWatermarkTilePositions({ columns: 3, rows: 6 });
const MOBILE_TILES = buildWatermarkTilePositions({ columns: 2, rows: 4 });

function WatermarkLayer({
  positions,
  text,
  textSizeClassName,
}: {
  positions: WatermarkTilePosition[];
  text: string;
  textSizeClassName: string;
}) {
  return (
    <div className="relative h-full w-full">
      {positions.map((pos, i) => (
        <p
          key={i}
          className={`absolute whitespace-pre-line text-center font-medium leading-tight text-gray-900 ${textSizeClassName}`}
          style={{
            left: `${pos.leftPercent}%`,
            top: `${pos.topPercent}%`,
            transform: `translate(-50%, -50%) rotate(${pos.rotationDeg}deg)`,
            opacity: 0.1,
          }}
        >
          {text}
        </p>
      ))}
    </div>
  );
}

/**
 * Exam Watermark v1 — see docs/exam-watermark-v1.md. A visible,
 * low-opacity, diagonal, staggered watermark overlay for the exam
 * question area: a deterrence/traceability aid, never an access control.
 * Purely decorative — `pointer-events: none` so it can never intercept
 * clicks/typing, and `aria-hidden="true"` so assistive tech skips it
 * entirely. The parent element must be `position: relative` (or similar)
 * for this absolutely-positioned overlay to cover it correctly — sized
 * via `inset-0` to match the parent, which (having no fixed height of
 * its own) grows to the full scrollable question content, not just the
 * viewport, so the watermark covers scrollable content too.
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
      <div className="hidden h-full w-full sm:block">
        <WatermarkLayer positions={DESKTOP_TILES} text={text} textSizeClassName="text-[10px]" />
      </div>
      <div className="h-full w-full sm:hidden">
        <WatermarkLayer positions={MOBILE_TILES} text={text} textSizeClassName="text-xs" />
      </div>
    </div>
  );
}
