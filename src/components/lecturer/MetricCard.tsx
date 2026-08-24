// Lecturer application shell v1 — compact summary-metric tile shared
// across dashboard, submissions, integrity, and analytics. Deliberately
// small (icon + value + label), per design brief: "Do not make these
// oversized."
import type { ReactNode } from "react";

const ACCENT_STYLES = {
  neutral: { border: "border-lecturer-border", icon: "bg-[#F2F4F7] text-lecturer-text-secondary" },
  success: { border: "border-lecturer-border", icon: "bg-[#ECFDF3] text-[#067647]" },
  info: { border: "border-lecturer-border", icon: "bg-[#EFF6FF] text-[#1D4ED8]" },
  warning: { border: "border-[#FEDF89] bg-[#FFFAEB]", icon: "bg-[#FFF6DD] text-[#B54708]" },
  critical: { border: "border-[#FDA29B] bg-[#FEF3F2]", icon: "bg-[#FEE4E2] text-[#B42318]" },
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
      <div className="flex items-center gap-2">
        {icon && <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${styles.icon}`}>{icon}</span>}
        <span className="text-sm font-medium text-lecturer-text-secondary">{label}</span>
      </div>
      <div className="mt-1.5 text-2xl font-bold text-lecturer-text-primary">{value}</div>
    </div>
  );
}
