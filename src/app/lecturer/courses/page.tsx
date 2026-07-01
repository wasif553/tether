"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Course = {
  id: string;
  name: string;
  code: string;
  description: string | null;
  active: boolean;
  _count: { enrollments: number; exams: number };
};

export default function LecturerCoursesPage() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    fetch("/api/courses")
      .then((res) => res.json())
      .then(setCourses)
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  async function createCourse() {
    setCreating(true);
    setError(null);
    const res = await fetch("/api/courses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, code, description: description || undefined }),
    });
    setCreating(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(typeof body?.error === "string" ? body.error : "Failed to create course.");
      return;
    }
    setName("");
    setCode("");
    setDescription("");
    load();
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">My Courses</h1>
      <p className="mt-1 text-sm text-gray-500">
        Courses group students so you can assign exams to a whole class or to
        selected students.
      </p>

      <div className="mt-6 rounded border border-gray-200 p-4">
        <h2 className="font-medium">Create a course</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input
            type="text"
            placeholder="Course name (e.g. Intro to Databases)"
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            type="text"
            placeholder="Course code (e.g. CS201)"
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        <input
          type="text"
          placeholder="Description (optional)"
          className="mt-2 w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <button
          onClick={createCourse}
          disabled={creating || !name.trim() || !code.trim()}
          className="mt-3 rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {creating ? "Creating..." : "Create course"}
        </button>
      </div>

      <div className="mt-6 space-y-3">
        {loading && <p className="text-gray-500">Loading...</p>}
        {!loading && courses.length === 0 && (
          <p className="text-gray-500">No courses yet.</p>
        )}
        {courses.map((course) => (
          <Link
            key={course.id}
            href={`/lecturer/courses/${course.id}`}
            className="block rounded border border-gray-200 p-4 hover:bg-gray-50"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">
                {course.code} — {course.name}
              </span>
              <span className="text-sm text-gray-500">
                {course._count.enrollments} enrolled · {course._count.exams} exams
              </span>
            </div>
            {course.description && (
              <p className="mt-1 text-sm text-gray-600">{course.description}</p>
            )}
            {!course.active && (
              <span className="mt-1 inline-block rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                Inactive
              </span>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
