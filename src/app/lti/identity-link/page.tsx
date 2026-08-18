"use client";

/**
 * Canvas/LTI identity-collision hardening v1 — see
 * docs/lti-identity-collision-hardening-v1.md. Shown when a Canvas
 * launch's email matches an existing Tether account that the current
 * browser has not proven ownership of (or is otherwise not safe to
 * connect automatically). Small and commercial — no technical jargon,
 * no internal IDs.
 */

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { signOut } from "next-auth/react";

type Reason = "requires_login" | "wrong_account" | "role_mismatch" | "different_institution" | "canvas_id_taken";

function isReason(value: string | null): value is Reason {
  return (
    value === "requires_login" ||
    value === "wrong_account" ||
    value === "role_mismatch" ||
    value === "different_institution" ||
    value === "canvas_id_taken"
  );
}

function IdentityLinkContent() {
  const searchParams = useSearchParams();
  const reasonParam = searchParams.get("reason");
  const reason: Reason = isReason(reasonParam) ? reasonParam : "requires_login";

  if (reason === "requires_login") {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-xl font-semibold">Existing account found</h1>
        <p className="mt-4 text-gray-600">
          Tether found an existing account using the email supplied by Canvas. For security, we
          need you to confirm that account before connecting it.
        </p>
        <a
          href="/login"
          className="mt-6 inline-block rounded bg-black px-4 py-2 text-sm text-white"
        >
          Sign in to Tether
        </a>
        <p className="mt-4 text-xs text-gray-400">
          After signing in, return to Canvas and open this assessment again.
        </p>
      </div>
    );
  }

  if (reason === "wrong_account") {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-xl font-semibold">A different Tether account is currently signed in</h1>
        <p className="mt-4 text-gray-600">
          Sign out of Tether, sign in with the account associated with this Canvas identity, then
          open the assessment from Canvas again.
        </p>
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="mt-6 rounded bg-black px-4 py-2 text-sm text-white"
        >
          Sign out
        </button>
        <p className="mt-4 text-xs text-gray-400">
          Then sign in with the Tether account associated with your Canvas identity.
        </p>
      </div>
    );
  }

  // role_mismatch / different_institution / canvas_id_taken — all edge
  // cases without a self-service resolution; point to support rather
  // than exposing internal details about why.
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-semibold">Couldn&apos;t connect your Canvas identity</h1>
      <p className="mt-4 text-gray-600">
        This Canvas identity couldn&apos;t be connected to a Tether account automatically. Please
        contact your institution&apos;s Tether administrator for help.
      </p>
    </div>
  );
}

export default function LtiIdentityLinkPage() {
  return (
    <Suspense fallback={null}>
      <IdentityLinkContent />
    </Suspense>
  );
}
