"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

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
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Question Banks</h1>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded bg-black px-4 py-2 text-sm text-white"
        >
          New bank
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={handleCreate}
          className="mt-4 flex items-end gap-3 rounded border border-gray-200 p-4"
        >
          <div className="flex-1">
            <label className="block text-sm font-medium">Title</label>
            <input
              required
              autoFocus
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={creating}
            className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {creating ? "Creating..." : "Create"}
          </button>
        </form>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-6 space-y-3">
        {loading && <p className="text-gray-500">Loading...</p>}
        {!loading && banks.length === 0 && (
          <p className="text-gray-500">
            No question banks yet. Create one to start building a reusable library of questions.
          </p>
        )}
        {banks.map((bank) => (
          <div
            key={bank.id}
            className="flex items-center justify-between rounded border border-gray-200 p-4"
          >
            <div>
              <p className="font-medium">{bank.title}</p>
              <p className="text-sm text-gray-500">
                {[bank.subject, bank.courseCode].filter(Boolean).join(" · ")}
                {bank.subject || bank.courseCode ? " · " : ""}
                {bank._count.questions} question(s) · Updated{" "}
                {new Date(bank.updatedAt).toLocaleDateString()}
              </p>
            </div>
            <Link
              href={`/lecturer/question-banks/${bank.id}`}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm"
            >
              Open
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
