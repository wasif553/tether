import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload } from "jose";
import { prisma } from "@/lib/prisma";
import { findPlatformJwk } from "@/lib/lti/jwks-cache";
import { createSessionCookie } from "@/lib/lti/session";
import type { Prisma } from "@/generated/prisma/client";

const CONTEXT_CLAIM = "https://purl.imsglobal.org/spec/lti/claim/context";
const RESOURCE_LINK_CLAIM = "https://purl.imsglobal.org/spec/lti/claim/resource_link";
const AGS_ENDPOINT_CLAIM = "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint";
const ROLES_CLAIM = "https://purl.imsglobal.org/spec/lti/claim/roles";
const DEPLOYMENT_ID_CLAIM = "https://purl.imsglobal.org/spec/lti/claim/deployment_id";

type LtiContextClaim = { id?: string; title?: string };
type LtiResourceLinkClaim = { id?: string };
type LtiAgsEndpointClaim = { lineitem?: string; lineitems?: string; scope?: string[] };

function authFailed(reason: string): NextResponse {
  console.error(`LTI launch: authentication failed — ${reason}`);
  return NextResponse.json({ error: "Authentication failed" }, { status: 401 });
}

function invalidSession(reason: string): NextResponse {
  console.error(`LTI launch: invalid session — ${reason}`);
  return NextResponse.json({ error: "Invalid session" }, { status: 403 });
}

function extractRole(payload: JWTPayload): "LECTURER" | "STUDENT" {
  const roles = payload[ROLES_CLAIM];
  if (
    Array.isArray(roles) &&
    roles.some(
      (role) =>
        typeof role === "string" && (role.includes("Instructor") || role.includes("Administrator")),
    )
  ) {
    return "LECTURER";
  }
  return "STUDENT";
}

export async function POST(req: Request) {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return invalidSession("request body was not form-encoded");
  }

  const idToken = formData.get("id_token");
  const state = formData.get("state");

  if (typeof idToken !== "string" || typeof state !== "string") {
    return invalidSession("missing id_token or state in launch request");
  }

  const session = await prisma.ltiSession.findUnique({
    where: { state },
    include: { platform: true },
  });

  if (!session) {
    return invalidSession(`no LtiSession found for state "${state}"`);
  }
  if (session.consumed) {
    return invalidSession(`LtiSession ${session.id} was already consumed (replay attempt)`);
  }
  if (session.expiresAt < new Date()) {
    return invalidSession(`LtiSession ${session.id} expired at ${session.expiresAt.toISOString()}`);
  }

  const platform = session.platform;

  let kid: string | undefined;
  try {
    const header = decodeProtectedHeader(idToken);
    kid = typeof header.kid === "string" ? header.kid : undefined;
  } catch (err) {
    return authFailed(`could not decode JWT header: ${(err as Error).message}`);
  }

  let jwk;
  try {
    jwk = await findPlatformJwk(platform.jwksUrl, kid);
  } catch (err) {
    return authFailed(`could not fetch platform JWKS: ${(err as Error).message}`);
  }

  if (!jwk) {
    return authFailed(`no matching JWK found for kid "${kid ?? "(none)"}"`);
  }

  let payload: JWTPayload;
  try {
    const key = await importJWK(jwk, jwk.alg ?? "RS256");
    const verified = await jwtVerify(idToken, key, {
      issuer: platform.issuer,
      audience: platform.clientId,
    });
    payload = verified.payload;
  } catch (err) {
    return authFailed(`JWT verification failed: ${(err as Error).message}`);
  }

  if (payload.nonce !== session.nonce) {
    return invalidSession("nonce in id_token did not match LtiSession.nonce");
  }

  const consumed = await prisma.ltiSession.updateMany({
    where: { id: session.id, consumed: false },
    data: { consumed: true },
  });
  if (consumed.count === 0) {
    return invalidSession(`LtiSession ${session.id} was already consumed (replay attempt)`);
  }

  const canvasUserId = typeof payload.sub === "string" ? payload.sub : undefined;
  if (!canvasUserId) {
    return authFailed("id_token payload missing sub claim");
  }

  const name = typeof payload.name === "string" ? payload.name : "Canvas User";
  const email =
    typeof payload.email === "string" ? payload.email : `lti-${canvasUserId}@safe-exam-system.local`;

  const context = payload[CONTEXT_CLAIM] as LtiContextClaim | undefined;
  const resourceLink = payload[RESOURCE_LINK_CLAIM] as LtiResourceLinkClaim | undefined;
  const agsEndpoint = payload[AGS_ENDPOINT_CLAIM] as LtiAgsEndpointClaim | undefined;
  const deploymentId = typeof payload[DEPLOYMENT_ID_CLAIM] === "string"
    ? (payload[DEPLOYMENT_ID_CLAIM] as string)
    : undefined;

  const canvasCourseId = context?.id;
  const canvasAssignmentId = resourceLink?.id;
  const resourceLinkId = resourceLink?.id;
  const lineitems = agsEndpoint?.lineitems;
  const lineitemUrl = agsEndpoint?.lineitem;
  const agsScope = agsEndpoint?.scope;
  const role = extractRole(payload);

  let user = await prisma.user.findUnique({ where: { canvasUserId } });

  if (!user) {
    const randomPassword = randomBytes(32).toString("hex");
    const passwordHash = await bcrypt.hash(randomPassword, 12);
    user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        role,
        canvasUserId,
        canvasCourseIds: canvasCourseId ? [canvasCourseId] : [],
      },
    });
  } else {
    const updates: { name?: string; email?: string; canvasCourseIds?: string[] } = {};
    if (user.name !== name) updates.name = name;
    if (user.email !== email) updates.email = email;
    if (canvasCourseId && !user.canvasCourseIds.includes(canvasCourseId)) {
      updates.canvasCourseIds = [...user.canvasCourseIds, canvasCourseId];
    }
    if (Object.keys(updates).length > 0) {
      user = await prisma.user.update({ where: { id: user.id }, data: updates });
    }
  }

  // Route this launch to a linked SES exam, if the lecturer has set one up
  // for this Canvas resource link. Unmatched launches never auto-link to a
  // random exam — they fall back to a friendly "not linked" page (students)
  // or the dashboard (lecturers, who can link it themselves).
  const examLink = resourceLinkId
    ? await prisma.ltiExamLink.findUnique({
        where: { platformId_resourceLinkId: { platformId: platform.id, resourceLinkId } },
      })
    : null;

  const launch = await prisma.ltiLaunch.create({
    data: {
      platformId: platform.id,
      canvasUserId,
      canvasCourseId: canvasCourseId ?? "",
      canvasAssignmentId,
      lineitems,
      deploymentId,
      resourceLinkId,
      lineitemUrl,
      lineitemsUrl: lineitems,
      agsScopeJson: agsScope as Prisma.InputJsonValue | undefined,
      launchClaimsJson: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue,
      launchRole: role,
      examId: examLink?.examId,
    },
  });

  const cookie = await createSessionCookie({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  });

  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    console.error("LTI launch: missing required environment variable APP_URL");
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const notLinkedPath = `/lti/not-linked?ref=${launch.id}&role=${user.role}`;
  let redirectPath: string;

  if (user.role === "LECTURER") {
    if (examLink) {
      redirectPath = `/lecturer/exams/${examLink.examId}`;
    } else if (resourceLinkId) {
      redirectPath = notLinkedPath;
    } else {
      redirectPath = "/lecturer";
    }
  } else if (examLink) {
    const exam = await prisma.exam.findUnique({ where: { id: examLink.examId } });
    if (!exam || !exam.published) {
      redirectPath = notLinkedPath;
    } else {
      const submission = await prisma.submission.upsert({
        where: { examId_studentId: { examId: exam.id, studentId: user.id } },
        update: {},
        create: { examId: exam.id, studentId: user.id },
      });
      redirectPath = `/student/exams/${submission.id}`;
    }
  } else if (resourceLinkId) {
    // This looks like an assignment launch, but no exam has been linked yet.
    redirectPath = notLinkedPath;
  } else {
    redirectPath = "/student";
  }

  const response = NextResponse.redirect(new URL(redirectPath, appUrl), 302);
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}

export const dynamic = "force-dynamic";
