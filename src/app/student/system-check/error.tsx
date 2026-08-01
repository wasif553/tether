"use client";

/**
 * Tether System Check and Exam Readiness v1 — a renderer crash or
 * rejected promise on this page must never surface an unrestricted
 * error page (stack trace, internal message) to a student. Every
 * individual check already fails safely into its own result state, but
 * this boundary is the last line of defence if something outside that
 * still throws.
 */
export default function SystemCheckError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto mt-16 max-w-md rounded border border-gray-200 p-6 text-center">
      <h1 className="text-lg font-medium">Check this computer</h1>
      <p className="mt-3 text-sm text-gray-700">Something went wrong running this check. Your exam is not affected.</p>
      <button onClick={reset} className="mt-4 rounded bg-black px-4 py-2 text-sm text-white">
        Try again
      </button>
    </div>
  );
}
