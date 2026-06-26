"use client";

import { useEffect, useState } from "react";

type UnmatchedLaunch = {
  id: string;
  createdAt: string;
  platformId: string;
  platformIssuer: string;
  resourceLinkId: string | null;
  deploymentId: string | null;
  canvasCourseId: string | null;
  canvasAssignmentId: string | null;
  launchRole: string | null;
  subject: string;
  status: string;
};

type ExamOption = { id: string; title: string };

export default function UnmatchedLaunchesPage() {
  const [launches, setLaunches] = useState<UnmatchedLaunch[]>([]);
  const [exams, setExams] = useState<ExamOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [selectedExamId, setSelectedExamId] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const [launchesRes, examsRes] = await Promise.all([
      fetch("/api/lecturer/lti/unmatched-launches"),
      fetch("/api/exams"),
    ]);
    if (launchesRes.ok) setLaunches(await launchesRes.json());
    if (examsRes.ok) setExams(await examsRes.json());
    setLoading(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  async function handleLink(launchId: string) {
    const examId = selectedExamId[launchId];
    if (!examId) return;

    setLinkingId(launchId);
    setMessage(null);

    const res = await fetch(`/api/lecturer/lti/unmatched-launches/${launchId}/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ examId }),
    });

    setLinkingId(null);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMessage(typeof data.error === "string" ? data.error : "Failed to link this launch");
      return;
    }

    setMessage("Linked. Future launches for this Canvas resource will route to that exam.");
    await load();
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">Unmatched Canvas Launches</h1>
      <p className="mt-1 text-sm text-gray-500">
        These are recent Canvas launches that didn&apos;t match any SES exam. Link each one to an
        exam so future launches for that Canvas assignment route correctly.
      </p>

      {message && <p className="mt-3 text-sm text-gray-600">{message}</p>}

      <div className="mt-6 space-y-3">
        {loading && <p className="text-gray-500">Loading...</p>}
        {!loading && launches.length === 0 && (
          <p className="text-gray-500">No unmatched launches right now.</p>
        )}
        {launches.map((l) => (
          <div key={l.id} className="rounded border border-gray-200 p-4 text-sm">
            <div className="flex flex-wrap gap-4 text-gray-600">
              <span>Launched: {new Date(l.createdAt).toLocaleString()}</span>
              <span>Platform: {l.platformIssuer}</span>
              <span>Role: {l.launchRole ?? "Unknown"}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-4 text-gray-500">
              <span>Resource link ID: {l.resourceLinkId}</span>
              {l.deploymentId && <span>Deployment ID: {l.deploymentId}</span>}
              {l.canvasCourseId && <span>Course ID: {l.canvasCourseId}</span>}
              {l.canvasAssignmentId && <span>Assignment ID: {l.canvasAssignmentId}</span>}
              <span>User: {l.subject}</span>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <select
                className="rounded border border-gray-300 px-2 py-1 text-sm"
                value={selectedExamId[l.id] ?? ""}
                onChange={(e) => setSelectedExamId({ ...selectedExamId, [l.id]: e.target.value })}
              >
                <option value="">Select an exam...</option>
                {exams.map((exam) => (
                  <option key={exam.id} value={exam.id}>
                    {exam.title}
                  </option>
                ))}
              </select>
              <button
                onClick={() => handleLink(l.id)}
                disabled={linkingId === l.id || !selectedExamId[l.id]}
                className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                {linkingId === l.id ? "Linking..." : "Link to exam"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
