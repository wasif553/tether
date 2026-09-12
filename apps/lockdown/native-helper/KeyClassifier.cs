namespace TetherKeyboardHelper;

/// <summary>
/// Tether Windows Hardening v1.8.0, Phase A+B — the PURE keystroke
/// classification decision, extracted out of KeyboardHook.cs so it can be
/// unit-tested directly without an actual installed WH_KEYBOARD_LL hook
/// or real OS-level key events (mirrors the TypeScript side's own
/// convention of separating pure decision logic from Win32/Electron-
/// touching glue — see keyboardHardeningRecoveryLogic.ts).
///
/// Scope for THIS phase only: Left/Right Windows key (both edges) and
/// Ctrl+Esc (Escape only, while Ctrl is held). See KeyboardHook.cs's own
/// doc comment for the full rationale, including the "no stuck modifier"
/// safety argument and why Ctrl+Alt+Delete is never referenced anywhere
/// in this class (there is nothing to classify — it never reaches this
/// process at all).
/// </summary>
internal static class KeyClassifier
{
    public const int VK_LWIN = 0x5B;
    public const int VK_RWIN = 0x5C;
    public const int VK_ESCAPE = 0x1B;

    /// <param name="vkCode">The virtual-key code from the KBDLLHOOKSTRUCT.</param>
    /// <param name="isKeyDown">True for WM_KEYDOWN/WM_SYSKEYDOWN.</param>
    /// <param name="isKeyUp">True for WM_KEYUP/WM_SYSKEYUP.</param>
    /// <param name="ctrlHeld">Whether Ctrl is currently held (from GetAsyncKeyState at the moment this key event arrived) — irrelevant for any key other than Escape.</param>
    /// <returns>True if this exact key event must be swallowed (never passed to CallNextHookEx).</returns>
    public static bool ShouldSwallow(uint vkCode, bool isKeyDown, bool isKeyUp, bool ctrlHeld)
    {
        if (!isKeyDown && !isKeyUp) return false;

        if (vkCode == VK_LWIN || vkCode == VK_RWIN)
        {
            // Both edges swallowed together — see the "no stuck modifier" note in KeyboardHook.cs.
            return true;
        }

        if (isKeyDown && vkCode == VK_ESCAPE && ctrlHeld)
        {
            return true;
        }

        return false;
    }
}
