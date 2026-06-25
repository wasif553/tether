import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { prisma } from "@/lib/prisma";
import { getPrivateKey, LTI_KEY_ID, LTI_SIGNING_ALG } from "@/lib/lti/keys";

const GRADE_SCOPE = "https://purl.imsglobal.org/spec/lti-ags/scope/score";
const ACCESS_TOKEN_TTL_SAFETY_MARGIN_MS = 30 * 1000;

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

type CanvasScorePayload = {
  userId: string;
  scoreGiven: number;
  scoreMaximum: number;
  comment: string;
  timestamp: string;
  activityProgress: "Completed";
  gradingProgress: "FullyGraded";
};

export type PushGradeResult =
  | { skipped: true; reason: string }
  | { success: true; skipped: false; canvasResponse: unknown }
  | { success: false; skipped: false; error: string; canvasResponse: unknown };

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

async function getAccessToken(platform: {
  id: string;
  clientId: string;
  tokenEndpoint: string;
}): Promise<string> {
  const cached = accessTokenCache.get(platform.id);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }

  const clientAssertion = await buildClientAssertion(platform.clientId, platform.tokenEndpoint);

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: clientAssertion,
    scope: GRADE_SCOPE,
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

  accessTokenCache.set(platform.id, {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000 - ACCESS_TOKEN_TTL_SAFETY_MARGIN_MS,
  });

  return json.access_token;
}

export async function pushGradeToCanvas(submissionId: string): Promise<PushGradeResult> {
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      exam: { include: { questions: true } },
      student: true,
    },
  });

  if (!submission) {
    return { skipped: true, reason: `Submission ${submissionId} not found` };
  }

  if (!submission.student.canvasUserId) {
    return { skipped: true, reason: "Submission's student is not an LTI/Canvas user" };
  }

  if (submission.totalScore == null) {
    return { skipped: true, reason: "Submission has no finalized score yet" };
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

  if (!launch || !launch.lineitems) {
    return { skipped: true, reason: "No LTI launch with a lineitems URL found for this submission" };
  }

  const platform = await prisma.ltiPlatform.findUnique({ where: { id: launch.platformId } });
  if (!platform) {
    return { skipped: true, reason: `LtiPlatform ${launch.platformId} not found` };
  }

  const maxScore = submission.exam.questions.reduce((sum, q) => sum + q.points, 0);

  try {
    const accessToken = await getAccessToken(platform);

    const payload: CanvasScorePayload = {
      userId: submission.student.canvasUserId,
      scoreGiven: submission.totalScore,
      scoreMaximum: maxScore,
      comment: "Graded by Safe Exam System",
      timestamp: new Date().toISOString(),
      activityProgress: "Completed",
      gradingProgress: "FullyGraded",
    };

    const scoresUrl = `${launch.lineitems}/scores`;
    const res = await fetch(scoresUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/vnd.ims.lis.v1.score+json",
      },
      body: JSON.stringify(payload),
    });

    const canvasResponse: unknown = await res.json().catch(() => null);

    if (!res.ok) {
      console.error(
        `LTI grade passback failed for submission ${submissionId}: HTTP ${res.status}`,
        canvasResponse,
      );
      return {
        success: false,
        skipped: false,
        error: `Canvas returned HTTP ${res.status}`,
        canvasResponse,
      };
    }

    await prisma.ltiLaunch.update({
      where: { id: launch.id },
      data: { submissionId },
    });

    console.log(`LTI grade passback succeeded for submission ${submissionId}`);
    return { success: true, skipped: false, canvasResponse };
  } catch (err) {
    console.error(`LTI grade passback errored for submission ${submissionId}:`, err);
    return {
      success: false,
      skipped: false,
      error: (err as Error).message,
      canvasResponse: null,
    };
  }
}
