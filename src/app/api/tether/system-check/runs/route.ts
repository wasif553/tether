/**
 * Tether System Check and Exam Readiness v1 — see
 * docs/tether-system-check-v1.md.
 *
 * POST /api/tether/system-check/runs — persists one completed "Check
 * this computer" run. The client reports what it observed for each
 * check, but this route NEVER simply trusts a client-supplied
 * status for the checks that actually decide readiness — authentication,
 * secure-client genuineness, client version, display topology, and
 * bridge availability are all recomputed here from server-verified data
 * or server-side comparisons, never from a renderer-provided boolean.
 * Camera, microphone, and network results are trusted as reported
 * (lying about one's OWN camera/network provides no advantage and these
 * are never required for READY or part of any security boundary — see
 * OPTIONAL_CHECK_IDS in readiness.ts); the clock check is also
 * recomputed here from the client's raw timestamp against this server's
 * own clock.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { systemCheckValidityHours, minimumSupportedTetherVersion } from "@/lib/systemCheckConfig";
import {
  CHECK_RESULT_STATES,
  isValidSystemCheckId,
  computeOverallStatus,
  computeExpiresAtMs,
  evaluateClientVersion,
  evaluateOperatingSystem,
  evaluateDisplayTopology,
  evaluateBridgeCapabilities,
  evaluateClockDifference,
  isValidDisplayTopologyClassification,
  MIN_RUN_INTERVAL_MS,
  type SystemCheckResults,
  type CheckResult,
} from "@/lib/systemCheck/readiness";

const SOURCE_CLIENT_TYPES = ["BROWSER", "TETHER_SECURE_CLIENT"] as const;

const checkResultSchema = z.object({
  status: z.enum(CHECK_RESULT_STATES),
  reasonCode: z.string().max(60).nullable().optional(),
});

const bridgeCapabilitiesSchema = z.object({
  getClientVersion: z.boolean(),
  getOperatingSystemInfo: z.boolean(),
  getDisplayTopology: z.boolean(),
  getSecureClientCapabilities: z.boolean(),
});

const bodySchema = z.object({
  sourceClientType: z.enum(SOURCE_CLIENT_TYPES),
  clientVersion: z.string().max(40).nullable().optional(),
  operatingSystem: z.string().max(40).nullable().optional(),
  operatingSystemVersion: z.string().max(60).nullable().optional(),
  secureClientSessionId: z.string().max(100).nullable().optional(),
  clientTimeMs: z.number().finite(),
  displayTopologyClassification: z.string().max(40).nullable().optional(),
  bridgeCapabilities: bridgeCapabilitiesSchema.nullable().optional(),
  // Self-reported results for the checks a client is trusted to assess
  // itself (camera, microphone, network) — see doc comment above. Any
  // entry for a server-decided check id is accepted here but silently
  // overwritten below, never used.
  results: z.record(z.string(), checkResultSchema),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawBody = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Malformed request", details: parsed.error.flatten() }, { status: 400 });
  }
  const body = parsed.data;

  // Reject a results payload carrying an unrecognised check id outright —
  // "impossible" per the fixed SYSTEM_CHECK_IDS set (Part: "reject
  // impossible or malformed result combinations").
  for (const key of Object.keys(body.results)) {
    if (!isValidSystemCheckId(key)) {
      return NextResponse.json({ error: `Unknown check id: ${key}` }, { status: 400 });
    }
  }

  // Sensible rate limiting (mirrors the dedupe-window pattern already
  // used by POST /api/submissions/[id]/session-heartbeat) — a fast retry
  // loop must not be able to flood this table.
  const lastRun = await prisma.tetherSystemCheckRun.findFirst({
    where: { userId: session.user.id },
    orderBy: { checkedAt: "desc" },
    select: { checkedAt: true },
  });
  if (lastRun && Date.now() - lastRun.checkedAt.getTime() < MIN_RUN_INTERVAL_MS) {
    return NextResponse.json({ error: "Please wait a moment before running the check again." }, { status: 429 });
  }

  // Secure-client session ownership (Part: "reject fabricated
  // secure-client session IDs" / "reject another student's secure-client
  // session"). Never trusted from the body alone — always re-verified
  // against the database, scoped to the authenticated student.
  let secureClientResult: CheckResult;
  if (body.secureClientSessionId) {
    const owned = await prisma.secureClientSession.findUnique({ where: { id: body.secureClientSessionId } });
    if (!owned || owned.studentId !== session.user.id) {
      return NextResponse.json({ error: "Secure-client session not found." }, { status: 404 });
    }
    secureClientResult = owned.verificationStatus === "VERIFIED" ? { status: "PASS", reasonCode: "SESSION_VERIFIED" } : { status: "BLOCKED", reasonCode: "SESSION_NOT_VERIFIED" };
  } else {
    // No session to reuse — a standalone check (the common case, run
    // before any exam attempt exists) cannot fabricate secure-client
    // genuineness from a renderer-provided boolean. This is the reason a
    // brand-new student's very first standalone check will show
    // "secure client: not checked" until they have taken (or started
    // launching) a Tether-delivered exam at least once — see
    // docs/tether-system-check-v1.md, "Known limitations".
    secureClientResult = { status: "NOT_CHECKED", reasonCode: "NO_SESSION_TO_VERIFY" };
  }

  const isTether = body.sourceClientType === "TETHER_SECURE_CLIENT";

  const clientVersionResult: CheckResult = isTether
    ? evaluateClientVersion(body.clientVersion ?? null, minimumSupportedTetherVersion())
    : { status: "NOT_CHECKED", reasonCode: "TETHER_NOT_DETECTED" };

  const displayTopologyResult: CheckResult = isTether
    ? evaluateDisplayTopology(
        body.displayTopologyClassification && isValidDisplayTopologyClassification(body.displayTopologyClassification) ? body.displayTopologyClassification : "ERROR",
      )
    : { status: "NOT_CHECKED", reasonCode: "TETHER_NOT_DETECTED" };

  const bridgeResult: CheckResult = isTether
    ? evaluateBridgeCapabilities(body.bridgeCapabilities ?? null)
    : { status: "NOT_CHECKED", reasonCode: "TETHER_NOT_DETECTED" };

  const operatingSystemResult: CheckResult = evaluateOperatingSystem(body.operatingSystem ?? null);
  const clockResult = evaluateClockDifference(body.clientTimeMs, Date.now());

  const finalResults: SystemCheckResults = {
    authentication: { status: "PASS", reasonCode: "AUTHENTICATED" },
    secureClient: secureClientResult,
    clientVersion: clientVersionResult,
    operatingSystem: operatingSystemResult,
    displayTopology: displayTopologyResult,
    bridge: bridgeResult,
    clock: { status: clockResult.status, reasonCode: clockResult.reasonCode },
    // Trusted as self-reported — see doc comment at the top of this file.
    network: body.results.network ?? { status: "NOT_CHECKED" },
    camera: body.results.camera ?? { status: "NOT_CHECKED" },
    microphone: body.results.microphone ?? { status: "NOT_CHECKED" },
  };

  const overallStatus = computeOverallStatus(finalResults);
  const checkedAt = new Date();
  const expiresAt = new Date(computeExpiresAtMs(checkedAt.getTime(), systemCheckValidityHours()));

  const run = await prisma.tetherSystemCheckRun.create({
    data: {
      userId: session.user.id,
      overallStatus,
      sourceClientType: body.sourceClientType,
      clientVersion: isTether ? (body.clientVersion ?? null) : null,
      operatingSystem: body.operatingSystem ?? null,
      operatingSystemVersion: body.operatingSystemVersion ?? null,
      secureClientSessionId: body.secureClientSessionId ?? null,
      checkedAt,
      expiresAt,
      resultsJson: finalResults as Prisma.InputJsonValue,
    },
  });

  return NextResponse.json({
    run: {
      id: run.id,
      overallStatus: run.overallStatus,
      checkedAt: run.checkedAt,
      expiresAt: run.expiresAt,
      results: finalResults,
    },
  });
}

export const dynamic = "force-dynamic";
