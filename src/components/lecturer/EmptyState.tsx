// Lecturer application shell v1 — one consistent empty-state pattern
// (previously each page hand-rolled its own "No X yet" block).
import type { ReactNode } from "react";

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-lecturer-border bg-lecturer-surface p-10 text-center">
      <p className="text-base font-semibold text-lecturer-text-primary">{title}</p>
      {description && <p className="mx-auto mt-1 max-w-sm text-sm text-lecturer-text-secondary">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-lecturer-text-secondary">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-lecturer-border border-t-lecturer-accent" aria-hidden="true" />
      {label}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-lecturer-border bg-[#FEF3F2] p-4 text-sm text-[#B42318]">
      <p>{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B42318]"
        >
          Try again
        </button>
      )}
    </div>
  );
}
