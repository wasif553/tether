"use client";

/**
 * Password Reset v1 — see docs/password-reset-v1.md. Same recovery flow
 * for STUDENT and LECTURER — no role selection on this page at all.
 *
 * Never distinguishes missing / unknown / expired / consumed token in the
 * UI — every failure (including a missing ?token= param) shows the same
 * friendly generic message, matching the API's own collapsed "invalid"
 * response (src/app/api/auth/reset-password/route.ts).
 */
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

const GENERIC_INVALID_MESSAGE = "This password reset link is invalid or has expired.";

function RequestNewLink() {
  return (
    <p className="mt-4 text-sm text-gray-600">
      <a href="/forgot-password" className="underline">
        Request a new reset link
      </a>
    </p>
  );
}

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [invalid, setInvalid] = useState(!token);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (!token) {
      setInvalid(true);
      return;
    }

    setLoading(true);
    const res = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    }).catch(() => null);
    setLoading(false);

    if (!res || !res.ok) {
      setInvalid(true);
      return;
    }

    setSuccess(true);
  }

  if (success) {
    return (
      <div className="mx-auto mt-16 max-w-sm rounded-lg border border-gray-200 p-6">
        <h1 className="mb-4 text-xl font-semibold">Password reset</h1>
        <p className="text-sm text-gray-600">Your password has been updated.</p>
        <p className="mt-4 text-sm text-gray-600">
          <a href="/login" className="underline">
            Log in
          </a>
        </p>
      </div>
    );
  }

  if (invalid) {
    return (
      <div className="mx-auto mt-16 max-w-sm rounded-lg border border-gray-200 p-6">
        <h1 className="mb-4 text-xl font-semibold">Reset password</h1>
        <p className="text-sm text-gray-600">{GENERIC_INVALID_MESSAGE}</p>
        <RequestNewLink />
      </div>
    );
  }

  return (
    <div className="mx-auto mt-16 max-w-sm rounded-lg border border-gray-200 p-6">
      <h1 className="mb-4 text-xl font-semibold">Reset password</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium">New password</label>
          <input
            required
            type="password"
            minLength={8}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm font-medium">Confirm new password</label>
          <input
            required
            type="password"
            minLength={8}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {loading ? "Resetting..." : "Reset password"}
        </button>
      </form>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
