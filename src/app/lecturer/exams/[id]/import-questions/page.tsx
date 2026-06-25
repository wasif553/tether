"use client";

import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type BankSummary = {
  id: string;
  title: string;
  _count: { questions: number };
};

type BankQuestion = {
  id: string;
  type: "MULTIPLE_CHOICE" | "SHORT_ANSWER" | "ESSAY";
  text: string;
  points: number;
  difficulty: "easy" | "medium" | "hard" | null;
  topic: string | null;
};

export default function ImportQuestionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);
  const router = useRouter();

  const [banks, setBanks] = useState<BankSummary[]>([]);
  const [selectedBankId, setSelectedBankId] = useState<string | null>(null);
  const [questions, setQuestions] = useState<BankQuestion[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingBanks, setLoadingBanks] = useState(true);
  const [loadingQuestions, setLoadingQuestions] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/lecturer/question-banks")
      .then((res) => res.json())
      .then(setBanks)
      .finally(() => setLoadingBanks(false));
  }, []);

  async function openBank(bankId: string) {
    setSelectedBankId(bankId);
    setSelected(new Set());
    setLoadingQuestions(true);
    const res = await fetch(`/api/lecturer/question-banks/${bankId}`);
    if (res.ok) {
      const data = await res.json();
      setQuestions(data.questions);
    }
    setLoadingQuestions(false);
  }

  function toggleSelected(questionId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      return next;
    });
  }

  async function handleImport() {
    if (selected.size === 0) return;
    setImporting(true);
    setMessage(null);

    const res = await fetch(`/api/lecturer/exams/${id}/import-bank-questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bankQuestionIds: Array.from(selected) }),
    });

    setImporting(false);

    if (!res.ok) {
      setMessage("Failed to import questions");
      return;
    }

    const result = await res.json();
    setMessage(`${result.imported} question(s) imported`);
    setTimeout(() => router.push(`/lecturer/exams/${id}`), 800);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">Import from question bank</h1>

      <div className="mt-6 grid grid-cols-3 gap-6">
        <div>
          <h2 className="text-sm font-medium text-gray-500">Your banks</h2>
          <div className="mt-2 space-y-1">
            {loadingBanks && <p className="text-sm text-gray-500">Loading...</p>}
            {!loadingBanks && banks.length === 0 && (
              <p className="text-sm text-gray-500">No question banks yet.</p>
            )}
            {banks.map((bank) => (
              <button
                key={bank.id}
                onClick={() => openBank(bank.id)}
                className={
                  selectedBankId === bank.id
                    ? "block w-full rounded bg-black px-3 py-2 text-left text-sm text-white"
                    : "block w-full rounded border border-gray-200 px-3 py-2 text-left text-sm"
                }
              >
                {bank.title}
                <span className="ml-1 text-xs opacity-70">({bank._count.questions})</span>
              </button>
            ))}
          </div>
        </div>

        <div className="col-span-2">
          <h2 className="text-sm font-medium text-gray-500">Questions</h2>
          <div className="mt-2 space-y-2">
            {!selectedBankId && <p className="text-sm text-gray-500">Select a bank to view its questions.</p>}
            {loadingQuestions && <p className="text-sm text-gray-500">Loading...</p>}
            {selectedBankId && !loadingQuestions && questions.length === 0 && (
              <p className="text-sm text-gray-500">This bank has no questions.</p>
            )}
            {questions.map((q) => (
              <label
                key={q.id}
                className="flex items-start gap-2 rounded border border-gray-200 p-3 text-sm"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selected.has(q.id)}
                  onChange={() => toggleSelected(q.id)}
                />
                <div>
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <span className="rounded bg-gray-100 px-2 py-0.5">{q.type}</span>
                    {q.difficulty && <span>{q.difficulty}</span>}
                    {q.topic && <span>· {q.topic}</span>}
                    <span>· {q.points} pt(s)</span>
                  </div>
                  <p className="mt-1">{q.text}</p>
                </div>
              </label>
            ))}
          </div>
        </div>
      </div>

      {message && <p className="mt-4 text-sm text-gray-600">{message}</p>}

      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={handleImport}
          disabled={importing || selected.size === 0}
          className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {importing ? "Importing..." : `Import selected (${selected.size})`}
        </button>
        <Link href={`/lecturer/exams/${id}`} className="text-sm underline">
          Cancel
        </Link>
      </div>
    </div>
  );
}
