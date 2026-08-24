// Lecturer application shell v1 — small dependency-free outline icon set.
// No icon package exists in this repo (package.json has none, and no
// lecturer page previously imported one), so these are hand-authored
// inline SVGs rather than a new dependency. Every icon shares a 20x20
// viewBox, 1.5 stroke width, round joins, and `aria-hidden` — treat this
// file as the ONLY place lecturer icon markup lives; import from here
// rather than inlining new <svg> icons on individual pages.
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function DashboardIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.75" y="2.75" width="6.5" height="7.5" rx="1.25" />
      <rect x="10.75" y="2.75" width="6.5" height="4.5" rx="1.25" />
      <rect x="10.75" y="9.75" width="6.5" height="7.5" rx="1.25" />
      <rect x="2.75" y="12.75" width="6.5" height="4.5" rx="1.25" />
    </Icon>
  );
}

export function CoursesIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 3.5 2.5 7l7.5 3.5L17.5 7 10 3.5Z" />
      <path d="M5 8.75v4.25c0 .9 2.24 2 5 2s5-1.1 5-2V8.75" />
    </Icon>
  );
}

export function ExamsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.75 2.75h6.6l2.9 2.9v10.6a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1V3.75a1 1 0 0 1 1-1Z" />
      <path d="M12.25 2.75v2.9h2.9" />
      <path d="M7 10.5 8.7 12.2 13 8" />
    </Icon>
  );
}

export function SubmissionsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6.25a1.5 1.5 0 0 1 1.5-1.5h9a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 15.25v-9Z" />
      <path d="M7 3.25v3M13 3.25v3M4 9.25h12" />
    </Icon>
  );
}

export function IntegrityIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 2.75 16.25 5v4.5c0 4-2.7 6.7-6.25 8-3.55-1.3-6.25-4-6.25-8V5L10 2.75Z" />
      <path d="M7.5 9.75 9.2 11.4 12.75 7.5" />
    </Icon>
  );
}

export function ReportsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 16.25v-6M8.5 16.25v-9M13.5 16.25v-4M16.5 16.25H3" />
    </Icon>
  );
}

export function QuestionBankIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.25" y="3.75" width="13.5" height="12.5" rx="1.5" />
      <path d="M6.75 7.5h6.5M6.75 10.25h6.5M6.75 13h4" />
    </Icon>
  );
}

export function LtiIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7.5 6.25H5.75a2 2 0 0 0-2 2v3.5a2 2 0 0 0 2 2H7.5" />
      <path d="M12.5 6.25h1.75a2 2 0 0 1 2 2v3.5a2 2 0 0 1-2 2H12.5" />
      <path d="M7 10h6" />
    </Icon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 3.25v1.6M10 15.15v1.6M16.75 10h-1.6M4.85 10H3.25M14.8 5.2l-1.13 1.13M6.33 13.67 5.2 14.8M14.8 14.8l-1.13-1.13M6.33 6.33 5.2 5.2" />
    </Icon>
  );
}

export function MoreIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="4.5" cy="10" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="10" cy="10" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="10" r="1.15" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 5.5h14M3 10h14M3 14.5h14" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 5l10 10M15 5 5 15" />
    </Icon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7.5 4.5 13 10l-5.5 5.5" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 7.5 10 13l5.5-5.5" />
    </Icon>
  );
}

export function HelpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="10" cy="10" r="7.25" />
      <path d="M7.75 7.9a2.25 2.25 0 1 1 3.2 2.04c-.66.33-1.2.8-1.2 1.56v.3" />
      <circle cx="10" cy="14.1" r="0.15" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function LogoutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8.75 3.25H5.5a1.5 1.5 0 0 0-1.5 1.5v10.5a1.5 1.5 0 0 0 1.5 1.5h3.25" />
      <path d="M13 6.5l3.5 3.5-3.5 3.5M16.25 10h-9" />
    </Icon>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="10" cy="6.75" r="3" />
      <path d="M3.75 16.25c.9-3.1 3.4-5 6.25-5s5.35 1.9 6.25 5" />
    </Icon>
  );
}

export function ShieldLockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 2.75 16.25 5v4.5c0 4-2.7 6.7-6.25 8-3.55-1.3-6.25-4-6.25-8V5L10 2.75Z" />
      <rect x="7.75" y="9.25" width="4.5" height="3.75" rx="0.9" />
      <path d="M8.5 9.25V8a1.5 1.5 0 0 1 3 0v1.25" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 4.5v11M4.5 10h11" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8.75" cy="8.75" r="5" />
      <path d="M12.6 12.6 16.5 16.5" />
    </Icon>
  );
}
