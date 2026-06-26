"use client";

import Link from "next/link";
import { useSession, signOut } from "next-auth/react";

export function NavBar() {
  const { data: session, status } = useSession();

  return (
    <header className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
      <Link href="/" className="font-semibold">
        Safe Exam System
      </Link>
      <nav className="flex items-center gap-4 text-sm">
        {status === "authenticated" && session.user.role === "LECTURER" && (
          <>
            <Link href="/lecturer">Dashboard</Link>
            <Link href="/lecturer/question-banks">Question Banks</Link>
            <Link href="/lecturer/pilot-readiness">Pilot Readiness</Link>
          </>
        )}
        {status === "authenticated" && session.user.role === "STUDENT" && (
          <Link href="/student">My Exams</Link>
        )}
        {status === "authenticated" ? (
          <>
            <span className="text-gray-500">{session.user.email}</span>
            <button onClick={() => signOut({ callbackUrl: "/" })} className="underline">
              Log out
            </button>
          </>
        ) : (
          status !== "loading" && (
            <>
              <Link href="/login">Log in</Link>
              <Link href="/signup">Sign up</Link>
            </>
          )
        )}
      </nav>
    </header>
  );
}
