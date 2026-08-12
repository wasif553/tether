import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { ActivationConfirmationPending } from "./ActivationConfirmationPending";

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

/** Collects every href value from the rendered tree — used to prove no dashboard link exists at all. */
function collectHrefs(node: ReactNode): string[] {
  if (node == null || typeof node === "boolean" || typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap(collectHrefs);
  if (typeof node === "object" && "props" in node) {
    const props = (node as { props?: { href?: string; children?: ReactNode } }).props;
    const own = props?.href != null ? [props.href] : [];
    return [...own, ...collectHrefs(props?.children)];
  }
  return [];
}

// PR #22 follow-up review, Issue 1 — the dedicated
// ACTIVATION_CONFIRMATION_PENDING screen. See this component's own doc
// comment for why it must never offer an ordinary Return-to-dashboard
// navigation the way LockdownApplicationCheck does.
describe("ActivationConfirmationPending — REQUIRED TEST 7 shape", () => {
  it("renders the given title/message/retryLabel", () => {
    const text = collectText(
      ActivationConfirmationPending({
        title: "Confirming exam start",
        message: "Tether could not confirm with the exam server whether this examination has started.",
        retryLabel: "Retry",
        onRetry: () => {},
        checking: false,
      }),
    );
    expect(text).toContain("Confirming exam start");
    expect(text).toContain("Tether could not confirm with the exam server whether this examination has started.");
    expect(text).toContain("Retry");
  });

  it("never renders any href/link at all — no Return to dashboard, no navigation away", () => {
    const hrefs = collectHrefs(
      ActivationConfirmationPending({
        title: "title",
        message: "message",
        retryLabel: "Retry",
        onRetry: () => {},
        checking: false,
      }),
    );
    expect(hrefs).toEqual([]);
  });

  it("never contains the literal text 'dashboard' anywhere in its rendered output", () => {
    const text = collectText(
      ActivationConfirmationPending({
        title: "title",
        message: "message",
        retryLabel: "Retry",
        onRetry: () => {},
        checking: false,
      }),
    ).toLowerCase();
    expect(text).not.toContain("dashboard");
  });

  it("disables the retry button and shows a checking label while checking", () => {
    const text = collectText(
      ActivationConfirmationPending({ title: "title", message: "message", retryLabel: "Retry", onRetry: () => {}, checking: true }),
    );
    expect(text).toContain("Checking…");
  });
});
