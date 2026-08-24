"use client";

// Lecturer application shell v1 — top-level "Submissions" nav
// destination. Submissions are graded per-exam
// (/lecturer/exams/[id]/submissions); this index reuses the same
// GET /api/exams?all=true endpoint the dashboard already calls to let a
// lecturer pick which exam's submissions to review, without inventing a
// new cross-exam submissions API.
import { useEffect, useState } from "react";
import Link from "next/link";
import { lecturerAvailabilityStatus } from "@/lib/lecturerDashboardGrouping";
import { LecturerPageHeader } from "@/components/lecturer/LecturerPageHeader";
import { MetricCard } from "@/components/lecturer/MetricCard";
import { StatusBadge, availabilityToneFor } from "@/components/lecturer/StatusBadge";
import { EmptyState, ErrorState, LoadingState } from "@/components/lecturer/EmptyState";
import { Table, TableWrap, Tbody, Td, Th, Thead, Tr } from "@/components/lecturer/Table";
import { SubmissionsIcon, IntegrityIcon } from "@/components/lecturer/icons";

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

export default function LecturerSubmissionsIndexPage() {
  const [exams, setExams] = useState<ExamSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/exams?all=true")
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((rows: ExamSummary[]) => setExams(rows.filter((exam) => exam._count.submissions > 0)))
      .catch(() => setError("Could not load submissions — check your connection and try refreshing the page."));
  }, []);

  const totalSubmissions = exams?.reduce((sum, exam) => sum + exam._count.submissions, 0) ?? 0;
  const totalNeedsReview = exams?.reduce((sum, exam) => sum + exam.needsReviewCount, 0) ?? 0;

  return (
    <div className="mx-auto max-w-6xl">
      <LecturerPageHeader breadcrumbs={[{ label: "Dashboard", href: "/lecturer" }, { label: "Submissions" }]} title="Submissions" description="Review student submissions by exam." />

      {exams && exams.length > 0 && (
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <MetricCard label="Exams with submissions" value={exams.length} icon={<SubmissionsIcon className="h-3.5 w-3.5" />} />
          <MetricCard label="Total submissions" value={totalSubmissions} accent="info" icon={<SubmissionsIcon className="h-3.5 w-3.5" />} />
          <MetricCard label="Needs review" value={totalNeedsReview} accent={totalNeedsReview > 0 ? "warning" : "neutral"} icon={<IntegrityIcon className="h-3.5 w-3.5" />} />
        </div>
      )}

      <div className="mt-4">
        {!exams && !error && <LoadingState label="Loading submissions…" />}
        {error && <ErrorState message={error} />}
        {exams && exams.length === 0 && <EmptyState title="No submissions yet" description="Submissions will appear here once students start taking your exams." />}
        {exams && exams.length > 0 && (
          <TableWrap>
            <Table>
              <Thead>
                <Tr>
                  <Th>Exam / course</Th>
                  <Th>Status</Th>
                  <Th>Submissions</Th>
                  <Th>Needs review</Th>
                  <Th className="text-right">Action</Th>
                </Tr>
              </Thead>
              <Tbody>
                {exams.map((exam) => {
                  const status = lecturerAvailabilityStatus(exam);
                  return (
                    <Tr key={exam.id}>
                      <Td>
                        <p className="font-medium text-lecturer-text-primary">{exam.title}</p>
                        {exam.course && <p className="text-xs text-lecturer-text-secondary">{exam.course.code} — {exam.course.name}</p>}
                      </Td>
                      <Td>
                        <StatusBadge tone={availabilityToneFor(status)}>{status}</StatusBadge>
                      </Td>
                      <Td>{exam._count.submissions}</Td>
                      <Td>{exam.needsReviewCount > 0 ? <StatusBadge tone="warning">{exam.needsReviewCount}</StatusBadge> : <span className="text-lecturer-text-muted">—</span>}</Td>
                      <Td className="text-right">
                        <Link href={`/lecturer/exams/${exam.id}/submissions`} className="text-sm font-semibold text-lecturer-accent hover:text-lecturer-accent-hover">
                          Review submissions →
                        </Link>
                      </Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
          </TableWrap>
        )}
      </div>
    </div>
  );
}
