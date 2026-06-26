import { auth } from "@/auth";
import Link from "next/link";

export default async function Home() {
  const session = await auth();

  return (
    <div className="mx-auto max-w-2xl py-16 text-center">
      <h1 className="text-3xl font-semibold">Safe Exam System</h1>
      <p className="mt-4 text-gray-600">
        A secure online assessment platform with integrity event logging, AI-assisted
        question creation and draft grading, and Canvas LTI integration.
      </p>

      {!session && (
        <div className="mt-8 flex justify-center gap-4">
          <Link href="/signup" className="rounded bg-black px-4 py-2 text-white">
            Get started
          </Link>
          <Link href="/login" className="rounded border border-gray-300 px-4 py-2">
            Log in
          </Link>
        </div>
      )}

      {session?.user.role === "LECTURER" && (
        <div className="mt-8">
          <Link href="/lecturer" className="rounded bg-black px-4 py-2 text-white">
            Go to dashboard
          </Link>
        </div>
      )}

      {session?.user.role === "STUDENT" && (
        <div className="mt-8">
          <Link href="/student" className="rounded bg-black px-4 py-2 text-white">
            View my exams
          </Link>
        </div>
      )}
    </div>
  );
}
