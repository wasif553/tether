/**
 * Tether Windows Lockdown Hardening v1 — pure remote-session/VM
 * classification logic (Part 5). No Electron, no Node child_process —
 * see windowsSessionDetection.ts for the spawning wrapper this feeds.
 */

export type RawWindowsSessionSignals = {
  ok: boolean;
  /** GetSystemMetrics(SM_REMOTESESSION) != 0 — the Windows-authoritative signal for "this session is being interacted with over Remote Desktop/RemoteFX/Remote Assistance/Quick Assist". */
  remoteSession?: boolean;
  /** The SESSIONNAME environment variable Windows itself sets ("Console" for a local session, "RDP-Tcp#N" for a Remote Desktop session) — corroborating signal only, see classifyWindowsSessionSignals's own doc comment on why this is never trusted alone. */
  sessionName?: string | null;
  /** HKLM\HARDWARE\DESCRIPTION\System\BIOS SystemManufacturer. */
  manufacturer?: string | null;
  /** HKLM\HARDWARE\DESCRIPTION\System\BIOS SystemProductName. */
  productName?: string | null;
};

export function parseWindowsSessionOutput(stdout: string): RawWindowsSessionSignals | null {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    const record = parsed as Record<string, unknown> | null;
    if (record == null || typeof record !== "object" || record.ok !== true) return null;
    return {
      ok: true,
      remoteSession: typeof record.remoteSession === "boolean" ? record.remoteSession : undefined,
      sessionName: typeof record.sessionName === "string" ? record.sessionName : null,
      manufacturer: typeof record.manufacturer === "string" ? record.manufacturer : null,
      productName: typeof record.productName === "string" ? record.productName : null,
    };
  } catch {
    return null;
  }
}

// Well-known BIOS/system-identification substrings for the most common
// virtualization platforms — a deliberately evasive VM can rewrite these
// (Part 5: "document false-positive limitations" / this is a best-effort
// signal, never a guarantee — see docs/tether-windows-lockdown-hardening-v1.md).
const VM_SIGNATURE_SUBSTRINGS = ["vmware", "virtualbox", "qemu", "xen", "parallels", "virtual machine", "kvm"];

export type WindowsSessionClassification = {
  isRemoteSession: boolean;
  /** True only when BOTH the Win32-authoritative signal and the SESSIONNAME env var agree it's a remote session, OR when only one signal is available and it says so — see resolveIsRemoteSession's own doc comment for the exact precedence. */
  remoteSessionSignalSource: "WIN32_API" | "SESSIONNAME_ENV" | "BOTH_AGREE" | "UNAVAILABLE";
  isLikelyVirtualMachine: boolean;
  vmSignatureMatched: string | null;
};

/**
 * The Win32 API result is authoritative when present (Part 5: "use
 * Windows-authoritative signals where possible") — SESSIONNAME is kept
 * only as a fallback for the (extremely unlikely, given
 * GetSystemMetrics is always available on every supported Windows
 * release) case where the API call itself could not be evaluated, and
 * as a documented corroborating signal in the classification's own
 * `remoteSessionSignalSource` field for transparency/debugging. Never
 * infers a remote session from screen resolution or any display-related
 * signal (Part 5: "do not infer solely from screen resolution").
 */
export function classifyWindowsSessionSignals(raw: RawWindowsSessionSignals | null): WindowsSessionClassification {
  if (raw == null || !raw.ok) {
    return { isRemoteSession: false, remoteSessionSignalSource: "UNAVAILABLE", isLikelyVirtualMachine: false, vmSignatureMatched: null };
  }

  const sessionNameSaysRemote = typeof raw.sessionName === "string" && raw.sessionName.toUpperCase().startsWith("RDP-");
  let isRemoteSession: boolean;
  let remoteSessionSignalSource: WindowsSessionClassification["remoteSessionSignalSource"];
  if (typeof raw.remoteSession === "boolean") {
    isRemoteSession = raw.remoteSession;
    remoteSessionSignalSource = sessionNameSaysRemote === raw.remoteSession ? "BOTH_AGREE" : "WIN32_API";
  } else if (typeof raw.sessionName === "string") {
    isRemoteSession = sessionNameSaysRemote;
    remoteSessionSignalSource = "SESSIONNAME_ENV";
  } else {
    isRemoteSession = false;
    remoteSessionSignalSource = "UNAVAILABLE";
  }

  const haystack = `${raw.manufacturer ?? ""} ${raw.productName ?? ""}`.toLowerCase();
  const vmSignatureMatched = VM_SIGNATURE_SUBSTRINGS.find((sig) => haystack.includes(sig)) ?? null;

  return {
    isRemoteSession,
    remoteSessionSignalSource,
    isLikelyVirtualMachine: vmSignatureMatched != null,
    vmSignatureMatched,
  };
}
