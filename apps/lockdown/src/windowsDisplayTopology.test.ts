import { describe, it, expect } from "vitest";
import { parseTopologyOutput } from "./windowsDisplayTopology";

// Corrective pass v1.2.0, Part 2 — the parsing/validation boundary
// between the spawned PowerShell process's stdout and the rest of the
// app. Never trusts stdout content structurally: only a well-formed
// {ok:true, activePathCount:number, distinctSourceCount:number} object
// is accepted; anything else fails closed to parse_failed.

describe("parseTopologyOutput", () => {
  it("parses a well-formed successful result", () => {
    expect(parseTopologyOutput('{"ok":true,"activePathCount":2,"distinctSourceCount":1}')).toEqual({
      ok: true,
      activePathCount: 2,
      distinctSourceCount: 1,
    });
  });

  it("tolerates surrounding whitespace/newlines from PowerShell output", () => {
    expect(parseTopologyOutput('\r\n  {"ok":true,"activePathCount":1,"distinctSourceCount":1}\r\n')).toEqual({
      ok: true,
      activePathCount: 1,
      distinctSourceCount: 1,
    });
  });

  it("fails closed on invalid JSON", () => {
    expect(parseTopologyOutput("not json at all")).toEqual({ ok: false, reason: "parse_failed" });
  });

  it("fails closed on empty output", () => {
    expect(parseTopologyOutput("")).toEqual({ ok: false, reason: "parse_failed" });
  });

  it("fails closed when ok is not literally true", () => {
    expect(parseTopologyOutput('{"ok":false,"reason":"buffer_sizes_failed"}')).toEqual({ ok: false, reason: "parse_failed" });
  });

  it("fails closed when the count fields are missing or the wrong type", () => {
    expect(parseTopologyOutput('{"ok":true}')).toEqual({ ok: false, reason: "parse_failed" });
    expect(parseTopologyOutput('{"ok":true,"activePathCount":"2","distinctSourceCount":1}')).toEqual({ ok: false, reason: "parse_failed" });
  });

  it("never trusts extra unexpected fields as a substitute for the required ones", () => {
    expect(parseTopologyOutput('{"ok":true,"serialNumber":"ABC123","distinctSourceCount":1}')).toEqual({ ok: false, reason: "parse_failed" });
  });
});
