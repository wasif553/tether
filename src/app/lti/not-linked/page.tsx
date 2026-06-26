"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";

function NotLinkedContent() {
  const searchParams = useSearchParams();
  const ref = searchParams.get("ref");
  const { data: session, status } = useSession();
  const isLecturer = status === "authenticated" && session?.user.role === "LECTURER";

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-semibold">Exam not linked yet</h1>

      {isLecturer ? (
        <>
          <p className="mt-4 text-gray-600">
            This Canvas assignment is not linked yet. Open Unmatched Canvas Launches to connect
            it to an SES exam.
          </p>
          <Link
            href="/lecturer/lti/unmatched-launches"
            className="mt-4 inline-block rounded bg-black px-4 py-2 text-sm text-white"
          >
            Open Unmatched Canvas Launches
          </Link>
        </>
      ) : (
        <p className="mt-4 text-gray-600">
          This Canvas assignment has not yet been connected to an SES exam. Please contact your
          lecturer — they can link this assignment from Safe Exam System.
        </p>
      )}

      {ref && <p className="mt-6 text-xs text-gray-400">Reference: {ref}</p>}
    </div>
  );
}

export default function LtiNotLinkedPage() {
  return (
    <Suspense fallback={null}>
      <NotLinkedContent />
    </Suspense>
  );
}
