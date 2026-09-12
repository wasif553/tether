/**
 * Tether Windows Hardening v1.8.0, Phase A+B — the bounded IPC message
 * vocabulary spoken between Electron main (the named-pipe SERVER) and the
 * native keyboard-hardening helper process (the CLIENT that dials in —
 * see keyboardHookHelperManager.ts for why Electron, not the helper,
 * owns the pipe).
 *
 * Pure module — no Electron/Node net dependency — so message shape and
 * parsing/validation can be unit tested directly, matching this
 * package's established convention of separating pure decision logic
 * from Electron-touching glue (see remoteSessionMonitorLogic.ts).
 *
 * Deliberately NOT a generic JSON-RPC/command passthrough: exactly nine
 * message types, each with a fixed, narrow shape (per the task's own
 * "no arbitrary command execution, no arbitrary file operations, no
 * generic JSON-RPC passthrough" requirement). Every parser below is
 * defensive against malformed/adversarial input (oversized, wrong type,
 * unknown `type` field) and never throws — an invalid line is simply
 * rejected (returns null), exactly like normalizeExecutableName in
 * lockdownCapabilityRegistry.ts.
 */

export const KEYBOARD_HELPER_MESSAGE_TYPES = ["HELLO", "ARM", "ARMED", "ARM_FAILED", "DISARM", "DISARMED", "PING", "PONG", "SHUTDOWN"] as const;
export type KeyboardHelperMessageType = (typeof KEYBOARD_HELPER_MESSAGE_TYPES)[number];

/** Sent by Electron (the pipe server / process owner) to the helper. */
export type KeyboardHelperOutboundMessage =
  | { type: "HELLO"; token: string }
  | { type: "ARM" }
  | { type: "DISARM" }
  | { type: "PING" }
  | { type: "SHUTDOWN" };

/** Sent by the helper to Electron. */
export type KeyboardHelperInboundMessage =
  | { type: "HELLO"; token: string }
  | { type: "ARMED" }
  | { type: "ARM_FAILED"; reason: string }
  | { type: "DISARMED" }
  | { type: "PONG" };

/** One line (including its trailing newline) must never exceed this — guards against a malformed/adversarial peer flooding the pipe. */
export const MAX_HELPER_MESSAGE_BYTES = 1024;
const MAX_REASON_LENGTH = 200;
const MAX_TOKEN_LENGTH = 256;

/**
 * Parses ONE newline-delimited line received from the helper. Never
 * throws. Returns null for anything malformed, oversized, or not one of
 * the exact recognized inbound message shapes — the caller must treat a
 * null result as "ignore this line", never as an error to propagate.
 */
export function parseInboundKeyboardHelperMessage(line: string): KeyboardHelperInboundMessage | null {
  if (typeof line !== "string" || line.length === 0 || line.length > MAX_HELPER_MESSAGE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== "string") return null;

  switch (v.type) {
    case "HELLO":
      return typeof v.token === "string" && v.token.length > 0 && v.token.length <= MAX_TOKEN_LENGTH ? { type: "HELLO", token: v.token } : null;
    case "ARMED":
      return { type: "ARMED" };
    case "ARM_FAILED":
      return { type: "ARM_FAILED", reason: typeof v.reason === "string" ? v.reason.slice(0, MAX_REASON_LENGTH) : "UNKNOWN" };
    case "DISARMED":
      return { type: "DISARMED" };
    case "PONG":
      return { type: "PONG" };
    default:
      return null;
  }
}

/** Serializes an outbound message as one newline-terminated JSON line — the helper's own line-reader splits strictly on "\n". */
export function serializeOutboundKeyboardHelperMessage(message: KeyboardHelperOutboundMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * True only for the exact token this launch expects — a plain,
 * constant-shape string comparison is sufficient here (this is a
 * same-machine, same-user, per-launch defense-in-depth check layered on
 * top of the pipe's own current-user-only ACL and unguessable random
 * name; it is not a cryptographic authentication boundary against a
 * hostile actor already running arbitrary code as this same user, which
 * is out of scope — see keyboardHookHelperManager.ts's own doc comment).
 */
export function isExpectedHelperToken(received: string, expected: string): boolean {
  return typeof received === "string" && typeof expected === "string" && received.length > 0 && received === expected;
}
