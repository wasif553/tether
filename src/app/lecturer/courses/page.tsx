"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { LecturerPageHeader, PrimaryButton } from "@/components/lecturer/LecturerPageHeader";
import { SectionCard } from "@/components/lecturer/SectionCard";
import { StatusBadge } from "@/components/lecturer/StatusBadge";
import { EmptyState, LoadingState } from "@/components/lecturer/EmptyState";
import { SearchIcon } from "@/components/lecturer/icons";

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
  const [showCreatePanel, setShowCreatePanel] = useState(false);
  const [query, setQuery] = useState("");

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
    setShowCreatePanel(false);
    load();
  }

  const filteredCourses = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return courses;
    return courses.filter((course) => course.name.toLowerCase().includes(q) || course.code.toLowerCase().includes(q));
  }, [courses, query]);

  return (
    <div className="mx-auto max-w-5xl">
      <LecturerPageHeader
        breadcrumbs={[{ label: "Dashboard", href: "/lecturer" }, { label: "Courses" }]}
        title="Courses"
        description={`${courses.length} course${courses.length === 1 ? "" : "s"} · groups students so you can assign exams to a whole class or selected students.`}
        actions={
          <PrimaryButton type="button" onClick={() => setShowCreatePanel((v) => !v)} aria-expanded={showCreatePanel} aria-controls="create-course-panel">
            New course
          </PrimaryButton>
        }
      />

      {showCreatePanel && (
        <SectionCard className="mt-4" title="Create a course">
          <div id="create-course-panel" className="grid gap-2 sm:grid-cols-2">
            <input
              type="text"
              placeholder="Course name (e.g. Intro to Databases)"
              className="rounded-lg border border-lecturer-border px-3 py-2 text-sm text-lecturer-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              type="text"
              placeholder="Course code (e.g. CS201)"
              className="rounded-lg border border-lecturer-border px-3 py-2 text-sm text-lecturer-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <input
            type="text"
            placeholder="Description (optional)"
            className="mt-2 w-full rounded-lg border border-lecturer-border px-3 py-2 text-sm text-lecturer-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          {error && <p className="mt-2 text-sm text-[#B42318]">{error}</p>}
          <div className="mt-3 flex gap-2">
            <PrimaryButton type="button" onClick={createCourse} disabled={creating || !name.trim() || !code.trim()}>
              {creating ? "Creating…" : "Create course"}
            </PrimaryButton>
            <button
              type="button"
              onClick={() => setShowCreatePanel(false)}
              className="rounded-lg border border-lecturer-border px-4 py-2 text-sm font-medium text-lecturer-text-secondary hover:bg-lecturer-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
            >
              Cancel
            </button>
          </div>
        </SectionCard>
      )}

      {!loading && courses.length > 0 && (
        <div className="relative mt-5 max-w-sm">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-lecturer-text-muted" />
          <input
            type="search"
            placeholder="Search courses…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-lg border border-lecturer-border bg-lecturer-surface py-2 pr-3 pl-9 text-sm text-lecturer-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
            aria-label="Search courses"
          />
        </div>
      )}

      <div className="mt-4 space-y-2">
        {loading && <LoadingState label="Loading courses…" />}
        {!loading && courses.length === 0 && (
          <EmptyState
            title="No courses yet"
            description="Create a course to start grouping students and assigning exams."
            action={
              <PrimaryButton type="button" onClick={() => setShowCreatePanel(true)}>
                New course
              </PrimaryButton>
            }
          />
        )}
        {!loading && courses.length > 0 && filteredCourses.length === 0 && <EmptyState title="No matching courses" description={`Nothing matches "${query}".`} />}
        {filteredCourses.map((course) => (
          <Link
            key={course.id}
            href={`/lecturer/courses/${course.id}`}
            className="block rounded-xl border border-lecturer-border bg-lecturer-surface p-4 transition-colors hover:border-lecturer-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-lecturer-text-primary">
                  {course.code} — {course.name}
                </p>
                {course.description && <p className="mt-0.5 truncate text-sm text-lecturer-text-secondary">{course.description}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!course.active && <StatusBadge tone="neutral">Inactive</StatusBadge>}
                <span className="text-sm whitespace-nowrap text-lecturer-text-secondary">
                  {course._count.enrollments} enrolled · {course._count.exams} exams
                </span>
                <span className="text-sm font-medium text-lecturer-accent">Open course →</span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
