"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { lecturerAvailabilityStatus, lecturerDashboardGroup } from "@/lib/lecturerDashboardGrouping";

type ExamSummary = {
  id: string;
  title: string;
  published: boolean;
  durationMins: number;
  availableFrom: string | null;
  availableUntil: string | null;
  course: { id: string; name: string; code: string } | null;
  _count: { questions: number; submissions: number };
  needsReviewCount: number;
};

// Pilot UI release readiness v1 — see
// docs/tether-v1.7.2-pilot-release-readiness.md. Draft/Scheduled/Open/
// Closed and the mutually-exclusive dashboard grouping both come from
// src/lib/lecturerDashboardGrouping.ts — the SAME functions
// src/app/api/exams/route.ts uses for server-side closed-history
// capping, so an exam can never be capped out of the response while
// still shown as actionable here (or vice versa). The "closed" group it
// returns is split further below, by recency only, into the small
// headline slice and the collapsed history tail. Summary tiles above
// remain independent counts, not display-group sizes.
const RECENT_CLOSED_LIMIT = 5;

export default function LecturerDashboard() {
  const [exams, setExams] = useState<ExamSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [durationMins, setDurationMins] = useState(60);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAllClosed, setShowAllClosed] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  async function loadExams(all = false) {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(all ? "/api/exams?all=true" : "/api/exams");
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setLoadError(
          typeof body?.error === "string"
            ? body.error
            : `Could not load your exams (status ${res.status}). Try refreshing the page.`,
        );
        return;
      }
      setExams(await res.json());
    } catch {
      setLoadError("Could not load your exams — check your connection and try refreshing the page.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadExams();
  }, []);

  function loadFullHistory() {
    setLoadingHistory(true);
    loadExams(true).finally(() => {
      setShowAllClosed(true);
      setLoadingHistory(false);
    });
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);

    const res = await fetch("/api/exams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, durationMins }),
    });

    setCreating(false);

    if (!res.ok) {
      setError("Failed to create exam");
      return;
    }

    setTitle("");
    setDurationMins(60);
    await loadExams(showAllClosed);
  }

  const { summary, needsAttention, active, upcoming, draft, recentlyClosed, olderClosed } = useMemo(() => {
    const grouped: Record<ReturnType<typeof lecturerDashboardGroup>, ExamSummary[]> = {
      needsAttention: [],
      active: [],
      upcoming: [],
      draft: [],
      closed: [],
    };
    for (const exam of exams) grouped[lecturerDashboardGroup(exam)].push(exam);

    grouped.upcoming.sort((a, b) => new Date(a.availableFrom ?? 0).getTime() - new Date(b.availableFrom ?? 0).getTime());
    grouped.closed.sort((a, b) => new Date(b.availableUntil ?? 0).getTime() - new Date(a.availableUntil ?? 0).getTime());

    const closedAll = grouped.closed;
    const recentSlice = closedAll.slice(0, RECENT_CLOSED_LIMIT);
    const olderSlice = closedAll.slice(RECENT_CLOSED_LIMIT);

    // Summary tiles are independent counts across ALL loaded exams
    // (not display-group sizes) — "Active"/"Upcoming" here count every
    // matching exam regardless of whether it's also flagged in Needs
    // Attention, since the tile answers "how many are open right now",
    // not "how many cards are in the Active section below".
    const summaryCounts = {
      active: exams.filter((exam) => lecturerAvailabilityStatus(exam) === "Open").length,
      upcoming: exams.filter((exam) => lecturerAvailabilityStatus(exam) === "Scheduled").length,
      needsReview: exams.filter((exam) => exam.needsReviewCount > 0).length,
      drafts: exams.filter((exam) => lecturerAvailabilityStatus(exam) === "Draft").length,
    };

    return {
      summary: summaryCounts,
      needsAttention: grouped.needsAttention,
      active: grouped.active,
      upcoming: grouped.upcoming,
      draft: grouped.draft,
      recentlyClosed: recentSlice,
      olderClosed: olderSlice,
    };
  }, [exams]);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Lecturer Dashboard</h1>
        <Link href="/lecturer/courses" className="text-sm underline">
          Manage courses
        </Link>
      </div>

      {!loading && !loadError && exams.length > 0 && (
        <div className="mt-4 grid grid-cols-4 gap-2">
          <SummaryTile label="Active" value={summary.active} />
          <SummaryTile label="Upcoming" value={summary.upcoming} />
          <SummaryTile label="Needs review" value={summary.needsReview} highlight={summary.needsReview > 0} />
          <SummaryTile label="Drafts" value={summary.drafts} />
        </div>
      )}

      <form onSubmit={handleCreate} className="mt-6 flex items-end gap-3 rounded border border-gray-200 p-4">
        <div className="flex-1">
          <label className="block text-sm font-medium">Exam title</label>
          <input
            required
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="w-32">
          <label className="block text-sm font-medium">Duration (min)</label>
          <input
            required
            type="number"
            min={1}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            value={durationMins}
            onChange={(e) => setDurationMins(Number(e.target.value))}
          />
        </div>
        <button
          type="submit"
          disabled={creating}
          className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {creating ? "Creating..." : "New exam"}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-6 space-y-8">
        {loading && <p className="text-gray-500">Loading exams...</p>}
        {!loading && loadError && (
          <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <p>{loadError}</p>
            <button onClick={() => loadExams(showAllClosed)} className="mt-2 text-sm underline">
              Try again
            </button>
          </div>
        )}
        {!loading && !loadError && exams.length === 0 && (
          <p className="text-gray-500">No exams yet. Create one above.</p>
        )}

        {needsAttention.length > 0 && (
          <ExamGroupSection title="Needs your attention" exams={needsAttention}>
            {(exam) => (
              <Link href={`/lecturer/exams/${exam.id}/integrity`} className="block rounded border border-amber-300 bg-amber-50 p-4 hover:border-amber-400">
                <ExamCardBody exam={exam} />
                <span className="mt-2 inline-block rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                  {exam.needsReviewCount} integrity {exam.needsReviewCount === 1 ? "signal needs" : "signals need"} review
                </span>
              </Link>
            )}
          </ExamGroupSection>
        )}

        {active.length > 0 && (
          <ExamGroupSection title="Active" exams={active}>
            {(exam) => (
              <ExamCard exam={exam}>
                <StatusPill exam={exam} />
              </ExamCard>
            )}
          </ExamGroupSection>
        )}

        {upcoming.length > 0 && (
          <ExamGroupSection title="Upcoming" exams={upcoming}>
            {(exam) => (
              <ExamCard exam={exam}>
                <StatusPill exam={exam} />
              </ExamCard>
            )}
          </ExamGroupSection>
        )}

        {draft.length > 0 && (
          <ExamGroupSection title="Drafts" exams={draft} secondary>
            {(exam) => (
              <ExamCard exam={exam} secondary>
                <StatusPill exam={exam} />
              </ExamCard>
            )}
          </ExamGroupSection>
        )}

        {recentlyClosed.length > 0 && (
          <ExamGroupSection title="Recent examinations" exams={recentlyClosed} secondary>
            {(exam) => (
              <ExamCard exam={exam} secondary>
                <StatusPill exam={exam} />
              </ExamCard>
            )}
          </ExamGroupSection>
        )}

        {(olderClosed.length > 0 || (!showAllClosed && recentlyClosed.length >= RECENT_CLOSED_LIMIT)) && (
          <div>
            {!showAllClosed ? (
              <button type="button" onClick={loadFullHistory} disabled={loadingHistory} className="text-sm text-gray-600 underline disabled:opacity-50">
                {loadingHistory ? "Loading…" : "Show all older examinations"}
              </button>
            ) : (
              olderClosed.length > 0 && (
                <ExamGroupSection title="Older examinations" exams={olderClosed} secondary>
                  {(exam) => (
                    <ExamCard exam={exam} secondary>
                      <StatusPill exam={exam} />
                    </ExamCard>
                  )}
                </ExamGroupSection>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryTile({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 text-center ${highlight ? "border-amber-300 bg-amber-50" : "border-gray-200"}`}>
      <div className={`text-xl font-semibold ${highlight ? "text-amber-800" : ""}`}>{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

function StatusPill({ exam }: { exam: ExamSummary }) {
  return <span className="mt-1 inline-block rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700">{lecturerAvailabilityStatus(exam)}</span>;
}

function ExamGroupSection({
  title,
  exams,
  secondary,
  children,
}: {
  title: string;
  exams: ExamSummary[];
  secondary?: boolean;
  children: (exam: ExamSummary) => React.ReactNode;
}) {
  return (
    <section>
      <h2 className={secondary ? "text-sm font-medium text-gray-500" : "text-sm font-semibold uppercase tracking-wide text-gray-700"}>{title}</h2>
      <div className="mt-2 space-y-2">
        {exams.map((exam) => (
          <div key={exam.id}>{children(exam)}</div>
        ))}
      </div>
    </section>
  );
}

// Essential fields only (title, course, submission/review counts already
// cheaply available from the single aggregate query, one status pill) —
// no per-exam extra DB round trip. `secondary` visually de-emphasizes
// drafts/closed exams.
function ExamCard({ exam, secondary, children }: { exam: ExamSummary; secondary?: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={`/lecturer/exams/${exam.id}`}
      className={secondary ? "block rounded border border-gray-100 bg-gray-50 p-3 hover:border-gray-300" : "block rounded border border-gray-200 p-4 hover:border-gray-400"}
    >
      <ExamCardBody exam={exam} secondary={secondary} />
      {children}
    </Link>
  );
}

function ExamCardBody({ exam, secondary }: { exam: ExamSummary; secondary?: boolean }) {
  return (
    <>
      <span className={secondary ? "text-sm font-medium text-gray-700" : "font-medium"}>{exam.title}</span>
      <p className="mt-1 text-sm text-gray-500">
        {exam._count.questions} questions · {exam.durationMins} min · {exam._count.submissions} submissions
        {exam.course && ` · ${exam.course.code} — ${exam.course.name}`}
      </p>
    </>
  );
}
