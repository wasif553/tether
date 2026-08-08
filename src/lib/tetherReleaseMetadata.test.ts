import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveTetherReleaseMetadata, resolveTetherCompatibilityState, tetherCompatibilityStateCopy } from "./tetherReleaseMetadata";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveTetherReleaseMetadata — canonical source", () => {
  it("[2] reports the frozen v1.7.2 metadata matching the known tested artifact", () => {
    const meta = resolveTetherReleaseMetadata();
    expect(meta.version).toBe("1.7.2");
    expect(meta.installerFilename).toBe("Tether-Secure-Browser-1.7.2-win-x64.exe");
    expect(meta.sha256).toBe("2295deeb6d78ff3f42911d2c0af904355e9cbd7048505c14a60e7a7072faed2d");
    expect(meta.platform).toBe("WINDOWS");
    expect(meta.architecture).toBe("x64");
  });

  it("[3] no installer URL configured -> downloads disabled, installerUrl null (never a fabricated link)", () => {
    vi.stubEnv("TETHER_INSTALLER_DOWNLOAD_URL", "");
    const meta = resolveTetherReleaseMetadata();
    expect(meta.installerUrl).toBeNull();
    expect(meta.downloadsEnabled).toBe(false);
  });

  it("[4] a valid configured installer URL enables downloads", () => {
    vi.stubEnv("TETHER_INSTALLER_DOWNLOAD_URL", "https://cdn.example.edu/tether/Tether-Secure-Browser-1.7.2-win-x64.exe");
    const meta = resolveTetherReleaseMetadata();
    expect(meta.installerUrl).toBe("https://cdn.example.edu/tether/Tether-Secure-Browser-1.7.2-win-x64.exe");
    expect(meta.downloadsEnabled).toBe(true);
  });

  it("[10] a malformed or non-http(s) installer URL never leaks through as a broken/dangerous link", () => {
    vi.stubEnv("TETHER_INSTALLER_DOWNLOAD_URL", "not a url");
    expect(resolveTetherReleaseMetadata().installerUrl).toBeNull();
    vi.stubEnv("TETHER_INSTALLER_DOWNLOAD_URL", "file:///C:/secret/installer.exe");
    expect(resolveTetherReleaseMetadata().installerUrl).toBeNull();
    vi.stubEnv("TETHER_INSTALLER_DOWNLOAD_URL", "javascript:alert(1)");
    expect(resolveTetherReleaseMetadata().installerUrl).toBeNull();
  });

  it("defaults release status to INTERNAL — never silently PILOT/GENERAL_AVAILABILITY", () => {
    vi.stubEnv("TETHER_RELEASE_STATUS", "");
    expect(resolveTetherReleaseMetadata().releaseStatus).toBe("INTERNAL");
    vi.stubEnv("TETHER_RELEASE_STATUS", "SOMETHING_MADE_UP");
    expect(resolveTetherReleaseMetadata().releaseStatus).toBe("INTERNAL");
  });

  it("accepts an explicit valid release status override", () => {
    vi.stubEnv("TETHER_RELEASE_STATUS", "PILOT");
    expect(resolveTetherReleaseMetadata().releaseStatus).toBe("PILOT");
  });

  it("[1] minimumSupportedVersion is the SAME resolver systemCheckConfig.ts uses — never a second source of truth", async () => {
    const { minimumSupportedTetherVersion } = await import("./systemCheckConfig");
    expect(resolveTetherReleaseMetadata().minimumSupportedVersion).toBe(minimumSupportedTetherVersion());
  });

  it("releaseNotesUrl defaults to null and rejects malformed values the same way as installerUrl", () => {
    vi.stubEnv("TETHER_RELEASE_NOTES_URL", "");
    expect(resolveTetherReleaseMetadata().releaseNotesUrl).toBeNull();
    vi.stubEnv("TETHER_RELEASE_NOTES_URL", "not a url");
    expect(resolveTetherReleaseMetadata().releaseNotesUrl).toBeNull();
  });
});

describe("resolveTetherCompatibilityState — [5, 6] distinguishes outdated from required-update, never an impossible loop", () => {
  it("[5] SUPPORTED when reported version meets the minimum", () => {
    expect(resolveTetherCompatibilityState({ reportedVersion: "1.7.2", minimumSupportedVersion: "1.5.0", downloadsEnabled: true })).toBe("SUPPORTED");
    expect(resolveTetherCompatibilityState({ reportedVersion: "1.5.0", minimumSupportedVersion: "1.5.0", downloadsEnabled: false })).toBe("SUPPORTED");
  });

  it("UNKNOWN when no version is reported at all", () => {
    expect(resolveTetherCompatibilityState({ reportedVersion: null, minimumSupportedVersion: "1.5.0", downloadsEnabled: true })).toBe("UNKNOWN");
    expect(resolveTetherCompatibilityState({ reportedVersion: "", minimumSupportedVersion: "1.5.0", downloadsEnabled: true })).toBe("UNKNOWN");
  });

  it("[5] below-minimum with downloads ENABLED is UPDATE_REQUIRED", () => {
    expect(resolveTetherCompatibilityState({ reportedVersion: "1.4.0", minimumSupportedVersion: "1.5.0", downloadsEnabled: true })).toBe("UPDATE_REQUIRED");
  });

  it("[6] below-minimum with downloads DISABLED can NEVER be UPDATE_REQUIRED — falls to OUTDATED_BUT_ALLOWED instead", () => {
    expect(resolveTetherCompatibilityState({ reportedVersion: "1.4.0", minimumSupportedVersion: "1.5.0", downloadsEnabled: false })).toBe("OUTDATED_BUT_ALLOWED");
  });

  it("[6] property-style check: for every below-minimum version, downloadsEnabled=false never yields UPDATE_REQUIRED", () => {
    const belowMinimumVersions = ["0.1.0", "1.0.0", "1.4.9", "1.4.99"];
    for (const v of belowMinimumVersions) {
      const state = resolveTetherCompatibilityState({ reportedVersion: v, minimumSupportedVersion: "1.5.0", downloadsEnabled: false });
      expect(state).not.toBe("UPDATE_REQUIRED");
    }
  });
});

describe("tetherCompatibilityStateCopy — approved product language, one source", () => {
  it("matches the exact required wording for each state", () => {
    expect(tetherCompatibilityStateCopy("SUPPORTED")).toBe("Your Tether version is supported.");
    expect(tetherCompatibilityStateCopy("OUTDATED_BUT_ALLOWED")).toBe("A newer Tether version is available.");
    expect(tetherCompatibilityStateCopy("UPDATE_REQUIRED")).toBe("This examination requires a newer supported version of Tether.");
  });
});
