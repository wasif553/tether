import { LecturerShell } from "@/components/lecturer/LecturerShell";

// Lecturer application shell v1 (preview/ui-redesign-2026-08-24) —
// mounts the persistent sidebar + responsive content shell
// (src/components/lecturer/LecturerShell.tsx) for every route under
// /lecturer/** (dashboard, exam workspace, submissions, integrity
// review, analytics, courses, question banks, settings, secure-client
// sessions, pilot readiness). Deliberately scoped to this one nested
// layout rather than the shared root layout, so the live student
// exam-taking surface, secure browser content, and lockdown UI — which
// never render under /lecturer — are completely unaffected. The global
// <NavBar> in the root layout hides itself on /lecturer/** routes (see
// src/components/nav-bar.tsx) so this shell's sidebar is the only
// navigation rendered here, never both at once.
//
// The negative margin cancels the root layout's <main className="px-4
// py-6"> padding so the sidebar/canvas bleed to the true viewport
// edges; LecturerShell's own <main> re-applies equivalent spacing
// around page content. Presentation-only — does not touch the shared
// root layout file itself.
export default function LecturerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="-mx-4 -my-6">
      <LecturerShell>{children}</LecturerShell>
    </div>
  );
}
