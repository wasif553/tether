"use client";

import { useEffect, useState } from "react";

type Status = "READY" | "NEEDS_SETUP" | "NOT_CONFIGURED" | "WARNING";

type ReadinessItem = {
  label: string;
  status: Status;
  detail?: string;
};

type Readiness = {
  core: ReadinessItem[];
  canvasOptional: ReadinessItem[];
  aiOptional: ReadinessItem[];
  deployment: ReadinessItem[];
  coreReady: boolean;
  summary: { corePlatform: string; canvas: string; ai: string };
};

const STATUS_LABELS: Record<Status, string> = {
  READY: "Ready",
  NEEDS_SETUP: "Needs setup",
  NOT_CONFIGURED: "Not configured",
  WARNING: "Warning",
};

const STATUS_STYLES: Record<Status, string> = {
  READY: "bg-green-100 text-green-700",
  NEEDS_SETUP: "bg-amber-100 text-amber-700",
  NOT_CONFIGURED: "bg-gray-100 text-gray-600",
  WARNING: "bg-red-100 text-red-700",
};

function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

function Section({ title, items }: { title: string; items: ReadinessItem[] }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <h2 className="font-medium">{title}</h2>
      <div className="mt-2 space-y-2">
        {items.map((item) => (
          <div key={item.label} className="flex items-start justify-between gap-3 text-sm">
            <div>
              <p>{item.label}</p>
              {item.detail && <p className="text-xs text-gray-500">{item.detail}</p>}
            </div>
            <StatusBadge status={item.status} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PilotReadinessPage() {
  const [data, setData] = useState<Readiness | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/lecturer/pilot-readiness")
      .then((res) => res.json())
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-gray-500">Loading...</p>;
  if (!data) return <p className="text-red-600">Could not load pilot readiness.</p>;

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">Pilot Readiness</h1>
      <p className="mt-1 text-sm text-gray-500">
        A checklist of whether Safe Exam System is ready for a controlled pilot. This page never
        shows secret values — only whether something is configured. Canvas and AI are optional
        modules; missing configuration there never blocks core readiness.
      </p>

      <p
        className={`mt-4 rounded p-3 text-sm ${
          data.coreReady ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
        }`}
      >
        {data.summary.corePlatform}. This never depends on Canvas/LTI or AI configuration.
      </p>

      <div className="mt-6 space-y-4">
        <Section title="A. Core secure exam readiness (required)" items={data.core} />
        <Section title="B. Optional Canvas readiness" items={data.canvasOptional} />
        <Section title="C. Optional AI readiness" items={data.aiOptional} />
        <Section title="D. Deployment readiness (required)" items={data.deployment} />
      </div>
    </div>
  );
}
