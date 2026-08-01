import { describe, it, expect } from "vitest";
import { isServerTetherDiagnosticLoggingEnabled, isClientTetherDiagnosticLoggingEnabled } from "./tetherDiagnosticLog";

describe("isServerTetherDiagnosticLoggingEnabled", () => {
  it("is disabled in production regardless of the flag", () => {
    expect(isServerTetherDiagnosticLoggingEnabled("production", "true")).toBe(false);
  });

  it("is disabled when the environment is unknown, even with the flag set", () => {
    expect(isServerTetherDiagnosticLoggingEnabled("unknown", "true")).toBe(false);
  });

  it("is disabled on preview/local-development without the explicit flag", () => {
    expect(isServerTetherDiagnosticLoggingEnabled("preview", undefined)).toBe(false);
    expect(isServerTetherDiagnosticLoggingEnabled("local-development", "false")).toBe(false);
  });

  it("is enabled on preview/local-development with the explicit flag", () => {
    expect(isServerTetherDiagnosticLoggingEnabled("preview", "true")).toBe(true);
    expect(isServerTetherDiagnosticLoggingEnabled("local-development", "true")).toBe(true);
  });
});

describe("isClientTetherDiagnosticLoggingEnabled", () => {
  it("is disabled when NODE_ENV is production", () => {
    expect(isClientTetherDiagnosticLoggingEnabled("production")).toBe(false);
  });

  it("is enabled for any non-production NODE_ENV, including undefined", () => {
    expect(isClientTetherDiagnosticLoggingEnabled("development")).toBe(true);
    expect(isClientTetherDiagnosticLoggingEnabled("test")).toBe(true);
    expect(isClientTetherDiagnosticLoggingEnabled(undefined)).toBe(true);
  });
});
