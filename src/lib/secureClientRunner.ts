/**
 * Tether Secure Client Foundation v1 — server-only orchestration. See
 * docs/secure-client-foundation-seb-v1.md.
 *
 * Touches Prisma, so it must never be imported from a "use client"
 * component — all pure decision logic lives in
 * src/lib/secureClientPolicy.ts and src/lib/secureClient/*.ts instead.
 * Concurrency-safe: every mutating entry point that needs it runs inside
 * a transaction guarded by a transaction-scoped advisory lock keyed on
 * submissionId (`pg_advisory_xact_lock`), mirroring
 * src/lib/answerDevelopmentRunner.ts and src/lib/aiAssistanceRunner.ts.
 */
import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { encryptSebKeyValue, decryptSebKeyValue } from "@/lib/secureClient/sebKeyEncryption";
import { computeKeyLookupHash, validateSebRequestHash } from "@/lib/secureClient/sebBrowserExamKey";
import {
  type SecureLaunchManifest,
  SECURE_LAUNCH_MANIFEST_SCHEMA_VERSION,
  SECURE_LAUNCH_MANIFEST_ISSUER,
  generateLaunchNonce,
  hashNonce,
  computeManifestHash,
  computePolicyHash,
  computeStudentSubjectHash,
  signManifest,
  validateManifestContext,
} from "@/lib/secureClient/secureLaunchManifest";
import { resolveExamAttestationMode } from "@/lib/tetherAttestationConfig";
import {
  overallStatusFromChecks,
  normaliseChecksForClientType,
  checksSupportedByClientType,
  isValidReportedDisplayCount,
  isValidDisplayTopology,
  type AttestationCheckKey,
  type AttestationChecks,
  type RequiredChecks,
  type DisplayTopology,
} from "@/lib/secureClient/attestation";
import {
  DEFAULT_SECURE_CLIENT_EVENT_LEVEL,
  validateSecureClientEventMetadata,
  checkSequenceNumber,
  type SecureClientEventType,
} from "@/lib/secureClient/secureClientEvents";
import { deriveSessionStatus, checkRecoveryGrant, type SessionStatus } from "@/lib/secureClient/secureClientSession";
import { parseSecureClientPolicy, isSecureClientDeliveryEnabled, type SecureClientPolicy } from "@/lib/secureClientPolicy";
import { createPlatformAuditLog } from "@/lib/platformAdmin";

type DbClient = Prisma.TransactionClient | typeof prisma;

async function acquireSubmissionLock(db: DbClient, submissionId: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${submissionId}))`;
}

export class SecureClientError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Signing keys (Part 6) — read once from server env. Never generated or
// committed by this codebase.
// ---------------------------------------------------------------------------

export function getSigningPrivateKey(): string {
  const key = process.env.TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY;
  if (!key) throw new SecureClientError(500, "SIGNING_KEY_NOT_CONFIGURED", "Secure-client launch signing is not configured.");
  return key;
}
export function getSigningPublicKey(): string {
  const key = process.env.TETHER_SECURE_CLIENT_SIGNING_PUBLIC_KEY;
  if (!key) throw new SecureClientError(500, "SIGNING_KEY_NOT_CONFIGURED", "Secure-client launch signing is not configured.");
  return key;
}
export function getSigningKeyId(): string {
  return process.env.TETHER_SECURE_CLIENT_SIGNING_KEY_ID ?? "dev-key-1";
}

// ---------------------------------------------------------------------------
// Shared student-route context loading (Part 7) — mirrors
// loadValidatedStudentContext in src/lib/answerDevelopmentRunner.ts.
// ---------------------------------------------------------------------------

export type StudentSecureClientContext = {
  submission: {
    id: string;
    examId: string;
    studentId: string;
    status: string;
    institutionId: string | null;
  };
  policy: SecureClientPolicy;
};

export async function loadValidatedSecureClientSubmission(submissionId: string, studentId: string): Promise<StudentSecureClientContext> {
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: { exam: { select: { institutionId: true } } },
  });
  if (!submission || submission.studentId !== studentId) {
    throw new SecureClientError(404, "NOT_FOUND", "Not found");
  }
  if (submission.status !== "IN_PROGRESS") {
    throw new SecureClientError(409, "NOT_IN_PROGRESS", "This submission is no longer active");
  }
  const policy = parseSecureClientPolicy(submission.secureClientPolicySnapshotJson);
  if (!isSecureClientDeliveryEnabled(policy)) {
    throw new SecureClientError(403, "NOT_ENABLED", "Secure-client delivery is not enabled for this exam");
  }
  return {
    submission: { id: submission.id, examId: submission.examId, studentId: submission.studentId, status: submission.status, institutionId: submission.exam.institutionId },
    policy,
  };
}

/** For routes keyed by sessionId rather than submissionId — resolves the session, then re-validates ownership/policy the same way. */
export async function loadValidatedSecureClientSession(sessionId: string, studentId: string) {
  const session = await prisma.secureClientSession.findUnique({ where: { id: sessionId } });
  if (!session || session.studentId !== studentId) {
    throw new SecureClientError(404, "NOT_FOUND", "Not found");
  }
  const context = await loadValidatedSecureClientSubmission(session.submissionId, studentId).catch((err) => {
    // A terminal/ended session's parent submission may no longer be
    // IN_PROGRESS — that's expected for end-of-attempt routes, so only
    // ownership (404) is fatal here, not liveness.
    if (err instanceof SecureClientError && err.code === "NOT_FOUND") throw err;
    return null;
  });
  return { session, context };
}

// ---------------------------------------------------------------------------
// Configuration management (Part 4)
// ---------------------------------------------------------------------------

export type ConfigurationInput = {
  institutionId: string;
  examId: string;
  provider: "SAFE_EXAM_BROWSER" | "TETHER_SECURE_CLIENT";
  displayName?: string | null;
  startUrlTemplate?: string | null;
  quitUrlTemplate?: string | null;
  allowedOrigins?: string[];
  allowedPlatforms?: string[];
  minimumVersions?: Record<string, string>;
  settings?: Record<string, unknown>;
};

export async function createDraftConfiguration(input: ConfigurationInput, createdById: string) {
  return prisma.secureClientConfiguration.create({
    data: {
      institutionId: input.institutionId,
      examId: input.examId,
      provider: input.provider,
      status: "DRAFT",
      displayName: input.displayName ?? null,
      startUrlTemplate: input.startUrlTemplate ?? null,
      quitUrlTemplate: input.quitUrlTemplate ?? null,
      allowedOriginsJson: (input.allowedOrigins ?? []) as Prisma.InputJsonValue,
      allowedPlatformsJson: (input.allowedPlatforms ?? []) as Prisma.InputJsonValue,
      minimumVersionsJson: (input.minimumVersions ?? {}) as Prisma.InputJsonValue,
      settingsJson: (input.settings ?? {}) as Prisma.InputJsonValue,
      createdById,
    },
  });
}

export async function updateDraftConfiguration(configurationId: string, input: Partial<ConfigurationInput>) {
  const existing = await prisma.secureClientConfiguration.findUnique({ where: { id: configurationId } });
  if (!existing) throw new SecureClientError(404, "NOT_FOUND", "Configuration not found");
  if (existing.status !== "DRAFT") {
    throw new SecureClientError(409, "NOT_DRAFT", "Only a DRAFT configuration may be edited — activated records may be revoked but not silently edited.");
  }
  return prisma.secureClientConfiguration.update({
    where: { id: configurationId },
    data: {
      displayName: input.displayName ?? existing.displayName,
      startUrlTemplate: input.startUrlTemplate ?? existing.startUrlTemplate,
      quitUrlTemplate: input.quitUrlTemplate ?? existing.quitUrlTemplate,
      allowedOriginsJson: (input.allowedOrigins as Prisma.InputJsonValue) ?? existing.allowedOriginsJson ?? undefined,
      allowedPlatformsJson: (input.allowedPlatforms as Prisma.InputJsonValue) ?? existing.allowedPlatformsJson ?? undefined,
      minimumVersionsJson: (input.minimumVersions as Prisma.InputJsonValue) ?? existing.minimumVersionsJson ?? undefined,
      settingsJson: (input.settings as Prisma.InputJsonValue) ?? existing.settingsJson ?? undefined,
      configurationVersion: { increment: 1 },
    },
  });
}

function computeConfigurationHash(config: { settingsJson: unknown; allowedOriginsJson: unknown; allowedPlatformsJson: unknown; minimumVersionsJson: unknown }): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        settings: config.settingsJson,
        origins: config.allowedOriginsJson,
        platforms: config.allowedPlatformsJson,
        versions: config.minimumVersionsJson,
      }),
    )
    .digest("hex");
}

/** Activates a DRAFT configuration, computing its immutable configurationHash. Enforces "only one ACTIVE per exam+provider" — the real guarantee is the migration's partial unique index; this also checks first, defense in depth. */
export async function activateConfiguration(configurationId: string, activatedById: string) {
  return prisma.$transaction(async (tx) => {
    const config = await tx.secureClientConfiguration.findUnique({ where: { id: configurationId } });
    if (!config) throw new SecureClientError(404, "NOT_FOUND", "Configuration not found");
    if (config.status !== "DRAFT") throw new SecureClientError(409, "NOT_DRAFT", "Only a DRAFT configuration can be activated");

    const existingActive = await tx.secureClientConfiguration.findFirst({
      where: { examId: config.examId, provider: config.provider, status: "ACTIVE" },
    });
    if (existingActive) {
      throw new SecureClientError(409, "ALREADY_ACTIVE", "This exam already has an active configuration for this provider — revoke it first.");
    }

    try {
      return await tx.secureClientConfiguration.update({
        where: { id: configurationId },
        data: {
          status: "ACTIVE",
          configurationHash: computeConfigurationHash(config),
          activatedById,
          activatedAt: new Date(),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new SecureClientError(409, "ALREADY_ACTIVE", "This exam already has an active configuration for this provider.");
      }
      throw err;
    }
  });
}

export async function revokeConfiguration(configurationId: string, revokedById: string) {
  return prisma.secureClientConfiguration.update({
    where: { id: configurationId },
    data: { status: "REVOKED", revokedById, revokedAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// SEB allowed key management (Part 4/5)
// ---------------------------------------------------------------------------

export type AddSebKeyInput = {
  configurationId: string;
  keyType: "BROWSER_EXAM_KEY" | "CONFIG_KEY";
  rawKey: string;
  platform?: string | null;
  clientVersion?: string | null;
  label?: string | null;
};

export async function addSebAllowedExamKey(input: AddSebKeyInput, createdById: string) {
  const normalisedKey = input.rawKey.trim();
  const keyHash = computeKeyLookupHash(normalisedKey);
  try {
    return await prisma.sebAllowedExamKey.create({
      data: {
        configurationId: input.configurationId,
        keyType: input.keyType,
        keyHash,
        rawKeyCiphertext: encryptSebKeyValue(normalisedKey),
        platform: input.platform ?? null,
        clientVersion: input.clientVersion ?? null,
        label: input.label ?? null,
        createdById,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new SecureClientError(409, "DUPLICATE_KEY", "This key has already been added to this configuration.");
    }
    throw err;
  }
}

export async function revokeSebAllowedExamKey(keyId: string) {
  return prisma.sebAllowedExamKey.update({ where: { id: keyId }, data: { active: false, revokedAt: new Date() } });
}

/** Never returns a raw or full key value — only a masked fingerprint (Part 11: "masked prefix/suffix; fingerprint; platform; version; status"). */
export function maskSebKey(keyHash: string) {
  return `${keyHash.slice(0, 6)}…${keyHash.slice(-4)}`;
}

export type MaskedSebKey = {
  id: string;
  keyType: string;
  fingerprint: string;
  platform: string | null;
  clientVersion: string | null;
  label: string | null;
  active: boolean;
  createdAt: Date;
  revokedAt: Date | null;
};

export async function listMaskedSebAllowedExamKeys(configurationId: string): Promise<MaskedSebKey[]> {
  const keys = await prisma.sebAllowedExamKey.findMany({ where: { configurationId }, orderBy: { createdAt: "asc" } });
  return keys.map((k) => ({
    id: k.id,
    keyType: k.keyType,
    fingerprint: maskSebKey(k.keyHash),
    platform: k.platform,
    clientVersion: k.clientVersion,
    label: k.label,
    active: k.active,
    createdAt: k.createdAt,
    revokedAt: k.revokedAt,
  }));
}

/** Loads and decrypts every currently-active raw key of one type for a configuration — server-only, never returned to any client. */
async function loadActiveRawKeys(configurationId: string, keyType: "BROWSER_EXAM_KEY" | "CONFIG_KEY"): Promise<string[]> {
  const keys = await prisma.sebAllowedExamKey.findMany({
    where: { configurationId, keyType, active: true, revokedAt: null },
    select: { rawKeyCiphertext: true },
  });
  return keys.map((k) => (k.rawKeyCiphertext ? decryptSebKeyValue(k.rawKeyCiphertext) : null)).filter((v): v is string => v != null);
}

export async function validateSebKeyForConfiguration(
  configurationId: string,
  keyType: "BROWSER_EXAM_KEY" | "CONFIG_KEY",
  suppliedHash: unknown,
  canonicalUrl: string,
) {
  const allowedRawKeys = await loadActiveRawKeys(configurationId, keyType);
  return validateSebRequestHash(suppliedHash, canonicalUrl, allowedRawKeys);
}

// ---------------------------------------------------------------------------
// Signed launch manifest (Part 6)
// ---------------------------------------------------------------------------

export type IssueLaunchManifestParams = {
  institutionId: string;
  examId: string;
  submissionId: string;
  studentId: string;
  configurationId: string | null;
  clientType: string;
  policy: SecureClientPolicy;
  canonicalExamOrigin: string;
  launchPath: string;
  audience: string;
};

export async function issueLaunchManifest(params: IssueLaunchManifestParams) {
  const now = new Date();
  const nonce = generateLaunchNonce();
  const manifestId = randomBytes(16).toString("hex");
  const policyHash = computePolicyHash(params.policy);
  const expiresAt = new Date(now.getTime() + params.policy.secureLaunchTokenTtlSeconds * 1000);

  const manifest: SecureLaunchManifest = {
    schemaVersion: SECURE_LAUNCH_MANIFEST_SCHEMA_VERSION,
    manifestId,
    keyId: getSigningKeyId(),
    issuer: SECURE_LAUNCH_MANIFEST_ISSUER,
    audience: params.audience,
    institutionId: params.institutionId,
    examId: params.examId,
    submissionId: params.submissionId,
    studentSubjectHash: computeStudentSubjectHash(params.studentId),
    configurationId: params.configurationId,
    clientType: params.clientType,
    policyHash,
    canonicalExamOrigin: params.canonicalExamOrigin,
    launchPath: params.launchPath,
    issuedAt: now.toISOString(),
    notBefore: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    nonce,
    minimumClientVersion: params.policy.allowedSebVersions[0] ?? null,
    allowedPlatform: params.policy.allowedSebPlatforms,
    heartbeatIntervalSeconds: params.policy.heartbeatIntervalSeconds,
    heartbeatGraceSeconds: params.policy.heartbeatGraceSeconds,
    // Filtered through checksSupportedByClientType so a check the client
    // type genuinely cannot report (e.g. displayCheck for SAFE_EXAM_BROWSER
    // — see SEB_UNSUPPORTED_CHECKS in attestation.ts) is never marked
    // REQUIRED here. A required-but-NOT_SUPPORTED check always resolves
    // the whole attestation to CANNOT_START (see overallStatusFromChecks),
    // which would make e.g. every SEB + Single Display Requirement exam
    // permanently unable to reach READY — the display restriction is
    // still enforced for SEB, just out-of-band via the generated .seb
    // configuration (see sebConfigGenerator.ts), not through this
    // attestation channel.
    requiredChecks: (
      [
        params.policy.requireDisplayCheck ? "displayCheck" : null,
        params.policy.requireRemoteSessionCheck ? "remoteSession" : null,
        params.policy.requireVirtualMachineCheck ? "virtualMachine" : null,
        params.policy.requireProcessCheck ? "processCheck" : null,
        params.policy.requireCaptureProtectionCheck ? "captureProtection" : null,
      ].filter((v): v is AttestationCheckKey => v != null) as AttestationCheckKey[]
    ).filter((check) => checksSupportedByClientType(params.clientType).has(check)),
    permittedCapabilities: [
      params.policy.allowClipboard ? "clipboard" : null,
      params.policy.allowPrinting ? "printing" : null,
      params.policy.allowExternalNavigation ? "externalNavigation" : null,
      params.policy.allowApplicationSwitching ? "applicationSwitching" : null,
    ].filter((v): v is string => v != null),
  };

  const signature = signManifest(manifest, getSigningPrivateKey());
  const manifestHash = computeManifestHash(manifest);

  const record = await prisma.secureClientLaunchManifest.create({
    data: {
      // Bug fix (hardening pass — found via disposable-database
      // validation, see docs/migration-ledger.md): consumeLaunchManifest
      // below rejects a manifest whose signed manifestId doesn't match
      // the persisted row's id (defence-in-depth beyond the nonce/
      // signature checks). Without pinning the row's id to the SAME
      // manifestId embedded in the manifest, that check could never pass
      // — every real consumption would fail with NOT_FOUND, since
      // Prisma's default cuid() has no relation to the manifestId
      // generated above.
      id: manifestId,
      institutionId: params.institutionId,
      examId: params.examId,
      submissionId: params.submissionId,
      studentId: params.studentId,
      configurationId: params.configurationId,
      clientType: params.clientType,
      nonceHash: hashNonce(nonce),
      policyHash,
      manifestHash,
      expiresAt,
    },
  });

  return { record, manifest, signature };
}

export type ConsumeLaunchManifestResult =
  | { outcome: "CONSUMED"; sessionId: string }
  | { outcome: "NOT_FOUND" }
  | { outcome: "EXPIRED" }
  | { outcome: "REVOKED" }
  | { outcome: "REPLAY" }
  | { outcome: "INVALID_NONCE" }
  | { outcome: "INVALID_SIGNATURE" };

/**
 * Consumes a launch manifest exactly once — a second consumption attempt
 * (replay) is recorded and rejected, never silently succeeds. Runs
 * inside the submission's advisory lock so two near-simultaneous consume
 * attempts can never both win.
 */
export async function consumeLaunchManifest(
  manifest: SecureLaunchManifest,
  signature: string,
  rawNonce: string,
): Promise<ConsumeLaunchManifestResult> {
  return prisma.$transaction(async (tx) => {
    await acquireSubmissionLock(tx, manifest.submissionId);

    const record = await tx.secureClientLaunchManifest.findUnique({ where: { nonceHash: hashNonce(rawNonce) } });
    if (!record) return { outcome: "NOT_FOUND" };
    if (record.id !== manifest.manifestId) return { outcome: "NOT_FOUND" };
    if (record.revokedAt) return { outcome: "REVOKED" };
    if (record.consumedAt) return { outcome: "REPLAY" };
    if (Date.now() > record.expiresAt.getTime()) return { outcome: "EXPIRED" };

    const validation = validateManifestContext(manifest, signature, getSigningPublicKey(), {
      expectedAudience: manifest.audience,
      expectedOrigin: manifest.canonicalExamOrigin,
      expectedPolicyHash: record.policyHash,
      nowMs: Date.now(),
    });
    if (validation === "INVALID_SIGNATURE") return { outcome: "INVALID_SIGNATURE" };
    if (validation !== "VALID") return { outcome: "EXPIRED" };

    const session = await getOrCreateSessionCore(tx, {
      institutionId: record.institutionId,
      examId: record.examId,
      submissionId: record.submissionId,
      studentId: record.studentId,
      configurationId: record.configurationId,
      clientType: record.clientType,
      manifestId: record.id,
      policyHash: record.policyHash,
    });

    await tx.secureClientLaunchManifest.update({
      where: { id: record.id },
      data: { consumedAt: new Date(), clientSessionId: session.id },
    });

    return { outcome: "CONSUMED", sessionId: session.id };
  });
}

// ---------------------------------------------------------------------------
// Session lifecycle (Part 7/10)
// ---------------------------------------------------------------------------

type GetOrCreateSessionParams = {
  institutionId: string;
  examId: string;
  submissionId: string;
  studentId: string;
  configurationId: string | null;
  clientType: string;
  manifestId: string;
  policyHash: string;
};

/**
 * Tether Secure Exam Recovery and Resilient Autosave v1 — see
 * docs/tether-secure-resume-recovery-v1.md, "Crash, relaunch and
 * Windows-restart recovery". Before this feature, a second manifest
 * consumption for a submission that already had a non-terminal session
 * silently REUSED that existing session — meaning its already-VERIFIED
 * state (from before a crash, kill, or Windows restart) carried straight
 * through with no new attestation of any kind. Now: an existing
 * non-terminal session is always SUPERSEDED (never reused) — closed with
 * closedAt/closeReason (and the existing terminal status "ENDED" +
 * endedAt/endReason, so every other terminal/non-terminal-aware query in
 * this codebase needs no further change) — and a genuinely fresh session
 * is created, pointing back at it via recoveryOfSessionId. The fresh
 * session starts at verificationStatus NOT_CHECKED /
 * installationAttestationVerified false, exactly like a submission's
 * very first launch — so resolveEffectiveTetherVerification (and
 * resolveTrustedTetherVerification, which every real content-access gate
 * actually calls — see src/lib/tetherRecovery.ts) can never treat this
 * fresh session as already verified. Best-effort audit trail: never
 * allowed to fail the actual manifest consumption.
 */
async function getOrCreateSessionCore(tx: DbClient, params: GetOrCreateSessionParams) {
  const existing = await tx.secureClientSession.findFirst({
    where: { submissionId: params.submissionId, status: { in: ["CREATED", "PREFLIGHT", "ACTIVE", "INTERRUPTED", "RECOVERY_REQUIRED"] } },
  });

  if (existing) {
    await tx.secureClientSession.update({
      where: { id: existing.id },
      data: {
        status: "ENDED",
        endedAt: new Date(),
        endReason: "SUPERSEDED_BY_RELAUNCH",
        closedAt: new Date(),
        closeReason: "SUPERSEDED_BY_RELAUNCH",
      },
    });
  }

  const created = await tx.secureClientSession.create({
    data: {
      institutionId: params.institutionId,
      examId: params.examId,
      submissionId: params.submissionId,
      studentId: params.studentId,
      configurationId: params.configurationId,
      clientType: params.clientType,
      status: "CREATED",
      verificationStatus: "NOT_CHECKED",
      manifestId: params.manifestId,
      policyHash: params.policyHash,
      // Pre-Preview safety pass — snapshotted ONCE, here, at the moment
      // this session is first created. Server-computed from the current
      // environment resolver only — never recalculated later, never
      // derived from any client-supplied value. See
      // resolveEffectiveTetherVerification() in tetherAttestationConfig.ts,
      // which reads this snapshot instead of the live environment
      // variable for every subsequent request against this session.
      attestationRequirement: resolveExamAttestationMode(),
      recoveryOfSessionId: existing ? existing.id : null,
    },
  });

  if (existing) {
    await createPlatformAuditLog({
      actorId: params.studentId,
      action: "TETHER_SECURE_RESUME_INITIATED",
      targetType: "Submission",
      targetId: params.submissionId,
      institutionId: params.institutionId,
      metadata: { supersededSessionId: existing.id, newSessionId: created.id },
    }).catch(() => {});

    // Secure-recovery hardening v1, Part A/B — the superseded session
    // never had a trusted (v2 installation-bound) reference at all
    // (LEGACY-only original attempt): automatic recovery can never be
    // granted for this new session, regardless of what attestation it
    // later presents (see resolveTrustedTetherVerification's own doc
    // comment). Audited exactly ONCE, here, at the moment this is first
    // known to be true — never re-logged by later status polling (see
    // resolveSubmissionRecoveryState in tetherRecoveryRunner.ts, which is
    // a pure read with no audit side effect of its own) or by repeated
    // relaunch attempts against this SAME new session.
    if (!existing.clientInstallationId) {
      await createPlatformAuditLog({
        actorId: params.studentId,
        action: "TETHER_SECURE_RESUME_MANUAL_REVIEW_REQUIRED",
        targetType: "Submission",
        targetId: params.submissionId,
        institutionId: params.institutionId,
        metadata: { newSessionId: created.id, reason: "UNBOUND_ORIGINAL_ATTEMPT" },
      }).catch(() => {});
    }
  }

  return created;
}

export async function getCurrentSessionForSubmission(submissionId: string) {
  return prisma.secureClientSession.findFirst({
    where: { submissionId, status: { in: ["CREATED", "PREFLIGHT", "ACTIVE", "INTERRUPTED", "RECOVERY_REQUIRED"] } },
    orderBy: { createdAt: "desc" },
  });
}

export type PriorSessionTrust = {
  /** The prior session's genuine, v2 installation-bound reference, or null if it was never installation-bound (LEGACY-only, or never verified at all). */
  trustedInstallationId: string | null;
  /**
   * True if the prior session ever reached a genuinely VERIFIED state by
   * ANY means (legacy verificationStatus === "VERIFIED", or v2
   * installationAttestationVerified) — i.e. exam content was actually
   * unlocked on it at some point. Distinguishes "a real attempt that got
   * as far as LEGACY verification but was never installation-bound"
   * (Part A's fail-closed target) from "a session that was created but
   * crashed before ever completing its OWN first attestation" (nothing
   * was ever unlocked to protect — relaunching this is no different from
   * an ordinary first launch, and must resolve exactly like one; see
   * requirement 4, "ordinary initial exam-start compatibility must
   * remain unchanged", and the "Immutable timing-policy tests" regression
   * this distinction was added to keep green).
   */
  everVerified: boolean;
};

/**
 * Secure-recovery hardening v1, Part A — for a session that supersedes
 * an earlier one (recoveryOfSessionId set), resolves whether that PRIOR
 * session ever established a trusted (genuine, v2 installation-bound)
 * reference, AND whether it was ever verified by any means at all. The
 * single place every content-gate, the recovery-state resolver, and the
 * attestation runner all consult to decide "is automatic recovery even
 * eligible to be considered for this attempt" — see
 * resolveTrustedTetherVerification (src/lib/tetherRecovery.ts) for how
 * the result is actually used. clientInstallationId, once set by a
 * genuine v2 attestation, is never cleared — so checking only the
 * DIRECT prior session (rather than walking the full supersession
 * chain) is sufficient: if the chain was ever bound, the most recent
 * link before this one already carries that binding forward.
 */
export async function resolvePriorSessionTrust(recoveryOfSessionId: string | null): Promise<PriorSessionTrust> {
  if (!recoveryOfSessionId) return { trustedInstallationId: null, everVerified: false };
  const prior = await prisma.secureClientSession.findUnique({
    where: { id: recoveryOfSessionId },
    select: { clientInstallationId: true, verificationStatus: true, installationAttestationVerified: true },
  });
  if (!prior) return { trustedInstallationId: null, everVerified: false };
  return {
    trustedInstallationId: prior.clientInstallationId,
    everVerified: prior.verificationStatus === "VERIFIED" || prior.installationAttestationVerified === true,
  };
}

export type RecordAttestationInput = {
  sessionId: string;
  clientType: string;
  platform?: string | null;
  osVersion?: string | null;
  clientVersion?: string | null;
  clientBuild?: string | null;
  checks: AttestationChecks;
  required: RequiredChecks;
  clientVerificationFailed: boolean;
  configurationInvalid: boolean;
  versionUnsupported: boolean;
  technicalFailure: boolean;
  clientReportedAt?: Date | null;
  /**
   * Single Display Requirement v1 (Part 6) — bounded, optional, and only
   * ever honoured for a client type that can actually support
   * displayCheck (TETHER_SECURE_CLIENT/MOCK_TETHER_CLIENT — see
   * SEB_UNSUPPORTED_CHECKS in attestation.ts). A SAFE_EXAM_BROWSER
   * session reporting either of these is silently ignored, never stored —
   * there is no trustworthy channel for SEB to know this, so a claimed
   * value could only ever be a guess or a fabrication.
   */
  displayCount?: number | null;
  displayTopology?: DisplayTopology | null;
};

export async function recordAttestation(input: RecordAttestationInput) {
  const normalisedChecks = normaliseChecksForClientType(input.checks, input.clientType);
  const overallStatus = overallStatusFromChecks({
    checks: normalisedChecks,
    required: input.required,
    clientVerificationFailed: input.clientVerificationFailed,
    configurationInvalid: input.configurationInvalid,
    versionUnsupported: input.versionUnsupported,
    technicalFailure: input.technicalFailure,
  });

  // Only a client type that genuinely supports displayCheck may have its
  // reported displayCount/displayTopology stored — never trusted from a
  // SAFE_EXAM_BROWSER session (see doc comment on RecordAttestationInput).
  const displaySupported = checksSupportedByClientType(input.clientType).has("displayCheck");
  const displayCount = displaySupported && isValidReportedDisplayCount(input.displayCount) ? input.displayCount : null;
  const displayTopology = displaySupported && typeof input.displayTopology === "string" && isValidDisplayTopology(input.displayTopology) ? input.displayTopology : null;

  const attestation = await prisma.secureClientAttestation.create({
    data: {
      secureClientSessionId: input.sessionId,
      clientType: input.clientType,
      platform: input.platform ?? null,
      osVersion: input.osVersion ?? null,
      clientVersion: input.clientVersion ?? null,
      clientBuild: input.clientBuild ?? null,
      displayCheckStatus: normalisedChecks.displayCheck ?? null,
      displayCount,
      remoteSessionStatus: normalisedChecks.remoteSession ?? null,
      virtualMachineStatus: normalisedChecks.virtualMachine ?? null,
      processCheckStatus: normalisedChecks.processCheck ?? null,
      captureProtectionStatus: normalisedChecks.captureProtection ?? null,
      clipboardPolicyStatus: normalisedChecks.clipboardPolicy ?? null,
      printingPolicyStatus: normalisedChecks.printingPolicy ?? null,
      externalNavigationPolicyStatus: normalisedChecks.externalNavigationPolicy ?? null,
      configurationVerificationStatus: normalisedChecks.configurationVerification ?? null,
      clientSignatureStatus: normalisedChecks.clientSignature ?? null,
      overallStatus,
      // displayTopology has no dedicated column (Single Display
      // Requirement v1 deliberately avoids a schema change — see
      // docs/migration-ledger.md) — stored inside the existing free-form
      // detailsJson blob alongside the per-check statuses instead.
      detailsJson: (displayTopology ? { ...normalisedChecks, displayTopology } : normalisedChecks) as Prisma.InputJsonValue,
      clientReportedAt: input.clientReportedAt ?? null,
    },
  });

  const newSessionStatus: SessionStatus =
    overallStatus === "READY" ? "ACTIVE" : overallStatus === "CANNOT_START" ? "REJECTED" : "PREFLIGHT";
  const newVerificationStatus =
    overallStatus === "READY"
      ? "VERIFIED"
      : input.clientVerificationFailed
        ? "UNVERIFIED_CLIENT"
        : input.configurationInvalid
          ? "INVALID_CONFIGURATION"
          : input.versionUnsupported
            ? "UNSUPPORTED_VERSION"
            : input.technicalFailure
              ? "TECHNICAL_FAILURE"
              : "NOT_CHECKED";

  await prisma.secureClientSession.update({
    where: { id: input.sessionId },
    data: {
      status: newSessionStatus,
      verificationStatus: newVerificationStatus,
      verifiedAt: overallStatus === "READY" ? new Date() : undefined,
      platform: input.platform ?? undefined,
      clientVersion: input.clientVersion ?? undefined,
    },
  });

  return { attestation, overallStatus };
}

export async function recordHeartbeat(sessionId: string, policy: { heartbeatIntervalSeconds: number; heartbeatGraceSeconds: number }) {
  const session = await prisma.secureClientSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new SecureClientError(404, "NOT_FOUND", "Session not found");
  const now = new Date();

  // A heartbeat arriving while INTERRUPTED means the client reconnected —
  // self-heals back to ACTIVE (Part 10: "when a client reconnects").
  // RECOVERY_REQUIRED is a stronger state that a plain heartbeat cannot
  // clear — that always requires an explicit lecturer-issued grant.
  const wasInterrupted = session.status === "INTERRUPTED";
  return prisma.secureClientSession.update({
    where: { id: sessionId },
    data: {
      lastHeartbeatAt: now,
      status: wasInterrupted ? "ACTIVE" : session.status,
      recoveredAt: wasInterrupted ? now : session.recoveredAt,
    },
  });
}

/** Re-derives whether an ACTIVE session's heartbeat has gone overdue past its grace period, and persists that transition if so — called on demand (Part 10), never from a background job. */
export async function reconcileSessionInterruption(sessionId: string, policy: { heartbeatIntervalSeconds: number; heartbeatGraceSeconds: number }) {
  const session = await prisma.secureClientSession.findUnique({ where: { id: sessionId } });
  if (!session) return null;
  const nowMs = Date.now();
  const derived = deriveSessionStatus(
    { status: session.status as SessionStatus, startedAt: session.startedAt.getTime(), lastHeartbeatAt: session.lastHeartbeatAt?.getTime() ?? null },
    policy,
    nowMs,
  );
  if (derived === session.status) return session;
  return prisma.secureClientSession.update({
    where: { id: sessionId },
    data: { status: derived, interruptedAt: derived === "INTERRUPTED" ? new Date() : session.interruptedAt },
  });
}

export async function markSessionInterrupted(sessionId: string, reasonCode?: string) {
  void reasonCode;
  return prisma.secureClientSession.update({
    where: { id: sessionId },
    data: { status: "INTERRUPTED", interruptedAt: new Date() },
  });
}

export async function requestSessionRecovery(sessionId: string) {
  const session = await prisma.secureClientSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new SecureClientError(404, "NOT_FOUND", "Session not found");
  if (session.status === "INTERRUPTED") {
    // Soft interruption — self-recover, no grant needed.
    return prisma.secureClientSession.update({ where: { id: sessionId }, data: { status: "ACTIVE", recoveredAt: new Date() } });
  }
  return prisma.secureClientSession.update({ where: { id: sessionId }, data: { status: "RECOVERY_REQUIRED" } });
}

export async function endSession(sessionId: string, endReason: string) {
  return prisma.secureClientSession.update({
    where: { id: sessionId },
    data: { status: "ENDED", endedAt: new Date(), endReason },
  });
}

// ---------------------------------------------------------------------------
// Recovery grants (Part 3/10) — lecturer-issued, one-time, short-lived.
// ---------------------------------------------------------------------------

const RECOVERY_GRANT_TTL_MS = 15 * 60 * 1000;

export async function issueRecoveryGrant(sessionId: string, submissionId: string, issuedById: string, reason: string) {
  const rawToken = randomBytes(24).toString("base64url");
  const grantCodeHash = createHash("sha256").update(rawToken).digest("hex");
  const grant = await prisma.secureClientRecoveryGrant.create({
    data: {
      secureClientSessionId: sessionId,
      submissionId,
      grantCodeHash,
      issuedById,
      expiresAt: new Date(Date.now() + RECOVERY_GRANT_TTL_MS),
      reason,
    },
  });
  return { grant, rawToken };
}

export type ConsumeRecoveryGrantResult = "RECOVERED" | "WRONG_SUBMISSION" | "EXPIRED" | "ALREADY_CONSUMED" | "REVOKED" | "NOT_FOUND";

export async function consumeRecoveryGrant(rawToken: string, requestSubmissionId: string): Promise<ConsumeRecoveryGrantResult> {
  const grantCodeHash = createHash("sha256").update(rawToken).digest("hex");
  return prisma.$transaction(async (tx) => {
    const grant = await tx.secureClientRecoveryGrant.findUnique({ where: { grantCodeHash } });
    if (!grant) return "NOT_FOUND";
    const check = checkRecoveryGrant({
      grant: {
        submissionId: grant.submissionId,
        expiresAt: grant.expiresAt.getTime(),
        consumedAt: grant.consumedAt?.getTime() ?? null,
        revokedAt: grant.revokedAt?.getTime() ?? null,
      },
      requestSubmissionId,
      nowMs: Date.now(),
    });
    if (check !== "VALID") {
      return check === "WRONG_SUBMISSION" ? "WRONG_SUBMISSION" : check === "EXPIRED" ? "EXPIRED" : check === "ALREADY_CONSUMED" ? "ALREADY_CONSUMED" : "REVOKED";
    }
    await tx.secureClientRecoveryGrant.update({ where: { id: grant.id }, data: { consumedAt: new Date() } });
    await tx.secureClientSession.update({
      where: { id: grant.secureClientSessionId },
      data: { status: "ACTIVE", recoveredAt: new Date() },
    });
    return "RECOVERED";
  });
}

// ---------------------------------------------------------------------------
// Events (Part 3/7/14)
// ---------------------------------------------------------------------------

export type RecordSecureClientEventParams = {
  secureClientSessionId: string | null;
  submissionId: string;
  examId: string;
  institutionId: string;
  eventType: SecureClientEventType;
  clientRequestId: string | null;
  sequenceNumber: number | null;
  clientElapsedMs: number | null;
  metadata: unknown;
};

export async function recordSecureClientEvent(params: RecordSecureClientEventParams) {
  if (params.clientRequestId) {
    const existing = await prisma.secureClientEvent.findUnique({ where: { clientRequestId: params.clientRequestId }, select: { id: true } });
    if (existing) return { replay: true as const, id: existing.id };
  }

  const metadataValidation = validateSecureClientEventMetadata(params.eventType, params.metadata);
  const safeMetadata = metadataValidation.success ? metadataValidation.data : {};

  let sequenceOutcome: "ACCEPT" | "DUPLICATE" | "OUT_OF_ORDER" = "ACCEPT";
  if (params.secureClientSessionId && params.sequenceNumber != null) {
    const last = await prisma.secureClientEvent.findFirst({
      where: { secureClientSessionId: params.secureClientSessionId },
      orderBy: { sequenceNumber: "desc" },
      select: { sequenceNumber: true },
    });
    sequenceOutcome = checkSequenceNumber(params.sequenceNumber, last?.sequenceNumber ?? null);
  }

  try {
    const created = await prisma.secureClientEvent.create({
      data: {
        secureClientSessionId: params.secureClientSessionId,
        submissionId: params.submissionId,
        examId: params.examId,
        institutionId: params.institutionId,
        eventType: params.eventType,
        eventLevel: DEFAULT_SECURE_CLIENT_EVENT_LEVEL[params.eventType],
        clientRequestId: params.clientRequestId,
        sequenceNumber: params.sequenceNumber,
        clientElapsedMs: params.clientElapsedMs,
        metadataJson: safeMetadata as Prisma.InputJsonValue,
      },
    });
    return { replay: false as const, id: created.id, sequenceOutcome };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && params.clientRequestId) {
      const replay = await prisma.secureClientEvent.findUnique({ where: { clientRequestId: params.clientRequestId }, select: { id: true } });
      if (replay) return { replay: true as const, id: replay.id };
    }
    throw err;
  }
}
