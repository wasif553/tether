namespace TetherKeyboardHelper;

/// <summary>
/// Tether Windows Hardening v1.8.0/v1.8.1, Phase A+B+C — the PURE
/// keystroke classification decision, extracted out of KeyboardHook.cs so
/// it can be unit-tested directly without an actual installed
/// WH_KEYBOARD_LL hook or real OS-level key events (mirrors the
/// TypeScript side's own convention of separating pure decision logic
/// from Win32/Electron-touching glue — see keyboardHardeningRecoveryLogic.ts).
///
/// Scope: Left/Right Windows key (both edges); Ctrl+Esc and Alt+Esc
/// (Escape only, on keydown, while Ctrl or Alt is held); and Tab while
/// Alt is held (both edges), which naturally also covers Shift+Alt+Tab
/// and Ctrl+Alt+Tab — altHeld alone gates the rule, so any other
/// simultaneously-held modifier is irrelevant to it. See KeyboardHook.cs's
/// own doc comment for the full "no stuck modifier" safety argument and
/// why Ctrl+Alt+Delete is never referenced anywhere in this class (there
/// is nothing to classify — it never reaches this process at all).
///
/// Phase C explicitly does NOT swallow Alt itself (VK_MENU/VK_LMENU/
/// VK_RMENU) — only Tab and Escape, exactly the same "non-modifier key"
/// shape the existing Ctrl+Esc rule already relies on for its
/// no-stuck-modifier safety, so Alt's own down/up state is never
/// interfered with and can never desync if the hook is removed mid-press.
/// </summary>
internal static class KeyClassifier
{
    public const int VK_LWIN = 0x5B;
    public const int VK_RWIN = 0x5C;
    public const int VK_ESCAPE = 0x1B;
    public const int VK_TAB = 0x09;

    /// <param name="vkCode">The virtual-key code from the KBDLLHOOKSTRUCT.</param>
    /// <param name="isKeyDown">True for WM_KEYDOWN/WM_SYSKEYDOWN.</param>
    /// <param name="isKeyUp">True for WM_KEYUP/WM_SYSKEYUP.</param>
    /// <param name="ctrlHeld">Whether Ctrl is currently held (from GetAsyncKeyState at the moment this key event arrived) — irrelevant for any key other than Escape.</param>
    /// <param name="altHeld">Whether Alt is held for THIS event (KBDLLHOOKSTRUCT.flags' LLKHF_ALTDOWN bit — see NativeMethods.cs) — irrelevant for any key other than Tab and Escape.</param>
    /// <returns>True if this exact key event must be swallowed (never passed to CallNextHookEx).</returns>
    public static bool ShouldSwallow(uint vkCode, bool isKeyDown, bool isKeyUp, bool ctrlHeld, bool altHeld)
    {
        if (!isKeyDown && !isKeyUp) return false;

        if (vkCode == VK_LWIN || vkCode == VK_RWIN)
        {
            // Both edges swallowed together — see the "no stuck modifier" note in KeyboardHook.cs.
            return true;
        }

        if (vkCode == VK_TAB && altHeld)
        {
            // Both edges swallowed together, exactly like the Windows-key
            // rule above — Tab is not a modifier key, so this can never
            // leave Alt (or Ctrl/Shift, if also held) believing itself
            // stuck down. Covers Alt+Tab, Shift+Alt+Tab, and Ctrl+Alt+Tab
            // uniformly: only altHeld is checked, so Shift/Ctrl being
            // simultaneously held is irrelevant to this rule.
            return true;
        }

        if (isKeyDown && vkCode == VK_ESCAPE && (ctrlHeld || altHeld))
        {
            // Keydown only, matching the pre-existing Ctrl+Esc pattern
            // exactly — Escape carries no "held" state of its own for a
            // lone unpaired keyup to corrupt, so this stays safe under the
            // same reasoning already established for Ctrl+Esc.
            return true;
        }

        return false;
    }
}
