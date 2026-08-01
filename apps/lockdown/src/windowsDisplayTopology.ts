/**
 * Tether Secure Browser — corrective pass v1.2.0, Part 2. Windows-native
 * display-topology adapter.
 *
 * `Electron.screen.getAllDisplays()` is confirmed insufficient for
 * Duplicate/Clone mode on Windows (physical testing: it continuously
 * reports displayCount=1 while a genuine external Duplicate/mirrored
 * display was connected). This module queries the real Windows display
 * topology via the Win32 `QueryDisplayConfig` API, using a small,
 * auditable embedded PowerShell + inline C# (`Add-Type`) script rather
 * than a compiled native Node addon or a bundled compiled helper binary
 * — this repo's own `electron-builder.yml` already documents packaging
 * constraints around native/signing tooling in this environment
 * (`asar: false`, `signAndEditExecutable: false`), and a plain-text
 * script needs no compiler dependency at package time, no prebuilt
 * binary to trust, and no `electron-builder.yml` `files:` entry — it is
 * written to a temp file once per app session and then simply invoked
 * repeatedly.
 *
 * Confirmed by direct manual testing in this environment (single real
 * display): the script compiles cleanly via `Add-Type -Language CSharp`
 * and returns the correct `{activePathCount:1, distinctSourceCount:1}`
 * result in ~750-800ms per fresh-process round trip — comfortably inside
 * the ~2s polling interval this is invoked on (see displayEnforcement.ts).
 * Multi-monitor Extend/Clone classification could not be physically
 * re-verified in this environment (no live second-display hardware) —
 * see the corrective-pass report for the recommended physical smoke test.
 *
 * Only ever returns bounded counts — never a monitor serial number,
 * EDID, manufacturer, model, or device path; there is nothing else in
 * the PowerShell script's output for a caller to even mistakenly log.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { RawWindowsTopologyQueryResult } from "./windowsDisplayTopologyClassifier";

const QUERY_TIMEOUT_MS = 5_000;

// Written once, lazily, to a per-user temp path — never re-embedded as a
// giant inline -Command argument on every poll (avoids Windows
// command-line length/escaping fragility under repeated invocation).
const SCRIPT_PATH = path.join(os.tmpdir(), "tether-secure-browser-display-topology.ps1");

const POWERSHELL_SCRIPT = String.raw`
$csharp = @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class TetherDisplayTopology {
    [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint LowPart; public int HighPart; }
    [StructLayout(LayoutKind.Sequential)] public struct DISPLAYCONFIG_PATH_SOURCE_INFO { public LUID adapterId; public uint id; public uint modeInfoIdx; public uint statusFlags; }
    [StructLayout(LayoutKind.Sequential)] public struct DISPLAYCONFIG_RATIONAL { public uint Numerator; public uint Denominator; }
    [StructLayout(LayoutKind.Sequential)] public struct DISPLAYCONFIG_PATH_TARGET_INFO { public LUID adapterId; public uint id; public uint modeInfoIdx; public int outputTechnology; public int rotation; public int scaling; public DISPLAYCONFIG_RATIONAL refreshRate; public int scanLineOrdering; public int targetAvailable; public uint statusFlags; }
    [StructLayout(LayoutKind.Sequential)] public struct DISPLAYCONFIG_PATH_INFO { public DISPLAYCONFIG_PATH_SOURCE_INFO sourceInfo; public DISPLAYCONFIG_PATH_TARGET_INFO targetInfo; public uint flags; }
    [StructLayout(LayoutKind.Sequential, Pack = 1)] public struct DISPLAYCONFIG_MODE_INFO_OPAQUE { [MarshalAs(UnmanagedType.ByValArray, SizeConst = 64)] public byte[] raw; }
    [DllImport("user32.dll")] public static extern int GetDisplayConfigBufferSizes(uint flags, out uint numPathArrayElements, out uint numModeInfoArrayElements);
    [DllImport("user32.dll")] public static extern int QueryDisplayConfig(uint flags, ref uint numPathArrayElements, [Out] DISPLAYCONFIG_PATH_INFO[] pathArray, ref uint numModeInfoArrayElements, [Out] DISPLAYCONFIG_MODE_INFO_OPAQUE[] modeInfoArray, IntPtr currentTopologyId);
    public const uint QDC_ONLY_ACTIVE_PATHS = 0x00000002;
    public static string Query() {
        uint pathCount, modeCount;
        int err = GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, out pathCount, out modeCount);
        if (err != 0) return "{\"ok\":false,\"reason\":\"buffer_sizes_failed\"}";
        var paths = new DISPLAYCONFIG_PATH_INFO[pathCount];
        var modes = new DISPLAYCONFIG_MODE_INFO_OPAQUE[modeCount];
        for (int i = 0; i < modes.Length; i++) modes[i].raw = new byte[64];
        err = QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, ref pathCount, paths, ref modeCount, modes, IntPtr.Zero);
        if (err != 0) return "{\"ok\":false,\"reason\":\"query_failed\"}";
        var sourceIds = new HashSet<string>();
        int activeCount = 0;
        for (int i = 0; i < pathCount; i++) { activeCount++; sourceIds.Add(paths[i].sourceInfo.adapterId.LowPart + "_" + paths[i].sourceInfo.adapterId.HighPart + "_" + paths[i].sourceInfo.id); }
        return "{\"ok\":true,\"activePathCount\":" + activeCount + ",\"distinctSourceCount\":" + sourceIds.Count + "}";
    }
}
"@
Add-Type -TypeDefinition $csharp -Language CSharp
[TetherDisplayTopology]::Query()
`;

let scriptWritten = false;
function ensureScriptWritten(): void {
  if (scriptWritten) return;
  writeFileSync(SCRIPT_PATH, POWERSHELL_SCRIPT, "utf8");
  scriptWritten = true;
}

/** Only Windows has this concept — every other platform gets a stable ERROR result rather than attempting a Windows-only spawn. */
function isWindows(): boolean {
  return process.platform === "win32";
}

export async function getWindowsDisplayTopology(): Promise<RawWindowsTopologyQueryResult> {
  if (!isWindows()) return { ok: false, reason: "spawn_failed" };

  try {
    ensureScriptWritten();
  } catch {
    return { ok: false, reason: "spawn_failed" };
  }

  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT_PATH], {
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ ok: false, reason: "timeout" });
    }, QUERY_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: "spawn_failed" });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, reason: "non_zero_exit" });
        return;
      }
      resolve(parseTopologyOutput(stdout));
    });
  });
}

/** Exported for direct unit testing of the parsing/validation boundary without spawning a process. */
export function parseTopologyOutput(stdout: string): RawWindowsTopologyQueryResult {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    const record = parsed as Record<string, unknown> | null;
    if (
      record != null &&
      typeof record === "object" &&
      record.ok === true &&
      typeof record.activePathCount === "number" &&
      typeof record.distinctSourceCount === "number"
    ) {
      return { ok: true, activePathCount: record.activePathCount, distinctSourceCount: record.distinctSourceCount };
    }
    return { ok: false, reason: "parse_failed" };
  } catch {
    return { ok: false, reason: "parse_failed" };
  }
}
