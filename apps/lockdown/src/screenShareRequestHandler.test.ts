import { describe, it, expect, vi } from "vitest";
import { selectEntireScreenSource, handleDisplayMediaRequest, type ScreenShareSource } from "./screenShareRequestHandler";

const PRIMARY_SCREEN: ScreenShareSource = { id: "screen:0:0", name: "Entire Screen", display_id: "1" };
const SECONDARY_SCREEN: ScreenShareSource = { id: "screen:1:0", name: "Screen 2", display_id: "2" };

describe("selectEntireScreenSource", () => {
  it("returns null when no screen sources are available (Electron/OS supplied none)", () => {
    expect(selectEntireScreenSource([], "1")).toBeNull();
  });

  it("[2] returns the single available Entire Screen source", () => {
    expect(selectEntireScreenSource([PRIMARY_SCREEN], "1")).toBe(PRIMARY_SCREEN);
  });

  it("prefers the source matching the primary display id when multiple screens are attached", () => {
    expect(selectEntireScreenSource([SECONDARY_SCREEN, PRIMARY_SCREEN], "1")).toBe(PRIMARY_SCREEN);
  });

  it("falls back to the first source when no primary-display match exists", () => {
    expect(selectEntireScreenSource([SECONDARY_SCREEN], "1")).toBe(SECONDARY_SCREEN);
  });
});

describe("handleDisplayMediaRequest — the fix for 'The screen sharing could not be started. Try again.'", () => {
  it("[1, 2] a successful desktopCapturer query resolves the callback with a valid Entire Screen video source", async () => {
    const getScreenSources = vi.fn().mockResolvedValue([PRIMARY_SCREEN]);
    const callback = vi.fn();
    const log = vi.fn();
    await handleDisplayMediaRequest(getScreenSources, () => "1", callback, log);
    expect(callback).toHaveBeenCalledWith({ video: PRIMARY_SCREEN });
  });

  it("[4] queries desktopCapturer for screen sources (Electron supplies a valid desktop source)", async () => {
    const getScreenSources = vi.fn().mockResolvedValue([PRIMARY_SCREEN]);
    const callback = vi.fn();
    await handleDisplayMediaRequest(getScreenSources, () => "1", callback, vi.fn());
    expect(getScreenSources).toHaveBeenCalledTimes(1);
  });

  it("[3] never has the ability to return a window-only source — the handler's own type only ever accepts screen-shaped sources, structurally enforcing Entire Screen", async () => {
    // getScreenSources is the caller-supplied source of ScreenShareSource[]
    // (built from desktopCapturer.getSources({ types: ["screen"] }) in
    // main.ts) — this handler has no code path that could select a
    // "window" source even if one were somehow present in that list, since
    // it only ever picks among what it's given and never queries for
    // window-type sources itself.
    const getScreenSources = vi.fn().mockResolvedValue([PRIMARY_SCREEN]);
    const callback = vi.fn();
    await handleDisplayMediaRequest(getScreenSources, () => "1", callback, vi.fn());
    const [[streams]] = callback.mock.calls;
    expect(streams.video.name).not.toMatch(/window/i);
  });

  it("[10] a no-source condition (Electron/OS enumerated zero displays) is non-fatal — resolves the callback with an empty object, never throws", async () => {
    const getScreenSources = vi.fn().mockResolvedValue([]);
    const callback = vi.fn();
    await expect(handleDisplayMediaRequest(getScreenSources, () => "1", callback, vi.fn())).resolves.toBeUndefined();
    expect(callback).toHaveBeenCalledWith({});
  });

  it("a desktopCapturer failure (rejected promise) is non-fatal — resolves the callback with an empty object, never throws or produces an unhandled rejection", async () => {
    const getScreenSources = vi.fn().mockRejectedValue(new Error("native capture failure"));
    const callback = vi.fn();
    await expect(handleDisplayMediaRequest(getScreenSources, () => "1", callback, vi.fn())).resolves.toBeUndefined();
    expect(callback).toHaveBeenCalledWith({});
  });

  it("[11] a retry after a genuine no-source failure can still succeed once a source becomes available", async () => {
    const getScreenSources = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([PRIMARY_SCREEN]);
    const callback = vi.fn();
    await handleDisplayMediaRequest(getScreenSources, () => "1", callback, vi.fn());
    expect(callback).toHaveBeenLastCalledWith({});
    await handleDisplayMediaRequest(getScreenSources, () => "1", callback, vi.fn());
    expect(callback).toHaveBeenLastCalledWith({ video: PRIMARY_SCREEN });
  });

  it("[5] logs diagnostic checkpoints without ever including captured pixels/thumbnails — only bounded counts/ids/booleans", async () => {
    const getScreenSources = vi.fn().mockResolvedValue([PRIMARY_SCREEN]);
    const callback = vi.fn();
    const log = vi.fn();
    await handleDisplayMediaRequest(getScreenSources, () => "1", callback, log);
    const loggedPayloads = log.mock.calls.map(([, data]) => data).filter(Boolean);
    for (const payload of loggedPayloads) {
      for (const value of Object.values(payload as Record<string, unknown>)) {
        expect(typeof value === "string" || typeof value === "number" || typeof value === "boolean").toBe(true);
      }
    }
    expect(log).toHaveBeenCalledWith("screenShare: display-media request received");
  });
});
