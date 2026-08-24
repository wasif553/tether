"use client";

// Lecturer application shell v1 — persistent left sidebar for every
// /lecturer/** route. Desktop: always visible, fixed width. Tablet/
// mobile: collapses into a drawer toggled by LecturerShell's top bar.
// Active-item highlighting uses the single most specific (longest)
// matching href, so nested routes like /lecturer/settings/lti highlight
// "Canvas / LTI" and never simultaneously light up "Settings" too.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import type { ReactNode } from "react";
import {
  DashboardIcon,
  CoursesIcon,
  ExamsIcon,
  SubmissionsIcon,
  IntegrityIcon,
  ReportsIcon,
  QuestionBankIcon,
  LtiIcon,
  SettingsIcon,
  MoreIcon,
  LogoutIcon,
  UserIcon,
  ShieldLockIcon,
  CloseIcon,
} from "./icons";

type NavItem = { label: string; href: string; icon: (props: { className?: string }) => ReactNode };

const PRIMARY_NAV: NavItem[] = [
  { label: "Dashboard", href: "/lecturer", icon: DashboardIcon },
  { label: "Courses", href: "/lecturer/courses", icon: CoursesIcon },
  { label: "Exams", href: "/lecturer/exams", icon: ExamsIcon },
  { label: "Submissions", href: "/lecturer/submissions", icon: SubmissionsIcon },
  { label: "Integrity Signals", href: "/lecturer/integrity", icon: IntegrityIcon },
  { label: "Reports", href: "/lecturer/reports", icon: ReportsIcon },
];

const SECONDARY_NAV: NavItem[] = [
  { label: "Question Banks", href: "/lecturer/question-banks", icon: QuestionBankIcon },
  { label: "Canvas / LTI", href: "/lecturer/settings/lti", icon: LtiIcon },
  { label: "Settings", href: "/lecturer/settings", icon: SettingsIcon },
];

const MORE_NAV: NavItem[] = [
  { label: "Pilot Readiness", href: "/lecturer/pilot-readiness", icon: ShieldLockIcon },
  { label: "Unmatched launches", href: "/lecturer/lti/unmatched-launches", icon: MoreIcon },
];

const ALL_NAV = [...PRIMARY_NAV, ...SECONDARY_NAV, ...MORE_NAV];

function useActiveHref(pathname: string): string | null {
  let best: string | null = null;
  for (const item of ALL_NAV) {
    const matches = pathname === item.href || (item.href !== "/lecturer" && pathname.startsWith(`${item.href}/`));
    if (matches && (!best || item.href.length > best.length)) best = item.href;
  }
  return best;
}

function NavLink({ item, activeHref, onNavigate }: { item: NavItem; activeHref: string | null; onNavigate?: () => void }) {
  const active = item.href === activeHref;
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2.5 rounded-lg border-l-2 py-2 pr-3 pl-[10px] text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent ${
        active
          ? "border-lecturer-accent bg-lecturer-accent/[0.16] text-white"
          : "border-transparent text-lecturer-sidebar-text hover:bg-lecturer-sidebar-elevated hover:text-white"
      }`}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

export function LecturerSidebar({ mobileOpen, onClose }: { mobileOpen: boolean; onClose: () => void }) {
  const pathname = usePathname() ?? "/lecturer";
  const activeHref = useActiveHref(pathname);
  const { data: session } = useSession();

  return (
    <>
      {mobileOpen && <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={onClose} aria-hidden="true" />}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[248px] shrink-0 -translate-x-full flex-col bg-lecturer-sidebar transition-transform duration-200 md:sticky md:top-0 md:h-screen md:translate-x-0 ${
          mobileOpen ? "translate-x-0" : ""
        }`}
        aria-label="Lecturer navigation"
      >
        <div className="flex items-center justify-between gap-2 border-b border-lecturer-sidebar-border px-4 py-4">
          <Link href="/lecturer" className="min-w-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent" onClick={onClose}>
            <p className="truncate text-sm font-bold tracking-tight text-white">Tether</p>
            <p className="truncate text-xs text-lecturer-sidebar-text-muted">Safe Exam System · Lecturer</p>
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-lecturer-sidebar-text-muted hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent md:hidden"
            aria-label="Close navigation"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="space-y-0.5">
            {PRIMARY_NAV.map((item) => (
              <li key={item.href}>
                <NavLink item={item} activeHref={activeHref} onNavigate={onClose} />
              </li>
            ))}
          </ul>

          <div className="mt-5 border-t border-lecturer-sidebar-border pt-4">
            <ul className="space-y-0.5">
              {SECONDARY_NAV.map((item) => (
                <li key={item.href}>
                  <NavLink item={item} activeHref={activeHref} onNavigate={onClose} />
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-6 border-t border-lecturer-sidebar-border pt-5">
            <p className="px-3 pb-2 text-xs font-semibold tracking-widest text-lecturer-sidebar-text/80 uppercase">Advanced</p>
            <ul className="space-y-0.5">
              {MORE_NAV.map((item) => (
                <li key={item.href}>
                  <NavLink item={item} activeHref={activeHref} onNavigate={onClose} />
                </li>
              ))}
            </ul>
          </div>
        </nav>

        <div className="border-t border-lecturer-sidebar-border px-3 py-3">
          {session?.user && (
            <div className="flex items-center gap-2.5 rounded-lg px-3 py-2">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-lecturer-sidebar-elevated text-lecturer-sidebar-text">
                <UserIcon className="h-4 w-4" />
              </span>
              <span className="min-w-0 truncate text-xs text-lecturer-sidebar-text" title={session.user.email ?? undefined}>
                {session.user.email}
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={() => signOut({ callbackUrl: "/" })}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-lecturer-sidebar-text hover:bg-lecturer-sidebar-elevated hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
          >
            <LogoutIcon className="h-[18px] w-[18px] shrink-0" />
            Log out
          </button>
        </div>
      </aside>
    </>
  );
}
