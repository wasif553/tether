"use client";

import { useEffect, useState, use as usePromise } from "react";

type Enrollment = {
  id: string;
  role: "STUDENT" | "LECTURER";
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    institutionStudentId: string | null;
  };
};

type CourseDetail = {
  id: string;
  name: string;
  code: string;
  description: string | null;
  enrollments: Enrollment[];
};

export default function CourseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    fetch(`/api/courses/${id}`)
      .then((res) => res.json())
      .then(setCourse)
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [id]);

  async function enrolStudent() {
    setEnrolling(true);
    setError(null);
    const res = await fetch(`/api/courses/${id}/enrolments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, role: "STUDENT" }),
    });
    setEnrolling(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(typeof body?.error === "string" ? body.error : "Failed to enrol student.");
      return;
    }
    setEmail("");
    load();
  }

  async function removeEnrolment(userId: string) {
    await fetch(`/api/courses/${id}/enrolments/${userId}`, { method: "DELETE" });
    load();
  }

  if (loading) return <p className="text-gray-500">Loading...</p>;
  if (!course) return <p className="text-red-600">Course not found.</p>;

  const students = course.enrollments.filter((e) => e.role === "STUDENT");
  const lecturers = course.enrollments.filter((e) => e.role === "LECTURER");

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">
        {course.code} — {course.name}
      </h1>
      {course.description && <p className="mt-1 text-gray-600">{course.description}</p>}

      <div className="mt-6 rounded border border-gray-200 p-4">
        <h2 className="font-medium">Enrol a student</h2>
        <p className="mt-1 text-sm text-gray-500">
          The student must already have an account in your institution.
        </p>
        <div className="mt-3 flex items-end gap-2">
          <input
            type="email"
            placeholder="student@example.com"
            className="flex-1 rounded border border-gray-300 px-3 py-1.5 text-sm"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button
            onClick={enrolStudent}
            disabled={enrolling || !email.trim()}
            className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {enrolling ? "Enrolling..." : "Enrol"}
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>

      <h2 className="mt-6 text-lg font-medium">Lecturers ({lecturers.length})</h2>
      <div className="mt-2 space-y-2">
        {lecturers.map((e) => (
          <div key={e.id} className="rounded border border-gray-200 p-3 text-sm">
            {e.user.name} — {e.user.email}
          </div>
        ))}
      </div>

      <h2 className="mt-6 text-lg font-medium">Students ({students.length})</h2>
      <div className="mt-2 space-y-2">
        {students.length === 0 && <p className="text-gray-500">No students enrolled yet.</p>}
        {students.map((e) => (
          <div
            key={e.id}
            className="flex items-center justify-between rounded border border-gray-200 p-3 text-sm"
          >
            <span>
              {e.user.name} — {e.user.email}
              {e.user.institutionStudentId && (
                <span className="text-gray-500"> · ID: {e.user.institutionStudentId}</span>
              )}
            </span>
            <button
              onClick={() => removeEnrolment(e.user.id)}
              className="text-xs text-red-600 underline"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
