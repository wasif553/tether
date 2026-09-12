using System.Runtime.InteropServices;

namespace TetherKeyboardHelper;

/// <summary>
/// Tether Windows Hardening v1.8.0, Phase A+B — the exact Win32 P/Invoke
/// surface this helper uses. Nothing beyond what is needed for: (1) a
/// low-level global keyboard hook, (2) the message loop a low-level hook
/// requires, and (3) a synchronous wait on the parent process's handle
/// (self-exit when Electron disappears — see Program.cs's own doc
/// comment for why this, rather than a Job Object, was chosen).
/// </summary>
internal static class NativeMethods
{
    public const int WH_KEYBOARD_LL = 13;
    public const int WM_KEYDOWN = 0x0100;
    public const int WM_KEYUP = 0x0101;
    public const int WM_SYSKEYDOWN = 0x0104;
    public const int WM_SYSKEYUP = 0x0105;

    public const int VK_LWIN = 0x5B;
    public const int VK_RWIN = 0x5C;
    public const int VK_CONTROL = 0x11;
    public const int VK_ESCAPE = 0x1B;

    /// <summary>Custom thread messages posted from the pipe-handling thread to the message-loop thread — ARM/DISARM must only ever touch SetWindowsHookEx/UnhookWindowsHookEx from the thread that owns the hook and its message queue.</summary>
    public const uint WM_APP = 0x8000;
    public const uint TETHER_WM_ARM = WM_APP + 1;
    public const uint TETHER_WM_DISARM = WM_APP + 2;
    public const uint TETHER_WM_QUIT_REQUEST = WM_APP + 3;

    [StructLayout(LayoutKind.Sequential)]
    public struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public nint dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG
    {
        public nint hwnd;
        public uint message;
        public nint wParam;
        public nint lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    public delegate nint LowLevelKeyboardProc(int nCode, nint wParam, nint lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern nint SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, nint hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool UnhookWindowsHookEx(nint hhk);

    [DllImport("user32.dll")]
    public static extern nint CallNextHookEx(nint hhk, int nCode, nint wParam, nint lParam);

    [DllImport("kernel32.dll")]
    public static extern nint GetModuleHandle(string? lpModuleName);

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    public static extern int GetMessage(out MSG lpMsg, nint hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    public static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    public static extern nint DispatchMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    public static extern bool PostThreadMessage(uint idThread, uint msg, nint wParam, nint lParam);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern void PostQuitMessage(int nExitCode);
}
