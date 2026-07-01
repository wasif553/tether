import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  isPlatformAdmin,
  institutionWhere,
  requireInstitutionId,
  institutionErrorResponse,
} from "@/lib/institutionScope";

const createCourseSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1),
  description: z.string().optional(),
  institutionId: z.string().optional(),
});

/**
 * Course, Enrolment, Exam Assignment, Scheduling v1 — see
 * docs/course-enrolment-and-exam-assignment.md.
 *
 * GET: PLATFORM_ADMIN sees all courses (optionally scoped by
 * ?institutionId=), a LECTURER sees courses they teach in their own
 * institution, a STUDENT is not permitted (course management only).
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role === "STUDENT") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const url = new URL(req.url);
    const institutionIdParam = url.searchParams.get("institutionId");

    if (isPlatformAdmin(session)) {
      const courses = await prisma.course.findMany({
        where: institutionIdParam ? { institutionId: institutionIdParam } : {},
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { enrollments: true, exams: true } } },
      });
      return NextResponse.json(courses);
    }

    // LECTURER: only courses they teach, within their own institution.
    const courses = await prisma.course.findMany({
      where: {
        ...institutionWhere(session),
        enrollments: { some: { userId: session.user.id, role: "LECTURER" } },
      },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { enrollments: true, exams: true } } },
    });
    return NextResponse.json(courses);
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

/**
 * POST: PLATFORM_ADMIN can create a course in any institution (must
 * supply institutionId). A LECTURER creates a course in their own
 * institution and is automatically enrolled as its LECTURER.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role === "STUDENT") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const parsed = createCourseSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    let institutionId: string;
    if (isPlatformAdmin(session)) {
      if (!parsed.data.institutionId) {
        return NextResponse.json(
          { error: "institutionId is required for platform admin course creation" },
          { status: 400 },
        );
      }
      institutionId = parsed.data.institutionId;
    } else {
      institutionId = requireInstitutionId(session);
    }

    const course = await prisma.course.create({
      data: {
        institutionId,
        name: parsed.data.name,
        code: parsed.data.code,
        description: parsed.data.description,
        // LECTURER creators are auto-enrolled as the course's lecturer so
        // GET /api/courses immediately shows it as "taught by me". A
        // platform admin creating on behalf of an institution is not
        // auto-enrolled — they are not necessarily a lecturer there.
        ...(session.user.role === "LECTURER"
          ? { enrollments: { create: { userId: session.user.id, role: "LECTURER" } } }
          : {}),
      },
    });

    return NextResponse.json(course, { status: 201 });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "A course with this code already exists in this institution" },
        { status: 409 },
      );
    }
    throw err;
  }
}

export const dynamic = "force-dynamic";
