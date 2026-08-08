import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveInstitutionSupportContact } from "./institutionSupportContact";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveInstitutionSupportContact", () => {
  it("returns null when unset", () => {
    vi.stubEnv("TETHER_SUPPORT_CONTACT", "");
    expect(resolveInstitutionSupportContact()).toBeNull();
  });

  it("returns the trimmed configured value", () => {
    vi.stubEnv("TETHER_SUPPORT_CONTACT", "  support@example.edu  ");
    expect(resolveInstitutionSupportContact()).toBe("support@example.edu");
  });
});
