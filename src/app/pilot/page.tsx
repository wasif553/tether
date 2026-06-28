import Link from "next/link";

export default function PilotLandingPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      {/* 1. Hero */}
      <section>
        <h1 className="text-3xl font-semibold">Secure Online Exams for Universities</h1>
        <p className="mt-3 text-lg text-gray-600">
          SES delivers cheat-resistant online assessments with browser-level security controls,
          camera monitoring, integrity evidence capture, and defensible lecturer review.
        </p>
        <a
          href="#request-a-pilot"
          className="mt-6 inline-block rounded bg-black px-5 py-2.5 text-sm text-white"
        >
          Request a controlled pilot
        </a>
      </section>

      {/* 2. What SES does */}
      <section className="mt-12">
        <h2 className="text-xl font-medium">What SES does</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-gray-700">
          <li>Secure exam delivery with browser-level friction</li>
          <li>Camera availability monitoring</li>
          <li>Integrity event capture and risk scoring</li>
          <li>Manual and auto-grading</li>
          <li>Evidence reports for academic integrity review</li>
          <li>Analytics and CSV exports</li>
          <li>Optional Canvas/LTI integration</li>
          <li>Optional AI question generation and essay marking</li>
        </ul>
      </section>

      {/* 3. Who it is for */}
      <section className="mt-12">
        <h2 className="text-xl font-medium">Who it is for</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-gray-700">
          <li>Universities and colleges</li>
          <li>Lecturers running online assessments</li>
          <li>Departments needing integrity evidence</li>
          <li>Institutions preparing for LMS-integrated assessment</li>
        </ul>
      </section>

      {/* 4. Core secure exam workflow */}
      <section className="mt-12">
        <h2 className="text-xl font-medium">Core secure exam workflow</h2>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-gray-700">
          <li>Lecturer creates exam and enables Secure Exam Mode</li>
          <li>Student opens exam — browser friction controls activate</li>
          <li>Optional: camera monitoring checks availability</li>
          <li>Student completes exam — integrity signals recorded</li>
          <li>Auto-grading for MCQ, manual review for essays</li>
          <li>Lecturer reviews integrity events and risk scores</li>
          <li>Evidence report generated for any integrity concerns</li>
          <li>Analytics exported for institutional reporting</li>
        </ol>
      </section>

      {/* 5. Current validated pilot capacity */}
      <section className="mt-12">
        <h2 className="text-xl font-medium">Current validated pilot capacity</h2>
        <div className="mt-3 overflow-x-auto rounded border border-gray-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left">
                <th className="p-2">Load test</th>
                <th className="p-2">Result</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-100">
                <td className="p-2">10 students / 1 exam</td>
                <td className="p-2 text-green-700">100% — PASS</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="p-2">25 students / 2 exams</td>
                <td className="p-2 text-green-700">100% — PASS</td>
              </tr>
              <tr>
                <td className="p-2">50 students / 3 exams</td>
                <td className="p-2 text-amber-700">94–96% — acceptable for pilot</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-sm text-gray-500">
          Recommended: 30–40 students per exam on current infrastructure.
        </p>
      </section>

      {/* 6. Known limitations */}
      <section className="mt-12">
        <h2 className="text-xl font-medium">Known limitations</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-gray-700">
          <li>Browser-based secure mode — not OS-level lockdown</li>
          <li>Camera monitoring checks availability — not face recognition</li>
          <li>Cannot close other browser tabs or block OS app switching</li>
          <li>Full lockdown browser planned as a future option</li>
          <li>50+ students requires an infrastructure upgrade</li>
        </ul>
        <p className="mt-2 text-sm text-gray-500">
          See <Link href="/privacy/student-exam-notice" className="underline">the student privacy notice</Link>{" "}
          for full detail on what is and isn&apos;t recorded.
        </p>
      </section>

      {/* 7. Optional modules */}
      <section className="mt-12">
        <h2 className="text-xl font-medium">Optional modules</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-gray-700">
          <li>
            <strong>Canvas/LTI:</strong> connect to your LMS for single sign-on and automatic
            grade sync
          </li>
          <li>
            <strong>AI assistance:</strong> generate questions and draft essay marking (lecturer
            retains final decision)
          </li>
        </ul>
      </section>

      {/* 8. Request a pilot */}
      <section id="request-a-pilot" className="mt-12 rounded border border-gray-200 p-5">
        <h2 className="text-xl font-medium">Request a controlled pilot</h2>
        <p className="mt-2 text-sm text-gray-700">
          We are accepting a small number of controlled pilot partners. A typical first pilot
          involves 1–3 lecturers, 1–3 exams, and 20–40 students over 2–4 weeks.
        </p>
        <p className="mt-3 text-sm text-gray-700">
          Contact us at{" "}
          <a href="mailto:pilot@yourdomain.com" className="underline">
            pilot@yourdomain.com
          </a>{" "}
          to discuss a controlled pilot.
        </p>
        <p className="mt-1 text-xs text-gray-400">(Replace with a real email before going live.)</p>
      </section>
    </div>
  );
}
