export default function LockdownBrowserPage() {
  return (
    <div className="mx-auto max-w-2xl py-12">
      <h1 className="text-2xl font-semibold">SES Secure Exam Browser</h1>
      <p className="mt-2 text-sm text-gray-500">
        A native desktop client that adds OS-level detection and evidence
        logging on top of the browser-based Secure Exam Mode already built
        into this platform.
      </p>

      <div className="mt-6 space-y-6 text-sm leading-6 text-gray-700">
        <section>
          <h2 className="font-medium text-gray-900">What it does</h2>
          <p className="mt-1">
            SES Secure Exam Browser runs the exam inside a dedicated
            fullscreen window and watches for OS-level integrity signals —
            window focus changes, fullscreen exits, window minimizing,
            multiple displays, and requests to non-SES domains. These
            signals are recorded as evidence for your lecturer to review,
            the same way browser-based Secure Exam Mode signals are.
          </p>
        </section>

        <section>
          <h2 className="font-medium text-gray-900">What it does not do</h2>
          <p className="mt-1">
            This is <strong>detection and soft enforcement</strong>, not a
            cheat-proof or guaranteed-lockdown tool. It does not perform a
            full OS lockdown, does not block every possible OS-level
            action, does not stop other applications from running, and
            does not automatically detect cheating. Closing the app is
            always possible — it never traps you inside the window.
            Humans — your lecturer and institution — make the final
            academic integrity determination, not this app.
          </p>
        </section>

        <section>
          <h2 className="font-medium text-gray-900">Is this required?</h2>
          <p className="mt-1">
            Only if your institution or lecturer tells you it is. Many
            exams only use the browser-based Secure Exam Mode, which
            requires no separate download. If your exam requires this
            app, your institution will provide you with the installer
            directly and instructions for installing it.
          </p>
        </section>

        <section>
          <h2 className="font-medium text-gray-900">
            v1 pilot limitations
          </h2>
          <p className="mt-1">
            This is a controlled-pilot release. The installer is not
            code-signed or notarized, so Windows and macOS will show a
            security warning on first install — this is expected. There
            is no auto-update, no kiosk mode, and no managed/IT-fleet
            deployment path yet.
          </p>
        </section>

        <section>
          <h2 className="font-medium text-gray-900">
            Installers are provided by your institution
          </h2>
          <p className="mt-1">
            This page does not host a public download. Installers are
            distributed by the pilot operator directly to enrolled
            students and lecturers, alongside a step-by-step install
            guide covering installation, troubleshooting, and
            uninstallation for both Windows and macOS.
          </p>
        </section>

        <section>
          <h2 className="font-medium text-gray-900">
            When should I install or uninstall it?
          </h2>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>Install before your exam or pilot test session.</li>
            <li>
              Keep it installed for the full exam period if you have more
              SES exams.
            </li>
            <li>
              After your final SES exam, follow your institution&apos;s
              instructions.
            </li>
            <li>
              On personal devices, uninstall using Windows Apps or macOS
              Applications.
            </li>
            <li>
              On managed devices, your institution&apos;s IT team may
              install or remove it for you.
            </li>
            <li>
              SES Secure Exam Browser does not silently uninstall itself.
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}
