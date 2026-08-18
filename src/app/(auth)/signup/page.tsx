"use client";

/**
 * Self-Service Account Onboarding v1 — see
 * docs/self-service-account-onboarding-v1.md.
 *
 * Account creation does NOT grant exam access. A self-service STUDENT
 * lands with no institution and an empty dashboard until later given
 * access (Canvas / Tether Course / Standalone Exam Link — none of those
 * connection mechanisms exist yet). A self-service LECTURER gets a
 * brand-new Tether workspace (Institution) created for them — this page
 * never lets a caller select or join an EXISTING institution; joining one
 * still goes through that institution's own platform-admin invitation.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";

type Role = "STUDENT" | "LECTURER";

export default function SignupPage() {
  const router = useRouter();
  const [role, setRole] = useState<Role>("STUDENT");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [organisationName, setOrganisationName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const body =
      role === "STUDENT"
        ? { name, email, password, role }
        : { name, email, password, role, organisationName };

    const res = await fetch("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error?.formErrors?.[0] ?? data.error?.fieldErrors?.organisationName?.[0] ?? data.error ?? "Signup failed");
      setLoading(false);
      return;
    }

    const signInRes = await signIn("credentials", { email, password, redirect: false });

    setLoading(false);

    if (signInRes?.error) {
      setError("Account created, but sign-in failed. Try logging in.");
      router.push("/login");
      return;
    }

    router.push(role === "LECTURER" ? "/lecturer" : "/student");
  }

  return (
    <div className="mx-auto mt-16 max-w-sm rounded-lg border border-gray-200 p-6">
      <h1 className="mb-4 text-xl font-semibold">Create your Tether account</h1>

      <div className="mb-4">
        <span className="block text-sm font-medium">I am a</span>
        <div className="mt-1.5 flex gap-2">
          <button
            type="button"
            onClick={() => setRole("STUDENT")}
            className={`flex-1 rounded border px-3 py-2 text-sm ${
              role === "STUDENT" ? "border-black bg-black text-white" : "border-gray-300 text-gray-700"
            }`}
          >
            Student
          </button>
          <button
            type="button"
            onClick={() => setRole("LECTURER")}
            className={`flex-1 rounded border px-3 py-2 text-sm ${
              role === "LECTURER" ? "border-black bg-black text-white" : "border-gray-300 text-gray-700"
            }`}
          >
            Lecturer
          </button>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium">Name</label>
          <input
            required
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
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
        <div>
          <label className="block text-sm font-medium">Password</label>
          <input
            required
            type="password"
            minLength={8}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {role === "LECTURER" && (
          <div>
            <label className="block text-sm font-medium">Institution or organisation name</label>
            <input
              required
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={organisationName}
              onChange={(e) => setOrganisationName(e.target.value)}
              placeholder="e.g. Adelaide College"
            />
          </div>
        )}

        <p className="text-xs text-gray-500">
          {role === "STUDENT"
            ? "Your account is ready immediately. Exams will appear when you are given access."
            : "This creates a new Tether workspace for your organisation."}
        </p>

        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {loading ? "Creating account..." : "Sign up"}
        </button>
      </form>

      <p className="mt-3 text-xs text-gray-500">
        Already joining an existing Tether institution? Use the invitation provided by your institution.
      </p>

      <p className="mt-4 text-sm text-gray-600">
        Already have an account?{" "}
        <a href="/login" className="underline">
          Log in
        </a>
      </p>
    </div>
  );
}
