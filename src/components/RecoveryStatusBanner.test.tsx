import { describe, expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { RecoveryStatusBanner, type RecoveryStatusBannerProps } from "./RecoveryStatusBanner";

/**
 * MCQ interaction layout-shift fix — see RecoveryStatusBanner.tsx's own
 * doc comment for the root cause. No DOM/testing-library dependency in
 * this repo (see ManualReviewNotice.test.tsx for the established
 * pattern this reuses): RecoveryStatusBanner has no hooks/state of its
 * own, so it's safe to call directly as a plain function and inspect the
 * returned React element tree.
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

describe("RecoveryStatusBanner — MCQ interaction layout-shift fix (root cause: this box's own mount/unmount)", () => {
  it("never returns null — the root node is always the same rendered div, steady-state or not", () => {
    const steady = RecoveryStatusBanner(baseProps());
    const pending = RecoveryStatusBanner(baseProps({ connectionStatus: "SENDING", pendingCount: 1 }));
    expect(steady).not.toBeNull();
    expect(pending).not.toBeNull();
    expect((steady as ReactElement).type).toBe("div");
    expect((pending as ReactElement).type).toBe("div");
  });

  it("the root element's className always carries the same stable min-height token, whether or not there is anything to show", () => {
    const steady = RecoveryStatusBanner(baseProps()) as ReactElement<{ className: string }>;
    const pending = RecoveryStatusBanner(baseProps({ connectionStatus: "SENDING", pendingCount: 1 })) as ReactElement<{ className: string }>;
    const failed = RecoveryStatusBanner(baseProps({ connectionStatus: "FAILED", pendingCount: 2 })) as ReactElement<{ className: string }>;
    for (const el of [steady, pending, failed]) {
      expect(el.props.className).toContain("min-h-[34px]");
    }
  });

  it("steady state (nothing pending, not offline, not failed/conflicted, no resume message) renders no visible text", () => {
    const text = collectText(RecoveryStatusBanner(baseProps()));
    expect(text.trim()).toBe("");
  });

  it("a save in flight shows the exact approved 'changes waiting to save' text", () => {
    const text = collectText(RecoveryStatusBanner(baseProps({ connectionStatus: "SENDING", pendingCount: 1 })));
    expect(text).toContain("Changes waiting to save (1).");
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
    expect(text).toBe("Resume secure examination Retry now");
  });

  it("aria-live/role are present unconditionally, not only when something is shown — a live region already in the DOM announces more reliably than one inserted fresh", () => {
    const steady = RecoveryStatusBanner(baseProps()) as ReactElement<{ role: string; "aria-live": string }>;
    expect(steady.props.role).toBe("status");
    expect(steady.props["aria-live"]).toBe("polite");
  });
});
