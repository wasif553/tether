"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";

export function NavBar() {
  const { data: session, status } = useSession();
  const pathname = usePathname();

  // Lecturer application shell v1 — /lecturer/** routes render their own
  // persistent sidebar (src/components/lecturer/LecturerShell.tsx) as
  // their navigation. Rendering this top nav there too would duplicate
  // navigation and the account/logout control. Every other route
  // (student, platform admin, unauthenticated, login/signup) keeps this
  // NavBar exactly as before — this early return is the ONLY change
  // made here for the redesign.
  if (pathname?.startsWith("/lecturer")) return null;

  return (
    <header className="flex items-center justify-between border-b border-[#E4E7EC] bg-white px-4 py-3">
      <Link href="/" className="font-semibold">
        Safe Exam System
      </Link>
      <nav className="flex items-center gap-4 text-sm">
        {status === "authenticated" && session.user.role === "LECTURER" && (
          <>
            <Link href="/lecturer">Dashboard</Link>
            <Link href="/lecturer/courses">Courses</Link>
            <Link href="/lecturer/question-banks">Question Banks</Link>
            <Link href="/lecturer/settings/lti">Canvas/LTI</Link>
            <Link href="/lecturer/pilot-readiness">Pilot Readiness</Link>
          </>
        )}
        {status === "authenticated" && session.user.role === "STUDENT" && (
          <Link href="/student">My Exams</Link>
        )}
        {status === "authenticated" && session.user.role === "PLATFORM_ADMIN" && (
          <Link href="/platform/institutions">Platform Institutions</Link>
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
