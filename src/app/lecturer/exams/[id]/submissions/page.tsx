"use client";

import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";

type SubmissionRow = {
  id: string;
  status: "IN_PROGRESS" | "SUBMITTED" | "GRADED";
  totalScore: number | null;
  startedAt: string;
  submittedAt: string | null;
  student: { id: string; name: string; email: string };
};

export default function SubmissionsListPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);
  const [submissions, setSubmissions] = useState<SubmissionRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/exams/${id}/submissions`)
      .then((res) => res.json())
      .then(setSubmissions)
      .finally(() => setLoading(false));
  }, [id]);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">Submissions</h1>

      <div className="mt-6 space-y-3">
        {loading && <p className="text-gray-500">Loading...</p>}
        {!loading && submissions.length === 0 && (
          <p className="text-gray-500">No submissions yet.</p>
        )}
        {submissions.map((s) => (
          <div
            key={s.id}
            className="flex items-center justify-between rounded border border-gray-200 p-4"
          >
            <div>
              <p className="font-medium">{s.student.name}</p>
              <p className="text-sm text-gray-500">{s.student.email}</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-500">
                {s.status === "GRADED" ? `Score: ${s.totalScore}` : s.status}
              </span>
              {s.status !== "IN_PROGRESS" && (
                <Link
                  href={`/lecturer/exams/${id}/submissions/${s.id}`}
                  className="rounded bg-black px-3 py-1.5 text-sm text-white"
                >
                  {s.status === "GRADED" ? "Review" : "Grade"}
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
