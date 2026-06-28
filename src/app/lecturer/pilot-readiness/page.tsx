"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

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

      <div className="mt-6 rounded border border-gray-200 p-4">
        <h2 className="font-medium">Pilot resources</h2>
        <p className="mt-1 text-sm text-gray-500">
          Reference material for running a controlled pilot with a real institution.
        </p>
        <ul className="mt-3 space-y-1.5 text-sm">
          <li>
            <Link href="/pilot" className="underline">
              Public pilot landing page
            </Link>{" "}
            <span className="text-gray-500">— share this with a prospective institution</span>
          </li>
          <li>
            <code className="text-xs">docs/demo-script.md</code>{" "}
            <span className="text-gray-500">— a 15-minute structured demo flow</span>
          </li>
          <li>
            <code className="text-xs">docs/pilot-proposal-template.md</code>{" "}
            <span className="text-gray-500">— scope, roles, and go/no-go criteria template</span>
          </li>
          <li>
            <code className="text-xs">docs/lecturer-onboarding-guide.md</code>{" "}
            <span className="text-gray-500">— step-by-step guide for a new lecturer</span>
          </li>
          <li>
            <code className="text-xs">docs/student-test-instructions.md</code>{" "}
            <span className="text-gray-500">— share with students before their exam</span>
          </li>
          <li>
            <code className="text-xs">docs/concurrent-exam-pilot-capacity.md</code>{" "}
            <span className="text-gray-500">— load test results and rollout stages</span>
          </li>
          <li>
            <code className="text-xs">docs/known-limitations.md</code>{" "}
            <span className="text-gray-500">— what SES does and does not do today</span>
          </li>
        </ul>
      </div>
    </div>
  );
}
