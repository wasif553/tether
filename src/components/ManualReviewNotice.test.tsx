import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ManualReviewNotice } from "./ManualReviewNotice";
import { RECOVERY_STATE_COPY } from "@/lib/tetherRecovery";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// No DOM/testing-library dependency in this repo yet — see
// src/app/privacy/student-exam-notice/page.test.tsx for the established
// pattern this reuses: walk the returned React element tree directly and
// collect its text content. ManualReviewNotice has no hooks/state of its
// own (see its own doc comment — deliberately side-effect-free), so it's
// safe to call directly as a plain function outside of a React render.
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

describe("ManualReviewNotice — secure-recovery hardening v1, Part B", () => {
  it("8. shows exactly the required title and message, matching RECOVERY_STATE_COPY.MANUAL_REVIEW_REQUIRED verbatim", () => {
    const text = collectText(ManualReviewNotice({}));
    expect(text).toContain("Recovery requires support");
    expect(text).toContain(RECOVERY_STATE_COPY.MANUAL_REVIEW_REQUIRED.detail);
    expect(RECOVERY_STATE_COPY.MANUAL_REVIEW_REQUIRED.detail).toBe(
      "This examination was started without a verifiable match to this registered computer, or it was started on another registered computer. Contact your lecturer or exam support.",
    );
  });

  it("never exposes installation ids, public keys, fingerprints, signatures, or internal error detail", () => {
    const text = collectText(ManualReviewNotice({ pendingCount: 2 })).toLowerCase();
    for (const forbidden of ["installation", "public key", "fingerprint", "signature", "stack", "error:", "exception"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("9. shows the exact approved 'changes waiting to save' phrasing when drafts are pending, reusing RecoveryStatusBanner's own wording", () => {
    const withPending = collectText(ManualReviewNotice({ pendingCount: 3 }));
    expect(withPending).toContain("Changes waiting to save (3).");
  });

  it("shows no pending-drafts line when there is nothing queued", () => {
    const withoutPending = collectText(ManualReviewNotice({ pendingCount: 0 }));
    expect(withoutPending).not.toContain("Changes waiting to save");
    const withoutProp = collectText(ManualReviewNotice({}));
    expect(withoutProp).not.toContain("Changes waiting to save");
  });

  it("is a pure, side-effect-free render: it never imports anything that could clear the local pending-save queue", () => {
    // Structural guard for item 9 ("preserve pending drafts") — a
    // side-effect-free component (no useEffect/useState, no fetch, no
    // IndexedDB access) cannot itself be the thing that clears queued
    // drafts; this is a permanent, source-level property of the
    // component rather than something a runtime assertion could
    // meaningfully re-check on every render.
    const source = fs.readFileSync(path.join(__dirname, "ManualReviewNotice.tsx"), "utf8");
    expect(source).not.toContain("useEffect");
    expect(source).not.toContain("useState");
    expect(source).not.toContain("deleteEntry");
    expect(source).not.toContain("clearAllForSubmission");
    expect(source).not.toContain("indexedDB");
  });
});
