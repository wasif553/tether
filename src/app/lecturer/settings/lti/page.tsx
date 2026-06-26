import Link from "next/link";

export default function LtiSettingsPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold">Canvas / LTI Settings</h1>
      <p className="mt-2 text-sm text-gray-500">
        Safe Exam System integrates with Canvas via LTI 1.3. This page links to the tools you
        need to validate a Canvas sandbox course end to end.
      </p>

      <div className="mt-6 rounded border border-gray-200 p-4">
        <h2 className="font-medium">Unmatched Canvas launches</h2>
        <p className="mt-1 text-sm text-gray-600">
          Canvas launches that haven&apos;t been connected to an SES exam yet show up here.
        </p>
        <Link
          href="/lecturer/lti/unmatched-launches"
          className="mt-3 inline-block rounded bg-black px-4 py-2 text-sm text-white"
        >
          Open Unmatched Canvas Launches
        </Link>
      </div>

      <div className="mt-6 rounded border border-gray-200 p-4">
        <h2 className="font-medium">Recommended Canvas validation flow</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-gray-700">
          <li>Configure the Canvas Developer Key (see the Canvas sandbox test guide).</li>
          <li>Install the tool in the Canvas course.</li>
          <li>Create a Canvas assignment using Safe Exam System as the external tool.</li>
          <li>Launch the assignment once, as lecturer or student.</li>
          <li>Open Unmatched Canvas Launches.</li>
          <li>Link the Canvas resource to an SES exam.</li>
          <li>Relaunch and confirm it now routes straight to the exam.</li>
          <li>Submit and verify Canvas passback reaches <strong>SENT</strong>.</li>
        </ol>
      </div>

      <div className="mt-6 flex gap-3">
        <Link href="/lecturer/pilot-readiness" className="text-sm underline">
          View pilot readiness
        </Link>
      </div>
    </div>
  );
}
