import { describe, it, expect } from "vitest";
import { lecturerAvailabilityStatus, lecturerDashboardGroup, isLecturerClosedHistoryItem, type LecturerDashboardExamLike } from "./lecturerDashboardGrouping";

const NOW = new Date("2026-08-08T12:00:00Z");

function exam(overrides: Partial<LecturerDashboardExamLike> = {}): LecturerDashboardExamLike {
  return {
    published: true,
    availableFrom: null,
    availableUntil: null,
    needsReviewCount: 0,
    ...overrides,
  };
}

describe("lecturerAvailabilityStatus", () => {
  it("Draft for an unpublished exam regardless of scheduling", () => {
    expect(lecturerAvailabilityStatus(exam({ published: false }), NOW)).toBe("Draft");
  });

  it("Scheduled for a published exam whose availableFrom is in the future", () => {
    expect(lecturerAvailabilityStatus(exam({ availableFrom: "2027-01-01T00:00:00Z" }), NOW)).toBe("Scheduled");
  });

  it("Closed for a published exam whose availableUntil is in the past", () => {
    expect(lecturerAvailabilityStatus(exam({ availableUntil: "2025-01-01T00:00:00Z" }), NOW)).toBe("Closed");
  });

  it("Open for a published exam with no window, or a window that currently contains now", () => {
    expect(lecturerAvailabilityStatus(exam(), NOW)).toBe("Open");
    expect(lecturerAvailabilityStatus(exam({ availableFrom: "2026-01-01T00:00:00Z", availableUntil: "2027-01-01T00:00:00Z" }), NOW)).toBe("Open");
  });
});

describe("lecturerDashboardGroup", () => {
  it("[10] needsAttention takes priority over any availability status, including Closed", () => {
    expect(lecturerDashboardGroup(exam({ needsReviewCount: 3 }), NOW)).toBe("needsAttention");
    expect(lecturerDashboardGroup(exam({ needsReviewCount: 1, availableUntil: "2025-01-01T00:00:00Z" }), NOW)).toBe("needsAttention");
    expect(lecturerDashboardGroup(exam({ needsReviewCount: 1, published: false }), NOW)).toBe("needsAttention");
  });

  it("[9] active/upcoming/draft/closed map 1:1 to availability status when there's nothing to review", () => {
    expect(lecturerDashboardGroup(exam(), NOW)).toBe("active");
    expect(lecturerDashboardGroup(exam({ availableFrom: "2027-01-01T00:00:00Z" }), NOW)).toBe("upcoming");
    expect(lecturerDashboardGroup(exam({ published: false }), NOW)).toBe("draft");
    expect(lecturerDashboardGroup(exam({ availableUntil: "2025-01-01T00:00:00Z" }), NOW)).toBe("closed");
  });
});

describe("isLecturerClosedHistoryItem", () => {
  it("true only for a closed exam with nothing outstanding to review", () => {
    expect(isLecturerClosedHistoryItem(exam({ availableUntil: "2025-01-01T00:00:00Z" }), NOW)).toBe(true);
  });

  it("false for a closed exam that still needs review — must never be capped out of the response", () => {
    expect(isLecturerClosedHistoryItem(exam({ availableUntil: "2025-01-01T00:00:00Z", needsReviewCount: 2 }), NOW)).toBe(false);
  });

  it("false for anything not closed (draft, upcoming, active)", () => {
    expect(isLecturerClosedHistoryItem(exam({ published: false }), NOW)).toBe(false);
    expect(isLecturerClosedHistoryItem(exam({ availableFrom: "2027-01-01T00:00:00Z" }), NOW)).toBe(false);
    expect(isLecturerClosedHistoryItem(exam(), NOW)).toBe(false);
  });
});
