"use client";

// Lecturer application shell v1 — top-level layout for every /lecturer/**
// route: persistent sidebar (desktop) / drawer (tablet+mobile) plus a
// responsive content area with a consistent max width. Mounted once by
// src/app/lecturer/layout.tsx, so individual pages never re-implement
// navigation chrome. This is a client component (owns the mobile drawer
// open/close state); pages nested inside it can still be server or
// client components as they already are.
import { useState } from "react";
import Link from "next/link";
import { LecturerSidebar } from "./LecturerSidebar";
import { MenuIcon } from "./icons";

export function LecturerShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-staff-canvas">
      <LecturerSidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-lecturer-border bg-lecturer-surface px-4 py-3 md:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="rounded p-1.5 text-lecturer-text-secondary hover:bg-lecturer-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
            aria-label="Open navigation"
          >
            <MenuIcon className="h-5 w-5" />
          </button>
          <Link href="/lecturer" className="text-sm font-bold text-lecturer-text-primary">
            Tether
          </Link>
        </div>

        <main className="mx-auto w-full max-w-[1480px] flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
