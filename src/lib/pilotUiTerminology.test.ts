/**
 * Pilot UI release readiness v1 — see
 * docs/tether-v1.7.2-pilot-release-readiness.md, Part J items 15-18.
 *
 * Two kinds of static regression guard, both scanning real source files
 * on disk (mirrors src/lib/studentDashboardRoute.test.ts's own pattern):
 *   1. terminology — core integrity-review-facing pages must never claim
 *      an integrity signal is automatic proof of misconduct;
 *   2. navigation — the canonical student dashboard route and the key
 *      recovery/error CTA destinations this task touched must resolve to
 *      real routes (a route folder actually exists under src/app).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

// Phrases that would claim an integrity signal is automatic, certain
// proof of misconduct — forbidden per Part E's product-language rules
// ("integrity signal", "needs review", "lecturer review", "evidence",
// "human decision" are the approved vocabulary; "cheat-proof",
// "automatic misconduct", "proof of cheating" are not).
const FORBIDDEN_MISCONDUCT_PHRASES = [/cheat-proof/i, /automatic(ally)? (determin|flag|confirm)\w* (misconduct|cheating)/i, /proof of cheating/i, /cheating (was )?detected/i, /ai has determined/i];

describe("terminology — core integrity UI never claims automatic proof of misconduct", () => {
  const filesToScan = [
    "src/app/lecturer/exams/[id]/integrity/page.tsx",
    "src/app/lecturer/secure-client/sessions/[sessionId]/page.tsx",
    "src/components/ManualReviewNotice.tsx",
  ];

  for (const file of filesToScan) {
    it(`${file} contains no forbidden automatic-misconduct phrasing`, () => {
      // \s+ -> single space tolerates JSX line-wrapping splitting a
      // multi-word forbidden phrase across lines.
      const content = read(file).replace(/\s+/g, " ");
      for (const pattern of FORBIDDEN_MISCONDUCT_PHRASES) {
        expect(content).not.toMatch(pattern);
      }
    });
  }

  it("[18] the integrity review page explicitly frames its risk score as evidence for human review, not a determination", () => {
    // \s+ between words tolerates the source's own JSX line-wrapping.
    const content = read("src/app/lecturer/exams/[id]/integrity/page.tsx").replace(/\s+/g, " ");
    expect(content).toMatch(/evidence for human review/i);
    // The correct phrase is a NEGATION ("...not a misconduct determination")
    // — assert that framing, not merely the substring's absence.
    expect(content).toMatch(/not a misconduct determination/i);
  });
});

describe("navigation — canonical dashboard route and key CTA destinations resolve", () => {
  it("[15] /student is the canonical student dashboard — its page.tsx exists", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "src/app/student/page.tsx"))).toBe(true);
  });

  it("[17] ManualReviewNotice's 'Return to dashboard' resolves to the canonical /student route", () => {
    const content = read("src/components/ManualReviewNotice.tsx");
    expect(content).toContain('href="/student"');
    expect(content).not.toContain("/student/dashboard");
  });

  it("[17] the secure-client session detail page's back link targets a real route", () => {
    const content = read("src/app/lecturer/secure-client/sessions/[sessionId]/page.tsx");
    expect(content).toMatch(/\/lecturer\/submissions\/\$\{detail\.submissionId\}\/evidence/);
    expect(fs.existsSync(path.join(REPO_ROOT, "src/app/lecturer/submissions/[id]/evidence/page.tsx"))).toBe(true);
  });

  it("[16] no /lecturer/dashboard stale reference exists anywhere under src/app/lecturer (mirrors the existing /student/dashboard guard)", () => {
    const offenders: string[] = [];
    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
        if (!fullPath.endsWith(".ts") && !fullPath.endsWith(".tsx")) continue;
        const content = fs.readFileSync(fullPath, "utf8");
        if (content.includes("/lecturer/dashboard")) offenders.push(path.relative(REPO_ROOT, fullPath));
      }
    }
    walk(path.join(REPO_ROOT, "src", "app", "lecturer"));
    expect(offenders).toEqual([]);
  });
});
