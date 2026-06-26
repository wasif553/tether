export default function StudentExamNoticePage() {
  return (
    <div className="mx-auto max-w-2xl py-12">
      <h1 className="text-2xl font-semibold">What Safe Exam System records during an exam</h1>
      <p className="mt-2 text-sm text-gray-500">
        This page explains, in plain language, what this exam platform records while you take an
        exam. It is not a complete legal privacy policy — your institution may have its own policy
        that also applies.
      </p>

      <div className="mt-6 space-y-6 text-sm leading-6 text-gray-700">
        <section>
          <h2 className="font-medium text-gray-900">Your answers</h2>
          <p className="mt-1">
            We record the answers you submit for each question, and autosave your in-progress
            responses periodically so you don&apos;t lose work if your browser refreshes.
          </p>
        </section>

        <section>
          <h2 className="font-medium text-gray-900">Timing information</h2>
          <p className="mt-1">
            We record when you start and submit an exam, and use this to enforce the time limit
            your lecturer set.
          </p>
        </section>

        <section>
          <h2 className="font-medium text-gray-900">Integrity events</h2>
          <p className="mt-1">
            While you&apos;re taking an exam, this platform may log a small number of browser
            behaviour signals as <strong>integrity events</strong> — for example, exiting
            fullscreen, switching tabs or windows, copy or paste actions, right-clicks, or your
            network connection dropping. These are recorded for your lecturer to review later if
            needed.
          </p>
          <p className="mt-1">
            Recording an integrity event does <strong>not</strong> automatically accuse you of
            anything or change your grade. These signals are simply flagged as{" "}
            <strong>review recommended</strong> for a human — your lecturer — to look at and use
            their own judgment.
          </p>
        </section>

        <section>
          <h2 className="font-medium text-gray-900">AI features, if enabled by your lecturer</h2>
          <p className="mt-1">
            Some lecturers use an AI assistant to draft a suggested score and feedback for essay
            questions. Any AI-generated score is always labeled as an{" "}
            <strong>AI draft</strong> — it is never the final grade. Your lecturer reviews,
            approves, or changes it before any grade is finalized.
          </p>
        </section>

        <section>
          <h2 className="font-medium text-gray-900">Who can review this data</h2>
          <p className="mt-1">
            Your answers, timing data, and any integrity events for an exam are visible to the
            lecturer who created that exam. They are not visible to other students.
          </p>
        </section>

        <section>
          <h2 className="font-medium text-gray-900">Who makes assessment decisions</h2>
          <p className="mt-1">
            This platform does not make grading or academic integrity decisions on its own. Your
            institution and your lecturer remain responsible for any assessment outcome.
          </p>
        </section>

        <section>
          <h2 className="font-medium text-gray-900">Questions or concerns</h2>
          <p className="mt-1">
            If you have questions about how your exam data is used, contact your lecturer or your
            institution&apos;s student support office.
          </p>
        </section>
      </div>
    </div>
  );
}
