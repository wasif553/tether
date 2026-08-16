// Staff application surface polish v1 — applies the slightly stronger
// staff-canvas background (see --staff-canvas in globals.css) to every
// route under /lecturer/** (dashboard, exam workspace, submissions,
// integrity review, analytics, courses, question banks, settings,
// secure-client sessions, pilot readiness). Deliberately scoped to this
// one nested layout rather than the shared root layout/globals.css body
// background, so the live student exam-taking surface, secure browser
// content, and lockdown UI — which never render under /lecturer — are
// completely unaffected.
//
// The negative margin cancels the root layout's <main className="px-4
// py-6"> padding so the canvas bleeds to the same edges the old body
// background used to reach, then re-applies the same padding on top of
// it — this is presentation-only and does not touch the shared root
// layout file itself.
export default function LecturerLayout({ children }: { children: React.ReactNode }) {
  return <div className="-mx-4 -my-6 bg-staff-canvas px-4 py-6">{children}</div>;
}
