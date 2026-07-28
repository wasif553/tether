import { describe, it, expect } from "vitest";
import { isSafeJoinCallbackUrl, isSafeAppCallbackUrl, isSafeTetherLaunchCallbackUrl } from "./safeCallbackUrl";

describe("isSafeJoinCallbackUrl", () => {
  it("accepts a well-formed join path", () => {
    expect(isSafeJoinCallbackUrl("/student/exams/join/exam-123")).toBe(true);
  });

  it("rejects protocol-relative and absolute URLs", () => {
    expect(isSafeJoinCallbackUrl("//evil.com")).toBe(false);
    expect(isSafeJoinCallbackUrl("https://evil.com/student/exams/join/exam-123")).toBe(false);
  });

  it("rejects extra path segments or missing examId", () => {
    expect(isSafeJoinCallbackUrl("/student/exams/join/exam-123/extra")).toBe(false);
    expect(isSafeJoinCallbackUrl("/student/exams/join/")).toBe(false);
  });

  it("rejects null/undefined/empty", () => {
    expect(isSafeJoinCallbackUrl(null)).toBe(false);
    expect(isSafeJoinCallbackUrl(undefined)).toBe(false);
    expect(isSafeJoinCallbackUrl("")).toBe(false);
  });
});

describe("isSafeTetherLaunchCallbackUrl", () => {
  it("Pending launch survives login: accepts the exact Tether launch page path for a given examId", () => {
    expect(isSafeTetherLaunchCallbackUrl("/student/exams/exam-123/tether-launch")).toBe(true);
  });

  it("rejects protocol-relative and absolute URLs", () => {
    expect(isSafeTetherLaunchCallbackUrl("//evil.com/student/exams/exam-123/tether-launch")).toBe(false);
    expect(isSafeTetherLaunchCallbackUrl("https://evil.com/student/exams/exam-123/tether-launch")).toBe(false);
  });

  it("rejects extra path segments, query/hash smuggling, and a missing examId", () => {
    expect(isSafeTetherLaunchCallbackUrl("/student/exams/exam-123/tether-launch/extra")).toBe(false);
    expect(isSafeTetherLaunchCallbackUrl("/student/exams//tether-launch")).toBe(false);
    expect(isSafeTetherLaunchCallbackUrl("/student/exams/exam-123/tether-launch?x=1")).toBe(false);
    expect(isSafeTetherLaunchCallbackUrl("/student/exams/exam-123/tether-launch#hash")).toBe(false);
  });

  it("rejects a bare exam page or join page — only the exact tether-launch path matches", () => {
    expect(isSafeTetherLaunchCallbackUrl("/student/exams/exam-123")).toBe(false);
    expect(isSafeTetherLaunchCallbackUrl("/student/exams/join/exam-123")).toBe(false);
  });

  it("rejects null/undefined/empty", () => {
    expect(isSafeTetherLaunchCallbackUrl(null)).toBe(false);
    expect(isSafeTetherLaunchCallbackUrl(undefined)).toBe(false);
    expect(isSafeTetherLaunchCallbackUrl("")).toBe(false);
  });
});

describe("isSafeAppCallbackUrl", () => {
  it("accepts a join path", () => {
    expect(isSafeAppCallbackUrl("/student/exams/join/exam-123")).toBe(true);
  });

  it("accepts a lecturer path", () => {
    expect(isSafeAppCallbackUrl("/lecturer/exams/exam-123/submissions")).toBe(true);
    expect(isSafeAppCallbackUrl("/lecturer")).toBe(true);
  });

  it("accepts the Tether launch path", () => {
    expect(isSafeAppCallbackUrl("/student/exams/exam-123/tether-launch")).toBe(true);
  });

  it("rejects an open-redirect attempt disguised as any of the three allowed shapes", () => {
    expect(isSafeAppCallbackUrl("//evil.com")).toBe(false);
    expect(isSafeAppCallbackUrl("https://evil.com")).toBe(false);
    expect(isSafeAppCallbackUrl("/student/exams/../../../etc/passwd/tether-launch")).toBe(false);
  });

  it("rejects an arbitrary student path outside the two explicitly allowed student shapes", () => {
    expect(isSafeAppCallbackUrl("/student/dashboard")).toBe(false);
    expect(isSafeAppCallbackUrl("/student/exams/exam-123")).toBe(false);
  });

  it("rejects null/undefined/empty", () => {
    expect(isSafeAppCallbackUrl(null)).toBe(false);
    expect(isSafeAppCallbackUrl(undefined)).toBe(false);
    expect(isSafeAppCallbackUrl("")).toBe(false);
  });
});
