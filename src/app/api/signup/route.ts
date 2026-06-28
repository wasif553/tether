import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { DEFAULT_INSTITUTION_SLUG } from "@/lib/institutionScope";

const signupSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["LECTURER", "STUDENT"]),
});

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { name, email, password, role } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "Email already registered" }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  // For v1 pilot: every self-signup lands in the default institution.
  // Do not add a complex invite/institution-code flow now (see
  // docs/multi-tenant-migration.md).
  const defaultInstitution = await prisma.institution.findUnique({
    where: { slug: DEFAULT_INSTITUTION_SLUG },
  });
  const user = await prisma.user.create({
    data: { name, email, passwordHash, role, institutionId: defaultInstitution?.id ?? null },
  });

  return NextResponse.json({ id: user.id, email: user.email });
}

export const dynamic = "force-dynamic";
