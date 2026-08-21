import { describe, expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { RecoveryStatusBanner, type RecoveryStatusBannerProps } from "./RecoveryStatusBanner";

/**
 * Exam workspace stability pass — product decision: ordinary, successful
 * autosave must produce NO visible banner at all (only a screen-reader-
 * only announcement); only exceptional states (offline/FAILED/CONFLICT/
 * resume-required) are visible, and those now render as a `position:
 * fixed` overlay so they can never move the question/answer controls.
 * See RecoveryStatusBanner.tsx's own doc comment for the full rationale.
 *
 * No DOM/testing-library dependency in this repo (see
 * ManualReviewNotice.test.tsx for the established pattern this reuses):
 * RecoveryStatusBanner has no hooks/state of its own, so it's safe to
 * call directly as a plain function and inspect the returned React
 * element tree.
 */
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

function baseProps(overrides: Partial<RecoveryStatusBannerProps> = {}): RecoveryStatusBannerProps {
  return {
    connectionStatus: "IDLE",
    pendingCount: 0,
    offline: false,
    recoveryMessage: null,
    onRetryNow: undefined,
    ...overrides,
  };
}

describe("RecoveryStatusBanner — ordinary autosave activity is silent (never visible, never reflows the page)", () => {
  it("steady state (nothing pending, not offline, not failed/conflicted, no resume message) renders an sr-only region, not a visible box", () => {
    const el = RecoveryStatusBanner(baseProps()) as ReactElement<{ className: string }>;
    expect(el.type).toBe("div");
    expect(el.props.className).toContain("sr-only");
    expect(el.props.className).not.toContain("fixed");
  });

  it("an ordinary save in flight (pendingCount > 0, no offline/failed/conflict) is ALSO sr-only — never a visible box", () => {
    const el = RecoveryStatusBanner(baseProps({ connectionStatus: "SENDING", pendingCount: 1 })) as ReactElement<{ className: string }>;
    expect(el.props.className).toContain("sr-only");
    expect(el.props.className).not.toContain("fixed");
  });

  it("SAVED (ordinary success) is ALSO sr-only — never a visible box", () => {
    const el = RecoveryStatusBanner(baseProps({ connectionStatus: "SAVED", pendingCount: 0 })) as ReactElement<{ className: string }>;
    expect(el.props.className).toContain("sr-only");
    expect(el.props.className).not.toContain("fixed");
  });

  it("the sr-only region still carries role=status/aria-live so a screen reader hears 'Saving.'/'Saved.' without any visual element", () => {
    const sending = RecoveryStatusBanner(baseProps({ connectionStatus: "SENDING", pendingCount: 1 })) as ReactElement<{
      role: string;
      "aria-live": string;
    }>;
    expect(sending.props.role).toBe("status");
    expect(sending.props["aria-live"]).toBe("polite");
    expect(collectText(sending)).toBe("Saving.");

    const saved = RecoveryStatusBanner(baseProps({ connectionStatus: "SAVED" }));
    expect(collectText(saved)).toBe("Saved.");
  });

  it("steady state's sr-only region has no text at all", () => {
    expect(collectText(RecoveryStatusBanner(baseProps())).trim()).toBe("");
  });
});

describe("RecoveryStatusBanner — exceptional states are visible AND non-reflowing (position: fixed, outside document flow)", () => {
  it("offline, FAILED, CONFLICT, and a resume message all render a `fixed` overlay, never sr-only", () => {
    const cases: RecoveryStatusBannerProps[] = [
      baseProps({ offline: true }),
      baseProps({ connectionStatus: "FAILED", pendingCount: 1 }),
      baseProps({ connectionStatus: "CONFLICT" }),
      baseProps({ recoveryMessage: "Resume secure examination" }),
    ];
    for (const props of cases) {
      const el = RecoveryStatusBanner(props) as ReactElement<{ className: string }>;
      expect(el.props.className).toContain("fixed");
      expect(el.props.className).not.toContain("sr-only");
    }
  });

  it("the fixed overlay is taken out of normal layout flow (fixed positioning) and marked pointer-events-none on the outer wrapper so it can never block clicks on content underneath when nothing is shown", () => {
    const el = RecoveryStatusBanner(baseProps({ offline: true })) as ReactElement<{ className: string }>;
    expect(el.props.className).toContain("pointer-events-none");
    expect(el.props.className).toMatch(/\bfixed\b/);
    expect(el.props.className).toContain("inset-x-0");
  });

  it("offline shows the connection-interrupted copy, with or without a pending count", () => {
    const withPending = collectText(RecoveryStatusBanner(baseProps({ offline: true, pendingCount: 2 })));
    expect(withPending).toContain("Connection interrupted");
    expect(withPending).toContain("2 changes waiting to save");
    const withoutPending = collectText(RecoveryStatusBanner(baseProps({ offline: true })));
    expect(withoutPending).toContain("Connection interrupted");
    expect(withoutPending).not.toContain("changes waiting to save");
  });

  it("FAILED shows the retry copy and a Retry now button when onRetryNow is provided", () => {
    const onRetryNow = () => {};
    const text = collectText(RecoveryStatusBanner(baseProps({ connectionStatus: "FAILED", pendingCount: 1, onRetryNow })));
    expect(text).toContain("Save could not yet be confirmed");
    expect(text).toContain("Retry now");
  });

  it("CONFLICT shows the conflict copy, never a retry button", () => {
    const onRetryNow = () => {};
    const text = collectText(RecoveryStatusBanner(baseProps({ connectionStatus: "CONFLICT", onRetryNow })));
    expect(text).toContain("A newer saved version of this answer already exists");
    expect(text).not.toContain("Retry now");
  });

  it("a resume message takes priority and shows a Retry now button", () => {
    const onRetryNow = () => {};
    const text = collectText(RecoveryStatusBanner(baseProps({ recoveryMessage: "Resume secure examination", onRetryNow })));
    expect(text).toContain("Resume secure examination");
    expect(text).toContain("Retry now");
  });

  it("role=status/aria-live are present on the visible overlay too, on the inner interactive element", () => {
    const el = RecoveryStatusBanner(baseProps({ offline: true })) as ReactElement<{ children: ReactElement<{ role: string; "aria-live": string }> }>;
    // Outer wrapper is a plain positioning div; the inner pill carries role/aria-live.
    const inner = el.props.children;
    expect(inner.props.role).toBe("status");
    expect(inner.props["aria-live"]).toBe("polite");
  });
});
