// Lecturer application shell v1 — the one card container every lecturer
// section should use: white surface, 10-12px radius, light border,
// little/no shadow, hierarchy from spacing not elevation (per design
// brief). `accent` lets a section read as amber ("needs review")-styled
// without a caller reaching for a bespoke bg/border colour string.
import type { ReactNode } from "react";

const ACCENT_STYLES = {
  none: "border-lecturer-border",
  warning: "border-lecturer-border border-l-[3px] border-l-[#D97706]",
  critical: "border-lecturer-border border-l-[3px] border-l-[#B42318]",
} as const;

export function SectionCard({
  title,
  subtitle,
  actions,
  accent = "none",
  padded = true,
  children,
  className = "",
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  accent?: keyof typeof ACCENT_STYLES;
  padded?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const hasHeader = title || subtitle || actions;
  return (
    <section className={`overflow-hidden rounded-xl border bg-lecturer-surface ${ACCENT_STYLES[accent]} ${className}`}>
      {hasHeader && (
        <div className={`flex flex-wrap items-start justify-between gap-3 ${padded ? "px-5 pt-4" : "px-5 pt-4"} ${children ? "pb-3" : "pb-4"}`}>
          <div>
            {title && <h2 className="text-base font-semibold text-lecturer-text-primary">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-sm text-lecturer-text-secondary">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children && <div className={padded ? `px-5 ${hasHeader ? "pb-5" : "py-5"}` : ""}>{children}</div>}
    </section>
  );
}

/** Plain section heading for groups of cards that aren't themselves a bordered card (e.g. a grid of ExamCards under "Active"). */
export function SectionHeading({
  title,
  badge,
  subtitle,
  muted,
  actions,
}: {
  title: string;
  badge?: string;
  subtitle?: string;
  muted?: boolean;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <div>
        <div className="flex items-center gap-2">
          <h2 className={muted ? "text-sm font-semibold text-lecturer-text-secondary" : "text-lg font-semibold text-lecturer-text-primary"}>{title}</h2>
          {badge && (
            <span className="rounded-full bg-lecturer-border-subtle px-2 py-0.5 text-xs font-medium text-lecturer-text-secondary">{badge}</span>
          )}
        </div>
        {subtitle && <p className="mt-0.5 text-sm text-lecturer-text-secondary">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
