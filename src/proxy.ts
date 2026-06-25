import { auth } from "@/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const role = req.auth?.user?.role;

  if (pathname.startsWith("/lecturer") && role !== "LECTURER") {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  if (pathname.startsWith("/student") && role !== "STUDENT") {
    return NextResponse.redirect(new URL("/login", req.url));
  }
});

export const config = {
  matcher: ["/lecturer/:path*", "/student/:path*"],
};
