using static TetherKeyboardHelper.NativeMethods;

namespace TetherKeyboardHelper;

/// <summary>
/// Tether Windows Hardening v1.8.0, Phase A+B — native keyboard-hardening
/// helper entry point.
///
/// Lifecycle: spawned fresh by Electron immediately before every arm
/// attempt (including each bounded recovery attempt — see
/// keyboardHookHelperManager.ts), and killed by Electron on every
/// DISARM/restore. Never installed as a service, never persists past its
/// own process, never writes anything to disk or the registry.
///
/// --- Parent-liveness self-exit (mandatory, per the task's own
/// instruction) ---
/// Windows does NOT automatically terminate a child process when its
/// parent exits (unlike POSIX process groups in some configurations).
/// If Electron is killed (crash, Task Manager, `TerminateProcess`) while
/// this helper is still running, this helper must not continue existing
/// (and therefore must not continue holding the keyboard hook) longer
/// than necessary. Rather than a Job Object (which would need the
/// PARENT to create and hold the job handle open — awkward from plain
/// Node without a native addon), this helper opens a handle to its OWN
/// parent process by the PID Electron passed it at spawn time and
/// starts an asynchronous wait on that handle; the moment it becomes
/// signaled (the parent process object has exited, for ANY reason —
/// this is a kernel-object property, not a polled check, and is
/// immune to PID reuse because the handle refers to the exact process
/// object opened at startup, never a PID number later reused by an
/// unrelated process), this helper immediately uninstalls its hook (if
/// installed) and exits. This is a strict SUPERSET of relying on
/// UnhookWindowsHookEx never running at all: Windows independently and
/// unconditionally removes a WH_KEYBOARD_LL hook the instant its owning
/// process terminates for any reason, so even a hang or crash in THIS
/// helper's own code before the explicit uninstall call still cannot
/// leave the hook installed once the process is gone.
/// </summary>
internal static class Program
{
    private static KeyboardHook? _hook;
    private static PipeServer? _pipeServer;
    private static uint _mainThreadId;

    private static int Main(string[] args)
    {
        // Physical-test diagnosis follow-up (IPC/handshake investigation)
        // — everything from here to the message loop is wrapped so an
        // exception on the MAIN thread (arg parsing, thread creation, the
        // hook/pipe-server constructors) is never silently swallowed by
        // the default .NET unhandled-exception process-crash behaviour.
        // The pipe-handling BACKGROUND thread has its own, separate
        // try/catch inside PipeServer.RunBlocking() — an exception there
        // is a distinct unhandled-exception context this outer try/catch
        // cannot observe.
        try
        {
            HelperDiagnosticLog.Log("argv accepted", $"argCount={args.Length}");
            if (!TryParseArgs(args, out string pipeName, out string token, out int parentPid))
            {
                HelperDiagnosticLog.Log("argv parse FAILED", $"argCount={args.Length}");
                return 2;
            }
            HelperDiagnosticLog.Log("parent PID parsed", $"parentPid={parentPid}");
            HelperDiagnosticLog.Log("pipe name parsed", $"pipeName={pipeName}");
            HelperDiagnosticLog.Log("token present", $"present={token.Length > 0} length={token.Length}");

            HelperDiagnosticLog.Log("helper process started", $"pid={Environment.ProcessId} parentPid={parentPid}");
            _mainThreadId = GetCurrentThreadId();
            _hook = new KeyboardHook();
            _pipeServer = new PipeServer(pipeName, token);
            _pipeServer.OnArmRequested += () => PostThreadMessage(_mainThreadId, TETHER_WM_ARM, 0, 0);
            _pipeServer.OnDisarmRequested += () => PostThreadMessage(_mainThreadId, TETHER_WM_DISARM, 0, 0);
            _pipeServer.OnShutdownRequested += () => PostThreadMessage(_mainThreadId, TETHER_WM_QUIT_REQUEST, 0, 0);
            _pipeServer.OnPingReceived += () => _pipeServer!.SendPong();
            // A client disconnect while ARMED is exactly the scenario the
            // Electron side detects via its own socket "close" handler
            // (declareHeartbeatLost) — this helper does not need to react to
            // it itself beyond the parent-liveness watch below eventually
            // catching a genuinely-dead Electron; if Electron is still alive
            // but merely dropped this one connection, Electron will spawn a
            // FRESH helper process for its next arm/recovery attempt rather
            // than reconnecting to this one, so this helper exiting here
            // (rather than waiting indefinitely for a reconnect that will
            // never come) is the correct, fail-safe behaviour.
            _pipeServer.OnClientDisconnected += () => PostThreadMessage(_mainThreadId, TETHER_WM_QUIT_REQUEST, 0, 0);

            var pipeThread = new Thread(() => _pipeServer.RunBlocking()) { IsBackground = true };
            pipeThread.Start();

            StartParentLivenessWatch(parentPid);

            RunMessageLoop();

            _hook.Uninstall();
            HelperDiagnosticLog.Log("process exiting", "reason=message-loop-ended code=0");
            return 0;
        }
        catch (Exception ex)
        {
            HelperDiagnosticLog.Log("UNHANDLED EXCEPTION on main thread", $"type={ex.GetType().FullName} hresult=0x{ex.HResult:X8} message={ex.Message}");
            HelperDiagnosticLog.Log("process exiting", "reason=unhandled-exception code=3");
            return 3;
        }
    }

    private static bool TryParseArgs(string[] args, out string pipeName, out string token, out int parentPid)
    {
        pipeName = string.Empty;
        token = string.Empty;
        parentPid = 0;
        for (int i = 0; i < args.Length - 1; i++)
        {
            switch (args[i])
            {
                case "--pipe": pipeName = args[i + 1]; break;
                case "--token": token = args[i + 1]; break;
                case "--parent-pid": _ = int.TryParse(args[i + 1], out parentPid); break;
            }
        }
        return pipeName.Length > 0 && token.Length > 0 && parentPid > 0;
    }

    /// <summary>
    /// See the class doc comment for the full rationale. Runs on its own
    /// background thread; the actual teardown (Uninstall + exit) is
    /// posted back to the message-loop thread so hook calls always
    /// happen on the thread that installed it.
    ///
    /// Final activation-failure safety audit (post-v1.8.0) — deliberately
    /// opens the parent process EXACTLY ONCE (GetProcessById) and waits
    /// on that SAME Process object's own kernel handle (WaitForExit()),
    /// never a loop that re-resolves the PID over time. This matters
    /// because Windows PIDs are reused once a process exits: a re-check
    /// implementation (e.g. periodically calling GetProcessById(parentPid)
    /// again, or scanning Process.GetProcesses() for a matching Id) could
    /// observe an UNRELATED later process that happens to reuse the same
    /// PID and incorrectly conclude the original parent is still alive.
    /// The handle obtained here is bound to the exact process object that
    /// existed at the moment this method ran — it becomes signaled only
    /// when THAT process terminates, regardless of what the OS later does
    /// with the numeric PID. See ParentLivenessWatchStructureTests.cs for
    /// the structural test guarding this shape.
    /// </summary>
    private static void StartParentLivenessWatch(int parentPid)
    {
        var watchThread = new Thread(() =>
        {
            try
            {
                using var parent = System.Diagnostics.Process.GetProcessById(parentPid);
                HelperDiagnosticLog.Log("parent handle opened", $"parentPid={parentPid}");
                parent.WaitForExit();
                HelperDiagnosticLog.Log("parent process exited", $"parentPid={parentPid}");
            }
            catch (ArgumentException)
            {
                // The parent PID was already gone by the time we tried to
                // open it — treat identically to "parent exited": there is
                // nothing left to serve.
                HelperDiagnosticLog.Log("parent handle open FAILED (already gone)", $"parentPid={parentPid}");
            }
            PostThreadMessage(_mainThreadId, TETHER_WM_QUIT_REQUEST, 0, 0);
        })
        { IsBackground = true };
        watchThread.Start();
    }

    /// <summary>
    /// The Win32 message loop this process's low-level keyboard hook
    /// requires. ARM/DISARM/quit requests arrive as posted thread
    /// messages (see the OnArmRequested/OnDisarmRequested wiring above)
    /// so SetWindowsHookEx/UnhookWindowsHookEx are only ever called from
    /// this exact thread, never from the pipe-handling background thread.
    /// </summary>
    private static void RunMessageLoop()
    {
        while (GetMessage(out MSG msg, 0, 0, 0) != 0)
        {
            if (msg.message == TETHER_WM_ARM)
            {
                HelperDiagnosticLog.Log("ARM message received");
                bool installed = _hook!.Install();
                if (installed) _pipeServer!.SendArmed();
                else _pipeServer!.SendArmFailed($"HOOK_INSTALL_FAILED:win32Error={_hook.LastInstallError}");
                continue;
            }
            if (msg.message == TETHER_WM_DISARM)
            {
                HelperDiagnosticLog.Log("DISARM message received");
                _hook!.Uninstall();
                _pipeServer!.SendDisarmed();
                continue;
            }
            if (msg.message == TETHER_WM_QUIT_REQUEST)
            {
                PostQuitMessage(0);
                continue;
            }
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
    }
}
