// Lecturer application shell v1 — one shared status-pill component for
// every lecturer surface (exam availability, submission/integrity/
// review state, connection status, etc). Consolidates the half-dozen
// near-identical local "StatusPill"/"StatusBadge" components that used
// to be redefined per page (dashboard, pilot-readiness, submissions,
// integrity) with slightly different colour maps. `tone` is the only
// thing callers choose — never raw colours — so every badge in the
// product stays visually consistent. Red is reserved for `critical`;
// ordinary navigation/actions never use it (see design brief).
const TONE_STYLES = {
  success: "bg-[#ECFDF3] text-[#067647]",
  warning: "bg-[#FFFAEB] text-[#B54708]",
  critical: "bg-[#FEF3F2] text-[#B42318]",
  info: "bg-[#EFF6FF] text-[#1D4ED8]",
  neutral: "bg-[#F2F4F7] text-[#667085]",
  accent: "bg-lecturer-accent-subtle text-lecturer-accent-hover",
} as const;

export type StatusTone = keyof typeof TONE_STYLES;

export function StatusBadge({
  tone = "neutral",
  children,
  className = "",
}: {
  tone?: StatusTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONE_STYLES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** Maps the shared lecturerAvailabilityStatus() values to a StatusBadge tone, so every page that shows exam availability agrees on colour. */
export function availabilityToneFor(status: "Draft" | "Scheduled" | "Open" | "Closed"): StatusTone {
  switch (status) {
    case "Open":
      return "success";
    case "Scheduled":
      return "info";
    case "Draft":
    case "Closed":
    default:
      return "neutral";
  }
}
