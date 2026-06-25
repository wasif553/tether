"use client";

import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";

type IntegrityEventRow = {
  id: string;
  submissionId: string;
  eventType: string;
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH";
  message: string;
  occurredAt: string;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolutionNote: string | null;
  student: { id: string; name: string; email: string };
  submissionStatus: string;
};

type StudentGroup = {
  studentId: string;
  studentName: string;
  studentEmail: string;
  submissionId: string;
  submissionStatus: string;
  eventCount: number;
  severityCounts: Record<string, number>;
};

type IntegrityData = {
  events: IntegrityEventRow[];
  studentGroups: StudentGroup[];
  severityCounts: Record<string, number>;
};

function severityBadge(severity: string) {
  const styles: Record<string, string> = {
    HIGH: "bg-red-100 text-red-700",
    MEDIUM: "bg-yellow-100 text-yellow-700",
    LOW: "bg-blue-100 text-blue-700",
    INFO: "bg-gray-100 text-gray-600",
  };
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${styles[severity] ?? styles.INFO}`}>
      {severity}
    </span>
  );
}

export default function ExamIntegrityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);

  const [examTitle, setExamTitle] = useState<string | null>(null);
  const [data, setData] = useState<IntegrityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeNoteEventId, setActiveNoteEventId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);

    const [examRes, eventsRes] = await Promise.all([
      fetch(`/api/exams/${id}`),
      fetch(`/api/lecturer/exams/${id}/integrity-events`),
    ]);

    if (examRes.ok) {
      const exam = await examRes.json();
      setExamTitle(exam.title);
    }

    if (!eventsRes.ok) {
      setError(
        eventsRes.status === 403
          ? "You don't have access to this exam's integrity events."
          : "Failed to load integrity events.",
      );
      setLoading(false);
      return;
    }

    setData(await eventsRes.json());
    setLoading(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [id]);

  async function handleResolve(eventId: string) {
    if (!noteText.trim()) return;
    setSaving(true);
    const res = await fetch(`/api/lecturer/integrity-events/${eventId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolutionNote: noteText.trim() }),
    });
    setSaving(false);
    if (res.ok) {
      setActiveNoteEventId(null);
      setNoteText("");
      await load();
    }
  }

  if (loading) return <p className="text-gray-500">Loading integrity events...</p>;
  if (error) return <p className="text-red-600">{error}</p>;
  if (!data) return <p className="text-red-600">No data available.</p>;

  const totalEvents = data.events.length;
  const highSeverityEvents = data.severityCounts.HIGH ?? 0;
  const studentsWithEvents = data.studentGroups.length;
  const unresolvedEvents = data.events.filter((e) => !e.resolvedAt).length;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{examTitle ?? "Exam"} — Integrity events</h1>
        <div className="flex gap-2">
          <a
            href={`/api/lecturer/exams/${id}/integrity-events/export.csv`}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            Export CSV
          </a>
          <Link
            href={`/lecturer/exams/${id}/analytics`}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            View analytics
          </Link>
          <Link
            href={`/lecturer/exams/${id}`}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            Back to exam
          </Link>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard label="Total integrity events" value={String(totalEvents)} />
        <SummaryCard label="High severity events" value={String(highSeverityEvents)} />
        <SummaryCard label="Students with events" value={String(studentsWithEvents)} />
        <SummaryCard label="Unresolved events" value={String(unresolvedEvents)} />
      </div>

      <h2 className="mt-8 text-lg font-medium">Students with the most events</h2>
      <div className="mt-3 space-y-2">
        {data.studentGroups.length === 0 && (
          <p className="text-sm text-gray-500">No integrity events recorded</p>
        )}
        {data.studentGroups.slice(0, 5).map((g) => (
          <div
            key={g.studentId}
            className="flex items-center justify-between rounded border border-gray-200 p-3 text-sm"
          >
            <div>
              <p className="font-medium">{g.studentName}</p>
              <p className="text-gray-500">{g.studentEmail}</p>
            </div>
            <span className="text-gray-600">{g.eventCount} event(s)</span>
          </div>
        ))}
      </div>

      <h2 className="mt-8 text-lg font-medium">Event log</h2>
      <div className="mt-3 overflow-x-auto rounded border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-left">
              <th className="p-2">Time</th>
              <th className="p-2">Student</th>
              <th className="p-2">Event type</th>
              <th className="p-2">Severity</th>
              <th className="p-2">Message</th>
              <th className="p-2">Status</th>
              <th className="p-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {data.events.length === 0 && (
              <tr>
                <td colSpan={7} className="p-4 text-center text-gray-500">
                  No integrity events recorded
                </td>
              </tr>
            )}
            {data.events.map((e) => (
              <tr key={e.id} className="border-b border-gray-100 align-top">
                <td className="whitespace-nowrap p-2">
                  {new Date(e.occurredAt).toLocaleString()}
                </td>
                <td className="p-2">
                  <div>{e.student.name}</div>
                  <div className="text-xs text-gray-500">{e.student.email}</div>
                </td>
                <td className="p-2">{e.eventType}</td>
                <td className="p-2">{severityBadge(e.severity)}</td>
                <td className="max-w-xs p-2">{e.message}</td>
                <td className="p-2">
                  {e.resolvedAt ? (
                    <span className="text-green-700">
                      Reviewed{e.resolvedByName ? ` by ${e.resolvedByName}` : ""}
                    </span>
                  ) : (
                    <span className="text-gray-500">Review recommended</span>
                  )}
                  {e.resolutionNote && (
                    <p className="mt-1 text-xs text-gray-500">Note: {e.resolutionNote}</p>
                  )}
                </td>
                <td className="p-2">
                  {!e.resolvedAt &&
                    (activeNoteEventId === e.id ? (
                      <div className="flex flex-col gap-1">
                        <input
                          autoFocus
                          placeholder="Resolution note"
                          className="w-40 rounded border border-gray-300 px-2 py-1 text-xs"
                          value={noteText}
                          onChange={(ev) => setNoteText(ev.target.value)}
                        />
                        <div className="flex gap-1">
                          <button
                            onClick={() => handleResolve(e.id)}
                            disabled={saving || !noteText.trim()}
                            className="rounded bg-black px-2 py-1 text-xs text-white disabled:opacity-50"
                          >
                            Mark reviewed
                          </button>
                          <button
                            onClick={() => {
                              setActiveNoteEventId(null);
                              setNoteText("");
                            }}
                            className="rounded border border-gray-300 px-2 py-1 text-xs"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setActiveNoteEventId(e.id);
                          setNoteText("");
                        }}
                        className="text-xs underline"
                      >
                        Review event
                      </button>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
  );
}
