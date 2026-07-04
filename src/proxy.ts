import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { isSafeAppCallbackUrl } from "@/lib/safeCallbackUrl";

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const role = req.auth?.user?.role;

  // Safe Exam Deep Link v1 — when redirecting an unauthenticated visitor
  // to login, preserve where they were headed so login can send them
  // back afterward. Only ever set for the current request's own path
  // (validated by isSafeAppCallbackUrl, which allow-lists the student
  // join route and the authenticated lecturer area) — never a
  // caller-supplied value, so this cannot become an open redirect. See
  // docs/course-enrolment-and-exam-assignment.md.
  function loginRedirect(): NextResponse {
    const loginUrl = new URL("/login", req.url);
    if (isSafeAppCallbackUrl(pathname)) {
      loginUrl.searchParams.set("callbackUrl", pathname);
    }
    return NextResponse.redirect(loginUrl);
  }

  // PLATFORM_ADMIN may access lecturer-area and platform-admin-area
  // routes (they are not students, and have no separate student-facing
  // need), but never the student area.
  if (pathname.startsWith("/lecturer") && role !== "LECTURER" && role !== "PLATFORM_ADMIN") {
    return loginRedirect();
  }

  if (pathname.startsWith("/student") && role !== "STUDENT") {
    return loginRedirect();
  }

  if (pathname.startsWith("/platform") && role !== "PLATFORM_ADMIN") {
    return loginRedirect();
  }
});

export const config = {
  matcher: ["/lecturer/:path*", "/student/:path*", "/platform/:path*"],
};
