"use client";

// Lecturer application shell v1 — top-level "Exams" nav destination.
// No dedicated exam-index API existed before this redesign; this reuses
// the SAME GET /api/exams?all=true endpoint the dashboard already calls
// (see src/app/lecturer/page.tsx) rather than inventing a new one, and
// adds a purely client-side status filter so lecturers can distinguish
// Draft/Scheduled/Open/Closed/Needs review at a glance.
//
// Exam Archive Lifecycle v1 — see docs/exam-archive-lifecycle-v1.md. The
// default view is "All current", which excludes archived exams because
// GET /api/exams already excludes them server-side. "Archived" is a
// SEPARATE, explicit filter that lazily fetches GET /api/exams?archived=true
// (only archived exams) — never merged into the default list, so an
// archived exam can only ever appear here behind that one deliberate click.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { lecturerAvailabilityStatus, type LecturerAvailabilityStatus } from "@/lib/lecturerDashboardGrouping";
import { LecturerPageHeader, PrimaryLinkButton } from "@/components/lecturer/LecturerPageHeader";
import { StatusBadge, availabilityToneFor } from "@/components/lecturer/StatusBadge";
import { EmptyState, ErrorState, LoadingState } from "@/components/lecturer/EmptyState";
import { Table, TableWrap, Tbody, Td, Th, Thead, Tr } from "@/components/lecturer/Table";
import { ExamActionsMenu, RestoreExamButton } from "@/components/lecturer/ExamActionsMenu";

type ExamSummary = {
  id: string;
  title: string;
  published: boolean;
  durationMins: number;
  availableFrom: string | null;
  availableUntil: string | null;
  archivedAt: string | null;
  course: { id: string; name: string; code: string } | null;
  _count: { questions: number; submissions: number };
  needsReviewCount: number;
};

type FilterValue = "all" | LecturerAvailabilityStatus | "NeedsReview" | "Archived";
const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "all", label: "All current" },
  { value: "NeedsReview", label: "Needs review" },
  { value: "Open", label: "Open" },
  { value: "Scheduled", label: "Scheduled" },
  { value: "Draft", label: "Draft" },
  { value: "Closed", label: "Closed" },
  { value: "Archived", label: "Archived" },
];

export default function LecturerExamsIndexPage() {
  const [exams, setExams] = useState<ExamSummary[] | null>(null);
  const [archivedExams, setArchivedExams] = useState<ExamSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterValue>("all");

  function loadCurrent() {
    fetch("/api/exams?all=true")
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((rows: ExamSummary[]) => setExams(rows))
      .catch(() => setError("Could not load exams — check your connection and try refreshing the page."));
  }

  function loadArchived() {
    fetch("/api/exams?archived=true")
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((rows: ExamSummary[]) => setArchivedExams(rows))
      .catch(() => setError("Could not load archived exams — check your connection and try refreshing the page."));
  }

  useEffect(() => {
    loadCurrent();
  }, []);

  useEffect(() => {
    if (filter === "Archived" && archivedExams === null) loadArchived();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const isArchivedView = filter === "Archived";

  const filtered = useMemo(() => {
    if (isArchivedView) return archivedExams ?? [];
    if (!exams) return [];
    if (filter === "all") return exams;
    if (filter === "NeedsReview") return exams.filter((exam) => exam.needsReviewCount > 0);
    return exams.filter((exam) => lecturerAvailabilityStatus(exam) === filter);
  }, [exams, archivedExams, filter, isArchivedView]);

  const loading = isArchivedView ? archivedExams === null && !error : exams === null && !error;

  return (
    <div className="mx-auto max-w-6xl">
      <LecturerPageHeader
        breadcrumbs={[{ label: "Dashboard", href: "/lecturer" }, { label: "Exams" }]}
        title="Exams"
        description="Every exam across your courses, in one place."
        actions={<PrimaryLinkButton href="/lecturer">Create exam</PrimaryLinkButton>}
      />

      {exams && exams.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent ${
                filter === f.value ? "bg-lecturer-accent text-white" : "bg-lecturer-surface text-lecturer-text-secondary hover:bg-lecturer-border-subtle"
              } border border-lecturer-border`}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      <div className="mt-4">
        {loading && <LoadingState label={isArchivedView ? "Loading archived exams…" : "Loading exams…"} />}
        {error && <ErrorState message={error} />}
        {!loading && exams && exams.length === 0 && !isArchivedView && (
          <EmptyState title="No exams yet" description="Create your first exam from the dashboard." action={<PrimaryLinkButton href="/lecturer">Create exam</PrimaryLinkButton>} />
        )}
        {!loading && filtered.length === 0 && !(exams && exams.length === 0 && !isArchivedView) && (
          <EmptyState title={isArchivedView ? "No archived exams" : "No exams match this filter"} description={isArchivedView ? "Exams you archive will appear here, fully restorable." : undefined} />
        )}
        {filtered.length > 0 && (
          <TableWrap>
            <Table>
              <Thead>
                <Tr>
                  <Th>Exam / course</Th>
                  <Th>{isArchivedView ? "Archived" : "Status"}</Th>
                  <Th>Questions</Th>
                  <Th>Submissions</Th>
                  <Th>Signals</Th>
                  <Th className="text-right">Action</Th>
                </Tr>
              </Thead>
              <Tbody>
                {filtered.map((exam) => {
                  const status = lecturerAvailabilityStatus(exam);
                  const href = `/lecturer/exams/${exam.id}`;
                  return (
                    <Tr key={exam.id}>
                      <Td>
                        <Link href={href} className="font-medium text-lecturer-text-primary hover:text-lecturer-accent hover:underline">
                          {exam.title}
                        </Link>
                        {exam.course && <p className="text-xs text-lecturer-text-secondary">{exam.course.code} — {exam.course.name}</p>}
                      </Td>
                      <Td>
                        {isArchivedView ? (
                          <StatusBadge tone="neutral">{exam.archivedAt ? new Date(exam.archivedAt).toLocaleDateString() : "Archived"}</StatusBadge>
                        ) : (
                          <StatusBadge tone={availabilityToneFor(status)}>{status}</StatusBadge>
                        )}
                      </Td>
                      <Td>{exam._count.questions}</Td>
                      <Td>{exam._count.submissions}</Td>
                      <Td>{exam.needsReviewCount > 0 ? <StatusBadge tone="neutral">{exam.needsReviewCount}</StatusBadge> : <span className="text-lecturer-text-muted">—</span>}</Td>
                      <Td className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          {/* Archived rows: Restore is the primary action (per design brief), View is secondary/quieter — both still reachable from the ••• menu too. */}
                          {isArchivedView && (
                            <RestoreExamButton
                              examId={exam.id}
                              examTitle={exam.title}
                              onChanged={() => {
                                setArchivedExams(null);
                                loadArchived();
                              }}
                            />
                          )}
                          <Link href={href} className={isArchivedView ? "text-sm font-medium text-lecturer-text-secondary hover:text-lecturer-text-primary" : "text-sm font-semibold text-lecturer-accent hover:text-lecturer-accent-hover"}>
                            {isArchivedView ? "View" : "Open →"}
                          </Link>
                          <ExamActionsMenu
                            examId={exam.id}
                            examTitle={exam.title}
                            archived={isArchivedView}
                            deletable={!exam.published && exam._count.submissions === 0}
                            href={href}
                            onChanged={() => {
                              if (isArchivedView) {
                                setArchivedExams(null);
                                loadArchived();
                              } else {
                                loadCurrent();
                              }
                            }}
                          />
                        </div>
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
