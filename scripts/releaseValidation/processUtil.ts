/**
 * Small cross-platform child-process helpers for the release-validation
 * runner. See docs/release-validation.md.
 */
import { spawn } from "node:child_process";

export type CaptureResult = { code: number | null; stdout: string; stderr: string };

/** Runs a command, capturing stdout/stderr (never inherited to the terminal) — used for short, informational checks like `docker --version`. `cwd` defaults to this process's own working directory (Node's normal `spawn` behaviour) — used by the Supabase-managed backup executor to run the Supabase CLI inside its own temporary, unlinked-to-the-repo workspace directory. */
export function runCapture(command: string, args: string[], options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: process.platform === "win32",
      env: options.env ?? process.env,
      cwd: options.cwd,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill();
          resolve({ code: null, stdout, stderr: stderr + "\n[timed out]" });
        }, options.timeoutMs)
      : null;
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Runs a command with stdio inherited (live output visible to the operator) — used for the real validation stages (tests/typecheck/lint/build). */
export function runInherit(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: process.platform === "win32",
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code }));
  });
}
