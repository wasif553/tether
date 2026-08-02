/**
 * Tether Windows Lockdown Hardening v1 — Windows remote-session/VM
 * adapter (Part 5). Same established pattern as
 * windowsDisplayTopology.ts / windowsProcessList.ts: a small, fully
 * static, auditable PowerShell(+C#) script, written once to a per-user
 * temp path, invoked via `spawn()` with an argv array (no shell string,
 * no injection surface).
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseWindowsSessionOutput, classifyWindowsSessionSignals, type WindowsSessionClassification } from "./windowsSessionDetectionLogic";

const SCRIPT_PATH = path.join(os.tmpdir(), "tether-secure-browser-session-info.ps1");

const POWERSHELL_SCRIPT = String.raw`
$csharp = @"
using System;
using System.Runtime.InteropServices;
public static class TetherSessionInfo {
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
    public const int SM_REMOTESESSION = 0x1000;
}
"@
Add-Type -TypeDefinition $csharp -Language CSharp
$remoteSession = ([TetherSessionInfo]::GetSystemMetrics([TetherSessionInfo]::SM_REMOTESESSION)) -ne 0
$sessionName = $env:SESSIONNAME
$bios = Get-ItemProperty -Path 'HKLM:\HARDWARE\DESCRIPTION\System\BIOS' -ErrorAction SilentlyContinue
$manufacturer = $bios.SystemManufacturer
$productName = $bios.SystemProductName
$result = [ordered]@{ ok = $true; remoteSession = $remoteSession; sessionName = $sessionName; manufacturer = $manufacturer; productName = $productName }
$result | ConvertTo-Json -Compress
`;

let scriptWritten = false;
function ensureScriptWritten(): void {
  if (scriptWritten) return;
  writeFileSync(SCRIPT_PATH, POWERSHELL_SCRIPT, "utf8");
  scriptWritten = true;
}

function isWindows(): boolean {
  return process.platform === "win32";
}

const QUERY_TIMEOUT_MS = 5_000;

export async function getWindowsSessionClassification(): Promise<WindowsSessionClassification> {
  if (!isWindows()) return classifyWindowsSessionSignals(null);

  try {
    ensureScriptWritten();
  } catch {
    return classifyWindowsSessionSignals(null);
  }

  const stdout = await new Promise<string | null>((resolve) => {
    let settled = false;
    let buffer = "";
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT_PATH], {
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve(null);
    }, QUERY_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      buffer += chunk.toString();
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0 ? buffer : null);
    });
  });

  if (stdout == null) return classifyWindowsSessionSignals(null);
  return classifyWindowsSessionSignals(parseWindowsSessionOutput(stdout));
}
