/**
 * Tether Integrity Evidence Timeline v1 — see
 * docs/integrity-evidence-timeline-v1.md.
 *
 * No jsdom/React-Testing-Library infrastructure exists in this repo (see
 * src/app/lecturer/exams/[id]/page.test.ts for the same convention) —
 * these assert directly on the page's source text.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const pageSource = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
const flat = pageSource.replace(/\s+/g, " ");

describe("full timeline page — header and summary", () => {
  it("has a back-to-submission link and the required headline copy", () => {
    expect(pageSource).toMatch(/&larr; Back to submission/);
    expect(pageSource).toMatch(/Integrity evidence timeline/);
    expect(flat).toMatch(/Chronological reconstruction of recorded assessment activity and integrity evidence\./);
    expect(flat).toMatch(/do not by themselves determine academic misconduct\./);
  });

  it("shows the four factual summary chips — no percentage, no score anywhere in the rendered component", () => {
    expect(pageSource).toMatch(/Attempt status/);
    expect(pageSource).toMatch(/Recorded events/);
    expect(pageSource).toMatch(/Evidence frames/);
    expect(pageSource).toMatch(/Items awaiting review/);
    const componentSource = pageSource.slice(pageSource.indexOf("export default function"));
    expect(componentSource.toLowerCase()).not.toMatch(/coverage|completeness|risk score|cheating|misconduct score/);
  });

  it("shows the Related review signals summary only when there is something to show", () => {
    expect(pageSource).toMatch(/relatedSessionSignals > 0 \|\| summary\.relatedTimingSignals > 0/);
    expect(pageSource).toMatch(/Session review signals: \{summary\.relatedSessionSignals\} awaiting review/);
    expect(pageSource).toMatch(/Timing review signals: \{summary\.relatedTimingSignals\} awaiting review/);
  });
});

describe("full timeline page — filters", () => {
  it("offers exactly the four required filters, no search", () => {
    expect(pageSource).toMatch(/"ALL"/);
    expect(pageSource).toMatch(/"REVIEW_SIGNALS"/);
    expect(pageSource).toMatch(/"EXAM_ACTIVITY"/);
    expect(pageSource).toMatch(/"EVIDENCE"/);
    expect(pageSource.toLowerCase()).not.toMatch(/<input[^>]*search/);
  });

  it("Review signals filter is based on reviewState presence, not a risk score", () => {
    expect(pageSource).toMatch(/case "REVIEW_SIGNALS":\s*\n\s*return event\.reviewState != null;/);
  });

  it("Evidence filter is based on evidenceAssets.length, matching the spec", () => {
    expect(pageSource).toMatch(/case "EVIDENCE":\s*\n\s*return event\.evidenceAssets\.length > 0;/);
  });
});

describe("full timeline page — rows and evidence disclosure", () => {
  it("evidence is never eagerly loaded — the view-evidence link points at the existing authenticated route only, no <img> tag", () => {
    expect(pageSource).toMatch(/href=\{`\/api\/integrity-evidence\/\$\{asset\.id\}`\}/);
    expect(pageSource).not.toMatch(/<img/);
  });

  it("uses restrained severity coloring: red only for HIGH, amber only for MEDIUM, green only for recovered/resolved", () => {
    expect(flat).toMatch(/if \(event\.severity === "HIGH"\) return \{ dot: "bg-\[#DC2626\]"/);
    expect(flat).toMatch(/if \(event\.severity === "MEDIUM"\) return \{ dot: "bg-\[#D97706\]"/);
    expect(pageSource).toMatch(/restored\|removed\|recovered/);
  });

  it("technical details are behind a progressive-disclosure toggle, not shown by default", () => {
    expect(pageSource).toMatch(/const \[detailsOpen, setDetailsOpen\] = useState\(false\)/);
    expect(pageSource).toMatch(/Details \{detailsOpen \? "▴" : "▾"\}/);
  });

  it("shows the empty-activity state only when there is truly nothing beyond lifecycle rows, under the All filter", () => {
    expect(flat).toMatch(/No detailed integrity activity was recorded for this attempt\./);
    expect(pageSource).toMatch(/filter === "ALL" && nonLifecycleCount === 0/);
  });
});
