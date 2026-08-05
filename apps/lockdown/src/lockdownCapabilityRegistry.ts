/**
 * Tether Windows Lockdown Hardening v1 — the central Windows lockdown
 * capability registry (Part 1). See
 * docs/tether-windows-lockdown-hardening-v1.md.
 *
 * Pure, dependency-free (no Electron, no Node child_process) — safe to
 * import from anywhere, including plain vitest, mirroring
 * displayEnforcementLogic.ts's own convention. This is the ONE place
 * "which applications/behaviours does Tether care about, and what does
 * it do about each one" is defined — src/processDetection.ts (the
 * Windows process-enumeration service) and main.ts (Electron hardening,
 * keyboard/navigation controls) both consult this file rather than
 * re-deriving their own lists.
 *
 * Deliberately does NOT depend only on window titles (a title is
 * trivially renamed/localized/hidden) — every process-based capability
 * below matches on the executable's own file name, normalized (see
 * normalizeExecutableName), never on any window's caption text.
 *
 * Scope, per the task's own explicit boundaries: practical Windows
 * controls for a controlled pilot. No kernel driver, no invasive
 * antivirus-style behaviour, no blanket process termination, no TPM
 * attestation. Detection is always an INTEGRITY SIGNAL for lecturer
 * review, never an automatic misconduct conclusion — see
 * docs/tether-windows-lockdown-hardening-v1.md, "Core principles".
 */

// ---------------------------------------------------------------------------
// Classification vocabulary (Part 1).
// ---------------------------------------------------------------------------

export const LOCKDOWN_CAPABILITY_ACTIONS = [
  /** Must be closed before final-exam content can open (Part 3). Every BLOCK_DURING_EXAM capability is also enforced at this stage — see resolvePreflightBlockingCapabilities. */
  "BLOCK_BEFORE_EXAM",
  /** Blocks/covers exam content with a calm overlay if detected WHILE the exam is active (Part 4); implies BLOCK_BEFORE_EXAM at preflight too. */
  "BLOCK_DURING_EXAM",
  /** Must be closed before content opens, but reappearing mid-exam does not re-cover content — only recorded (used for capabilities whose process presence alone cannot reliably distinguish "installed/idle" from "actively being used against Tether"). */
  "WARN_AND_REQUIRE_CLOSE",
  /** Never blocks anything on its own — recorded as a technical/integrity signal for lecturer awareness only. */
  "DETECT_AND_RECORD",
  /** No reliable Windows-level detection exists for this capability in this pilot — documented, not enforced. See docs/tether-windows-lockdown-hardening-v1.md, "Unsupported controls". */
  "NOT_SUPPORTED",
] as const;
export type LockdownCapabilityAction = (typeof LOCKDOWN_CAPABILITY_ACTIONS)[number];

export const LOCKDOWN_CAPABILITY_CATEGORIES = [
  "REMOTE_CONTROL",
  "DEBUGGING",
  "VIRTUALIZATION",
  "CAPTURE_OVERLAY",
  "NAVIGATION_ESCAPE",
] as const;
export type LockdownCapabilityCategory = (typeof LOCKDOWN_CAPABILITY_CATEGORIES)[number];

export const LOCKDOWN_FALSE_POSITIVE_RISKS = ["LOW", "MEDIUM", "HIGH"] as const;
export type LockdownFalsePositiveRisk = (typeof LOCKDOWN_FALSE_POSITIVE_RISKS)[number];

export const LOCKDOWN_DETECTION_METHODS = [
  /** Windows process enumeration (Get-Process), matched against executableNames below — see processDetection.ts. */
  "PROCESS_NAME_MATCH",
  /** Win32 session API (GetSystemMetrics(SM_REMOTESESSION)) plus the SESSIONNAME environment variable as corroboration — see windowsSessionDetection.ts. */
  "WINDOWS_SESSION_API",
  /** Windows system/BIOS identification strings (registry SystemManufacturer/SystemProductName) — see windowsSessionDetection.ts. */
  "WINDOWS_SYSTEM_INFO",
  /** Electron webContents/session API (will-navigate, setWindowOpenHandler, will-download, devtools-opened, before-input-event) — see main.ts. */
  "ELECTRON_WEBCONTENTS_API",
  /** Electron/Chromium command-line switch inspection (process.argv / app.commandLine) — see main.ts. */
  "ELECTRON_COMMAND_LINE",
  /** No detection implemented in this pilot. */
  "NOT_IMPLEMENTED",
] as const;
export type LockdownDetectionMethod = (typeof LOCKDOWN_DETECTION_METHODS)[number];

/**
 * Which TETHER_BLOCK_* environment toggle (Part 12) governs this
 * capability's category, if any. See lockdownConfig.ts. `null` means the
 * capability's action is never gated by a category toggle (either it
 * never blocks anything — always DETECT_AND_RECORD — or it's an
 * Electron-level control that isn't a process-detection toggle at all).
 */
export type LockdownConfigToggle =
  | "TETHER_BLOCK_REMOTE_CONTROL"
  | "TETHER_BLOCK_SCREEN_CAPTURE_TOOLS"
  | "TETHER_BLOCK_DEBUG_TOOLS"
  | "TETHER_BLOCK_VIRTUAL_MACHINES"
  | null;

export type LockdownCapability = {
  /** Stable identifier — never renamed once shipped; used as the capability reference in evidence metadata (Part 11) and IPC payloads. */
  id: string;
  /** Exact, calm, non-technical name shown to the student when this capability blocks/warns (Part 13) — e.g. "TeamViewer", never a raw executable name. */
  displayName: string;
  category: LockdownCapabilityCategory;
  /**
   * Normalized (lowercase, no path, no ".exe") executable names this
   * capability matches on — see normalizeExecutableName. Empty for
   * capabilities whose detectionMethod is not PROCESS_NAME_MATCH.
   */
  executableNames: string[];
  detectionMethod: LockdownDetectionMethod;
  /** Free-text elaboration on the detection method and its limits — e.g. why command-line arguments are deliberately NOT inspected for this capability. */
  detectionNotes: string;
  falsePositiveRisk: LockdownFalsePositiveRisk;
  /** The classification BEFORE any TETHER_BLOCK_* toggle is applied — see resolveEffectiveAction. */
  defaultAction: LockdownCapabilityAction;
  configToggle: LockdownConfigToggle;
  /** Shown to the student only when the EFFECTIVE action blocks or warns — calm, non-accusatory, exact application name only, no technical detail. Null when the capability never surfaces student-facing copy (DETECT_AND_RECORD/NOT_SUPPORTED). */
  studentExplanation: string | null;
  /** What gets recorded, and where (IntegrityEvent vs PlatformAuditLog) — see Part 11's classification rules, applied uniformly in lockdownEventClassification.ts. */
  auditEvidenceBehavior: string;
  supportedWindowsVersions: string;
};

const PROCESS_NAME_MATCH_WINDOWS_VERSIONS = "Windows 10 (1607+), Windows 11 — PowerShell 5.1 (built in) or PowerShell 7+.";
const SESSION_API_WINDOWS_VERSIONS = "Windows 10, Windows 11 — Win32 user32.dll GetSystemMetrics, present on every supported Windows release.";
const ELECTRON_LEVEL_WINDOWS_VERSIONS = "All Tether-supported Windows versions — enforced by Electron/Chromium APIs, not a Windows-version-specific mechanism.";

// ---------------------------------------------------------------------------
// The registry (Part 1). Grouped by category for readability; order has no
// runtime significance — matching is by executableNames membership only.
// ---------------------------------------------------------------------------

export const LOCKDOWN_CAPABILITY_REGISTRY: LockdownCapability[] = [
  // --- Remote control and screen sharing ---------------------------------
  {
    id: "TEAMVIEWER",
    displayName: "TeamViewer",
    category: "REMOTE_CONTROL",
    executableNames: ["teamviewer", "tv_w32", "tv_x64"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "Matches TeamViewer's main application and both known 32/64-bit host-service executable names.",
    falsePositiveRisk: "LOW",
    defaultAction: "BLOCK_DURING_EXAM",
    configToggle: "TETHER_BLOCK_REMOTE_CONTROL",
    studentExplanation: "TeamViewer",
    auditEvidenceBehavior: "Reviewable IntegrityEvent (REMOTE_CONTROL_SOFTWARE_DETECTED) while an exam is active; PlatformAuditLog only at preflight (before content ever opens).",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "ANYDESK",
    displayName: "AnyDesk",
    category: "REMOTE_CONTROL",
    executableNames: ["anydesk"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "Single, stable executable name across AnyDesk releases.",
    falsePositiveRisk: "LOW",
    defaultAction: "BLOCK_DURING_EXAM",
    configToggle: "TETHER_BLOCK_REMOTE_CONTROL",
    studentExplanation: "AnyDesk",
    auditEvidenceBehavior: "Reviewable IntegrityEvent (REMOTE_CONTROL_SOFTWARE_DETECTED) while an exam is active; PlatformAuditLog only at preflight.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "RUSTDESK",
    displayName: "RustDesk",
    category: "REMOTE_CONTROL",
    executableNames: ["rustdesk"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "Single, stable executable name.",
    falsePositiveRisk: "LOW",
    defaultAction: "BLOCK_DURING_EXAM",
    configToggle: "TETHER_BLOCK_REMOTE_CONTROL",
    studentExplanation: "RustDesk",
    auditEvidenceBehavior: "Reviewable IntegrityEvent (REMOTE_CONTROL_SOFTWARE_DETECTED) while an exam is active; PlatformAuditLog only at preflight.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "CHROME_REMOTE_DESKTOP",
    displayName: "Chrome Remote Desktop",
    category: "REMOTE_CONTROL",
    executableNames: ["remoting_host", "remoting_native_messaging_host"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "Matches the Chrome Remote Desktop host background service process names; the feature otherwise runs inside an ordinary Chrome tab, which cannot be distinguished from any other browsing by process name alone.",
    falsePositiveRisk: "MEDIUM",
    defaultAction: "BLOCK_DURING_EXAM",
    configToggle: "TETHER_BLOCK_REMOTE_CONTROL",
    studentExplanation: "Chrome Remote Desktop",
    auditEvidenceBehavior: "Reviewable IntegrityEvent (REMOTE_CONTROL_SOFTWARE_DETECTED) while an exam is active; PlatformAuditLog only at preflight.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "MS_REMOTE_DESKTOP",
    displayName: "Microsoft Remote Desktop",
    category: "REMOTE_CONTROL",
    executableNames: ["mstsc", "msrdcw", "rdclient.windows"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "Covers the built-in mstsc.exe client, the modern Windows App/Remote Desktop client (MSRDCW.exe), and the Windows App RdClient executable. This detects the CLIENT reaching out, not this device being an inbound RDP host target — see the separate REMOTE_DESKTOP_SESSION capability for whether Tether itself is running inside an inbound RDP session.",
    falsePositiveRisk: "LOW",
    defaultAction: "BLOCK_DURING_EXAM",
    configToggle: "TETHER_BLOCK_REMOTE_CONTROL",
    studentExplanation: "Remote Desktop Connection",
    auditEvidenceBehavior: "Reviewable IntegrityEvent (REMOTE_CONTROL_SOFTWARE_DETECTED) while an exam is active; PlatformAuditLog only at preflight.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "QUICK_ASSIST",
    displayName: "Quick Assist",
    category: "REMOTE_CONTROL",
    executableNames: ["quickassist"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "Built into Windows 10/11; single stable executable name.",
    falsePositiveRisk: "LOW",
    defaultAction: "BLOCK_DURING_EXAM",
    configToggle: "TETHER_BLOCK_REMOTE_CONTROL",
    studentExplanation: "Quick Assist",
    auditEvidenceBehavior: "Reviewable IntegrityEvent (REMOTE_CONTROL_SOFTWARE_DETECTED) while an exam is active; PlatformAuditLog only at preflight.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "ZOOM",
    displayName: "Zoom",
    category: "REMOTE_CONTROL",
    executableNames: ["zoom"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "Process presence only proves Zoom is OPEN, not that screen sharing is active — Zoom has many legitimate non-exam uses (an oral component, a lecturer meeting held earlier the same day). Deliberately not a hard BLOCK_DURING_EXAM for this reason.",
    falsePositiveRisk: "HIGH",
    defaultAction: "WARN_AND_REQUIRE_CLOSE",
    configToggle: "TETHER_BLOCK_REMOTE_CONTROL",
    studentExplanation: "Zoom",
    auditEvidenceBehavior: "PlatformAuditLog only (preflight block/student-closed-before-open) — never re-covers content if it reappears mid-exam, only recorded.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "MS_TEAMS",
    displayName: "Microsoft Teams",
    category: "REMOTE_CONTROL",
    executableNames: ["teams", "ms-teams"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "Same reasoning as Zoom — process presence does not prove active screen sharing, and Teams is extremely common as a general-purpose institutional chat client with no exam relevance at all.",
    falsePositiveRisk: "HIGH",
    defaultAction: "WARN_AND_REQUIRE_CLOSE",
    configToggle: "TETHER_BLOCK_REMOTE_CONTROL",
    studentExplanation: "Microsoft Teams",
    auditEvidenceBehavior: "PlatformAuditLog only (preflight block/student-closed-before-open) — never re-covers content if it reappears mid-exam, only recorded.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "DISCORD",
    displayName: "Discord",
    category: "REMOTE_CONTROL",
    executableNames: ["discord"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "Same reasoning as Zoom/Teams — a very common general-purpose chat application for many students unrelated to any exam use.",
    falsePositiveRisk: "HIGH",
    defaultAction: "WARN_AND_REQUIRE_CLOSE",
    configToggle: "TETHER_BLOCK_REMOTE_CONTROL",
    studentExplanation: "Discord",
    auditEvidenceBehavior: "PlatformAuditLog only (preflight block/student-closed-before-open) — never re-covers content if it reappears mid-exam, only recorded.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "VNC",
    displayName: "VNC remote-control software",
    category: "REMOTE_CONTROL",
    executableNames: ["vncserver", "vncviewer", "tvnserver", "winvnc", "ultravnc"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "Covers the most common VNC client/server distributions (RealVNC, TightVNC, UltraVNC). Other, less common VNC forks are not covered — see docs/tether-windows-lockdown-hardening-v1.md, 'Unsupported controls'.",
    falsePositiveRisk: "LOW",
    defaultAction: "BLOCK_DURING_EXAM",
    configToggle: "TETHER_BLOCK_REMOTE_CONTROL",
    studentExplanation: "VNC remote-control software",
    auditEvidenceBehavior: "Reviewable IntegrityEvent (REMOTE_CONTROL_SOFTWARE_DETECTED) while an exam is active; PlatformAuditLog only at preflight.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },

  // --- Development / debugging ---------------------------------------------
  {
    id: "CHROME_DEVTOOLS_REMOTE_DEBUGGING",
    displayName: "Remote debugging port",
    category: "DEBUGGING",
    executableNames: [],
    detectionMethod: "ELECTRON_COMMAND_LINE",
    detectionNotes: "Tether itself is Chromium-based — this capability is about refusing to LAUNCH if Tether's own process was started with a --remote-debugging-port/--remote-debugging-pipe switch, not about scanning for another browser. See main.ts's command-line-switch rejection (Part 7).",
    falsePositiveRisk: "LOW",
    defaultAction: "BLOCK_BEFORE_EXAM",
    configToggle: null,
    studentExplanation: null,
    auditEvidenceBehavior: "PlatformAuditLog only — Tether refuses to start; there is no exam session for an IntegrityEvent to attach to.",
    supportedWindowsVersions: ELECTRON_LEVEL_WINDOWS_VERSIONS,
  },
  {
    id: "ELECTRON_DEVTOOLS",
    displayName: "Developer tools",
    category: "DEBUGGING",
    executableNames: [],
    detectionMethod: "ELECTRON_WEBCONTENTS_API",
    detectionNotes: "Tether's own DevTools window opening (via shortcut or menu) — see webContents 'devtools-opened' handling and the packaged-build DevTools prevention in Part 7/8.",
    falsePositiveRisk: "LOW",
    defaultAction: "BLOCK_DURING_EXAM",
    configToggle: null,
    studentExplanation: "Developer tools",
    auditEvidenceBehavior: "Reviewable IntegrityEvent (DEBUGGING_TOOL_DETECTED) while an exam is active.",
    supportedWindowsVersions: ELECTRON_LEVEL_WINDOWS_VERSIONS,
  },
  {
    id: "NODE_INSPECTOR",
    displayName: "Node.js process",
    category: "DEBUGGING",
    executableNames: ["node"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "Distinguishing an ordinary node.exe from one launched with --inspect would require reading the process command line — deliberately NOT done (privacy requirement: never collect command-line arguments unless strictly necessary and privacy-reviewed; a general capability audit did not find this necessary for a controlled pilot). As a result this can only ever detect Node.js RUNNING, not that it is being used to debug/inspect Tether — recorded only, never blocked.",
    falsePositiveRisk: "HIGH",
    defaultAction: "DETECT_AND_RECORD",
    configToggle: null,
    studentExplanation: null,
    auditEvidenceBehavior: "Reviewable IntegrityEvent (DEBUGGING_TOOL_DETECTED), always INFO-tier — never blocks.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "VISUAL_STUDIO_DEBUGGER",
    displayName: "Visual Studio",
    category: "DEBUGGING",
    executableNames: ["devenv", "msvsmon"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "devenv.exe (the Visual Studio IDE) and msvsmon.exe (the remote debugging monitor). A student may have Visual Studio open for unrelated coursework — moderate false-positive risk.",
    falsePositiveRisk: "MEDIUM",
    defaultAction: "BLOCK_DURING_EXAM",
    configToggle: "TETHER_BLOCK_DEBUG_TOOLS",
    studentExplanation: "Visual Studio",
    auditEvidenceBehavior: "Reviewable IntegrityEvent (DEBUGGING_TOOL_DETECTED) while an exam is active; PlatformAuditLog only at preflight.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "VSCODE_DEBUG_ADAPTER",
    displayName: "VS Code debug session",
    category: "DEBUGGING",
    executableNames: ["vsdbg", "debugadapter"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "Matches the spawned debug-adapter helper processes VS Code launches for an ACTIVE debug session — deliberately NOT the VS Code editor itself (Code.exe), which is an extremely common everyday editor with no exam relevance when merely open. This narrower signal still cannot see WHAT is being debugged.",
    falsePositiveRisk: "MEDIUM",
    defaultAction: "DETECT_AND_RECORD",
    configToggle: "TETHER_BLOCK_DEBUG_TOOLS",
    studentExplanation: "VS Code debug session",
    auditEvidenceBehavior: "Reviewable IntegrityEvent (DEBUGGING_TOOL_DETECTED) while an exam is active; escalates to BLOCK_DURING_EXAM only when TETHER_BLOCK_DEBUG_TOOLS is enabled.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "TERMINAL",
    displayName: "PowerShell or Command Prompt",
    category: "DEBUGGING",
    executableNames: ["powershell", "pwsh", "cmd", "windowsterminal"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "Terminals are ubiquitous, general-purpose Windows tools (the OS itself and countless unrelated background tasks use them) — deliberately never escalated to a hard block by any config toggle in this pilot; institutions that need to block terminals for a specific assessment should use exam-level policy, not a global Tether setting.",
    falsePositiveRisk: "HIGH",
    defaultAction: "DETECT_AND_RECORD",
    configToggle: null,
    studentExplanation: null,
    auditEvidenceBehavior: "Reviewable IntegrityEvent (DEBUGGING_TOOL_DETECTED), always INFO-tier — never blocks.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "PROCESS_INSPECTION_TOOLS",
    displayName: "Process inspection tools",
    category: "DEBUGGING",
    executableNames: ["procexp", "procexp64", "processhacker"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "Sysinternals Process Explorer and Process Hacker — single-purpose tools rarely open by accident.",
    falsePositiveRisk: "LOW",
    defaultAction: "BLOCK_DURING_EXAM",
    configToggle: "TETHER_BLOCK_DEBUG_TOOLS",
    studentExplanation: "Process inspection tools",
    auditEvidenceBehavior: "Reviewable IntegrityEvent (DEBUGGING_TOOL_DETECTED) while an exam is active; PlatformAuditLog only at preflight.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },

  // --- Virtualisation and remote environment indicators ---------------------
  {
    id: "HYPERV_CONSOLE",
    displayName: "Hyper-V console",
    category: "VIRTUALIZATION",
    executableNames: ["vmconnect"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "vmconnect.exe is the Hyper-V Manager's connection console — a deliberate, rarely-accidental tool.",
    falsePositiveRisk: "LOW",
    defaultAction: "BLOCK_DURING_EXAM",
    configToggle: "TETHER_BLOCK_VIRTUAL_MACHINES",
    studentExplanation: "Hyper-V console",
    auditEvidenceBehavior: "Reviewable IntegrityEvent while an exam is active; PlatformAuditLog only at preflight.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "VMWARE",
    displayName: "VMware",
    category: "VIRTUALIZATION",
    executableNames: ["vmware", "vmware-tray", "vmware-hostd"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "VMware Workstation/Player running on the HOST does not by itself prove Tether is running inside a guest — some students keep it open for unrelated development work.",
    falsePositiveRisk: "MEDIUM",
    defaultAction: "WARN_AND_REQUIRE_CLOSE",
    configToggle: "TETHER_BLOCK_VIRTUAL_MACHINES",
    studentExplanation: "VMware",
    auditEvidenceBehavior: "PlatformAuditLog only — never re-covers content if it reappears mid-exam, only recorded.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "VIRTUALBOX",
    displayName: "VirtualBox",
    category: "VIRTUALIZATION",
    executableNames: ["virtualboxvm", "vboxsvc"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "Same reasoning as VMware.",
    falsePositiveRisk: "MEDIUM",
    defaultAction: "WARN_AND_REQUIRE_CLOSE",
    configToggle: "TETHER_BLOCK_VIRTUAL_MACHINES",
    studentExplanation: "VirtualBox",
    auditEvidenceBehavior: "PlatformAuditLog only — never re-covers content if it reappears mid-exam, only recorded.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "WINDOWS_SANDBOX",
    displayName: "Windows Sandbox",
    category: "VIRTUALIZATION",
    executableNames: ["windowssandbox", "windowssandboxremotesession"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "A disposable, isolated container specifically meant for running throwaway/untrusted software — genuinely unusual to have open during an exam.",
    falsePositiveRisk: "LOW",
    defaultAction: "BLOCK_DURING_EXAM",
    configToggle: "TETHER_BLOCK_VIRTUAL_MACHINES",
    studentExplanation: "Windows Sandbox",
    auditEvidenceBehavior: "Reviewable IntegrityEvent while an exam is active; PlatformAuditLog only at preflight.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "REMOTE_DESKTOP_SESSION",
    displayName: "Remote Desktop session",
    category: "VIRTUALIZATION",
    executableNames: [],
    detectionMethod: "WINDOWS_SESSION_API",
    detectionNotes: "Whether TETHER ITSELF is currently running inside an inbound Remote Desktop / Remote Assistance / Quick Assist session (distinct from the MS_REMOTE_DESKTOP capability above, which detects the CLIENT reaching OUT). See Part 5 / windowsSessionDetection.ts.",
    falsePositiveRisk: "LOW",
    defaultAction: "BLOCK_DURING_EXAM",
    configToggle: "TETHER_BLOCK_REMOTE_CONTROL",
    studentExplanation: "This computer is connected to over Remote Desktop",
    auditEvidenceBehavior: "Reviewable IntegrityEvent (REMOTE_CONTROL_SOFTWARE_DETECTED) while an exam is active; fails closed for final examinations at preflight when this cannot be safely resolved — see Part 5.",
    supportedWindowsVersions: SESSION_API_WINDOWS_VERSIONS,
  },
  {
    id: "VIRTUAL_MACHINE_HOST",
    displayName: "Virtual machine",
    category: "VIRTUALIZATION",
    executableNames: [],
    detectionMethod: "WINDOWS_SYSTEM_INFO",
    detectionNotes: "Whether TETHER ITSELF is running inside a virtual machine (as opposed to a VM management console running on the host — see HYPERV_CONSOLE/VMWARE/VIRTUALBOX above). Matches well-known BIOS/system-identification strings (see Part 5) — a deliberately evasive VM can spoof these; this is a best-effort signal, not a guarantee.",
    falsePositiveRisk: "MEDIUM",
    defaultAction: "WARN_AND_REQUIRE_CLOSE",
    configToggle: "TETHER_BLOCK_VIRTUAL_MACHINES",
    studentExplanation: "This computer appears to be a virtual machine",
    auditEvidenceBehavior: "PlatformAuditLog only — never re-covers content if it reappears mid-exam, only recorded.",
    supportedWindowsVersions: SESSION_API_WINDOWS_VERSIONS,
  },

  // --- Capture and overlay ---------------------------------------------------
  {
    id: "OBS",
    displayName: "OBS Studio",
    category: "CAPTURE_OVERLAY",
    executableNames: ["obs64", "obs32"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "Single-purpose recording/streaming software — low false-positive risk.",
    falsePositiveRisk: "LOW",
    defaultAction: "BLOCK_DURING_EXAM",
    configToggle: "TETHER_BLOCK_SCREEN_CAPTURE_TOOLS",
    studentExplanation: "OBS Studio",
    auditEvidenceBehavior: "Reviewable IntegrityEvent (SCREEN_CAPTURE_SOFTWARE_DETECTED) while an exam is active; PlatformAuditLog only at preflight.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "SCREEN_RECORDERS_GENERIC",
    displayName: "Screen-recording software",
    category: "CAPTURE_OVERLAY",
    executableNames: ["camtasiastudio", "bdcam", "sharex", "fraps"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "Covers the most common dedicated screen-recording tools beyond OBS.",
    falsePositiveRisk: "LOW",
    defaultAction: "BLOCK_DURING_EXAM",
    configToggle: "TETHER_BLOCK_SCREEN_CAPTURE_TOOLS",
    studentExplanation: "Screen-recording software",
    auditEvidenceBehavior: "Reviewable IntegrityEvent (SCREEN_CAPTURE_SOFTWARE_DETECTED) while an exam is active; PlatformAuditLog only at preflight.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "NVIDIA_CAPTURE",
    displayName: "NVIDIA capture/broadcast tools",
    category: "CAPTURE_OVERLAY",
    executableNames: ["nvidia broadcast", "nvsphelper64", "nvidia share"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "NVIDIA driver/GeForce Experience background processes run on a very large share of gaming-capable Windows PCs regardless of any actual capture activity — hard-blocking would lock out many legitimate students with an NVIDIA GPU.",
    falsePositiveRisk: "HIGH",
    defaultAction: "DETECT_AND_RECORD",
    configToggle: null,
    studentExplanation: null,
    auditEvidenceBehavior: "Reviewable IntegrityEvent (SCREEN_CAPTURE_SOFTWARE_DETECTED), always INFO-tier — never blocks.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "XBOX_GAME_BAR",
    displayName: "Xbox Game Bar",
    category: "CAPTURE_OVERLAY",
    executableNames: ["gamebar", "gamebarftserver", "gameoverlayui"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "Built into Windows 10/11 and can be triggered accidentally (Win+G) — moderate false-positive risk.",
    falsePositiveRisk: "MEDIUM",
    defaultAction: "WARN_AND_REQUIRE_CLOSE",
    configToggle: "TETHER_BLOCK_SCREEN_CAPTURE_TOOLS",
    studentExplanation: "Xbox Game Bar",
    auditEvidenceBehavior: "PlatformAuditLog only — never re-covers content if it reappears mid-exam, only recorded.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "SNIPPING_TOOL",
    displayName: "Snipping Tool",
    category: "CAPTURE_OVERLAY",
    executableNames: ["snippingtool", "screenclippinghost"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "Built into Windows, used for many entirely unrelated everyday purposes, and often runs only momentarily — high false-positive risk and low detection reliability (a brief single screenshot may complete before the next poll).",
    falsePositiveRisk: "HIGH",
    defaultAction: "DETECT_AND_RECORD",
    configToggle: null,
    studentExplanation: null,
    auditEvidenceBehavior: "Reviewable IntegrityEvent (SCREEN_CAPTURE_SOFTWARE_DETECTED), always INFO-tier — never blocks.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },
  {
    id: "CLIPBOARD_MANAGERS",
    displayName: "Clipboard manager",
    category: "CAPTURE_OVERLAY",
    executableNames: ["ditto", "clipboardfusion", "clipclip"],
    detectionMethod: "PROCESS_NAME_MATCH",
    detectionNotes: "A clipboard manager does not itself threaten exam integrity the way screen-sharing/recording does; recorded for awareness only. Many people run one as a permanent background utility unrelated to any exam.",
    falsePositiveRisk: "MEDIUM",
    defaultAction: "DETECT_AND_RECORD",
    configToggle: null,
    studentExplanation: null,
    auditEvidenceBehavior: "Reviewable IntegrityEvent (SCREEN_CAPTURE_SOFTWARE_DETECTED), always INFO-tier — never blocks.",
    supportedWindowsVersions: PROCESS_NAME_MATCH_WINDOWS_VERSIONS,
  },

  // --- Navigation and launch escape (Electron-level, not process-based) -----
  {
    id: "EXTERNAL_PROTOCOL_LAUNCH",
    displayName: "External application launch",
    category: "NAVIGATION_ESCAPE",
    executableNames: [],
    detectionMethod: "ELECTRON_WEBCONTENTS_API",
    detectionNotes: "A page-initiated request to launch an external protocol handler (mailto:, another app's own custom protocol, etc.) — denied via Electron's setWindowOpenHandler/will-navigate, see Part 7/8.",
    falsePositiveRisk: "LOW",
    defaultAction: "BLOCK_DURING_EXAM",
    configToggle: null,
    studentExplanation: null,
    auditEvidenceBehavior: "PlatformAuditLog only (denied navigation is a technical fact, not an integrity signal on its own unless it recurs — see Part 11).",
    supportedWindowsVersions: ELECTRON_LEVEL_WINDOWS_VERSIONS,
  },
  {
    id: "SHELL_OPEN_REQUEST",
    displayName: "System shell open request",
    category: "NAVIGATION_ESCAPE",
    executableNames: [],
    detectionMethod: "ELECTRON_WEBCONTENTS_API",
    detectionNotes: "Denied identically to EXTERNAL_PROTOCOL_LAUNCH — Tether never calls shell.openExternal on renderer-supplied input.",
    falsePositiveRisk: "LOW",
    defaultAction: "BLOCK_DURING_EXAM",
    configToggle: null,
    studentExplanation: null,
    auditEvidenceBehavior: "PlatformAuditLog only.",
    supportedWindowsVersions: ELECTRON_LEVEL_WINDOWS_VERSIONS,
  },
  {
    id: "NEW_BROWSER_WINDOW",
    displayName: "New browser window",
    category: "NAVIGATION_ESCAPE",
    executableNames: [],
    detectionMethod: "ELECTRON_WEBCONTENTS_API",
    detectionNotes: "window.open() and target=_blank links are denied via setWindowOpenHandler returning {action: 'deny'} — see Part 7.",
    falsePositiveRisk: "LOW",
    defaultAction: "BLOCK_DURING_EXAM",
    configToggle: null,
    studentExplanation: null,
    auditEvidenceBehavior: "PlatformAuditLog only.",
    supportedWindowsVersions: ELECTRON_LEVEL_WINDOWS_VERSIONS,
  },
  {
    id: "DOWNLOADS",
    displayName: "File download",
    category: "NAVIGATION_ESCAPE",
    executableNames: [],
    detectionMethod: "ELECTRON_WEBCONTENTS_API",
    detectionNotes: "Denied by default via session.on('will-download') calling item.cancel() — overridden per-exam only when the exam's own secure policy explicitly requires a file-upload/download question type (Part 9); Tether never distinguishes this itself, it only enforces whatever the loaded page requests through the existing SES policy machinery.",
    falsePositiveRisk: "LOW",
    defaultAction: "BLOCK_DURING_EXAM",
    configToggle: null,
    studentExplanation: null,
    auditEvidenceBehavior: "PlatformAuditLog only.",
    supportedWindowsVersions: ELECTRON_LEVEL_WINDOWS_VERSIONS,
  },
  {
    id: "DEVELOPER_MENU_ACCESS",
    displayName: "Developer menu",
    category: "NAVIGATION_ESCAPE",
    executableNames: [],
    detectionMethod: "ELECTRON_WEBCONTENTS_API",
    detectionNotes: "Covered by the same DevTools-prevention mechanism as ELECTRON_DEVTOOLS above (Part 7/8) — kept as a separate registry entry only for documentation completeness (Part 1 explicitly lists it under navigation/launch escape).",
    falsePositiveRisk: "LOW",
    defaultAction: "BLOCK_DURING_EXAM",
    configToggle: null,
    studentExplanation: null,
    auditEvidenceBehavior: "Reviewable IntegrityEvent (DEBUGGING_TOOL_DETECTED) while an exam is active — shared event type with ELECTRON_DEVTOOLS.",
    supportedWindowsVersions: ELECTRON_LEVEL_WINDOWS_VERSIONS,
  },
  {
    id: "NAVIGATION_AWAY_FROM_APPROVED_ORIGIN",
    displayName: "Navigation outside the exam application",
    category: "NAVIGATION_ESCAPE",
    executableNames: [],
    detectionMethod: "ELECTRON_WEBCONTENTS_API",
    detectionNotes: "will-navigate is denied for any URL whose origin does not match the configured SES_BASE_URL — see Part 7.",
    falsePositiveRisk: "LOW",
    defaultAction: "BLOCK_DURING_EXAM",
    configToggle: null,
    studentExplanation: null,
    auditEvidenceBehavior: "PlatformAuditLog only.",
    supportedWindowsVersions: ELECTRON_LEVEL_WINDOWS_VERSIONS,
  },
];

// ---------------------------------------------------------------------------
// Pure lookup/matching helpers.
// ---------------------------------------------------------------------------

/**
 * Normalizes a raw Windows process name/path into the lowercase,
 * extension-free, path-free form every executableNames entry above is
 * written in. Deliberately defensive against malformed input (Part 17,
 * "malformed process output" fault injection; Part 16 test 6/7): never
 * throws, always returns a bounded string, strips path separators before
 * taking the basename so a value like `..\\..\\teamviewer.exe` or a
 * value containing shell metacharacters can never be mistaken for a
 * legitimate path component — this function only ever produces a plain
 * comparison string, never anything passed to a shell or file-system
 * call.
 */
export function normalizeExecutableName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // Cap length defensively — a malformed/adversarial process-listing
  // result must never be treated as an arbitrarily large string.
  const bounded = raw.slice(0, 512);
  // Basename: take whatever follows the LAST path separator (either
  // slash style — Windows paths use backslash, but be defensive about
  // forward slashes too), never attempt to actually resolve/traverse the
  // path.
  const lastSep = Math.max(bounded.lastIndexOf("\\"), bounded.lastIndexOf("/"));
  const base = lastSep >= 0 ? bounded.slice(lastSep + 1) : bounded;
  const lower = base.trim().toLowerCase();
  return lower.endsWith(".exe") ? lower.slice(0, -4) : lower;
}

/** Every capability whose executableNames includes at least one of the given (already-normalized) process names. */
export function matchCapabilitiesByExecutableNames(normalizedNames: readonly string[]): LockdownCapability[] {
  if (normalizedNames.length === 0) return [];
  const nameSet = new Set(normalizedNames);
  return LOCKDOWN_CAPABILITY_REGISTRY.filter(
    (capability) => capability.detectionMethod === "PROCESS_NAME_MATCH" && capability.executableNames.some((exe) => nameSet.has(exe)),
  );
}

export function getCapabilityById(id: string): LockdownCapability | undefined {
  return LOCKDOWN_CAPABILITY_REGISTRY.find((capability) => capability.id === id);
}

/** Every capability id known to be a process-based signal — used to size/bound the process-scan matching loop. */
export function processMatchableCapabilityIds(): string[] {
  return LOCKDOWN_CAPABILITY_REGISTRY.filter((c) => c.detectionMethod === "PROCESS_NAME_MATCH").map((c) => c.id);
}

/**
 * Server-served policy toggles (Part 12) — the ONLY input from outside
 * this registry that ever changes a capability's action. Never read from
 * Electron's own local environment for the boolean toggles themselves
 * (that would let a modified/local install silently downgrade its own
 * enforcement) — the hosted web app resolves these server-side and the
 * page relays them to Electron main via IPC, exactly like
 * setSecureClientEnforcementState already does for display enforcement.
 * See src/lib/tetherLockdownConfig.ts (web app) and lockdownConfig.ts
 * (this package)'s own doc comments.
 */
export type LockdownPolicyToggles = {
  blockRemoteControl: boolean;
  blockScreenCaptureTools: boolean;
  blockDebugTools: boolean;
  blockVirtualMachines: boolean;
};

export const DEFAULT_LOCKDOWN_POLICY_TOGGLES: LockdownPolicyToggles = {
  blockRemoteControl: true,
  blockScreenCaptureTools: true,
  blockDebugTools: false,
  blockVirtualMachines: false,
};

/**
 * Resolves a capability's EFFECTIVE action for this session: its own
 * defaultAction, downgraded to DETECT_AND_RECORD when its configToggle
 * is present but OFF. A toggle being off never fully silences a
 * capability (Part 12: "prefer detection plus controlled remediation
 * over aggressive system modification") — it only ever narrows
 * BLOCK_BEFORE_EXAM/BLOCK_DURING_EXAM/WARN_AND_REQUIRE_CLOSE down to
 * DETECT_AND_RECORD, never the reverse, and NOT_SUPPORTED is never
 * affected (there is nothing to toggle for a capability with no
 * detection at all).
 */
export function resolveEffectiveAction(capability: LockdownCapability, toggles: LockdownPolicyToggles): LockdownCapabilityAction {
  if (capability.configToggle == null) return capability.defaultAction;
  if (capability.defaultAction === "NOT_SUPPORTED" || capability.defaultAction === "DETECT_AND_RECORD") return capability.defaultAction;
  const toggleValue =
    capability.configToggle === "TETHER_BLOCK_REMOTE_CONTROL"
      ? toggles.blockRemoteControl
      : capability.configToggle === "TETHER_BLOCK_SCREEN_CAPTURE_TOOLS"
        ? toggles.blockScreenCaptureTools
        : capability.configToggle === "TETHER_BLOCK_DEBUG_TOOLS"
          ? toggles.blockDebugTools
          : toggles.blockVirtualMachines;
  return toggleValue ? capability.defaultAction : "DETECT_AND_RECORD";
}

/** True for any action that must block/cover exam content at preflight (Part 3) — the union of BLOCK_BEFORE_EXAM and BLOCK_DURING_EXAM (every during-exam block also implies a preflight block). */
export function isPreflightBlockingAction(action: LockdownCapabilityAction): boolean {
  return action === "BLOCK_BEFORE_EXAM" || action === "BLOCK_DURING_EXAM";
}

/** True only for the live, mid-exam blocking overlay (Part 4) — a strict subset of isPreflightBlockingAction. */
export function isDuringExamBlockingAction(action: LockdownCapabilityAction): boolean {
  return action === "BLOCK_DURING_EXAM";
}
