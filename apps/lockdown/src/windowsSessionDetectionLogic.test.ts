import { describe, it, expect } from "vitest";
import { parseWindowsSessionOutput, classifyWindowsSessionSignals } from "./windowsSessionDetectionLogic";

describe("parseWindowsSessionOutput", () => {
  it("parses a well-formed result", () => {
    expect(parseWindowsSessionOutput('{"ok":true,"remoteSession":true,"sessionName":"RDP-Tcp#3","manufacturer":"Dell Inc.","productName":"OptiPlex 7090"}')).toEqual({
      ok: true,
      remoteSession: true,
      sessionName: "RDP-Tcp#3",
      manufacturer: "Dell Inc.",
      productName: "OptiPlex 7090",
    });
  });

  it("14. an explicitly unsupported/failed state is returned as null, not silently defaulted to 'not remote'", () => {
    expect(parseWindowsSessionOutput("not json")).toBeNull();
    expect(parseWindowsSessionOutput('{"ok":false}')).toBeNull();
    expect(parseWindowsSessionOutput("")).toBeNull();
  });

  it("tolerates missing optional fields", () => {
    expect(parseWindowsSessionOutput('{"ok":true}')).toEqual({ ok: true, remoteSession: undefined, sessionName: null, manufacturer: null, productName: null });
  });
});

describe("classifyWindowsSessionSignals — remote session", () => {
  it("12. detects an active Remote Desktop session via the Win32-authoritative signal", () => {
    const result = classifyWindowsSessionSignals({ ok: true, remoteSession: true, sessionName: "RDP-Tcp#1" });
    expect(result.isRemoteSession).toBe(true);
    expect(result.remoteSessionSignalSource).toBe("BOTH_AGREE");
  });

  it("13. an ordinary local session passes (not flagged remote)", () => {
    const result = classifyWindowsSessionSignals({ ok: true, remoteSession: false, sessionName: "Console" });
    expect(result.isRemoteSession).toBe(false);
    expect(result.isLikelyVirtualMachine).toBe(false);
  });

  it("the Win32 API result is authoritative even when SESSIONNAME appears to disagree", () => {
    const result = classifyWindowsSessionSignals({ ok: true, remoteSession: true, sessionName: "Console" });
    expect(result.isRemoteSession).toBe(true);
    expect(result.remoteSessionSignalSource).toBe("WIN32_API");
  });

  it("falls back to SESSIONNAME only when the Win32 API result is unavailable", () => {
    const result = classifyWindowsSessionSignals({ ok: true, sessionName: "RDP-Tcp#2" });
    expect(result.isRemoteSession).toBe(true);
    expect(result.remoteSessionSignalSource).toBe("SESSIONNAME_ENV");
  });

  it("14. an unavailable/failed query is explicit, never defaulted to 'not remote' as if it were a clean check", () => {
    const result = classifyWindowsSessionSignals(null);
    expect(result.remoteSessionSignalSource).toBe("UNAVAILABLE");
    // Structurally distinguishable from a genuine clean local-session result:
    expect(result).not.toEqual(classifyWindowsSessionSignals({ ok: true, remoteSession: false, sessionName: "Console" }));
  });
});

describe("classifyWindowsSessionSignals — virtual machine indicators", () => {
  it("matches a VMware signature", () => {
    const result = classifyWindowsSessionSignals({ ok: true, manufacturer: "VMware, Inc.", productName: "VMware Virtual Platform" });
    expect(result.isLikelyVirtualMachine).toBe(true);
    expect(result.vmSignatureMatched).toBe("vmware");
  });

  it("matches a VirtualBox signature", () => {
    const result = classifyWindowsSessionSignals({ ok: true, manufacturer: "innotek GmbH", productName: "VirtualBox" });
    expect(result.isLikelyVirtualMachine).toBe(true);
    expect(result.vmSignatureMatched).toBe("virtualbox");
  });

  it("matches a generic Hyper-V/Xen 'Virtual Machine' product name", () => {
    const result = classifyWindowsSessionSignals({ ok: true, manufacturer: "Microsoft Corporation", productName: "Virtual Machine" });
    expect(result.isLikelyVirtualMachine).toBe(true);
    expect(result.vmSignatureMatched).toBe("virtual machine");
  });

  it("does not flag an ordinary physical machine", () => {
    const result = classifyWindowsSessionSignals({ ok: true, manufacturer: "Dell Inc.", productName: "OptiPlex 7090" });
    expect(result.isLikelyVirtualMachine).toBe(false);
    expect(result.vmSignatureMatched).toBeNull();
  });

  it("is case-insensitive", () => {
    const result = classifyWindowsSessionSignals({ ok: true, manufacturer: "VMWARE, INC.", productName: "" });
    expect(result.isLikelyVirtualMachine).toBe(true);
  });
});
