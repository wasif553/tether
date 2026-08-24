// Lecturer application shell v1 — the one page-header pattern every
// lecturer route should use: optional breadcrumb, title, one-line
// description, right-aligned actions. Deliberately no large marketing
// hero (per design brief).
import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronRightIcon } from "./icons";

export type Breadcrumb = { label: string; href?: string };

export function LecturerPageHeader({
  breadcrumbs,
  title,
  description,
  actions,
}: {
  breadcrumbs?: Breadcrumb[];
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-1.5 flex flex-wrap items-center gap-1 text-xs text-lecturer-text-secondary">
            {breadcrumbs.map((crumb, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRightIcon className="h-3 w-3 text-lecturer-text-muted" />}
                {crumb.href ? (
                  <Link href={crumb.href} className="rounded hover:text-lecturer-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent">
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="text-lecturer-text-primary">{crumb.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        <h1 className="text-[28px] leading-tight font-bold text-lecturer-text-primary sm:text-[30px]">{title}</h1>
        {description && <p className="mt-1 text-sm text-lecturer-text-secondary">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

export function PrimaryButton({ className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`${BUTTON_BASE} bg-lecturer-accent text-white hover:bg-lecturer-accent-hover ${className}`} />;
}

export function SecondaryButton({ className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`${BUTTON_BASE} border border-lecturer-border bg-lecturer-surface font-medium text-lecturer-text-primary hover:bg-lecturer-border-subtle ${className}`}
    />
  );
}

export function PrimaryLinkButton({ className = "", href, children }: { className?: string; href: string; children: ReactNode }) {
  return (
    <Link href={href} className={`${BUTTON_BASE} bg-lecturer-accent text-white hover:bg-lecturer-accent-hover ${className}`}>
      {children}
    </Link>
  );
}

export function SecondaryLinkButton({ className = "", href, children }: { className?: string; href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={`${BUTTON_BASE} border border-lecturer-border bg-lecturer-surface font-medium text-lecturer-text-primary hover:bg-lecturer-border-subtle ${className}`}
    >
      {children}
    </Link>
  );
}
