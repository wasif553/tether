using System.IO;
using System.Reflection;
using Xunit;

namespace TetherKeyboardHelper.Tests;

/// <summary>
/// Final activation-failure safety audit (post-v1.8.0) — item 2: "Helper
/// parent-death monitoring uses an opened parent PROCESS HANDLE, not
/// only repeated PID existence checks, so PID reuse cannot keep the
/// helper alive."
///
/// This cannot be behaviourally unit-tested without spawning, killing,
/// and racing a real OS process ID reuse — which is exactly the kind of
/// OS-level scenario this package's own established convention (see
/// KeyClassifierTests.cs, and the TypeScript side's ipcChain.test.ts)
/// defers to a physical test pass rather than faking. What CAN be
/// checked structurally, directly against the real source file (not a
/// copy/paraphrase that could silently drift from the actual
/// implementation): that StartParentLivenessWatch calls
/// Process.GetProcessById EXACTLY ONCE and waits on THAT SAME Process
/// object's WaitForExit() — never a loop that repeatedly re-resolves the
/// PID (which WOULD be vulnerable: if the real parent exits and Windows
/// later reuses its PID for an unrelated process, a fresh
/// GetProcessById(parentPid) at that later point would return a handle
/// to the WRONG process and never detect the real parent's death).
/// </summary>
public class ParentLivenessWatchStructureTests
{
    private static string ReadProgramCsSource()
    {
        // native-helper/TetherKeyboardHelper.Tests/bin/<config>/<tfm>/ -> native-helper/Program.cs
        var dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)!;
        var path = Path.GetFullPath(Path.Combine(dir, "..", "..", "..", "..", "Program.cs"));
        Assert.True(File.Exists(path), $"Could not locate Program.cs at {path}");
        // Normalize to LF before returning — this checkout has
        // core.autocrlf=true, so the file on disk has CRLF line endings,
        // but every literal "\n    }\n"-style marker search below only
        // cares about the C# source's actual structure, never about which
        // line-ending convention the working tree happens to use.
        return File.ReadAllText(path).Replace("\r\n", "\n");
    }

    [Fact]
    public void StartParentLivenessWatch_calls_GetProcessById_exactly_once()
    {
        var source = ReadProgramCsSource();
        var methodStart = source.IndexOf("private static void StartParentLivenessWatch(int parentPid)");
        Assert.True(methodStart >= 0, "StartParentLivenessWatch method not found");
        var methodEnd = source.IndexOf("\n    }\n", methodStart);
        Assert.True(methodEnd > methodStart, "Could not find the end of StartParentLivenessWatch");
        var methodBody = source.Substring(methodStart, methodEnd - methodStart);

        int occurrences = 0;
        int searchFrom = 0;
        while (true)
        {
            int idx = methodBody.IndexOf("GetProcessById", searchFrom);
            if (idx < 0) break;
            occurrences++;
            searchFrom = idx + 1;
        }
        Assert.Equal(1, occurrences);
    }

    [Fact]
    public void StartParentLivenessWatch_waits_on_the_SAME_Process_object_it_opened_never_a_fresh_one()
    {
        var source = ReadProgramCsSource();
        var methodStart = source.IndexOf("private static void StartParentLivenessWatch(int parentPid)");
        var methodEnd = source.IndexOf("\n    }\n", methodStart);
        var methodBody = source.Substring(methodStart, methodEnd - methodStart);

        // "using var parent = ...GetProcessById(...)" followed later by
        // "parent.WaitForExit()" on that SAME local variable — proves the
        // wait targets the handle opened at that one moment, not a
        // PID re-resolved at wait time.
        var declareIdx = methodBody.IndexOf("var parent = System.Diagnostics.Process.GetProcessById(parentPid);");
        Assert.True(declareIdx >= 0, "Expected a single `var parent = ...GetProcessById(parentPid);` declaration");
        Assert.Contains("using var parent", methodBody);
        var waitIdx = methodBody.IndexOf("parent.WaitForExit();", declareIdx);
        Assert.True(waitIdx > declareIdx, "parent.WaitForExit() must appear after the GetProcessById declaration, on the same `parent` variable");
    }

    [Fact]
    public void StartParentLivenessWatch_contains_no_polling_loop_around_the_liveness_check()
    {
        var source = ReadProgramCsSource();
        var methodStart = source.IndexOf("private static void StartParentLivenessWatch(int parentPid)");
        var methodEnd = source.IndexOf("\n    }\n", methodStart);
        var methodBody = source.Substring(methodStart, methodEnd - methodStart);

        // A polling re-implementation would need a loop construct and/or
        // a sleep between repeated existence checks — neither should ever
        // appear here; WaitForExit() itself is the (non-polling, kernel-
        // handle-backed) blocking wait.
        Assert.DoesNotContain("while (", methodBody);
        Assert.DoesNotContain("for (", methodBody);
        Assert.DoesNotContain("Thread.Sleep", methodBody);
        Assert.DoesNotContain("Task.Delay", methodBody);
    }
}
