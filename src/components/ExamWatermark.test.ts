/**
 * Spread watermark and enable Enter submit — watermark positions changed
 * from a regular CSS grid (which reads as obvious vertical/horizontal
 * lines) to a deterministic staggered/brick-style layout. No DOM/render-
 * testing tooling in this repo (see src/app/student/exams/[id]/page.test.ts's
 * own doc comment for the established precedent) — source-level structural
 * assertions here prove the new positioning is wired in, and that nothing
 * else about the watermark (text/opacity/rotation/accessibility/timing)
 * changed alongside it.
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
    expect(source).toContain("select-none");
  });

  it("per-tile rotation and text-building call are unchanged", () => {
    expect(source).toContain("rotate(-28deg)");
    expect(source).toContain("buildExamWatermarkLines(");
  });
});

describe("watermark positioning — deterministic staggered layout (Spread watermark and enable Enter submit)", () => {
  it("1. positions are a fixed, deterministic array — never Math.random()", () => {
    expect(source).toContain("WATERMARK_TILE_POSITIONS");
    expect(source).not.toContain("Math.random()");
  });

  it("2. no regular CSS grid is used for tile layout", () => {
    expect(source).not.toMatch(/className="grid /);
    expect(source).not.toContain("grid-cols-2");
    expect(source).not.toContain("grid-cols-3");
  });

  it("uses absolute percentage positioning with a centering transform, per tile", () => {
    expect(source).toContain("left: `${position.left}%`");
    expect(source).toContain("top: `${position.top}%`");
    expect(source).toContain("translate(-50%, -50%) rotate(-28deg)");
  });

  it("3. desktop distribution: 18 total positions, spread across roughly six staggered bands (distinct top values), with varied horizontal offsets (no shared column centres)", () => {
    const match = source.match(/const WATERMARK_TILE_POSITIONS = \[([\s\S]*?)\] as const;/);
    expect(match).not.toBeNull();
    const body = match![1];
    const positions = [...body.matchAll(/\{\s*left:\s*(-?\d+),\s*top:\s*(-?\d+)\s*\}/g)].map((m) => ({
      left: Number(m[1]),
      top: Number(m[2]),
    }));

    expect(positions).toHaveLength(18);

    // "Six staggered bands" — distinct top (row) values used across all
    // 18 desktop tiles.
    const bands = new Set(positions.map((p) => p.top));
    expect(bands.size).toBeGreaterThanOrEqual(6);

    // No obvious vertical stripes — every left value is distinct, so no
    // two tiles share a column centre.
    const lefts = positions.map((p) => p.left);
    expect(new Set(lefts).size).toBe(lefts.length);
  });

  it("4. mobile/tablet distribution: the first 8 positions are always visible (no lg: gate), spread across roughly four staggered bands", () => {
    const match = source.match(/const WATERMARK_TILE_POSITIONS = \[([\s\S]*?)\] as const;/);
    const body = match![1];
    const positions = [...body.matchAll(/\{\s*left:\s*(-?\d+),\s*top:\s*(-?\d+)\s*\}/g)].map((m) => ({
      left: Number(m[1]),
      top: Number(m[2]),
    }));
    const mobilePositions = positions.slice(0, 8);

    expect(mobilePositions).toHaveLength(8);
    // "Roughly four staggered bands" — distinct top (row) values among
    // the mobile-visible tiles.
    const bands = new Set(mobilePositions.map((p) => p.top));
    expect(bands.size).toBeGreaterThanOrEqual(4);

    // Adjacent rows use different horizontal offsets, not a repeating pair.
    const lefts = mobilePositions.map((p) => p.left);
    expect(new Set(lefts).size).toBe(lefts.length);
  });

  it("desktop-only positions (index >= 8) are hidden below the lg breakpoint and shown at it", () => {
    expect(source).toContain('"absolute hidden lg:block"');
    expect(source).toContain("index < 8");
  });

  it("5. watermark text, student identifier, submission identifier, and timestamp construction are unchanged", () => {
    expect(source).toContain("buildExamWatermarkLines(");
    expect(source).toContain("studentIdentifierForWatermark(student)");
    expect(source).toContain("shortenSubmissionId(submissionId)");
    expect(source).toContain("timestamp");
  });

  it("5. timestamp refresh behaviour is unchanged (still an interval keyed off refreshIntervalMs, default 45s)", () => {
    expect(source).toContain("refreshIntervalMs = 45_000");
    expect(source).toContain("setInterval(() => setTimestamp(new Date().toLocaleString()), refreshIntervalMs)");
  });
});
