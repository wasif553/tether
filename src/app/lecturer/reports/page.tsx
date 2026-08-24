"use client";

// Lecturer application shell v1 — top-level "Reports" nav destination.
// Per design brief, Reports serves analytical/export workflows (not a
// duplicate of Integrity Signals); the actual analytics content lives
// at the existing per-exam route (/lecturer/exams/[id]/analytics). This
// index reuses the same GET /api/exams?all=true endpoint the dashboard
// already calls so a lecturer can pick which exam's report to open,
// without inventing a new cross-exam analytics API.
import { useEffect, useState } from "react";
import Link from "next/link";
import { lecturerAvailabilityStatus } from "@/lib/lecturerDashboardGrouping";
import { LecturerPageHeader } from "@/components/lecturer/LecturerPageHeader";
import { EmptyState, ErrorState, LoadingState } from "@/components/lecturer/EmptyState";
import { StatusBadge, availabilityToneFor } from "@/components/lecturer/StatusBadge";
import { Table, TableWrap, Tbody, Td, Th, Thead, Tr } from "@/components/lecturer/Table";

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

export default function LecturerReportsIndexPage() {
  const [exams, setExams] = useState<ExamSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/exams?all=true")
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((rows: ExamSummary[]) => setExams(rows.filter((exam) => exam._count.submissions > 0)))
      .catch(() => setError("Could not load reports — check your connection and try refreshing the page."));
  }, []);

  return (
    <div className="mx-auto max-w-6xl">
      <LecturerPageHeader
        breadcrumbs={[{ label: "Dashboard", href: "/lecturer" }, { label: "Reports" }]}
        title="Reports"
        description="Participation, score distribution and question performance, by exam."
      />

      <div className="mt-5">
        {!exams && !error && <LoadingState label="Loading reports…" />}
        {error && <ErrorState message={error} />}
        {exams && exams.length === 0 && <EmptyState title="No reports available yet" description="Reports appear here once an exam has at least one submission." />}
        {exams && exams.length > 0 && (
          <TableWrap>
            <Table>
              <Thead>
                <Tr>
                  <Th>Exam / course</Th>
                  <Th>Status</Th>
                  <Th>Submissions</Th>
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
                      <Td className="text-right">
                        <Link href={`/lecturer/exams/${exam.id}/analytics`} className="text-sm font-semibold text-lecturer-accent hover:text-lecturer-accent-hover">
                          View report →
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
