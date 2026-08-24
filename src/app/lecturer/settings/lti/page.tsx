import Link from "next/link";
import { LecturerPageHeader, PrimaryLinkButton } from "@/components/lecturer/LecturerPageHeader";
import { SectionCard } from "@/components/lecturer/SectionCard";

export default function LtiSettingsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <LecturerPageHeader
        breadcrumbs={[{ label: "Dashboard", href: "/lecturer" }, { label: "Settings", href: "/lecturer/settings" }, { label: "Canvas / LTI" }]}
        title="Canvas / LTI"
        description="Connect Tether with your LMS. Canvas is an optional integration — Tether works fully without it."
      />

      <SectionCard title="Unmatched Canvas launches" subtitle="Canvas launches that haven't been connected to a Tether exam yet show up here.">
        <PrimaryLinkButton href="/lecturer/lti/unmatched-launches">Open unmatched Canvas launches</PrimaryLinkButton>
      </SectionCard>

      <SectionCard title="Recommended Canvas validation flow">
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-lecturer-text-primary">
          <li>Configure the Canvas Developer Key (see the Canvas sandbox test guide).</li>
          <li>Install the tool in the Canvas course.</li>
          <li>Create a Canvas assignment using Tether as the external tool.</li>
          <li>Launch the assignment once, as lecturer or student.</li>
          <li>Open Unmatched Canvas Launches.</li>
          <li>Link the Canvas resource to a Tether exam.</li>
          <li>Relaunch and confirm it now routes straight to the exam.</li>
          <li>
            Submit and verify Canvas passback reaches <strong>SENT</strong>.
          </li>
        </ol>
      </SectionCard>

      <Link href="/lecturer/pilot-readiness" className="text-sm font-medium text-lecturer-accent hover:text-lecturer-accent-hover">
        View pilot readiness →
      </Link>
    </div>
  );
}
