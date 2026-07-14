/**
 * Fix exam publish redirect origin handling — see
 * docs/deployment-vercel-supabase.md and src/lib/examShareLink.ts.
 *
 * Pure unit tests only — no Prisma/DB, no browser, no network.
 */
import { describe, expect, it } from "vitest";
import { buildStudentJoinLink } from "./examShareLink";

describe("buildStudentJoinLink", () => {
  it("4. builds the join link from the given origin (the caller is expected to pass window.location.origin)", () => {
    expect(buildStudentJoinLink("https://tether-murex.vercel.app", "exam123")).toBe(
      "https://tether-murex.vercel.app/student/exams/join/exam123",
    );
  });

  it("works with a fresh Vercel Preview origin, not just the production one", () => {
    expect(buildStudentJoinLink("https://tether-git-feature-branch-team.vercel.app", "examABC")).toBe(
      "https://tether-git-feature-branch-team.vercel.app/student/exams/join/examABC",
    );
  });

  it("works with a local dev origin", () => {
    expect(buildStudentJoinLink("http://localhost:3001", "exam1")).toBe(
      "http://localhost:3001/student/exams/join/exam1",
    );
  });

  it("never hardcodes any specific domain — it only ever reflects back the origin it was given", () => {
    const origin = "https://this-is-not-a-real-domain.example";
    expect(buildStudentJoinLink(origin, "exam1")).toContain(origin);
    expect(buildStudentJoinLink(origin, "exam1")).not.toContain("vercel.app");
  });
});
