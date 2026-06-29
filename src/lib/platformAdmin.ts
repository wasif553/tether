/**
 * Platform Admin Onboarding v2 — helpers shared by every /api/platform/*
 * route. See docs/platform-admin-onboarding.md.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isPlatformAdmin } from "@/lib/institutionScope";
import type { Prisma } from "@/generated/prisma/client";

type SessionLike = {
  user?: { id?: string; role?: string | null } | null;
} | null;

/**
 * Returns a 401/403 NextResponse if the session isn't a PLATFORM_ADMIN, or
 * null if it's fine to proceed. Use: `const denied = requirePlatformAdmin(session); if (denied) return denied;`
 */
export function requirePlatformAdmin(session: SessionLike): NextResponse | null {
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isPlatformAdmin(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

export async function createPlatformAuditLog(entry: {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  institutionId?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  return prisma.platformAuditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      institutionId: entry.institutionId ?? null,
      metadata: (entry.metadata as Prisma.InputJsonValue) ?? undefined,
    },
  });
}

/**
 * Normalizes a candidate institution slug: lowercase, ASCII letters/digits
 * only, words joined by single hyphens, no leading/trailing hyphens.
 * Does not check uniqueness — callers must check that separately.
 */
export function sanitizeInstitutionSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type InstitutionPayload = {
  name: string;
  slug: string;
  domain?: string | null;
  plan: string;
};

export type InstitutionPayloadError = { error: string };

/**
 * Validates a POST /api/platform/institutions body. Returns the
 * normalized payload on success, or an error message on failure — never
 * throws, so callers can map straight to a 400 response.
 */
export function validateInstitutionPayload(
  body: unknown,
): InstitutionPayload | InstitutionPayloadError {
  if (typeof body !== "object" || body === null) {
    return { error: "Request body must be an object" };
  }
  const { name, slug, domain, plan } = body as Record<string, unknown>;

  if (typeof name !== "string" || name.trim().length === 0) {
    return { error: "name is required" };
  }
  if (typeof slug !== "string" || slug.trim().length === 0) {
    return { error: "slug is required" };
  }
  const sanitizedSlug = sanitizeInstitutionSlug(slug);
  if (sanitizedSlug.length === 0) {
    return { error: "slug must contain at least one letter or digit" };
  }
  if (domain !== undefined && domain !== null && typeof domain !== "string") {
    return { error: "domain must be a string" };
  }
  if (plan !== undefined && typeof plan !== "string") {
    return { error: "plan must be a string" };
  }

  return {
    name: name.trim(),
    slug: sanitizedSlug,
    domain: typeof domain === "string" && domain.trim().length > 0 ? domain.trim() : null,
    plan: typeof plan === "string" && plan.trim().length > 0 ? plan.trim() : "pilot",
  };
}

export type InviteLecturerPayload = {
  name: string;
  email: string;
  password: string;
};

export type InviteLecturerPayloadError = { error: string };

/**
 * Validates a POST /api/platform/institutions/[id]/invite-lecturer body.
 * Email is normalized to lowercase. Password is required for v2 — there
 * is no email-sending flow yet, so the platform admin must hand the
 * lecturer a temporary password out of band.
 */
export function validateInviteLecturerPayload(
  body: unknown,
): InviteLecturerPayload | InviteLecturerPayloadError {
  if (typeof body !== "object" || body === null) {
    return { error: "Request body must be an object" };
  }
  const { name, email, password } = body as Record<string, unknown>;

  if (typeof name !== "string" || name.trim().length === 0) {
    return { error: "name is required" };
  }
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return { error: "a valid email is required" };
  }
  if (typeof password !== "string" || password.length < 8) {
    return { error: "password is required and must be at least 8 characters" };
  }

  return {
    name: name.trim(),
    email: email.trim().toLowerCase(),
    password,
  };
}
