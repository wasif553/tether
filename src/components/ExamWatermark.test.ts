/**
 * Watermark layout refinement — see docs/exam-watermark-v1.md,
 * "Distributed layout". No DOM/render-testing tooling in this repo (see
 * src/app/student/exams/[id]/page.test.ts's own doc comment for the
 * established precedent) — a source-level structural assertion proves
 * the staggered tile layout, opacity, and accessibility properties are
 * actually wired in. The tile-position MATH itself is unit-tested
 * properly (no DOM needed) in src/lib/examWatermark.test.ts.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, "ExamWatermark.tsx"), "utf8");

describe("ExamWatermark", () => {
  it("uses the staggered tile-position layout, not a plain grid", () => {
    expect(source).toContain("buildWatermarkTilePositions(");
    // The old repeating-grid implementation is gone — never re-introduced.
    expect(source).not.toContain("grid-cols-2");
    expect(source).not.toContain("grid-cols-3");
  });

  it("retains the approved 0.10 opacity", () => {
    expect(source).toContain("opacity: 0.1");
  });

  it("remains pointer-events-none and aria-hidden — a visual deterrent only, never intercepting input or read by assistive tech", () => {
    expect(source).toContain("pointer-events-none");
    expect(source).toContain('aria-hidden="true"');
  });

  it("has two independent responsive tile sets — fewer/larger on mobile, not the same grid shrunk down", () => {
    expect(source).toContain("DESKTOP_TILES");
    expect(source).toContain("MOBILE_TILES");
    expect(source).toContain("sm:block");
    expect(source).toContain("sm:hidden");
  });

  it("still builds its text from buildExamWatermarkLines — text content is unchanged by the layout refinement", () => {
    expect(source).toContain("buildExamWatermarkLines(");
  });
});
