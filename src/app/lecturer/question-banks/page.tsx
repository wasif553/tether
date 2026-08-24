"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LecturerPageHeader, PrimaryButton } from "@/components/lecturer/LecturerPageHeader";
import { SectionCard } from "@/components/lecturer/SectionCard";
import { EmptyState, LoadingState } from "@/components/lecturer/EmptyState";

type BankSummary = {
  id: string;
  title: string;
  subject: string | null;
  courseCode: string | null;
  updatedAt: string;
  _count: { questions: number };
};

export default function QuestionBanksPage() {
  const [banks, setBanks] = useState<BankSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadBanks() {
    setLoading(true);
    const res = await fetch("/api/lecturer/question-banks");
    if (res.ok) setBanks(await res.json());
    setLoading(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadBanks();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);

    const res = await fetch("/api/lecturer/question-banks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });

    setCreating(false);

    if (!res.ok) {
      setError("Failed to create question bank");
      return;
    }

    setTitle("");
    setShowForm(false);
    await loadBanks();
  }

  return (
    <div className="mx-auto max-w-4xl">
      <LecturerPageHeader
        breadcrumbs={[{ label: "Dashboard", href: "/lecturer" }, { label: "Question Banks" }]}
        title="Question Banks"
        description="Reusable libraries of questions you can import into any exam."
        actions={
          <PrimaryButton type="button" onClick={() => setShowForm((v) => !v)} aria-expanded={showForm}>
            New bank
          </PrimaryButton>
        }
      />

      {showForm && (
        <SectionCard className="mt-4">
          <form onSubmit={handleCreate} className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-sm font-medium text-lecturer-text-primary">Title</label>
              <input
                required
                autoFocus
                className="mt-1 w-full rounded-lg border border-lecturer-border px-3 py-2 text-sm text-lecturer-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <PrimaryButton type="submit" disabled={creating}>
              {creating ? "Creating…" : "Create"}
            </PrimaryButton>
          </form>
        </SectionCard>
      )}
      {error && <p className="mt-2 text-sm text-[#B42318]">{error}</p>}

      <div className="mt-5 space-y-2">
        {loading && <LoadingState label="Loading question banks…" />}
        {!loading && banks.length === 0 && <EmptyState title="No question banks yet" description="Create one to start building a reusable library of questions." />}
        {banks.map((bank) => (
          <div key={bank.id} className="flex items-center justify-between gap-3 rounded-xl border border-lecturer-border bg-lecturer-surface p-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-lecturer-text-primary">{bank.title}</p>
              <p className="mt-0.5 truncate text-xs text-lecturer-text-secondary">
                {[bank.subject, bank.courseCode].filter(Boolean).join(" · ")}
                {bank.subject || bank.courseCode ? " · " : ""}
                {bank._count.questions} question(s) · Updated {new Date(bank.updatedAt).toLocaleDateString()}
              </p>
            </div>
            <Link
              href={`/lecturer/question-banks/${bank.id}`}
              className="shrink-0 rounded-lg border border-lecturer-border px-3 py-1.5 text-sm font-medium text-lecturer-text-primary hover:bg-lecturer-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
            >
              Open
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
