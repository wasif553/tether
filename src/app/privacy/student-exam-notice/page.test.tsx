import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import StudentExamNoticePage from "./page";

// No DOM/testing-library dependency in this repo yet — walk the returned
// React element tree directly and collect its text content.
function collectText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(" ");
  if (typeof node === "object" && "props" in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return collectText(props?.children);
  }
  return "";
}

describe("student exam notice page", () => {
  it("renders camera monitoring and browser secure mode sections", () => {
    const text = collectText(StudentExamNoticePage());

    expect(text).toContain("Camera monitoring");
    expect(text).toContain("checks that your camera is available when the exam starts");
    expect(text).toContain("store video recordings");
    expect(text).toContain("Browser secure mode");
    expect(text).toContain("block copy, cut, and paste inside the exam page");
    expect(text).toContain("cannot close other browser tabs");
  });

  it("renders the camera evidence frames section with required privacy wording", () => {
    const text = collectText(StudentExamNoticePage());

    expect(text).toContain("Camera evidence frames");
    expect(text).toContain(
      "This exam may save a single low-resolution camera evidence frame if a possible phone or",
    );
    expect(text).toContain("second person is detected. No video is recorded.");
    expect(text).toContain("available only to");
    expect(text.toLowerCase()).toContain("never a video");
    expect(text.toLowerCase()).toContain("never capture your exam screen");
    expect(text.toLowerCase()).toContain("facial recognition");
    expect(text.toLowerCase()).toContain("biometric identifier");
    expect(text.toLowerCase()).not.toContain("cheating");
    expect(text.toLowerCase()).not.toContain("misconduct detected");
  });
});
