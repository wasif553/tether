import { describe, expect, it } from "vitest";
import { clampPanelPosition, DRAGGABLE_PANEL_EDGE_MARGIN } from "./draggablePanelBounds";

const panelSize = { width: 176, height: 140 };
const viewport = { width: 1366, height: 768 };
const minTop = 96;

describe("clampPanelPosition", () => {
  it("leaves an already-valid position unchanged", () => {
    expect(clampPanelPosition({ x: 400, y: 300 }, panelSize, viewport, minTop)).toEqual({ x: 400, y: 300 });
  });

  it("clamps a negative x to the left edge margin", () => {
    expect(clampPanelPosition({ x: -500, y: 300 }, panelSize, viewport, minTop).x).toBe(DRAGGABLE_PANEL_EDGE_MARGIN);
  });

  it("clamps y above the header/status area up to minTop", () => {
    expect(clampPanelPosition({ x: 400, y: 0 }, panelSize, viewport, minTop).y).toBe(minTop);
  });

  it("clamps x past the right edge, accounting for panel width", () => {
    const result = clampPanelPosition({ x: 5000, y: 300 }, panelSize, viewport, minTop);
    expect(result.x).toBe(viewport.width - panelSize.width - DRAGGABLE_PANEL_EDGE_MARGIN);
  });

  it("clamps y past the bottom edge, accounting for panel height", () => {
    const result = clampPanelPosition({ x: 400, y: 5000 }, panelSize, viewport, minTop);
    expect(result.y).toBe(viewport.height - panelSize.height - DRAGGABLE_PANEL_EDGE_MARGIN);
  });

  it("never lets the panel disappear off-screen even at the exact viewport corner", () => {
    const result = clampPanelPosition({ x: viewport.width, y: viewport.height }, panelSize, viewport, minTop);
    expect(result.x).toBeLessThanOrEqual(viewport.width - panelSize.width);
    expect(result.y).toBeLessThanOrEqual(viewport.height - panelSize.height);
  });

  it("re-clamps a previously-valid position after the viewport shrinks (e.g. resize/rotate)", () => {
    const persisted = { x: 1200, y: 600 };
    const shrunkViewport = { width: 900, height: 500 };
    const result = clampPanelPosition(persisted, panelSize, shrunkViewport, minTop);
    expect(result.x).toBeLessThanOrEqual(shrunkViewport.width - panelSize.width);
    expect(result.y).toBeLessThanOrEqual(shrunkViewport.height - panelSize.height);
  });

  it("falls back to the edge margin/minTop rather than a negative range when the panel is larger than the viewport", () => {
    const tinyViewport = { width: 100, height: 100 };
    const result = clampPanelPosition({ x: 50, y: 50 }, panelSize, tinyViewport, minTop);
    expect(result.x).toBe(DRAGGABLE_PANEL_EDGE_MARGIN);
    expect(result.y).toBe(minTop);
  });
});
