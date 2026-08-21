"use client";

/**
 * Canvas/LTI identity-collision browser-flow hardening — see
 * docs/lti-identity-collision-hardening-v1.md.
 *
 * A normal, same-site Tether page — reached only via a redirect from the
 * (now cross-site-unsafe-for-session-reading) Canvas launch. Carries a
 * short-lived signed handoff token in `?handoff=`, never trusted on its
 * own: the actual link only happens after this page's own same-site POST
 * to /api/lti/identity-link/confirm, where the CURRENT authenticated
 * Tether session is re-verified against the handoff's candidate account.
 *
 * If not signed in, the "Sign in to Tether" link preserves this exact
 * page (with its handoff) as the post-login callback — guarded by
 * isSafeLtiIdentityLinkCallbackUrl (src/lib/safeCallbackUrl.ts) — so the
 * user lands right back here, still holding the same handoff, ready to
 * confirm. It never returns to the consumed Canvas launch itself.
 */

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";

type ConfirmResult = { ok: true } | { ok: false; reason: string };

const REASON_MESSAGES: Record<string, string> = {
  wrong_account: "This Canvas identity is associated with a different Tether account than the one you're signed in as.",
  invalid: "This connection link is no longer valid. Please return to Canvas and open the assessment again.",
};

function messageFor(reason: string): string {
  return (
    REASON_MESSAGES[reason] ??
    "This Canvas identity couldn't be connected automatically. Please contact your institution's Tether administrator."
  );
}

/**
 * Pure, hook-free — extracted so it's directly testable without a React
 * rendering harness (this repo has no DOM/testing-library dependency; see
 * docs/security-headers-csp-v1.md, "Identity-link escape test"). Builds
 * the exact same-page callbackUrl (guarded by
 * isSafeLtiIdentityLinkCallbackUrl in src/lib/safeCallbackUrl.ts, never
 * altered here) and the /login href that carries it.
 */
export function buildIdentityLinkSignInHref(handoff: string): { returnTo: string; loginHref: string } {
  const returnTo = `/lti/identity-link?handoff=${encodeURIComponent(handoff)}`;
  const loginHref = `/login?callbackUrl=${encodeURIComponent(returnTo)}`;
  return { returnTo, loginHref };
}

function IdentityLinkContent() {
  const searchParams = useSearchParams();
  const handoff = searchParams.get("handoff");
  const { data: session, status } = useSession();
  const [connecting, setConnecting] = useState(false);
  const [result, setResult] = useState<ConfirmResult | null>(null);

  async function handleConnect() {
    if (!handoff) return;
    setConnecting(true);
    const res = await fetch("/api/lti/identity-link/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handoff }),
    });
    const body = await res.json().catch(() => null);
    setConnecting(false);
    setResult(res.ok && body?.ok ? { ok: true } : { ok: false, reason: typeof body?.reason === "string" ? body.reason : "invalid" });
  }

  if (!handoff) {
    return (
      <div className="mx-auto mt-16 max-w-md rounded border border-gray-200 p-6 text-center">
        <h1 className="text-xl font-semibold">Connect your Canvas identity</h1>
        <p className="mt-4 text-gray-600">
          This connection link is no longer valid. Please return to Canvas and open the assessment
          again.
        </p>
      </div>
    );
  }

  if (result?.ok) {
    return (
      <div className="mx-auto mt-16 max-w-md rounded border border-gray-200 p-6 text-center">
        <h1 className="text-xl font-semibold">Canvas identity connected</h1>
        <p className="mt-4 text-gray-600">Return to Canvas and open the assessment again.</p>
      </div>
    );
  }

  if (result && !result.ok) {
    return (
      <div className="mx-auto mt-16 max-w-md rounded border border-gray-200 p-6 text-center">
        <h1 className="text-xl font-semibold">Couldn&apos;t connect your Canvas identity</h1>
        <p className="mt-4 text-gray-600">{messageFor(result.reason)}</p>
      </div>
    );
  }

  if (status === "loading") {
    return <p className="mx-auto mt-16 max-w-md text-center text-gray-500">Loading...</p>;
  }

  if (status !== "authenticated" || !session) {
    const { loginHref } = buildIdentityLinkSignInHref(handoff);
    return (
      <div className="mx-auto mt-16 max-w-md rounded border border-gray-200 p-6 text-center">
        <h1 className="text-xl font-semibold">Existing account found</h1>
        <p className="mt-4 text-gray-600">
          Tether found an existing account using the email supplied by Canvas. For security, sign
          in to confirm that this account belongs to you.
        </p>
        {/*
          target="_top" — /login is deliberately frame-denied (CSP
          frame-ancestors 'none' + X-Frame-Options: DENY; see
          docs/security-headers-csp-v1.md), so a normal same-frame
          navigation there would be blocked when this page is reached
          from an embedded Canvas LTI launch. This link is the one place
          that boundary must be crossed, and it does so the safe way: an
          explicit, user-initiated click that opens /login in the TOP-LEVEL
          browsing context instead, escaping the Canvas iframe entirely
          rather than weakening /login's clickjacking protection. This
          also avoids depending on third-party/embedded-iframe cookie
          behavior for the account-confirmation login. Never triggered
          automatically on page load — only this explicit click.
        */}
        <a
          href={loginHref}
          target="_top"
          className="mt-6 inline-block rounded bg-black px-4 py-2 text-sm text-white"
        >
          Sign in to Tether
        </a>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-16 max-w-md rounded border border-gray-200 p-6 text-center">
      <h1 className="text-xl font-semibold">You are signed in to Tether</h1>
      <p className="mt-4 text-gray-600">
        Confirm that this is the account you want to connect to your Canvas identity.
      </p>
      <button
        onClick={handleConnect}
        disabled={connecting}
        className="mt-6 rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {connecting ? "Connecting..." : "Connect Canvas identity"}
      </button>
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
