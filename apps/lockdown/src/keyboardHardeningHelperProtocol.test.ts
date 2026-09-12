import { describe, it, expect } from "vitest";
import {
  parseInboundKeyboardHelperMessage,
  serializeOutboundKeyboardHelperMessage,
  isExpectedHelperToken,
  MAX_HELPER_MESSAGE_BYTES,
} from "./keyboardHardeningHelperProtocol";

describe("parseInboundKeyboardHelperMessage — valid messages", () => {
  it("parses HELLO with its token", () => {
    expect(parseInboundKeyboardHelperMessage('{"type":"HELLO","token":"abc123"}')).toEqual({ type: "HELLO", token: "abc123" });
  });
  it("parses ARMED", () => {
    expect(parseInboundKeyboardHelperMessage('{"type":"ARMED"}')).toEqual({ type: "ARMED" });
  });
  it("parses ARM_FAILED with its reason", () => {
    expect(parseInboundKeyboardHelperMessage('{"type":"ARM_FAILED","reason":"HOOK_INSTALL_FAILED"}')).toEqual({ type: "ARM_FAILED", reason: "HOOK_INSTALL_FAILED" });
  });
  it("ARM_FAILED without a reason defaults to UNKNOWN rather than being rejected", () => {
    expect(parseInboundKeyboardHelperMessage('{"type":"ARM_FAILED"}')).toEqual({ type: "ARM_FAILED", reason: "UNKNOWN" });
  });
  it("parses DISARMED", () => {
    expect(parseInboundKeyboardHelperMessage('{"type":"DISARMED"}')).toEqual({ type: "DISARMED" });
  });
  it("parses PONG", () => {
    expect(parseInboundKeyboardHelperMessage('{"type":"PONG"}')).toEqual({ type: "PONG" });
  });
});

describe("parseInboundKeyboardHelperMessage — malformed/adversarial input is rejected (returns null), never throws", () => {
  it("rejects invalid JSON", () => {
    expect(parseInboundKeyboardHelperMessage("not json")).toBeNull();
    expect(parseInboundKeyboardHelperMessage("{")).toBeNull();
  });
  it("rejects a JSON array", () => {
    expect(parseInboundKeyboardHelperMessage("[1,2,3]")).toBeNull();
  });
  it("rejects a bare JSON primitive", () => {
    expect(parseInboundKeyboardHelperMessage("42")).toBeNull();
    expect(parseInboundKeyboardHelperMessage('"HELLO"')).toBeNull();
  });
  it("rejects a missing type field", () => {
    expect(parseInboundKeyboardHelperMessage('{"token":"abc"}')).toBeNull();
  });
  it("rejects an unrecognized type — including outbound-only types a compromised/confused peer might send", () => {
    expect(parseInboundKeyboardHelperMessage('{"type":"ARM"}')).toBeNull();
    expect(parseInboundKeyboardHelperMessage('{"type":"DISARM"}')).toBeNull();
    expect(parseInboundKeyboardHelperMessage('{"type":"PING"}')).toBeNull();
    expect(parseInboundKeyboardHelperMessage('{"type":"SHUTDOWN"}')).toBeNull();
    expect(parseInboundKeyboardHelperMessage('{"type":"SOMETHING_ELSE"}')).toBeNull();
  });
  it("rejects HELLO with a non-string or empty token", () => {
    expect(parseInboundKeyboardHelperMessage('{"type":"HELLO","token":123}')).toBeNull();
    expect(parseInboundKeyboardHelperMessage('{"type":"HELLO","token":""}')).toBeNull();
    expect(parseInboundKeyboardHelperMessage('{"type":"HELLO"}')).toBeNull();
  });
  it("rejects a HELLO token over 256 characters", () => {
    const longToken = "a".repeat(257);
    expect(parseInboundKeyboardHelperMessage(`{"type":"HELLO","token":"${longToken}"}`)).toBeNull();
  });
  it("rejects an empty or oversized line without throwing", () => {
    expect(parseInboundKeyboardHelperMessage("")).toBeNull();
    expect(parseInboundKeyboardHelperMessage("x".repeat(MAX_HELPER_MESSAGE_BYTES + 1))).toBeNull();
  });
  it("never throws for non-string input", () => {
    // @ts-expect-error — deliberately exercising the runtime guard against a caller that doesn't respect the type signature (e.g. a raw net.Socket 'data' handler passing something unexpected).
    expect(() => parseInboundKeyboardHelperMessage(null)).not.toThrow();
    // @ts-expect-error — same as above.
    expect(parseInboundKeyboardHelperMessage(undefined)).toBeNull();
  });
});

describe("serializeOutboundKeyboardHelperMessage", () => {
  it("serializes each outbound message as one newline-terminated JSON line", () => {
    expect(serializeOutboundKeyboardHelperMessage({ type: "HELLO", token: "tok" })).toBe('{"type":"HELLO","token":"tok"}\n');
    expect(serializeOutboundKeyboardHelperMessage({ type: "ARM" })).toBe('{"type":"ARM"}\n');
    expect(serializeOutboundKeyboardHelperMessage({ type: "DISARM" })).toBe('{"type":"DISARM"}\n');
    expect(serializeOutboundKeyboardHelperMessage({ type: "PING" })).toBe('{"type":"PING"}\n');
    expect(serializeOutboundKeyboardHelperMessage({ type: "SHUTDOWN" })).toBe('{"type":"SHUTDOWN"}\n');
  });

  it("round-trips through parseInboundKeyboardHelperMessage's own shape for the inbound-equivalent messages (sanity check that both sides agree on the wire format)", () => {
    const line = serializeOutboundKeyboardHelperMessage({ type: "HELLO", token: "round-trip-token" });
    expect(parseInboundKeyboardHelperMessage(line.trimEnd())).toEqual({ type: "HELLO", token: "round-trip-token" });
  });
});

describe("isExpectedHelperToken", () => {
  it("true only for an exact, non-empty match", () => {
    expect(isExpectedHelperToken("abc", "abc")).toBe(true);
    expect(isExpectedHelperToken("abc", "abd")).toBe(false);
    expect(isExpectedHelperToken("", "")).toBe(false);
    expect(isExpectedHelperToken("abc", "")).toBe(false);
  });
});
