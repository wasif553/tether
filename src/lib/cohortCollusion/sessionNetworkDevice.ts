/**
 * Cohort-Level Collusion Detection v1 — SESSION_NETWORK_DEVICE signal
 * family. See docs/cohort-collusion-graph-v1.md and Part 2.5 of the spec.
 *
 * Uses only the existing hashed/coarse fields from ExamAttemptSession and
 * NetworkEvidence — never raw IP addresses, raw device tokens, or raw
 * browser-session tokens (those never leave src/lib/sessionBinding.ts /
 * src/lib/networkEvidence.ts). Weak by construction: this whole family is
 * capped lowest in FAMILY_SCORE_CAPS, and a shared IP/network or a single
 * matching device identifier must never be enough on its own — students
 * legitimately share university networks, accommodation, libraries,
 * workplaces, VPN exits, and family networks.
 */
import { NETWORK_MIN_SHARED_OBSERVATIONS, SESSION_MIN_OVERLAP_MS } from "@/lib/cohortCollusionThresholds";
import type { PairSignal } from "./types";

export const SESSION_NETWORK_DEVICE_SIGNAL_TYPES = [
  "REPEATED_SHARED_NETWORK",
  "REPEATED_SHARED_DEVICE",
  "OVERLAPPING_SESSION_PATTERN",
  "MATCHING_RECONNECT_PATTERN",
] as const;
export type SessionNetworkDeviceSignalType = (typeof SESSION_NETWORK_DEVICE_SIGNAL_TYPES)[number];

export type HashedNetworkObservation = { ipPrefixHash: string | null; atMs: number };
export type HashedSessionSnapshot = {
  deviceTokenHash: string;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  status: string;
};

/** Flags REPEATED_SHARED_NETWORK only when the SAME hashed network prefix is observed for both submissions on at least NETWORK_MIN_SHARED_OBSERVATIONS separate occasions — never a single shared observation. */
export function computeRepeatedSharedNetworkSignal(
  observationsA: HashedNetworkObservation[],
  observationsB: HashedNetworkObservation[],
): PairSignal[] {
  const prefixesA = observationsA.map((o) => o.ipPrefixHash).filter((h): h is string => Boolean(h));
  const prefixesB = new Set(observationsB.map((o) => o.ipPrefixHash).filter((h): h is string => Boolean(h)));
  const sharedObservations = prefixesA.filter((h) => prefixesB.has(h));
  if (sharedObservations.length < NETWORK_MIN_SHARED_OBSERVATIONS) return [];
  return [
    {
      signalFamily: "SESSION_NETWORK_DEVICE",
      signalType: "REPEATED_SHARED_NETWORK",
      score: 0.3,
      confidence: 0.3,
      explanation: `Both submissions were repeatedly observed from the same network address range (${sharedObservations.length} occasions). Weak, supporting evidence only — shared institutional networks, accommodation, or VPN exits are common and legitimate.`,
      evidence: { sharedObservationCount: sharedObservations.length },
    },
  ];
}

/** Flags REPEATED_SHARED_DEVICE when the same hashed device token appears on sessions for two DIFFERENT students. Still capped at the lowest family weight — see FAMILY_SCORE_CAPS. */
export function computeRepeatedSharedDeviceSignal(
  sessionsA: HashedSessionSnapshot[],
  sessionsB: HashedSessionSnapshot[],
): PairSignal[] {
  const devicesA = new Set(sessionsA.map((s) => s.deviceTokenHash));
  const shared = sessionsB.filter((s) => devicesA.has(s.deviceTokenHash));
  if (shared.length === 0) return [];
  return [
    {
      signalFamily: "SESSION_NETWORK_DEVICE",
      signalType: "REPEATED_SHARED_DEVICE",
      score: 0.4,
      confidence: 0.4,
      explanation: "Both submissions were associated with the same device identifier at some point. Weak, supporting evidence only — a shared lab or library workstation can produce this.",
      evidence: { sharedSessionCount: shared.length },
    },
  ];
}

/** Flags OVERLAPPING_SESSION_PATTERN when the two students' ExamAttemptSession windows genuinely overlap in time for at least SESSION_MIN_OVERLAP_MS. */
export function computeOverlappingSessionPatternSignal(
  sessionsA: HashedSessionSnapshot[],
  sessionsB: HashedSessionSnapshot[],
): PairSignal[] {
  for (const a of sessionsA) {
    for (const b of sessionsB) {
      const overlapStart = Math.max(a.firstSeenAtMs, b.firstSeenAtMs);
      const overlapEnd = Math.min(a.lastSeenAtMs, b.lastSeenAtMs);
      if (overlapEnd - overlapStart >= SESSION_MIN_OVERLAP_MS) {
        return [
          {
            signalFamily: "SESSION_NETWORK_DEVICE",
            signalType: "OVERLAPPING_SESSION_PATTERN",
            score: 0.25,
            confidence: 0.3,
            explanation: "Both submissions had active exam sessions overlapping in time. Weak, supporting evidence only.",
            evidence: { overlapMs: overlapEnd - overlapStart },
          },
        ];
      }
    }
  }
  return [];
}

/** Flags MATCHING_RECONNECT_PATTERN when both submissions show a REPLACED/reconnect session within the same narrow window — a coarse, low-weight pattern. */
export function computeMatchingReconnectPatternSignal(
  sessionsA: HashedSessionSnapshot[],
  sessionsB: HashedSessionSnapshot[],
): PairSignal[] {
  const reconnectsA = sessionsA.filter((s) => s.status === "REPLACED");
  const reconnectsB = sessionsB.filter((s) => s.status === "REPLACED");
  for (const a of reconnectsA) {
    for (const b of reconnectsB) {
      if (Math.abs(a.lastSeenAtMs - b.lastSeenAtMs) <= SESSION_MIN_OVERLAP_MS * 6) {
        return [
          {
            signalFamily: "SESSION_NETWORK_DEVICE",
            signalType: "MATCHING_RECONNECT_PATTERN",
            score: 0.2,
            confidence: 0.25,
            explanation: "Both submissions show a session reconnect/restart within a similar timeframe. Weak, supporting evidence only.",
            evidence: {},
          },
        ];
      }
    }
  }
  return [];
}

export function computeSessionNetworkDeviceSignals(
  networkA: HashedNetworkObservation[],
  networkB: HashedNetworkObservation[],
  sessionsA: HashedSessionSnapshot[],
  sessionsB: HashedSessionSnapshot[],
): PairSignal[] {
  return [
    ...computeRepeatedSharedNetworkSignal(networkA, networkB),
    ...computeRepeatedSharedDeviceSignal(sessionsA, sessionsB),
    ...computeOverlappingSessionPatternSignal(sessionsA, sessionsB),
    ...computeMatchingReconnectPatternSignal(sessionsA, sessionsB),
  ];
}
