"use client";

/**
 * Answer-Development Provenance v1 — student-facing notice + optional
 * DETAILED-mode workspace tabs (Outline / Working / Code / Sources). See
 * docs/answer-development-provenance-v1.md and Part 5 of the spec.
 *
 * Self-contained, mirrors the AiBrainstormPanel integration pattern — a
 * single component dropped into both the one-question and full-paper
 * render branches of the student exam page.
 */
import { useEffect, useRef, useState } from "react";

export type AnswerDevelopmentPanelProps = {
  submissionId: string;
  questionId: string;
  mode: "OFF" | "BASIC" | "DETAILED";
  enableOutlineWorkspace: boolean;
  enableCalculationWorkspace: boolean;
  enableCodeWorkspace: boolean;
  requireAiSourceDeclaration: boolean;
};

type Tab = "OUTLINE" | "WORKING" | "CODE" | "SOURCES";

function useDebouncedArtifactSave(submissionId: string, artifactType: string, questionId: string | null) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (content: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      fetch(`/api/submissions/${submissionId}/answer-development/artifacts/${artifactType}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, questionId: questionId ?? undefined }),
      }).catch(() => {});
    }, 800);
  };
}

function WorkspaceTextarea({
  submissionId,
  artifactType,
  questionId,
  label,
  placeholder,
  maxLength,
}: {
  submissionId: string;
  artifactType: string;
  questionId: string | null;
  label: string;
  placeholder: string;
  maxLength: number;
}) {
  const [value, setValue] = useState("");
  const save = useDebouncedArtifactSave(submissionId, artifactType, questionId);
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600">{label}</label>
      <textarea
        className="mt-1 w-full rounded border border-gray-300 p-2 text-sm"
        rows={5}
        maxLength={maxLength}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          save(e.target.value);
        }}
      />
    </div>
  );
}

function SourcesTab({ submissionId }: { submissionId: string }) {
  const [usedAi, setUsedAi] = useState<"YES" | "NO" | "">("");
  const [toolName, setToolName] = useState("");
  const [howUsed, setHowUsed] = useState("");
  const [partsInfluenced, setPartsInfluenced] = useState("");
  const [verifiedOrChanged, setVerifiedOrChanged] = useState("");
  const [otherSources, setOtherSources] = useState("");

  useEffect(() => {
    const payload = JSON.stringify({ usedAi, toolName, howUsed, partsInfluenced, verifiedOrChanged, otherSources });
    const timer = setTimeout(() => {
      fetch(`/api/submissions/${submissionId}/answer-development/artifacts/AI_SOURCE_DECLARATION`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: payload }),
      }).catch(() => {});
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usedAi, toolName, howUsed, partsInfluenced, verifiedOrChanged, otherSources]);

  return (
    <div className="space-y-2 text-sm">
      <p className="text-xs text-gray-500">
        Declaring AI or other source use is not itself misconduct — this is used for context alongside your response.
      </p>
      <div>
        <span className="block text-xs font-medium text-gray-600">Did you use an AI tool?</span>
        <div className="mt-1 flex gap-3">
          <label className="flex items-center gap-1">
            <input type="radio" name="usedAi" checked={usedAi === "NO"} onChange={() => setUsedAi("NO")} /> No AI tool used
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" name="usedAi" checked={usedAi === "YES"} onChange={() => setUsedAi("YES")} /> Yes
          </label>
        </div>
      </div>
      {usedAi === "YES" && (
        <>
          <input
            className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
            placeholder="Tool or service name"
            value={toolName}
            onChange={(e) => setToolName(e.target.value)}
          />
          <textarea
            className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
            rows={2}
            placeholder="How was it used?"
            value={howUsed}
            onChange={(e) => setHowUsed(e.target.value)}
          />
          <textarea
            className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
            rows={2}
            placeholder="Which parts of the response it influenced"
            value={partsInfluenced}
            onChange={(e) => setPartsInfluenced(e.target.value)}
          />
          <textarea
            className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
            rows={2}
            placeholder="What you verified or changed"
            value={verifiedOrChanged}
            onChange={(e) => setVerifiedOrChanged(e.target.value)}
          />
        </>
      )}
      <textarea
        className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
        rows={2}
        placeholder="Other sources consulted (optional)"
        value={otherSources}
        onChange={(e) => setOtherSources(e.target.value)}
      />
    </div>
  );
}

export function AnswerDevelopmentPanel(props: AnswerDevelopmentPanelProps) {
  const [tab, setTab] = useState<Tab>("OUTLINE");
  if (props.mode === "OFF") return null;

  const tabs: Tab[] = [
    ...(props.enableOutlineWorkspace ? (["OUTLINE"] as Tab[]) : []),
    ...(props.enableCalculationWorkspace ? (["WORKING"] as Tab[]) : []),
    ...(props.enableCodeWorkspace ? (["CODE"] as Tab[]) : []),
    ...(props.requireAiSourceDeclaration ? (["SOURCES"] as Tab[]) : []),
  ];

  return (
    <div className="mt-3 rounded border border-gray-200 p-3">
      <p className="text-xs text-gray-500">
        Answer-development checkpoints are enabled for this assessment. Meaningful versions of your answer may be preserved
        for lecturer review. Individual keystrokes are not recorded.
      </p>

      {props.mode === "DETAILED" && tabs.length > 0 && (
        <div className="mt-2">
          <div className="flex gap-1 text-xs">
            {tabs.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`rounded border px-2 py-1 ${tab === t ? "border-gray-500 bg-gray-100" : "border-gray-200"}`}
              >
                {t.charAt(0) + t.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
          <div className="mt-2">
            {tab === "OUTLINE" && props.enableOutlineWorkspace && (
              <WorkspaceTextarea
                submissionId={props.submissionId}
                artifactType="OUTLINE"
                questionId={props.questionId}
                label="Outline"
                placeholder="Sketch your approach before or while writing your answer — this does not need to match your final answer."
                maxLength={20_000}
              />
            )}
            {tab === "WORKING" && props.enableCalculationWorkspace && (
              <WorkspaceTextarea
                submissionId={props.submissionId}
                artifactType="CALCULATION_WORKING"
                questionId={props.questionId}
                label="Calculation working"
                placeholder="Show your working — plain text, simple notation, and line breaks are fine."
                maxLength={30_000}
              />
            )}
            {tab === "CODE" && props.enableCodeWorkspace && (
              <CodeWorkspace submissionId={props.submissionId} questionId={props.questionId} />
            )}
            {tab === "SOURCES" && props.requireAiSourceDeclaration && <SourcesTab submissionId={props.submissionId} />}
          </div>
        </div>
      )}
    </div>
  );
}

function CodeWorkspace({ submissionId, questionId }: { submissionId: string; questionId: string }) {
  const [code, setCode] = useState("");
  const [runMessage, setRunMessage] = useState<string | null>(null);
  const save = useDebouncedArtifactSave(submissionId, "CODE_WORKING", questionId);

  async function handleRun() {
    setRunMessage("Requesting run…");
    try {
      const res = await fetch(`/api/submissions/${submissionId}/answer-development/code-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId, code }),
      });
      const body = await res.json().catch(() => ({}));
      setRunMessage(body.message ?? "Code execution is not available for this exam.");
    } catch {
      setRunMessage("Code execution is not available for this exam.");
    }
  }

  return (
    <div>
      <label className="block text-xs font-medium text-gray-600">Code working</label>
      <textarea
        className="mt-1 w-full rounded border border-gray-300 p-2 font-mono text-sm"
        rows={8}
        maxLength={100_000}
        placeholder="Write and revise your code here."
        value={code}
        onChange={(e) => {
          setCode(e.target.value);
          save(e.target.value);
        }}
      />
      <button
        type="button"
        onClick={handleRun}
        className="mt-2 rounded border border-gray-300 px-3 py-1 text-xs text-gray-500"
        title="Code execution is not configured for this exam"
      >
        Run code
      </button>
      {runMessage && <p className="mt-1 text-xs text-gray-500">{runMessage}</p>}
    </div>
  );
}
