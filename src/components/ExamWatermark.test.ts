/**
 * Final minor UX refinements v1 — the watermark opacity was lightened
 * to 0.06 by a prior pass, then restored back to the original 0.1 by
 * this one. No DOM/render-testing tooling in this repo (see
 * src/app/student/exams/[id]/page.test.ts's own doc comment for the
 * established precedent) — a source-level structural assertion here
 * proves the darker value is actually the one wired in, and that
 * nothing else about the watermark (text/pattern/positioning/
 * accessibility) changed alongside it.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, "ExamWatermark.tsx"), "utf8");

describe("ExamWatermark opacity", () => {
  it("is restored to the original 0.1 — not the 0.06 a prior pass lightened it to", () => {
    expect(source).toContain("opacity: 0.1 }");
    expect(source).not.toContain("opacity: 0.06 }");
  });

  it("the watermark remains pointer-events-none and aria-hidden — a visual deterrent only, never intercepting input or read by assistive tech", () => {
    expect(source).toContain("pointer-events-none");
    expect(source).toContain('aria-hidden="true"');
  });

  it("the repeated-tile pattern, per-tile rotation, and text-building call are all unchanged by the opacity restoration", () => {
    expect(source).toContain("WATERMARK_TILE_COUNT");
    expect(source).toContain('transform: "rotate(-28deg)"');
    expect(source).toContain("buildExamWatermarkLines(");
  });
});
