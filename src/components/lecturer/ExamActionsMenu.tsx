"use client";

// Exam Archive Lifecycle v1 — see docs/exam-archive-lifecycle-v1.md. The
// ONE consistent exam actions menu used everywhere an exam row/card
// needs Archive/Restore/Delete (Dashboard, Exams index, Course detail,
// Exam workspace) — deliberately not duplicated per page. Archive is
// never the main CTA for an active exam (it's tucked in this overflow
// menu, not a top-level button); Delete is visually separated (its own
// red-bordered "Danger zone" row, never beside ordinary actions) and
// gated by a stronger confirmation. The client-side `deletable` flag is
// ONLY a heuristic for whether to render the item at all — the server
// (DELETE /api/exams/[id], via src/lib/examDeleteEligibility.ts) is the
// authoritative check regardless of what this menu decided to show.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MoreIcon } from "./icons";

type ExamActionsMenuProps = {
  examId: string;
  examTitle: string;
  /** Whether the exam is currently archived — determines which action set renders. */
  archived: boolean;
  /**
   * Client-side heuristic only (unpublished + zero known submissions) —
   * decides whether "Delete permanently" is even offered. The server
   * re-checks authoritatively regardless; this never substitutes for
   * that check.
   */
  deletable: boolean;
  /** Called after a successful archive/restore/delete so the parent can refetch its list. */
  onChanged: () => void;
  /** Where "Open exam" / "View" should link. */
  href: string;
};

const MENU_ITEM_CLASS =
  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-lecturer-text-primary hover:bg-lecturer-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent";

export function ExamActionsMenu({ examId, examTitle, archived, deletable, onChanged, href }: ExamActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [confirmMode, setConfirmMode] = useState<"archive" | "restore" | "delete" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${examTitle}`}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-lecturer-border bg-lecturer-surface text-lecturer-text-secondary hover:bg-lecturer-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
      >
        <MoreIcon className="h-4 w-4" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1.5 w-56 overflow-hidden rounded-xl border border-lecturer-border bg-lecturer-surface p-1.5 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          {!archived && (
            <>
              <Link href={href} role="menuitem" className={MENU_ITEM_CLASS} onClick={() => setOpen(false)}>
                Open exam
              </Link>
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM_CLASS}
                onClick={() => {
                  setOpen(false);
                  setConfirmMode("archive");
                }}
              >
                Archive exam
              </button>
              {deletable && (
                <>
                  <div className="my-1.5 border-t border-lecturer-border" />
                  <p className="px-3 pt-0.5 pb-1 text-[11px] font-semibold tracking-wide text-lecturer-text-muted uppercase">Danger zone</p>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium text-[#B42318] hover:bg-[#FEF3F2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B42318]"
                    onClick={() => {
                      setOpen(false);
                      setConfirmMode("delete");
                    }}
                  >
                    Delete permanently
                  </button>
                </>
              )}
            </>
          )}
          {archived && (
            <>
              <Link href={href} role="menuitem" className={MENU_ITEM_CLASS} onClick={() => setOpen(false)}>
                View
              </Link>
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM_CLASS}
                onClick={() => {
                  setOpen(false);
                  setConfirmMode("restore");
                }}
              >
                Restore exam
              </button>
            </>
          )}
        </div>
      )}

      {confirmMode === "archive" && (
        <ArchiveConfirmDialog examId={examId} examTitle={examTitle} onClose={() => setConfirmMode(null)} onDone={onChanged} />
      )}
      {confirmMode === "restore" && (
        <RestoreConfirmDialog examId={examId} examTitle={examTitle} onClose={() => setConfirmMode(null)} onDone={onChanged} />
      )}
      {confirmMode === "delete" && (
        <DeleteConfirmDialog examId={examId} examTitle={examTitle} onClose={() => setConfirmMode(null)} onDone={onChanged} />
      )}
    </div>
  );
}

/**
 * A standalone, prominent "Restore" trigger for contexts where Restore
 * should be the PRIMARY visible action for an archived exam (e.g. the
 * Exams index "Archived" filter row), rather than tucked inside the
 * overflow menu — Restore stays reachable from ExamActionsMenu's own
 * menu too, this is purely an additional, more prominent entry point to
 * the same confirm dialog/PATCH call.
 */
export function RestoreExamButton({ examId, examTitle, onChanged }: { examId: string; examTitle: string; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-sm font-semibold text-lecturer-accent hover:text-lecturer-accent-hover"
      >
        Restore
      </button>
      {confirming && <RestoreConfirmDialog examId={examId} examTitle={examTitle} onClose={() => setConfirming(false)} onDone={onChanged} />}
    </>
  );
}

function DialogShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="presentation">
      <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-xl border border-lecturer-border bg-lecturer-surface p-5 shadow-xl">
        {children}
      </div>
    </div>
  );
}

function ArchiveConfirmDialog({ examId, examTitle, onClose, onDone }: { examId: string; examTitle: string; onClose: () => void; onDone: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/exams/${examId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    setSaving(false);
    if (!res.ok) {
      setError("Could not archive this exam. Try again.");
      return;
    }
    onClose();
    onDone();
  }

  return (
    <DialogShell>
      <h2 className="text-base font-semibold text-lecturer-text-primary">Archive exam?</h2>
      <p className="mt-2 text-sm text-lecturer-text-secondary">
        “{examTitle}” will be removed from your active exam lists but its submissions, marks and integrity records will be retained. You can restore it at any time.
      </p>
      {error && <p className="mt-2 text-sm text-[#B42318]">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="rounded-lg border border-lecturer-border px-4 py-2 text-sm font-medium text-lecturer-text-secondary hover:bg-lecturer-border-subtle disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={confirm}
          disabled={saving}
          className="rounded-lg bg-lecturer-accent px-4 py-2 text-sm font-semibold text-white hover:bg-lecturer-accent-hover disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent focus-visible:ring-offset-2"
        >
          {saving ? "Archiving…" : "Archive exam"}
        </button>
      </div>
    </DialogShell>
  );
}

function RestoreConfirmDialog({ examId, examTitle, onClose, onDone }: { examId: string; examTitle: string; onClose: () => void; onDone: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/exams/${examId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });
    setSaving(false);
    if (!res.ok) {
      setError("Could not restore this exam. Try again.");
      return;
    }
    onClose();
    onDone();
  }

  return (
    <DialogShell>
      <h2 className="text-base font-semibold text-lecturer-text-primary">Restore exam?</h2>
      <p className="mt-2 text-sm text-lecturer-text-secondary">
        “{examTitle}” will return to your normal exam lists, grouped by its own status (Draft, Upcoming, or Closed).
      </p>
      {error && <p className="mt-2 text-sm text-[#B42318]">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="rounded-lg border border-lecturer-border px-4 py-2 text-sm font-medium text-lecturer-text-secondary hover:bg-lecturer-border-subtle disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={confirm}
          disabled={saving}
          className="rounded-lg bg-lecturer-accent px-4 py-2 text-sm font-semibold text-white hover:bg-lecturer-accent-hover disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent focus-visible:ring-offset-2"
        >
          {saving ? "Restoring…" : "Restore exam"}
        </button>
      </div>
    </DialogShell>
  );
}

function DeleteConfirmDialog({ examId, examTitle, onClose, onDone }: { examId: string; examTitle: string; onClose: () => void; onDone: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typedTitle, setTypedTitle] = useState("");
  const canConfirm = typedTitle.trim() === examTitle.trim();

  async function confirm() {
    if (!canConfirm) return;
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/exams/${examId}`, { method: "DELETE" });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(typeof body?.error === "string" ? body.error : "This exam could not be deleted.");
      return;
    }
    onClose();
    onDone();
  }

  return (
    <DialogShell>
      <h2 className="text-base font-semibold text-[#B42318]">Delete draft permanently?</h2>
      <p className="mt-2 text-sm text-lecturer-text-secondary">
        This action cannot be undone. Only unused drafts with no submissions or integrity records can be deleted.
      </p>
      <label className="mt-4 block text-xs font-medium text-lecturer-text-secondary" htmlFor="delete-confirm-title">
        Type &ldquo;{examTitle}&rdquo; to confirm.
      </label>
      <input
        id="delete-confirm-title"
        type="text"
        autoFocus
        value={typedTitle}
        onChange={(e) => setTypedTitle(e.target.value)}
        className="mt-1 w-full rounded-lg border border-lecturer-border px-3 py-2 text-sm text-lecturer-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-[#B42318]"
      />
      {error && <p className="mt-2 text-sm text-[#B42318]">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="rounded-lg border border-lecturer-border px-4 py-2 text-sm font-medium text-lecturer-text-secondary hover:bg-lecturer-border-subtle disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={confirm}
          disabled={saving || !canConfirm}
          className="rounded-lg bg-[#B42318] px-4 py-2 text-sm font-semibold text-white hover:bg-[#912018] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B42318] focus-visible:ring-offset-2"
        >
          {saving ? "Deleting…" : "Delete permanently"}
        </button>
      </div>
    </DialogShell>
  );
}
