/**
 * Production administration hardening v1 — operational health
 * aggregation. See docs/tether-production-observability.md and
 * docs/tether-broad-rollout-readiness.md.
 *
 * Every metric here is derived from data this codebase ALREADY persists
 * (SecureClientLaunchManifest, SecureClientSession, SecureClientAttestation,
 * SecureClientRecoveryGrant, IntegrityEvent, TetherClientInstallation).
 * Nothing here introduces a new external monitoring vendor or a new
 * table. Deliberately does NOT report a metric that isn't genuinely
 * persisted — see `notPersisted` on the returned summary for the
 * specific gaps (e.g. secure-launch-consume TRANSIENT failures are only
 * ever `console.error`-logged, not written to any table — see
 * docs/tether-production-observability.md's own recommended-alerts
 * section for why that remains a log-aggregation problem, not a
 * database-query problem).
 */
import { prisma } from "@/lib/prisma";

export type OperationalHealthScope = { institutionId?: string };

function scopeWhere(scope: OperationalHealthScope): { institutionId?: string } {
  return scope.institutionId ? { institutionId: scope.institutionId } : {};
}

export type SecureLaunchHealth = {
  /** Manifests issued within the window. */
  issued: number;
  /** Successfully consumed (a real launch completed) within the window. */
  consumed: number;
  /** Explicitly revoked within the window. */
  revoked: number;
  /**
   * Issued, past their expiry, never consumed, never revoked — the
   * closest available proxy for "launch abandoned or failed," but NOT
   * the same as a genuine transient consume failure (a student who never
   * attempted the deep link at all looks identical in this data).
   */
  expiredUnconsumed: number;
};

async function loadSecureLaunchHealth(scope: OperationalHealthScope, since: Date, now: Date): Promise<SecureLaunchHealth> {
  const where = { ...scopeWhere(scope), issuedAt: { gte: since } };
  const [issued, consumed, revoked, expiredUnconsumed] = await Promise.all([
    prisma.secureClientLaunchManifest.count({ where }),
    prisma.secureClientLaunchManifest.count({ where: { ...where, consumedAt: { not: null } } }),
    prisma.secureClientLaunchManifest.count({ where: { ...where, revokedAt: { not: null } } }),
    prisma.secureClientLaunchManifest.count({ where: { ...where, consumedAt: null, revokedAt: null, expiresAt: { lt: now } } }),
  ]);
  return { issued, consumed, revoked, expiredUnconsumed };
}

export type SecureSessionHealth = {
  /** Current snapshot (not time-windowed) — counts by SecureClientSession.status right now. */
  byStatus: Record<string, number>;
};

const SESSION_STATUSES = ["CREATED", "PREFLIGHT", "ACTIVE", "INTERRUPTED", "RECOVERY_REQUIRED", "ENDED", "REJECTED"] as const;

async function loadSecureSessionHealth(scope: OperationalHealthScope): Promise<SecureSessionHealth> {
  const grouped = await prisma.secureClientSession.groupBy({
    by: ["status"],
    where: scopeWhere(scope),
    _count: { _all: true },
  });
  const byStatus: Record<string, number> = Object.fromEntries(SESSION_STATUSES.map((s) => [s, 0]));
  for (const row of grouped) byStatus[row.status] = row._count._all;
  return { byStatus };
}

export type AttestationHealth = {
  /** Within the window, by SecureClientAttestation.overallStatus. */
  byOverallStatus: Record<string, number>;
};

const ATTESTATION_STATUSES = ["READY", "ACTION_REQUIRED", "CANNOT_START", "NOT_SUPPORTED", "TECHNICAL_FAILURE"] as const;

async function loadAttestationHealth(scope: OperationalHealthScope, since: Date): Promise<AttestationHealth> {
  // SecureClientAttestation has no institutionId column of its own —
  // scoped via its session relation, mirroring how every other
  // institution-scoped join in this codebase reaches a child table that
  // predates multi-tenancy (see docs/multi-tenant-migration.md).
  const grouped = await prisma.secureClientAttestation.groupBy({
    by: ["overallStatus"],
    where: { serverReceivedAt: { gte: since }, ...(scope.institutionId ? { session: { institutionId: scope.institutionId } } : {}) },
    _count: { _all: true },
  });
  const byOverallStatus: Record<string, number> = Object.fromEntries(ATTESTATION_STATUSES.map((s) => [s, 0]));
  for (const row of grouped) byOverallStatus[row.overallStatus] = row._count._all;
  return { byOverallStatus };
}

export type RecoveryGrantHealth = {
  issued: number;
  consumed: number;
  revoked: number;
  expiredUnused: number;
};

async function loadRecoveryGrantHealth(scope: OperationalHealthScope, since: Date, now: Date): Promise<RecoveryGrantHealth> {
  // SecureClientRecoveryGrant has no institutionId column either —
  // scoped via its session relation, same pattern as attestations above.
  const sessionScope = scope.institutionId ? { session: { institutionId: scope.institutionId } } : {};
  const where = { ...sessionScope, issuedAt: { gte: since } };
  const [issued, consumed, revoked, expiredUnused] = await Promise.all([
    prisma.secureClientRecoveryGrant.count({ where }),
    prisma.secureClientRecoveryGrant.count({ where: { ...where, consumedAt: { not: null } } }),
    prisma.secureClientRecoveryGrant.count({ where: { ...where, revokedAt: { not: null } } }),
    prisma.secureClientRecoveryGrant.count({ where: { ...where, consumedAt: null, revokedAt: null, expiresAt: { lt: now } } }),
  ]);
  return { issued, consumed, revoked, expiredUnused };
}

export type IntegrityEventIngestionHealth = {
  totalWithinWindow: number;
  bySeverity: Record<string, number>;
};

const INTEGRITY_SEVERITIES = ["INFO", "LOW", "MEDIUM", "HIGH"] as const;

async function loadIntegrityEventIngestionHealth(scope: OperationalHealthScope, since: Date): Promise<IntegrityEventIngestionHealth> {
  const grouped = await prisma.integrityEvent.groupBy({
    by: ["severity"],
    where: { occurredAt: { gte: since }, ...(scope.institutionId ? { exam: { institutionId: scope.institutionId } } : {}) },
    _count: { _all: true },
  });
  const bySeverity: Record<string, number> = Object.fromEntries(INTEGRITY_SEVERITIES.map((s) => [s, 0]));
  let totalWithinWindow = 0;
  for (const row of grouped) {
    bySeverity[row.severity] = row._count._all;
    totalWithinWindow += row._count._all;
  }
  return { totalWithinWindow, bySeverity };
}

export type OperationalHealthSummary = {
  scope: { institutionId: string | null };
  windowHours: number;
  generatedAt: string;
  secureLaunch: SecureLaunchHealth;
  secureSessions: SecureSessionHealth;
  attestations: AttestationHealth;
  recoveryGrants: RecoveryGrantHealth;
  integrityEventIngestion: IntegrityEventIngestionHealth;
  /**
   * Explicit, honest list of metrics this view deliberately does NOT
   * report, and why — never silently omitted, so an operator reading
   * this never mistakes "not shown" for "zero."
   */
  notPersisted: Array<{ metric: string; reason: string }>;
};

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 30; // 30 days — bounds the query window so this can never be asked to scan unboundedly far back.

export function resolveOperationalHealthWindowHours(raw: string | null | undefined): number {
  const parsed = raw != null ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_WINDOW_HOURS;
  return Math.min(parsed, MAX_WINDOW_HOURS);
}

export async function summarizeOperationalHealth(scope: OperationalHealthScope, windowHours: number = DEFAULT_WINDOW_HOURS): Promise<OperationalHealthSummary> {
  const now = new Date();
  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

  const [secureLaunch, secureSessions, attestations, recoveryGrants, integrityEventIngestion] = await Promise.all([
    loadSecureLaunchHealth(scope, since, now),
    loadSecureSessionHealth(scope),
    loadAttestationHealth(scope, since),
    loadRecoveryGrantHealth(scope, since, now),
    loadIntegrityEventIngestionHealth(scope, since),
  ]);

  return {
    scope: { institutionId: scope.institutionId ?? null },
    windowHours,
    generatedAt: now.toISOString(),
    secureLaunch,
    secureSessions,
    attestations,
    recoveryGrants,
    integrityEventIngestion,
    notPersisted: [
      {
        metric: "Secure-launch-consume transient failure count",
        reason: "consumeLaunchManifest's TRANSIENT_FAILURE/INVALID_SIGNATURE/etc. outcomes are console.error-logged (see docs/tether-production-observability.md) but never written to any table — only successful consumption (consumedAt) and explicit revocation are queryable.",
      },
      {
        metric: "Evidence (screen/camera) upload failure count",
        reason: "A failed evidence upload never creates an IntegrityEvidenceAsset row — only successful uploads are persisted and countable. Upload failures are logged (console.error) but not aggregable via a database query.",
      },
      {
        metric: "Unsupported Tether client version fleet breakdown",
        reason: "Available separately via summarizeTetherFleet() (src/lib/tetherFleetVisibility.ts) / GET /api/platform/tether-fleet — not duplicated here to keep this summary focused on session/launch/attestation/recovery health.",
      },
    ],
  };
}
