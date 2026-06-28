import { auth } from "@/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const role = req.auth?.user?.role;

  // PLATFORM_ADMIN may access lecturer-area and platform-admin-area
  // routes (they are not students, and have no separate student-facing
  // need), but never the student area.
  if (pathname.startsWith("/lecturer") && role !== "LECTURER" && role !== "PLATFORM_ADMIN") {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  if (pathname.startsWith("/student") && role !== "STUDENT") {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  if (pathname.startsWith("/platform") && role !== "PLATFORM_ADMIN") {
    return NextResponse.redirect(new URL("/login", req.url));
  }
});

export const config = {
  matcher: ["/lecturer/:path*", "/student/:path*", "/platform/:path*"],
};
