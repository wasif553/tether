import { prisma } from "@/lib/prisma";

/** Masks a Canvas subject/user identifier for display — never the raw value. */
export function maskSubject(subject: string): string {
  if (subject.length <= 8) return `${subject.slice(0, 2)}***`;
  return `${subject.slice(0, 6)}…${subject.slice(-2)}`;
}

export function unmatchedLaunchWhere() {
  return { examId: null, resourceLinkId: { not: null } } as const;
}

export async function countUnmatchedLaunches(): Promise<number> {
  return prisma.ltiLaunch.count({ where: unmatchedLaunchWhere() });
}
