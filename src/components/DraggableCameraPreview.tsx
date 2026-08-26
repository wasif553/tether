"use client";

/**
 * Final minor UX refinements v1 — a lightweight, dependency-free
 * picture-in-picture wrapper around the existing camera preview
 * (Persistent Camera Preview v1, src/app/student/exams/[id]/page.tsx).
 * This component owns ONLY presentation/position — it never touches
 * the camera stream, never creates an IntegrityEvent, and never
 * changes camera monitoring/evidence-capture semantics. The `<video>`
 * element (passed in as `children`) is never unmounted/remounted by a
 * drag — only this wrapper's own `left`/`top` inline styles change —
 * so the live stream is never interrupted.
 *
 * Renders in normal flow by default (`position === null`, drawn by the
 * caller wherever it's placed in the layout — e.g. under the question
 * navigator). Once the student drags the header, it becomes a
 * `position: fixed` floating panel and stays that way, clamped inside
 * the viewport (src/lib/draggablePanelBounds.ts), for the rest of the
 * session — persisted to sessionStorage keyed by `storageKey` (the
 * submission id), never sent to the server, never a DB/schema change.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { clampPanelPosition, type PanelPosition } from "@/lib/draggablePanelBounds";

/** Keeps the floating panel below the exam title/timer/integrity strip. */
const MIN_TOP_PX = 96;
const DEFAULT_PANEL_SIZE = { width: 176, height: 140 };

function readPersistedPosition(storageKey: string): PanelPosition | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PanelPosition>;
    if (typeof parsed.x === "number" && typeof parsed.y === "number") return { x: parsed.x, y: parsed.y };
  } catch {
    // sessionStorage can throw under strict privacy settings — never fatal.
  }
  return null;
}

function writePersistedPosition(storageKey: string, position: PanelPosition): void {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(position));
  } catch {
    // Best-effort only.
  }
}

export function DraggableCameraPreview({
  storageKey,
  minimized,
  onToggleMinimized,
  children,
}: {
  /** Unique per submission — e.g. `tether-camera-position-${submissionId}`. */
  storageKey: string;
  minimized: boolean;
  onToggleMinimized: () => void;
  /** The video element + status messages, shown only while expanded. */
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);
  // null = still in normal flow (never dragged this session/reload).
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const [dragging, setDragging] = useState(false);

  function currentPanelSize() {
    const rect = panelRef.current?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : DEFAULT_PANEL_SIZE;
  }

  // Restore a persisted position on mount only — sessionStorage is
  // client-only, so this must happen post-mount, never during render.
  useEffect(() => {
    const persisted = readPersistedPosition(storageKey);
    if (!persisted) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPosition(
      clampPanelPosition(persisted, currentPanelSize(), { width: window.innerWidth, height: window.innerHeight }, MIN_TOP_PX),
    );
  }, [storageKey]);

  // Re-clamp whenever the viewport resizes so a floating panel can
  // never end up off-screen after the window/browser shrinks.
  useEffect(() => {
    function handleResize() {
      setPosition((prev) => {
        if (!prev) return prev;
        return clampPanelPosition(prev, currentPanelSize(), { width: window.innerWidth, height: window.innerHeight }, MIN_TOP_PX);
      });
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!panelRef.current) return;
    const rect = panelRef.current.getBoundingClientRect();
    dragOffsetRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragOffsetRef.current) return;
    const next = clampPanelPosition(
      { x: e.clientX - dragOffsetRef.current.dx, y: e.clientY - dragOffsetRef.current.dy },
      currentPanelSize(),
      { width: window.innerWidth, height: window.innerHeight },
      MIN_TOP_PX,
    );
    setPosition(next);
  }, []);

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragOffsetRef.current) return;
      dragOffsetRef.current = null;
      setDragging(false);
      if (panelRef.current && e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      setPosition((current) => {
        if (current) writePersistedPosition(storageKey, current);
        return current;
      });
    },
    [storageKey],
  );

  const floating = position != null;

  return (
    <div
      ref={panelRef}
      style={floating ? { position: "fixed", left: position.x, top: position.y, zIndex: 50 } : undefined}
      className={floating ? "w-44" : "w-full"}
    >
      {minimized ? (
        <button
          onClick={onToggleMinimized}
          className="flex items-center gap-2 rounded-full border border-gray-300 bg-white px-3 py-1.5 text-xs shadow"
          aria-label="Expand camera preview"
        >
          <span className="h-2 w-2 rounded-full bg-green-500" />
          Camera active
          <span aria-hidden>▸</span>
        </button>
      ) : (
        <div className="rounded border border-gray-300 bg-white p-2 shadow">
          {/* Drag handle (Part 3) — pointer events only, per the task's
              own guidance to prefer a small native implementation over
              a drag-and-drop dependency. touch-none prevents the
              browser's own touch-scroll gesture from fighting the drag
              on tablets/phones; select-none stops the label text being
              selected mid-drag. */}
          <div
            className={`mb-1 flex items-center justify-between gap-3 touch-none select-none ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            aria-label="Move camera preview"
          >
            <span className="text-xs text-gray-500">Your camera — only you can see this</span>
            <button
              onClick={onToggleMinimized}
              // Stops the pointerdown from also being seen by the
              // header's own drag-start handler above (event bubbling)
              // — without this, pressing the collapse button would
              // register as the start of a drag instead of a click.
              onPointerDown={(e) => e.stopPropagation()}
              className="rounded border border-gray-300 px-1.5 py-0.5 text-xs"
              aria-label="Minimize camera preview"
            >
              <span aria-hidden>▾</span>
            </button>
          </div>
          {children}
        </div>
      )}
    </div>
  );
}
