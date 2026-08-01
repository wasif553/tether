import { describe, it, expect } from "vitest";
import { assignDeviceLabels } from "./deviceLabels";

describe("assignDeviceLabels", () => {
  it("labels a single Windows installation as ordinal 1 when it is not current", () => {
    const labels = assignDeviceLabels([{ id: "a", platform: "win32", installedAt: "2026-01-01T00:00:00.000Z" }], null);
    expect(labels.a).toBe("Windows computer 1");
  });

  it("labels the current installation distinctly, regardless of its registration order", () => {
    const installations = [
      { id: "a", platform: "win32", installedAt: "2026-01-01T00:00:00.000Z" },
      { id: "b", platform: "win32", installedAt: "2026-01-02T00:00:00.000Z" },
    ];
    const labels = assignDeviceLabels(installations, "b");
    expect(labels.a).toBe("Windows computer 1");
    expect(labels.b).toBe("Current Windows computer");
  });

  it("assigns stable, increasing ordinals in chronological registration order, oldest first", () => {
    const installations = [
      { id: "newest", platform: "win32", installedAt: "2026-03-01T00:00:00.000Z" },
      { id: "oldest", platform: "win32", installedAt: "2026-01-01T00:00:00.000Z" },
      { id: "middle", platform: "win32", installedAt: "2026-02-01T00:00:00.000Z" },
    ];
    const labels = assignDeviceLabels(installations, null);
    expect(labels.oldest).toBe("Windows computer 1");
    expect(labels.middle).toBe("Windows computer 2");
    expect(labels.newest).toBe("Windows computer 3");
  });

  it("an already-revoked device keeps its ordinal even after a newer device is registered", () => {
    const before = [{ id: "a", platform: "win32", installedAt: "2026-01-01T00:00:00.000Z" }];
    expect(assignDeviceLabels(before, null).a).toBe("Windows computer 1");

    // "a" later revoked, "b" registered — "a" must still read "Windows computer 1".
    const after = [
      { id: "a", platform: "win32", installedAt: "2026-01-01T00:00:00.000Z" },
      { id: "b", platform: "win32", installedAt: "2026-02-01T00:00:00.000Z" },
    ];
    const labels = assignDeviceLabels(after, null);
    expect(labels.a).toBe("Windows computer 1");
    expect(labels.b).toBe("Windows computer 2");
  });

  it("never collects or displays anything beyond platform + timestamp — unrecognised platform falls back to a generic label", () => {
    const labels = assignDeviceLabels([{ id: "a", platform: "chromeos", installedAt: "2026-01-01T00:00:00.000Z" }], null);
    expect(labels.a).toBe("Computer 1");
  });

  it("null platform falls back to a generic label", () => {
    const labels = assignDeviceLabels([{ id: "a", platform: null, installedAt: "2026-01-01T00:00:00.000Z" }], null);
    expect(labels.a).toBe("Computer 1");
  });

  it("Mac and Windows installations get independent ordinal sequences", () => {
    const installations = [
      { id: "w1", platform: "win32", installedAt: "2026-01-01T00:00:00.000Z" },
      { id: "m1", platform: "darwin", installedAt: "2026-01-02T00:00:00.000Z" },
      { id: "w2", platform: "win32", installedAt: "2026-01-03T00:00:00.000Z" },
    ];
    const labels = assignDeviceLabels(installations, null);
    expect(labels.w1).toBe("Windows computer 1");
    expect(labels.w2).toBe("Windows computer 2");
    expect(labels.m1).toBe("Mac computer 1");
  });

  it("empty installation list returns an empty label map", () => {
    expect(assignDeviceLabels([], null)).toEqual({});
  });
});
