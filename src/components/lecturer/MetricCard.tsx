// Lecturer application shell v1 — compact summary-metric tile shared
// across dashboard, submissions, integrity, and analytics. Deliberately
// small (icon + value + label), per design brief: "Do not make these
// oversized."
//
// Polish pass v2 — restrained-colour concept: every card keeps a white
// surface and neutral border regardless of accent; only the icon tile
// and (for warning/critical) a thin left accent bar carry colour, so
// "Needs review" still reads as the strongest state without washing the
// whole card in colour. Icon/label/value laid out icon-left,
// label-over-value-right for cleaner alignment than the old
// icon-beside-label / value-below arrangement.
import type { ReactNode } from "react";

const ACCENT_STYLES = {
  neutral: { border: "border-lecturer-border", icon: "bg-[#F2F4F7] text-lecturer-text-secondary" },
  success: { border: "border-lecturer-border", icon: "bg-[#ECFDF3] text-[#067647]" },
  info: { border: "border-lecturer-border", icon: "bg-[#EFF6FF] text-[#1D4ED8]" },
  warning: { border: "border-lecturer-border border-l-[3px] border-l-[#D97706]", icon: "bg-[#FFF6DD] text-[#B54708]" },
  critical: { border: "border-lecturer-border border-l-[3px] border-l-[#B42318]", icon: "bg-[#FEE4E2] text-[#B42318]" },
} as const;

export function MetricCard({
  label,
  value,
  accent = "neutral",
  icon,
}: {
  label: string;
  value: string | number;
  accent?: keyof typeof ACCENT_STYLES;
  icon?: ReactNode;
}) {
  const styles = ACCENT_STYLES[accent];
  return (
    <div className={`rounded-xl border bg-lecturer-surface p-4 ${styles.border}`}>
      <div className="flex items-center gap-3">
        {icon && <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${styles.icon}`}>{icon}</span>}
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-lecturer-text-secondary">{label}</p>
          <p className="mt-0.5 text-2xl leading-none font-bold text-lecturer-text-primary">{value}</p>
        </div>
      </div>
    </div>
  );
}
