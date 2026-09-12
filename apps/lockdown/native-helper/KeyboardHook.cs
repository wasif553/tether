using static TetherKeyboardHelper.NativeMethods;

namespace TetherKeyboardHelper;

/// <summary>
/// Tether Windows Hardening v1.8.0, Phase A+B — installs/removes exactly
/// one WH_KEYBOARD_LL hook and decides, per keystroke, whether to swallow
/// it (never call CallNextHookEx) or pass it through.
///
/// Scope for THIS phase only, per the task's explicit instructions:
///   - Left Windows key (VK_LWIN) and Right Windows key (VK_RWIN) — both
///     keydown AND keyup are swallowed together (see "no stuck modifier"
///     note below). This alone also prevents Win+Tab, Win+D, Win+M,
///     Win+R, Win+E, etc., since none of those combos can begin without
///     the Windows-key-down that starts them ever reaching the OS shell.
///   - Ctrl+Esc — only the Esc key is swallowed, and only while Ctrl is
///     currently down (GetAsyncKeyState); Ctrl's own key events are never
///     touched, so Ctrl+C/Ctrl+V and every other ordinary Ctrl shortcut
///     the exam page needs keeps working normally.
/// Explicitly NOT handled here (deferred to a later phase, per the task):
/// Alt+Tab, Alt+Esc, Win+Tab as a *distinct* rule (it is only ever
/// suppressed as a side effect of swallowing the Windows key itself),
/// virtual-desktop shortcuts beyond that same side effect.
///
/// Ctrl+Alt+Delete is never inspected or referenced anywhere in this
/// file — the Secure Attention Sequence is intercepted by Windows session
/// manager code before ANY user-mode hook (this one included) ever
/// receives it; there is nothing for this class to do or avoid doing.
///
/// "Stuck modifier" safety: this hook only ever suppresses a key in
/// BOTH-edges-together fashion (WM_(SYS)KEYDOWN and WM_(SYS)KEYUP for the
/// exact same key), or (for Ctrl+Esc) suppresses a key that carries no
/// down/up "is this modifier currently held" state of its own (Escape is
/// not a modifier key). Removing the hook (Unarm/process exit) at any
/// point — including mid-press — can therefore never leave Windows
/// believing Ctrl, Alt, Shift, or the Windows key itself is stuck down:
/// the one key this hook ever partially observes asymmetrically (Escape)
/// has no "held" state for a stray unpaired keyup to corrupt.
/// </summary>
internal sealed class KeyboardHook
{
    private nint _hookHandle;
    private readonly LowLevelKeyboardProc _proc;

    /// <summary>Windows Hardening v1.8.0 physical-test diagnosis follow-up — the Win32 error code from the most recent failed Install() attempt (item 7's explicit "checks GetLastWin32Error after failure" requirement). Null after a successful install, or before any attempt.</summary>
    public int? LastInstallError { get; private set; }

    public KeyboardHook()
    {
        // Keeping a single, permanently-rooted delegate instance for the
        // hook's lifetime is required — the CLR must never garbage-collect
        // the delegate while native code (user32.dll) still holds a
        // function pointer to it.
        _proc = HookCallback;
    }

    public bool IsInstalled => _hookHandle != nint.Zero;

    /// <summary>Must be called from the thread that will run the Win32 message loop (Program.cs's main thread) — a low-level hook's callback is only ever invoked via that thread's own message pump.</summary>
    public bool Install()
    {
        if (IsInstalled) return true;
        nint moduleHandle = GetModuleHandle(null);
        _hookHandle = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, moduleHandle, 0);
        if (!IsInstalled)
        {
            // Must be read IMMEDIATELY after the P/Invoke call that set it
            // (SetWindowsHookEx has SetLastError = true) — any other
            // managed/interop call in between could overwrite it.
            LastInstallError = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
            HelperDiagnosticLog.Log("hook install FAILED", $"win32Error={LastInstallError}");
            return false;
        }
        LastInstallError = null;
        HelperDiagnosticLog.Log("hook installed", $"handle={_hookHandle}");
        return true;
    }

    public void Uninstall()
    {
        if (!IsInstalled) return;
        UnhookWindowsHookEx(_hookHandle);
        _hookHandle = nint.Zero;
    }

    private nint HookCallback(int nCode, nint wParam, nint lParam)
    {
        if (nCode >= 0)
        {
            var data = System.Runtime.InteropServices.Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            uint message = (uint)wParam;
            bool isKeyDown = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
            bool isKeyUp = message == WM_KEYUP || message == WM_SYSKEYUP;
            bool ctrlHeld = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;

            // Windows Hardening v1.8.0 physical-test diagnosis follow-up —
            // item "record whether VK_LWIN / VK_RWIN events are actually
            // observed by the hook". Logged BEFORE the swallow decision so
            // this line proves the callback itself fired for this key,
            // regardless of what happens next — the single most direct
            // way to distinguish "hook never sees the key at all" (Case B)
            // from "hook sees it but a classification/return-value bug
            // lets it through anyway".
            if (data.vkCode == VK_LWIN || data.vkCode == VK_RWIN || data.vkCode == VK_ESCAPE)
            {
                HelperDiagnosticLog.Log(
                    "key event observed",
                    $"vkCode=0x{data.vkCode:X2} isKeyDown={isKeyDown} isKeyUp={isKeyUp} ctrlHeld={ctrlHeld}");
            }

            // All classification logic lives in the pure, directly unit-
            // tested KeyClassifier — this callback only supplies the live
            // Win32 facts (vkCode/edge/ctrlHeld) and acts on the verdict.
            if (KeyClassifier.ShouldSwallow(data.vkCode, isKeyDown, isKeyUp, ctrlHeld))
            {
                HelperDiagnosticLog.Log("key event SWALLOWED", $"vkCode=0x{data.vkCode:X2}");
                return 1;
            }
        }
        return CallNextHookEx(_hookHandle, nCode, wParam, lParam);
    }
}
