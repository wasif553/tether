using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace TetherKeyboardHelper;

/// <summary>
/// Tether Windows Hardening v1.8.0, Phase A+B — the named-pipe SERVER
/// side of the helper. This helper is deliberately the pipe SERVER (with
/// an explicit PipeSecurity restricting access to the CURRENT WINDOWS
/// USER only) and Electron main is the CLIENT that connects out — see
/// keyboardHookHelperManager.ts's own doc comment for why the roles are
/// this way round (Node's plain net.createServer has no equivalent
/// per-user ACL option).
///
/// Speaks exactly the same newline-delimited JSON line protocol as
/// keyboardHardeningHelperProtocol.ts on the Electron side — nine
/// message types, nothing else. This class only ever reads/writes those
/// exact shapes; it never executes an arbitrary command or touches the
/// filesystem on the caller's behalf.
/// </summary>
internal sealed class PipeServer : IDisposable
{
    private readonly string _pipeName;
    private readonly string _expectedToken;
    private NamedPipeServerStream? _stream;
    private StreamReader? _reader;
    private StreamWriter? _writer;

    public event Action? OnArmRequested;
    public event Action? OnDisarmRequested;
    public event Action? OnShutdownRequested;
    public event Action? OnPingReceived;
    public event Action? OnClientDisconnected;

    public PipeServer(string pipeName, string expectedToken)
    {
        _pipeName = pipeName;
        _expectedToken = expectedToken;
    }

    /// <summary>
    /// Builds a PipeSecurity granting full control to ONLY the current
    /// Windows identity — "accessible only to the current user/session
    /// where practical" (see the task's own IPC-security requirement).
    ///
    /// Physical-test IPC/handshake investigation — root cause of the
    /// confirmed connect failure: this method previously ALSO added an
    /// explicit Deny ACE for the well-known "Everyone" SID, intending to
    /// belt-and-suspenders close off any other access. That is actively
    /// wrong: .NET's PipeSecurity/CommonObjectSecurity canonicalizes a
    /// DACL's ACE order on write, sorting ALL explicit Deny ACEs before
    /// ALL explicit Allow ACEs regardless of the order AddAccessRule was
    /// called in — confirmed by dumping the actual constructed SDDL,
    /// which came out as
    /// "D:(D;;0x1f019f;;;WD)(A;;0x1f019f;;;&lt;user-SID&gt;)" (Deny-Everyone
    /// first, Allow-user second). Windows evaluates a DACL in order and
    /// stops at the FIRST ACE that matches any SID in the connecting
    /// token — and "Everyone" (WD / S-1-1-0) is present in every access
    /// token, including the pipe-owning user's own. So the Deny-Everyone
    /// ACE matched first for literally every connect attempt, including
    /// the legitimate same-user Electron client, before the Allow ACE
    /// further down the list was ever reached — confirmed live via
    /// isolation-harness.mjs against the real published .exe: every
    /// connect attempt failed with EPERM while the helper's own logs
    /// showed the pipe created and waiting.
    ///
    /// The fix is to not add the Deny-Everyone ACE at all: an
    /// Allow-only DACL naming just the current user's SID already means
    /// every other principal is implicitly denied (standard NT DACL
    /// semantics — nothing not explicitly granted may access the
    /// object), which is exactly the "current user only" security goal
    /// this method exists for. No inherited ACE can widen this back out
    /// either: NamedPipeServerStreamAcl.Create is given this PipeSecurity
    /// directly and pipes are not created under a parent container that
    /// could contribute inherited ACEs.
    /// </summary>
    private static PipeSecurity BuildCurrentUserOnlyPipeSecurity()
    {
        var security = new PipeSecurity();
        using var identity = WindowsIdentity.GetCurrent();
        SecurityIdentifier? owner = identity.User;
        if (owner is not null)
        {
            security.AddAccessRule(new PipeAccessRule(owner, PipeAccessRights.FullControl, AccessControlType.Allow));
        }
        return security;
    }

    /// <summary>Runs forever (until disposed) on a background thread: accept exactly one connection, handshake it, then service ARM/DISARM/PING/SHUTDOWN lines until the peer disconnects.</summary>
    public void RunBlocking()
    {
        string bareName = _pipeName.Replace("\\\\.\\pipe\\", string.Empty);
        while (true)
        {
            try
            {
                var security = BuildCurrentUserOnlyPipeSecurity();
                HelperDiagnosticLog.Log("pipe security created", $"pipeName={bareName}");
                _stream = NamedPipeServerStreamAcl.Create(
                    bareName,
                    PipeDirection.InOut,
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous,
                    0,
                    0,
                    security);
                HelperDiagnosticLog.Log("named-pipe server object created", $"pipeName={bareName}");
                HelperDiagnosticLog.Log("waiting for client connection", $"pipeName={bareName}");
                _stream.WaitForConnection();
                HelperDiagnosticLog.Log("client connected", $"pipeName={bareName}");
                _reader = new StreamReader(_stream);
                _writer = new StreamWriter(_stream) { AutoFlush = true };

                if (!CompleteHandshake())
                {
                    Cleanup();
                    continue;
                }

                ServiceConnection();
            }
            catch (IOException ex)
            {
                // Client disconnected mid-read/write — expected on a
                // helper-crash-simulated disconnect; loop back and accept
                // a fresh connection (Electron only ever connects once per
                // launched helper process in practice, but this keeps the
                // server side robust regardless).
                HelperDiagnosticLog.Log("pipe IOException (peer disconnect, continuing)", $"message={ex.Message}");
            }
            catch (Exception ex)
            {
                // Physical-test diagnosis follow-up — previously only
                // IOException was caught here, so any OTHER exception
                // (e.g. UnauthorizedAccessException/PlatformNotSupportedException
                // from PipeSecurity/NamedPipeServerStreamAcl.Create, or an
                // ArgumentException from a malformed pipe name) propagated
                // out of this background thread uncaught — which crashes
                // the ENTIRE process by .NET's default unhandled-exception
                // behaviour, with no log line ever written to explain why.
                // Logging and looping back (rather than rethrowing) makes
                // that failure mode observable instead of a silent,
                // unexplained process exit; Electron's own bounded ARM
                // timeout is what actually bounds how long this can retry
                // for in practice.
                HelperDiagnosticLog.Log("UNHANDLED EXCEPTION in pipe server loop", $"type={ex.GetType().FullName} hresult=0x{ex.HResult:X8} message={ex.Message}");
            }
            finally
            {
                Cleanup();
            }
            OnClientDisconnected?.Invoke();
        }
    }

    private bool CompleteHandshake()
    {
        string? line = _reader!.ReadLine();
        if (line is null)
        {
            HelperDiagnosticLog.Log("HELLO not received (stream closed before any line)");
            return false;
        }
        HelperDiagnosticLog.Log("HELLO received", $"length={line.Length}");
        var message = ProtocolMessage.Parse(line);
        if (message is null || message.Type != "HELLO" || message.Token != _expectedToken)
        {
            HelperDiagnosticLog.Log("HELLO token REJECTED", $"parsed={message is not null} type={message?.Type ?? "(none)"}");
            return false;
        }
        HelperDiagnosticLog.Log("HELLO token accepted");
        WriteLine(new ProtocolMessage("HELLO", token: _expectedToken));
        return true;
    }

    private void ServiceConnection()
    {
        string? line;
        while ((line = _reader!.ReadLine()) is not null)
        {
            var message = ProtocolMessage.Parse(line);
            if (message is null) continue; // malformed/unrecognized line — ignored, never treated as fatal
            switch (message.Type)
            {
                case "ARM":
                    OnArmRequested?.Invoke();
                    break;
                case "DISARM":
                    OnDisarmRequested?.Invoke();
                    break;
                case "PING":
                    OnPingReceived?.Invoke();
                    break;
                case "SHUTDOWN":
                    OnShutdownRequested?.Invoke();
                    return;
                default:
                    // HELLO/ARMED/ARM_FAILED/DISARMED/PONG arriving here
                    // are not valid post-handshake CLIENT-to-server
                    // messages (those are things WE send) — ignored as
                    // stale/unexpected, never acted on.
                    break;
            }
        }
    }

    public void SendArmed() => WriteLine(new ProtocolMessage("ARMED"));
    public void SendArmFailed(string reason) => WriteLine(new ProtocolMessage("ARM_FAILED", reason: reason));
    public void SendDisarmed() => WriteLine(new ProtocolMessage("DISARMED"));
    public void SendPong() => WriteLine(new ProtocolMessage("PONG"));

    private void WriteLine(ProtocolMessage message)
    {
        try
        {
            _writer?.WriteLine(message.Serialize());
        }
        catch
        {
            // Best-effort — a write failure means the peer is already
            // gone; the surrounding RunBlocking loop's catch handles
            // reconnection/exit.
        }
    }

    private void Cleanup()
    {
        try { _reader?.Dispose(); } catch { /* best-effort */ }
        try { _writer?.Dispose(); } catch { /* best-effort */ }
        try { _stream?.Dispose(); } catch { /* best-effort */ }
        _reader = null;
        _writer = null;
        _stream = null;
    }

    public void Dispose() => Cleanup();
}

/// <summary>Mirrors keyboardHardeningHelperProtocol.ts's bounded message shape exactly — no field beyond `type`/`token`/`reason` is ever read or written.</summary>
internal sealed class ProtocolMessage
{
    public string Type { get; }
    public string? Token { get; }
    public string? Reason { get; }

    public ProtocolMessage(string type, string? token = null, string? reason = null)
    {
        Type = type;
        Token = token;
        Reason = reason;
    }

    private const int MaxLineLength = 1024;

    public static ProtocolMessage? Parse(string? line)
    {
        if (string.IsNullOrEmpty(line) || line.Length > MaxLineLength) return null;
        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("type", out var typeEl) || typeEl.ValueKind != JsonValueKind.String) return null;
            string type = typeEl.GetString() ?? string.Empty;
            string? token = root.TryGetProperty("token", out var tokenEl) && tokenEl.ValueKind == JsonValueKind.String ? tokenEl.GetString() : null;
            string? reason = root.TryGetProperty("reason", out var reasonEl) && reasonEl.ValueKind == JsonValueKind.String ? reasonEl.GetString() : null;
            return new ProtocolMessage(type, token, reason);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public string Serialize()
    {
        var obj = new Dictionary<string, string>{ ["type"] = Type };
        if (Token is not null) obj["token"] = Token;
        if (Reason is not null) obj["reason"] = Reason;
        return JsonSerializer.Serialize(obj);
    }
}
