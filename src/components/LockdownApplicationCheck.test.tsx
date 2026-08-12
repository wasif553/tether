import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { LockdownApplicationCheck } from "./LockdownApplicationCheck";

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

// v1.7.4 pre-exam readiness — generalised from a two-state
// (BLOCKED/UNAVAILABLE) process-only screen into a generic
// title/message/applicationNames remediation screen shared by every
// mandatory PRECHECK condition (process, remote session, display). The
// caller now supplies the exact copy — see src/lib/tetherLaunch.ts's
// resolveActivationFailureIssue/resolveDisplayPreflightIssue for the
// actual required wording per reason; this component's own job is only
// to render whatever it's given, calmly, with a Recheck action and a
// way back to the dashboard.
describe("LockdownApplicationCheck — Part 3 required screen shape", () => {
  it("renders the given title/message and lists the given application names", () => {
    const text = collectText(
      LockdownApplicationCheck({
        title: "Close applications before continuing",
        message:
          "Tether found applications that may allow screen sharing, remote access, recording or debugging. Close the listed applications, then select Recheck.",
        applicationNames: ["TeamViewer", "OBS Studio"],
        onCheckAgain: () => {},
        checking: false,
      }),
    );
    expect(text).toContain("Close applications before continuing");
    expect(text).toContain(
      "Tether found applications that may allow screen sharing, remote access, recording or debugging. Close the listed applications, then select Recheck.",
    );
    expect(text).toContain("TeamViewer");
    expect(text).toContain("OBS Studio");
  });

  it("renders a message-only screen (no applicationNames) without an empty list", () => {
    const text = collectText(
      LockdownApplicationCheck({
        title: "Application check could not be completed",
        message: "Tether could not verify that prohibited applications are closed. Restart Tether or contact exam support.",
        onCheckAgain: () => {},
        checking: false,
      }),
    );
    expect(text).toContain("Application check could not be completed");
    expect(text).toContain("Tether could not verify that prohibited applications are closed. Restart Tether or contact exam support.");
    expect(text.toLowerCase()).not.toContain("clean");
    expect(text.toLowerCase()).not.toContain("no prohibited");
  });

  it("never exposes raw executable names, paths, or internal error detail beyond what the caller supplies", () => {
    const text = collectText(
      LockdownApplicationCheck({
        title: "Close applications before continuing",
        message: "Tether found applications that may allow screen sharing, remote access, recording or debugging. Close the listed applications, then select Recheck.",
        applicationNames: ["TeamViewer"],
        onCheckAgain: () => {},
        checking: false,
      }),
    ).toLowerCase();
    for (const forbidden of [".exe", "c:\\", "stack", "exception", "error:"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("always provides a Recheck action and a way back to the dashboard", () => {
    const withApps = collectText(
      LockdownApplicationCheck({ title: "Close applications before continuing", message: "message", applicationNames: [], onCheckAgain: () => {}, checking: false }),
    );
    const withoutApps = collectText(
      LockdownApplicationCheck({ title: "Application check could not be completed", message: "message", onCheckAgain: () => {}, checking: false }),
    );
    expect(withApps).toContain("Recheck");
    expect(withApps).toContain("Return to dashboard");
    expect(withoutApps).toContain("Recheck");
    expect(withoutApps).toContain("Return to dashboard");
  });

  it("disables the Recheck button and shows a checking label while checking", () => {
    const text = collectText(
      LockdownApplicationCheck({ title: "title", message: "message", onCheckAgain: () => {}, checking: true }),
    );
    expect(text).toContain("Checking…");
  });
});
