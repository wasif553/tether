import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { prisma } from "@/lib/prisma";
import { getPrivateKey, LTI_KEY_ID, LTI_SIGNING_ALG } from "@/lib/lti/keys";
import type { CanvasPassbackStatus, Prisma } from "@/generated/prisma/client";

export const AGS_SCORE_SCOPE = "https://purl.imsglobal.org/spec/lti-ags/scope/score";

const ACCESS_TOKEN_TTL_SAFETY_MARGIN_MS = 30 * 1000;
const SCORE_EPSILON = 0.001;

type AccessTokenCacheEntry = {
  accessToken: string;
  expiresAt: number;
};

const accessTokenCache = new Map<string, AccessTokenCacheEntry>();

type CanvasTokenResponse = {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
};

export type AgsScorePayload = {
  userId: string;
  scoreGiven: number;
  scoreMaximum: number;
  activityProgress: "Completed";
  gradingProgress: "FullyGraded";
  timestamp: string;
};

export type NormalizedScore = {
  scoreGiven: number;
  scoreMaximum: number;
  scorePct: number | null;
};

/** Clamps a raw score into [0, scoreMaximum] and computes the percentage. Pure — no I/O. */
export function normalizeScore(scoreGiven: number, scoreMaximum: number): NormalizedScore {
  const safeMax = Number.isFinite(scoreMaximum) && scoreMaximum > 0 ? scoreMaximum : 0;
  const clamped = Math.min(Math.max(scoreGiven, 0), safeMax);
  return {
    scoreGiven: clamped,
    scoreMaximum: safeMax,
    scorePct: safeMax > 0 ? (clamped / safeMax) * 100 : null,
  };
}

/** Builds the LTI-AGS score payload. Pure — no I/O. */
export function buildAgsScorePayload(params: {
  userId: string;
  scoreGiven: number;
  scoreMaximum: number;
  timestamp?: string;
}): AgsScorePayload {
  return {
    userId: params.userId,
    scoreGiven: params.scoreGiven,
    scoreMaximum: params.scoreMaximum,
    activityProgress: "Completed",
    gradingProgress: "FullyGraded",
    timestamp: params.timestamp ?? new Date().toISOString(),
  };
}

async function buildClientAssertion(clientId: string, tokenEndpoint: string): Promise<string> {
  const privateKey = await getPrivateKey();
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: LTI_SIGNING_ALG, kid: LTI_KEY_ID })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience(tokenEndpoint)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .setJti(randomUUID())
    .sign(privateKey);
}

/**
 * Exchanges a signed client assertion for a Canvas AGS access token
 * (OAuth2 client_credentials + private_key_jwt), cached in memory until
 * shortly before expiry. Never returns/logs the token to the browser.
 */
export async function getCanvasAccessToken(platformId: string): Promise<string> {
  const cached = accessTokenCache.get(platformId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }

  const platform = await prisma.ltiPlatform.findUnique({ where: { id: platformId } });
  if (!platform) {
    throw new Error(`LtiPlatform ${platformId} not found`);
  }

  const clientAssertion = await buildClientAssertion(platform.clientId, platform.tokenEndpoint);

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: clientAssertion,
    scope: AGS_SCORE_SCOPE,
  });

  const res = await fetch(platform.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Canvas token endpoint returned HTTP ${res.status}: ${text}`);
  }

  const json = (await res.json()) as CanvasTokenResponse;

  accessTokenCache.set(platformId, {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000 - ACCESS_TOKEN_TTL_SAFETY_MARGIN_MS,
  });

  return json.access_token;
}

export type PushGradeResult =
  | { skipped: true; reason: string; status: CanvasPassbackStatus }
  | { success: true; skipped: false; status: "SENT"; canvasResponse: unknown }
  | { success: false; skipped: false; status: "FAILED"; error: string; canvasResponse: unknown };

async function markStatus(
  submissionId: string,
  data: {
    status: CanvasPassbackStatus;
    ltiLaunchId?: string | null;
    scoreGiven?: number | null;
    scoreMaximum?: number | null;
    scorePct?: number | null;
    attemptedAt?: Date | null;
    sentAt?: Date | null;
    errorMessage?: string | null;
    canvasResponseJson?: unknown;
  },
) {
  const fields = {
    ...data,
    canvasResponseJson: (data.canvasResponseJson ?? undefined) as Prisma.InputJsonValue | undefined,
  };
  await prisma.canvasGradePassback.upsert({
    where: { submissionId },
    create: { submissionId, ...fields },
    update: fields,
  });
}

/**
 * Pushes a submission's final score to the Canvas gradebook via LTI-AGS.
 * Safe to call repeatedly: skips cleanly when the submission isn't an LTI
 * launch, isn't finalized, or lacks the AGS endpoint/scope it needs, and is
 * idempotent on repeat success (pass `force: true` to resend regardless).
 */
export async function pushGradeToCanvas(
  submissionId: string,
  options: { force?: boolean } = {},
): Promise<PushGradeResult> {
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      exam: { include: { questions: true } },
      student: true,
      gradePassback: true,
    },
  });

  if (!submission) {
    return { skipped: true, reason: `Submission ${submissionId} not found`, status: "SKIPPED" };
  }

  if (!submission.student.canvasUserId) {
    await markStatus(submissionId, { status: "SKIPPED", errorMessage: null });
    return {
      skipped: true,
      reason: "Submission's student is not an LTI/Canvas user",
      status: "SKIPPED",
    };
  }

  if (submission.status !== "GRADED" || submission.totalScore == null) {
    await markStatus(submissionId, { status: "NOT_READY", errorMessage: null });
    return { skipped: true, reason: "Submission has no finalized score yet", status: "NOT_READY" };
  }

  const launch = await prisma.ltiLaunch.findFirst({
    where: {
      OR: [
        { submissionId },
        { submissionId: null, canvasUserId: submission.student.canvasUserId },
      ],
    },
    orderBy: { createdAt: "desc" },
  });

  const scoresEndpoint = launch?.lineitemUrl ?? launch?.lineitemsUrl ?? launch?.lineitems;

  if (!launch || !scoresEndpoint) {
    await markStatus(submissionId, {
      status: "SKIPPED",
      ltiLaunchId: launch?.id ?? null,
      errorMessage: null,
    });
    return {
      skipped: true,
      reason: "No LTI launch with an AGS lineitem URL found for this submission",
      status: "SKIPPED",
    };
  }

  const grantedScopes = launch.agsScopeJson as string[] | null;
  if (Array.isArray(grantedScopes) && !grantedScopes.includes(AGS_SCORE_SCOPE)) {
    await markStatus(submissionId, {
      status: "NOT_READY",
      ltiLaunchId: launch.id,
      errorMessage: "Platform did not grant the AGS score scope at launch time",
    });
    return {
      skipped: true,
      reason: "Platform did not grant the AGS score scope at launch time",
      status: "NOT_READY",
    };
  }

  const maxScore = submission.exam.questions.reduce((sum, q) => sum + q.points, 0);
  const normalized = normalizeScore(submission.totalScore, maxScore);

  const existing = submission.gradePassback;
  if (
    !options.force &&
    existing?.status === "SENT" &&
    existing.scoreGiven != null &&
    Math.abs(existing.scoreGiven - normalized.scoreGiven) < SCORE_EPSILON
  ) {
    return { success: true, skipped: false, status: "SENT", canvasResponse: existing.canvasResponseJson };
  }

  await markStatus(submissionId, {
    status: "PENDING",
    ltiLaunchId: launch.id,
    scoreGiven: normalized.scoreGiven,
    scoreMaximum: normalized.scoreMaximum,
    scorePct: normalized.scorePct,
    attemptedAt: new Date(),
  });

  try {
    const accessToken = await getCanvasAccessToken(launch.platformId);

    const payload = buildAgsScorePayload({
      userId: submission.student.canvasUserId,
      scoreGiven: normalized.scoreGiven,
      scoreMaximum: normalized.scoreMaximum,
    });

    const res = await fetch(`${scoresEndpoint}/scores`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/vnd.ims.lis.v1.score+json",
      },
      body: JSON.stringify(payload),
    });

    const canvasResponse: unknown = await res.json().catch(() => null);

    if (!res.ok) {
      const errorMessage = `Canvas returned HTTP ${res.status}`;
      console.error(`LTI grade passback failed for submission ${submissionId}: HTTP ${res.status}`, canvasResponse);
      await markStatus(submissionId, {
        status: "FAILED",
        ltiLaunchId: launch.id,
        errorMessage,
        canvasResponseJson: canvasResponse,
      });
      return { success: false, skipped: false, status: "FAILED", error: errorMessage, canvasResponse };
    }

    await prisma.ltiLaunch.update({ where: { id: launch.id }, data: { submissionId } });
    await markStatus(submissionId, {
      status: "SENT",
      ltiLaunchId: launch.id,
      sentAt: new Date(),
      errorMessage: null,
      canvasResponseJson: canvasResponse,
    });

    console.log(`LTI grade passback succeeded for submission ${submissionId}`);
    return { success: true, skipped: false, status: "SENT", canvasResponse };
  } catch (err) {
    const errorMessage = "Unable to reach Canvas to deliver the grade";
    console.error(`LTI grade passback errored for submission ${submissionId}:`, err);
    await markStatus(submissionId, {
      status: "FAILED",
      ltiLaunchId: launch.id,
      errorMessage,
    });
    return { success: false, skipped: false, status: "FAILED", error: errorMessage, canvasResponse: null };
  }
}
