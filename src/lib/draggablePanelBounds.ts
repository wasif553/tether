/**
 * Final minor UX refinements v1 — pure bounds-clamping logic for the
 * draggable camera preview (src/components/DraggableCameraPreview.tsx).
 * Kept separate and dependency-free so it's testable without simulating
 * actual pointer drags (which the task itself asks not to over-test).
 */

export type PanelPosition = { x: number; y: number };
export type PanelSize = { width: number; height: number };
export type ViewportSize = { width: number; height: number };

/** Minimum gap kept from the left/right/bottom viewport edges. */
export const DRAGGABLE_PANEL_EDGE_MARGIN = 8;

/**
 * Clamps a panel's top-left position so it always stays fully within
 * the viewport: never left of `DRAGGABLE_PANEL_EDGE_MARGIN`, never
 * above `minTop` (keeps it below the exam header/status strip), and
 * never past the right/bottom edge (accounting for the panel's own
 * width/height) minus the same margin. Safe to call again after a
 * viewport resize — it always re-derives a valid position from
 * whatever `viewport`/`panelSize` are current, never assumes the
 * position was valid before.
 */
export function clampPanelPosition(
  position: PanelPosition,
  panelSize: PanelSize,
  viewport: ViewportSize,
  minTop: number,
): PanelPosition {
  const maxX = Math.max(DRAGGABLE_PANEL_EDGE_MARGIN, viewport.width - panelSize.width - DRAGGABLE_PANEL_EDGE_MARGIN);
  const maxY = Math.max(minTop, viewport.height - panelSize.height - DRAGGABLE_PANEL_EDGE_MARGIN);
  return {
    x: Math.min(Math.max(position.x, DRAGGABLE_PANEL_EDGE_MARGIN), maxX),
    y: Math.min(Math.max(position.y, minTop), maxY),
  };
}
