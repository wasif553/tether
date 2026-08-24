"use client";

import { useEffect, useState } from "react";
import { LecturerPageHeader } from "@/components/lecturer/LecturerPageHeader";
import { EmptyState, LoadingState } from "@/components/lecturer/EmptyState";

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
    <div className="mx-auto max-w-4xl">
      <LecturerPageHeader
        breadcrumbs={[{ label: "Dashboard", href: "/lecturer" }, { label: "Canvas / LTI", href: "/lecturer/settings/lti" }, { label: "Unmatched launches" }]}
        title="Unmatched Canvas Launches"
        description="Recent Canvas launches that didn't match any Tether exam. Link each one to an exam so future launches for that Canvas assignment route correctly."
      />

      {message && <p className="mt-3 text-sm text-lecturer-text-primary">{message}</p>}

      <div className="mt-6 space-y-3">
        {loading && <LoadingState label="Loading unmatched launches…" />}
        {!loading && launches.length === 0 && <EmptyState title="No unmatched launches right now" />}
        {launches.map((l) => (
          <div key={l.id} className="rounded-xl border border-lecturer-border bg-lecturer-surface p-4 text-sm">
            <div className="flex flex-wrap gap-4 text-lecturer-text-secondary">
              <span>Launched: {new Date(l.createdAt).toLocaleString()}</span>
              <span>Platform: {l.platformIssuer}</span>
              <span>Role: {l.launchRole ?? "Unknown"}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-4 text-lecturer-text-muted">
              <span>Resource link ID: {l.resourceLinkId}</span>
              {l.deploymentId && <span>Deployment ID: {l.deploymentId}</span>}
              {l.canvasCourseId && <span>Course ID: {l.canvasCourseId}</span>}
              {l.canvasAssignmentId && <span>Assignment ID: {l.canvasAssignmentId}</span>}
              <span>User: {l.subject}</span>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <select
                className="rounded-lg border border-lecturer-border px-2 py-1.5 text-sm text-lecturer-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                value={selectedExamId[l.id] ?? ""}
                onChange={(e) => setSelectedExamId({ ...selectedExamId, [l.id]: e.target.value })}
              >
                <option value="">Select an exam…</option>
                {exams.map((exam) => (
                  <option key={exam.id} value={exam.id}>
                    {exam.title}
                  </option>
                ))}
              </select>
              <button
                onClick={() => handleLink(l.id)}
                disabled={linkingId === l.id || !selectedExamId[l.id]}
                className="rounded-lg bg-lecturer-accent px-3 py-1.5 text-sm font-semibold text-white hover:bg-lecturer-accent-hover disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent focus-visible:ring-offset-2"
              >
                {linkingId === l.id ? "Linking…" : "Link to exam"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
