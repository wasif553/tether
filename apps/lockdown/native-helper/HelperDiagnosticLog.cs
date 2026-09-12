using System;
using System.IO;

namespace TetherKeyboardHelper;

/// <summary>
/// Windows Hardening v1.8.0 physical-test diagnosis follow-up — narrowly
/// scoped, TEMPORARY diagnostic logging for the helper side of the
/// handshake, mirroring the Electron-side diagnosticLog.ts (same env-var
/// gate, same "best-effort, never throws" contract, same intent: prove
/// or disprove exactly where a physical test's activation actually got
/// to, without guessing).
///
/// Gated on the SAME TETHER_DIAGNOSTIC_LOGGING environment variable the
/// Electron side uses — child_process.spawn passes the parent's
/// environment through to this helper by default (no explicit `env`
/// override in keyboardHookHelperManager.ts), so enabling it for
/// Electron enables it here too, with no separate configuration needed.
/// Off by default — never writes anything for an ordinary install/exam.
///
/// Writes to a fixed, per-user-writable temp-directory file (no admin
/// needed, nothing persisted once the file is deleted) — deliberately
/// NOT the Electron app's own userData directory, which this native,
/// separately-packaged process has no built-in way to know.
/// </summary>
internal static class HelperDiagnosticLog
{
    public static readonly string LogPath = Path.Combine(Path.GetTempPath(), "tether-keyboard-helper-diagnostics.log");
    private static readonly bool Enabled = Environment.GetEnvironmentVariable("TETHER_DIAGNOSTIC_LOGGING") == "true";

    public static void Log(string checkpoint, string detail = "")
    {
        if (!Enabled) return;
        try
        {
            File.AppendAllText(LogPath, $"{DateTime.UtcNow:o} [tether-keyboard-helper] {checkpoint} {detail}{Environment.NewLine}");
        }
        catch
        {
            // Best-effort only — a disk/path failure must never crash the
            // helper or otherwise change its behaviour.
        }
    }
}
