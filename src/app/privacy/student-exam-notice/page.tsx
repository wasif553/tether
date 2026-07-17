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
          <h2 className="font-medium text-gray-900">Network evidence</h2>
          <p className="mt-1">
            When you open an exam and when you submit it, SES records:
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>Your IP address at exam open</li>
            <li>Approximate country, region, and city inferred from that IP address</li>
            <li>Your IP address at final submission</li>
            <li>Approximate country, region, and city inferred from that IP address</li>
            <li>Browser and operating system information (user-agent string)</li>
            <li>Whether the network address changed between exam open and submission</li>
          </ul>
          <p className="mt-2">
            <strong>
              Location is inferred from IP address and is approximate. VPNs, mobile networks,
              campus networks, and ISP routing may affect accuracy. SES does not use GPS location.
              Network evidence is an integrity signal for lecturer review, not proof of misconduct.
            </strong>
          </p>
          <p className="mt-1">
            Network evidence is visible only to the lecturer who owns the exam and to authorised
            platform staff. It is not visible to other students. It is never used to automatically
            determine misconduct or affect your grade.
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
          <h2 className="font-medium text-gray-900">Camera monitoring</h2>
          <p className="mt-1">
            If your lecturer has enabled camera monitoring for this exam, SES will request access
            to your camera.
          </p>
          <p className="mt-1">Camera Monitoring v1:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>checks that your camera is available when the exam starts</li>
            <li>monitors camera availability during the exam</li>
            <li>records camera status events for lecturer review</li>
          </ul>
          <p className="mt-2">Camera Monitoring v1 does <strong>not</strong>:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>store video recordings</li>
            <li>store images</li>
            <li>use facial recognition</li>
            <li>automatically determine misconduct</li>
            <li>share your camera feed with other students</li>
          </ul>
          <p className="mt-2">
            Camera integrity events are reviewed by authorised teaching staff. Final academic
            decisions remain with your institution and lecturer.
          </p>
        </section>

        <section>
          <h2 className="font-medium text-gray-900">Student verification and AI camera checks, if enabled</h2>
          <p className="mt-1">
            If your lecturer enables it, you may be asked to confirm your identity before starting
            an exam — a simple tick-box confirmation of your name, student ID, and email already on
            file. This does <strong>not</strong> involve scanning a photo ID, comparing your face
            to anything, or storing any image.
          </p>
          <p className="mt-1">
            If your lecturer also enables AI-assisted camera integrity checks, your camera may be
            checked <strong>locally on your own device</strong> for signals such as whether a phone
            or another person may be visible, or whether the camera view is blocked or too dark.
          </p>
          <p className="mt-2">This does <strong>not</strong>:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>record, stream, or store your camera video</li>
            <li>use facial recognition, compare your face to anything, or create a biometric template</li>
            <li>track your eye gaze</li>
            <li>detect your emotions</li>
            <li>record or capture your screen or desktop</li>
            <li>make an automatic misconduct decision</li>
          </ul>
          <p className="mt-2">
            Any signal produced is worded as a <strong>possible</strong> indicator — for example
            &quot;possible mobile phone visible&quot; — and is reviewed by your lecturer, who makes
            the final academic decision. This is not live proctoring: no one watches your camera in
            real time.
          </p>
          <p className="mt-2">
            <strong>By default, no image, frame, or screenshot is ever stored</strong> — only the
            numeric signal itself (e.g. &quot;possible phone visible&quot;) is recorded.
          </p>
        </section>

        <section>
          <h2 className="font-medium text-gray-900">Camera evidence frames, if separately enabled</h2>
          <p className="mt-1">
            Some lecturers additionally enable a further, separate opt-in setting: saving a single
            <strong> camera evidence frame</strong> when a possible phone or possible second person
            is detected. If your lecturer has enabled this for your exam, you will see it named
            explicitly in the checklist before you start.
          </p>
          <p className="mt-1">
            This exam may save a single low-resolution camera evidence frame if a possible phone or
            second person is detected. No video is recorded. Evidence is available only to
            authorised reviewers.
          </p>
          <p className="mt-2">Camera evidence frames:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>are captured only for a possible phone or possible second person signal — never for other signals</li>
            <li>are a single still image, never a video or a recording</li>
            <li>never capture your exam screen or desktop</li>
            <li>are low-resolution and compressed, not full quality</li>
            <li>are never analysed with facial recognition and never used to create a biometric identifier</li>
            <li>are stored privately and are visible only to your lecturer and authorised institution staff, never to other students</li>
            <li>are not created for every check — only once per recorded signal, not continuously</li>
          </ul>
          <p className="mt-2">
            An evidence frame is a review aid for a human reviewer, exactly like the text-only
            signal it accompanies — it is not proof of misconduct, and does not by itself change
            any grade or academic outcome.
          </p>
        </section>

        <section>
          <h2 className="font-medium text-gray-900">Exam watermark, if enabled</h2>
          <p className="mt-1">
            This exam may display a watermark containing your student identifier, attempt ID, and
            timestamp to discourage copying, sharing, screenshots, and uploading assessment content
            to AI tools.
          </p>
          <p className="mt-1">
            The watermark identifier prefers your institution-assigned student ID, then the first
            part of your email address, and only falls back to a short, truncated portion of your
            account ID if neither is available. It never shows your full name, phone number,
            address, or date of birth.
          </p>
          <p className="mt-2">
            <strong>
              The watermark is a deterrent and traceability aid, not a guarantee — it discourages
              copying and does not guarantee AI tools will refuse to answer shared content, and it
              does not by itself prove or determine misconduct.
            </strong>
          </p>
          <p className="mt-1">
            The watermark is purely visual — it does not capture, record, or upload anything by
            itself, and it never blocks you from reading questions or typing your answers.
          </p>
        </section>

        <section>
          <h2 className="font-medium text-gray-900">Browser secure mode</h2>
          <p className="mt-1">When Secure Exam Mode is active, SES may:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>block copy, cut, and paste inside the exam page</li>
            <li>block right-click/context menu inside the exam page</li>
            <li>block selected keyboard shortcuts where supported by the browser</li>
            <li>request or re-enforce fullscreen mode</li>
            <li>record attempts to leave the exam window</li>
          </ul>
          <p className="mt-2">
            SES cannot close other browser tabs or control other applications on your device.
            Higher-security lockdown mode requires a dedicated lockdown browser and is planned as
            a future option.
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
