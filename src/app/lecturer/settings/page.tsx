import { auth } from "@/auth";
import { LecturerPageHeader, SecondaryLinkButton } from "@/components/lecturer/LecturerPageHeader";
import { SectionCard } from "@/components/lecturer/SectionCard";
import { LtiIcon, ShieldLockIcon, UserIcon } from "@/components/lecturer/icons";

// Lecturer application shell v1 — Settings landing page. No general
// settings page existed before this redesign, and none of these values
// are editable here (per design brief: "do not invent settings that
// cannot persist") — this is a read-only account summary plus a
// navigation hub into the configuration surfaces that already exist
// (Canvas/LTI connection, Pilot Readiness). A server component so it
// can read the session directly via auth(), matching this file's own
// existing sibling src/app/lecturer/settings/lti/page.tsx.
export default async function LecturerSettingsPage() {
  const session = await auth();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <LecturerPageHeader breadcrumbs={[{ label: "Dashboard", href: "/lecturer" }, { label: "Settings" }]} title="Settings" description="Your account and Tether integrations." />

      <SectionCard title="Account">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-lecturer-accent-subtle text-lecturer-accent-hover">
            <UserIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-lecturer-text-primary">{session?.user?.email}</p>
            <p className="text-xs text-lecturer-text-secondary">Lecturer</p>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Integrations">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-lecturer-border p-3">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#EFF6FF] text-[#1D4ED8]">
              <LtiIcon className="h-4.5 w-4.5" />
            </span>
            <div>
              <p className="text-sm font-medium text-lecturer-text-primary">Canvas / LTI</p>
              <p className="text-xs text-lecturer-text-secondary">Connect Tether with your LMS</p>
            </div>
          </div>
          <SecondaryLinkButton href="/lecturer/settings/lti" className="px-3 py-1.5">
            Manage →
          </SecondaryLinkButton>
        </div>
      </SectionCard>

      <SectionCard title="Operational tools">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-lecturer-border p-3">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-lecturer-border-subtle text-lecturer-text-secondary">
              <ShieldLockIcon className="h-4.5 w-4.5" />
            </span>
            <div>
              <p className="text-sm font-medium text-lecturer-text-primary">Pilot Readiness</p>
              <p className="text-xs text-lecturer-text-secondary">Deployment and configuration checks</p>
            </div>
          </div>
          <SecondaryLinkButton href="/lecturer/pilot-readiness" className="px-3 py-1.5">
            Open →
          </SecondaryLinkButton>
        </div>
      </SectionCard>
    </div>
  );
}
