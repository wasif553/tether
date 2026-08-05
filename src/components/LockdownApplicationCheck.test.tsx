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

describe("LockdownApplicationCheck — Part 3 required copy", () => {
  it("BLOCKED shows the exact required title/message and lists the matched application names", () => {
    const text = collectText(
      LockdownApplicationCheck({ state: "BLOCKED", applicationNames: ["TeamViewer", "OBS Studio"], onCheckAgain: () => {}, checking: false }),
    );
    expect(text).toContain("Close applications before continuing");
    expect(text).toContain(
      "Tether found applications that may allow screen sharing, remote access, recording or debugging. Close the listed applications, then check again.",
    );
    expect(text).toContain("TeamViewer");
    expect(text).toContain("OBS Studio");
  });

  it("UNAVAILABLE shows the exact required title/message and never claims a clean scan", () => {
    const text = collectText(LockdownApplicationCheck({ state: "UNAVAILABLE", onCheckAgain: () => {}, checking: false }));
    expect(text).toContain("Application check could not be completed");
    expect(text).toContain("Tether could not verify that prohibited applications are closed. Restart Tether or contact exam support.");
    expect(text.toLowerCase()).not.toContain("clean");
    expect(text.toLowerCase()).not.toContain("no prohibited");
  });

  it("never exposes raw executable names, paths, or internal error detail", () => {
    const text = collectText(
      LockdownApplicationCheck({ state: "BLOCKED", applicationNames: ["TeamViewer"], onCheckAgain: () => {}, checking: false }),
    ).toLowerCase();
    for (const forbidden of [".exe", "c:\\", "stack", "exception", "error:"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("always provides a 'Check again' action and a way back to the dashboard", () => {
    const blocked = collectText(LockdownApplicationCheck({ state: "BLOCKED", applicationNames: [], onCheckAgain: () => {}, checking: false }));
    const unavailable = collectText(LockdownApplicationCheck({ state: "UNAVAILABLE", onCheckAgain: () => {}, checking: false }));
    expect(blocked).toContain("Check again");
    expect(blocked).toContain("Return to dashboard");
    expect(unavailable).toContain("Check again");
    expect(unavailable).toContain("Return to dashboard");
  });
});
