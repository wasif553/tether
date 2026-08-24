"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LecturerPageHeader } from "@/components/lecturer/LecturerPageHeader";
import { SectionCard } from "@/components/lecturer/SectionCard";
import { StatusBadge, type StatusTone } from "@/components/lecturer/StatusBadge";
import { LoadingState, ErrorState } from "@/components/lecturer/EmptyState";

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

const STATUS_TONES: Record<Status, StatusTone> = {
  READY: "success",
  NEEDS_SETUP: "warning",
  NOT_CONFIGURED: "neutral",
  WARNING: "critical",
};

function ReadinessSection({ title, items }: { title: string; items: ReadinessItem[] }) {
  return (
    <SectionCard title={title}>
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.label} className="flex items-start justify-between gap-3 text-sm">
            <div>
              <p className="text-lecturer-text-primary">{item.label}</p>
              {item.detail && <p className="text-xs text-lecturer-text-secondary">{item.detail}</p>}
            </div>
            <StatusBadge tone={STATUS_TONES[item.status]}>{STATUS_LABELS[item.status]}</StatusBadge>
          </div>
        ))}
      </div>
    </SectionCard>
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

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <LecturerPageHeader
        breadcrumbs={[{ label: "Dashboard", href: "/lecturer" }, { label: "Pilot Readiness" }]}
        title="Pilot Readiness"
        description="A checklist of whether Safe Exam System is ready for a controlled pilot. This page never shows secret values — only whether something is configured. Canvas and AI are optional modules; missing configuration there never blocks core readiness."
      />

      {loading && <LoadingState label="Loading pilot readiness…" />}
      {!loading && !data && <ErrorState message="Could not load pilot readiness." />}

      {data && (
        <>
          <div className={`rounded-xl border p-4 text-sm ${data.coreReady ? "border-lecturer-border bg-[#ECFDF3] text-[#067647]" : "border-[#FEDF89] bg-[#FFFAEB] text-[#B54708]"}`}>
            {data.summary.corePlatform}. This never depends on Canvas/LTI or AI configuration.
          </div>

          <ReadinessSection title="A. Core secure exam readiness (required)" items={data.core} />
          <ReadinessSection title="B. Optional Canvas readiness" items={data.canvasOptional} />
          <ReadinessSection title="C. Optional AI readiness" items={data.aiOptional} />
          <ReadinessSection title="D. Deployment readiness (required)" items={data.deployment} />

          <SectionCard title="Pilot resources" subtitle="Reference material for running a controlled pilot with a real institution.">
            <ul className="space-y-1.5 text-sm">
              <li>
                <Link href="/pilot" className="text-lecturer-accent underline underline-offset-2 hover:text-lecturer-accent-hover">
                  Public pilot landing page
                </Link>{" "}
                <span className="text-lecturer-text-secondary">— share this with a prospective institution</span>
              </li>
              <li>
                <code className="text-xs text-lecturer-text-primary">docs/demo-script.md</code>{" "}
                <span className="text-lecturer-text-secondary">— a 15-minute structured demo flow</span>
              </li>
              <li>
                <code className="text-xs text-lecturer-text-primary">docs/pilot-proposal-template.md</code>{" "}
                <span className="text-lecturer-text-secondary">— scope, roles, and go/no-go criteria template</span>
              </li>
              <li>
                <code className="text-xs text-lecturer-text-primary">docs/lecturer-onboarding-guide.md</code>{" "}
                <span className="text-lecturer-text-secondary">— step-by-step guide for a new lecturer</span>
              </li>
              <li>
                <code className="text-xs text-lecturer-text-primary">docs/student-test-instructions.md</code>{" "}
                <span className="text-lecturer-text-secondary">— share with students before their exam</span>
              </li>
              <li>
                <code className="text-xs text-lecturer-text-primary">docs/concurrent-exam-pilot-capacity.md</code>{" "}
                <span className="text-lecturer-text-secondary">— load test results and rollout stages</span>
              </li>
              <li>
                <code className="text-xs text-lecturer-text-primary">docs/known-limitations.md</code>{" "}
                <span className="text-lecturer-text-secondary">— what SES does and does not do today</span>
              </li>
            </ul>
          </SectionCard>
        </>
      )}
    </div>
  );
}
