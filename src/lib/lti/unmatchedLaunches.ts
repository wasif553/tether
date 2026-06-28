import { prisma } from "@/lib/prisma";
import { isPlatformAdmin, requireInstitutionId } from "@/lib/institutionScope";
import type { Session } from "next-auth";

/** Masks a Canvas subject/user identifier for display — never the raw value. */
export function maskSubject(subject: string): string {
  if (subject.length <= 8) return `${subject.slice(0, 2)}***`;
  return `${subject.slice(0, 6)}…${subject.slice(-2)}`;
}

export function unmatchedLaunchWhere() {
  return { examId: null, resourceLinkId: { not: null } } as const;
}

export async function countUnmatchedLaunches(session?: Session | null): Promise<number> {
  const institutionFilter =
    session && !isPlatformAdmin(session)
      ? { platform: { institutionId: requireInstitutionId(session) } }
      : {};
  return prisma.ltiLaunch.count({ where: { ...unmatchedLaunchWhere(), ...institutionFilter } });
}
