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
            <li>Your IP address at exam open, and a hashed (scrambled) version of it used for comparison</li>
            <li>Approximate country, region, and city inferred from that IP address, when available</li>
            <li>Your IP address at final submission, and a hashed version of it</li>
            <li>Approximate country, region, and city inferred from that IP address, when available</li>
            <li>Browser and operating system information (user-agent string)</li>
            <li>Whether the network address changed between exam open and submission</li>
          </ul>
          <p className="mt-1">
            Separately, while you are taking the exam, this platform may also record a{" "}
            <strong>hashed (scrambled) representation</strong> of your device and network for
            session-continuity checks — for example, detecting whether your exam is unexpectedly
            open in two places at once. This separate check never stores your raw IP address —
            only a hashed, coarse network range.
          </p>
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
            <li>continuously record or store video</li>
            <li>use facial recognition</li>
            <li>automatically determine misconduct</li>
            <li>share your camera feed with other students</li>
          </ul>
          <p className="mt-2">
            Camera Monitoring v1 on its own never stores an image either — but if your lecturer has
            <strong> separately</strong> enabled camera evidence frames (see below), a single still
            image may be saved for specific signals only. This is always a distinct, separately
            enabled setting, never something Camera Monitoring v1 does by itself.
          </p>
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
            <strong>By default, no image, frame, or screenshot is ever stored by this AI camera
            check itself</strong> — only the numeric signal (e.g. &quot;possible phone
            visible&quot;) is recorded. The one exception is the separate, further opt-in setting
            described immediately below — if your lecturer has enabled it, you will see it named
            explicitly in the checklist before you start.
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
          <h2 className="font-medium text-gray-900">One question at a time, if enabled</h2>
          <p className="mt-1">
            This exam shows one question at a time. Your answers are saved as you move between
            questions.
          </p>
          <p className="mt-1">
            You may not be able to return to previous questions after moving forward, if your
            lecturer has disabled going back. If so, you will see this in the checklist before you
            start.
          </p>
          <p className="mt-1">
            Some exams also show questions (and, for multiple-choice questions, the answer options)
            in a stable order chosen for your attempt specifically. This order does not change if
            you refresh the page, and does not affect how your answers are graded.
          </p>
          <p className="mt-2">
            <strong>
              This reduces exposure of the full exam paper at any one time — it is a deterrent, not
              a guarantee that copying or sharing is impossible.
            </strong>
          </p>
        </section>

        <section>
          <h2 className="font-medium text-gray-900">Browser secure mode</h2>
          <p className="mt-1">When Secure Exam Mode is active in an ordinary browser, SES may:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>block copy, cut, and paste inside the exam page</li>
            <li>block right-click/context menu inside the exam page</li>
            <li>block selected keyboard shortcuts where supported by the browser</li>
            <li>request or re-enforce fullscreen mode</li>
            <li>record attempts to leave the exam window</li>
          </ul>
          <p className="mt-2">
            An ordinary browser cannot close other browser tabs or control other applications on
            your device.
          </p>
        </section>

        <section>
          <h2 className="font-medium text-gray-900">Tether Secure Browser, if required for your exam</h2>
          <p className="mt-1">
            Some exams require <strong>Tether Secure Browser</strong>, a dedicated exam
            application that applies additional device and exam-session controls beyond what an
            ordinary browser tab can enforce. If your exam requires it, you will be guided through
            installing and starting it before your attempt begins, and the specific requirements
            for your exam are shown to you at that point.
          </p>
          <p className="mt-1">
            Tether Secure Browser establishes a verified session for your attempt and sends
            periodic status/heartbeat signals confirming that session is still active — this
            operational session evidence is reviewable by your lecturer alongside other integrity
            signals, in the same way as everything else on this page. As with every other feature
            here, this does not by itself make any misconduct determination.
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
          <h2 className="font-medium text-gray-900">AI Brainstorming Assistance, if enabled by your lecturer</h2>
          <p className="mt-1">
            Some lecturers enable a controlled AI assistant to help you understand a question,
            organise your ideas, or think through your reasoning. It will not provide the answer,
            the correct multiple-choice option, or write a submission-ready response for you —
            every response is checked by a separate verification step before it is shown to you,
            and requests for a direct answer are declined. Your prompts and the assistant&apos;s
            approved responses are recorded as part of the assessment record and are visible to
            your lecturer, in the same way your answers are. Using this assistant as intended is
            an allowed part of the exam, not an integrity concern, and does not affect your
            integrity risk score. See docs/controlled-ai-brainstorming-assistance-v1.md for the
            full design.
          </p>
        </section>

        <section>
          <h2 className="font-medium text-gray-900">Screen-share evidence, if enabled by your lecturer</h2>
          <p className="mt-1">
            Some lecturers require you to share your entire screen for the duration of the exam.
            You will be shown what this involves and asked to start sharing yourself — the exam
            cannot begin until you do. Only the video of your screen is shared: your microphone
            and system audio are never captured, and your screen is never continuously recorded,
            saved as a video, or streamed anywhere. Tether
            records when sharing starts, stops, or is restored as review signals, and, if your
            lecturer has enabled it, may save a limited number of still frames of your screen for
            review. These signals and frames are stored privately and are for your lecturer&apos;s
            review, not an automatic finding — an interruption to your screen share does not, by
            itself, mean you have done anything wrong. Because your entire display may be shared,
            we recommend closing anything unrelated to the exam beforehand. Screen sharing cannot
            detect a separate device, and on some browsers it cannot fully confirm that your whole
            screen (rather than a single window) was shared — you will be told if this applies to
            you. See docs/screen-share-evidence-v1.md for the full design.
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
            <strong>
              Tether does not automatically determine academic misconduct.
            </strong>{" "}
            Every integrity signal, evidence frame, and review status described on this page
            exists to support review by authorised institutional staff — never to make a decision
            on its own. This platform does not make grading or academic integrity decisions by
            itself. Your institution and your lecturer remain responsible for any assessment
            outcome, including any integrity finding.
          </p>
        </section>

        <section>
          <h2 className="font-medium text-gray-900">How long is exam integrity evidence kept?</h2>
          <p className="mt-1">
            Retention is set by your institution and applicable requirements. Tether&apos;s
            recommended evidence-retention approach is to keep integrity evidence through the
            applicable review/appeal period and a short administrative buffer, then securely
            remove it when it is no longer required, subject to any active investigation, appeal,
            or legal retention requirement.
          </p>
          <p className="mt-1">Your institution can provide the retention period that applies to your exam.</p>
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
