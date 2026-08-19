"use client";

/**
 * Password Reset v1 — see docs/password-reset-v1.md. Same recovery flow
 * for STUDENT and LECTURER — no role selection on this page at all.
 */
import { useState } from "react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }).catch(() => {});

    // The public response is intentionally generic and never inspected
    // here — this page shows the same "check your email" state whether
    // or not an account exists, and even if the request itself failed
    // outright, since a distinguishable UI state would defeat the whole
    // point of the anti-enumeration response.
    setLoading(false);
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className="mx-auto mt-16 max-w-sm rounded-lg border border-gray-200 p-6">
        <h1 className="mb-4 text-xl font-semibold">Check your email</h1>
        <p className="text-sm text-gray-600">
          If an account exists for that email, we&apos;ve sent password reset instructions.
        </p>
        <p className="mt-4 text-sm text-gray-600">
          <a href="/login" className="underline">
            Back to log in
          </a>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-16 max-w-sm rounded-lg border border-gray-200 p-6">
      <h1 className="mb-4 text-xl font-semibold">Forgot password?</h1>
      <p className="mb-4 text-sm text-gray-600">
        Enter your email and we&apos;ll send you instructions to reset your password.
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium">Email</label>
          <input
            required
            type="email"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {loading ? "Sending..." : "Send reset instructions"}
        </button>
      </form>
      <p className="mt-4 text-sm text-gray-600">
        <a href="/login" className="underline">
          Back to log in
        </a>
      </p>
    </div>
  );
}
