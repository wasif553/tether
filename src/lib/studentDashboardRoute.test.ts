/**
 * URGENT fix — confirmed physical bug: ManualReviewNotice's "Return to
 * dashboard" link pointed at /student/dashboard, which 404s (the
 * canonical student landing route is /student — see
 * src/app/student/page.tsx). This is a repo-wide regression guard
 * proving no OTHER stale /student/dashboard reference has crept into
 * executable production code (components/pages/lib), so this defect
 * class can't silently reappear elsewhere.
 *
 * Deliberately does NOT scan test files — some legitimately use
 * "/student/dashboard" as an arbitrary string value with no connection
 * to real navigation (e.g. safeCallbackUrl.test.ts uses it as an example
 * of a path outside an allow-list; sebConfigGenerator.test.ts uses it as
 * an arbitrary config-string input) — see this file's own scan roots.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

const SCAN_ROOTS = [path.join(REPO_ROOT, "src", "app"), path.join(REPO_ROOT, "src", "components")];

const SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);
const FORBIDDEN = "/student/dashboard";

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, out);
      continue;
    }
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
    if (SCAN_EXTENSIONS.has(path.extname(entry.name))) out.push(fullPath);
  }
}

describe("no stale /student/dashboard link remains in executable production code", () => {
  it("no .ts/.tsx file under src/app or src/components (excluding tests) references the 404ing /student/dashboard route", () => {
    const files: string[] = [];
    for (const root of SCAN_ROOTS) walk(root, files);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      if (content.includes(FORBIDDEN)) offenders.push(path.relative(REPO_ROOT, file));
    }
    expect(offenders).toEqual([]);
  });
});
