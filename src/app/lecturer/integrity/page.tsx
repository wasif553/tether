"use client";

// Lecturer application shell v1 — top-level "Integrity Signals" nav
// destination (design brief: treat this as a core workflow, not hidden
// inside Reports). Actual signal inspection/evidence/review stays at
// the existing per-exam route (/lecturer/exams/[id]/integrity); this
// index reuses the SAME GET /api/exams?all=true endpoint the dashboard
// already calls (needsReviewCount is already part of that response) so
// lecturers can see which exams have signals awaiting review and route
// straight into review — no new cross-exam aggregation API invented.
// Deliberately worded as "signals awaiting review", never an
// accusation: signal != misconduct finding, human review stays central.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { lecturerAvailabilityStatus } from "@/lib/lecturerDashboardGrouping";
import { LecturerPageHeader } from "@/components/lecturer/LecturerPageHeader";
import { MetricCard } from "@/components/lecturer/MetricCard";
import { SectionCard } from "@/components/lecturer/SectionCard";
import { StatusBadge, availabilityToneFor } from "@/components/lecturer/StatusBadge";
import { EmptyState, ErrorState, LoadingState } from "@/components/lecturer/EmptyState";
import { IntegrityIcon } from "@/components/lecturer/icons";

type ExamSummary = {
  id: string;
  title: string;
  published: boolean;
  availableFrom: string | null;
  availableUntil: string | null;
  course: { id: string; name: string; code: string } | null;
  _count: { submissions: number };
  needsReviewCount: number;
};

export default function LecturerIntegritySignalsIndexPage() {
  const [exams, setExams] = useState<ExamSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/exams?all=true")
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((rows: ExamSummary[]) => setExams(rows))
      .catch(() => setError("Could not load integrity signals — check your connection and try refreshing the page."));
  }, []);

  const withSignals = useMemo(() => (exams ?? []).filter((exam) => exam.needsReviewCount > 0).sort((a, b) => b.needsReviewCount - a.needsReviewCount), [exams]);
  const monitored = exams?.filter((exam) => exam._count.submissions > 0).length ?? 0;
  const totalSignals = withSignals.reduce((sum, exam) => sum + exam.needsReviewCount, 0);

  return (
    <div className="mx-auto max-w-5xl">
      <LecturerPageHeader
        breadcrumbs={[{ label: "Dashboard", href: "/lecturer" }, { label: "Integrity Signals" }]}
        title="Integrity Signals"
        description="Signals awaiting review across your exams. A signal is not a misconduct finding — human review decides."
      />

      {exams && exams.length > 0 && (
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <MetricCard label="Exams monitored" value={monitored} icon={<IntegrityIcon className="h-[18px] w-[18px]" />} />
          <MetricCard label="Exams with signals" value={withSignals.length} accent={withSignals.length > 0 ? "warning" : "neutral"} icon={<IntegrityIcon className="h-[18px] w-[18px]" />} />
          <MetricCard label="Signals awaiting review" value={totalSignals} accent={totalSignals > 0 ? "warning" : "neutral"} icon={<IntegrityIcon className="h-[18px] w-[18px]" />} />
        </div>
      )}

      <div className="mt-5">
        {!exams && !error && <LoadingState label="Loading integrity signals…" />}
        {error && <ErrorState message={error} />}
        {exams && withSignals.length === 0 && <EmptyState title="No signals awaiting review" description="Every exam is currently clear — new signals will appear here as they occur." />}
        {withSignals.length > 0 && (
          <SectionCard accent="warning" padded={false}>
            <ul className="divide-y divide-lecturer-border">
              {withSignals.map((exam) => {
                const status = lecturerAvailabilityStatus(exam);
                return (
                  <li key={exam.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-lecturer-text-primary">{exam.title}</p>
                      {exam.course && <p className="truncate text-xs text-lecturer-text-secondary">{exam.course.code} — {exam.course.name}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <StatusBadge tone={availabilityToneFor(status)}>{status}</StatusBadge>
                      <StatusBadge tone="neutral">{exam.needsReviewCount} signal{exam.needsReviewCount === 1 ? "" : "s"}</StatusBadge>
                      <Link href={`/lecturer/exams/${exam.id}/integrity`} className="text-sm font-semibold text-lecturer-accent hover:text-lecturer-accent-hover">
                        Review →
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          </SectionCard>
        )}
      </div>
    </div>
  );
}
