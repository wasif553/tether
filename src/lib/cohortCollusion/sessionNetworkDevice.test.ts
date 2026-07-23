import { describe, it, expect } from "vitest";
import {
  computeRepeatedSharedNetworkSignal,
  computeRepeatedSharedDeviceSignal,
  computeSessionNetworkDeviceSignals,
} from "./sessionNetworkDevice";
import { FAMILY_SCORE_CAPS } from "../cohortCollusionThresholds";

describe("SESSION_NETWORK_DEVICE — weak support only", () => {
  it("a single shared network observation is never enough", () => {
    const signals = computeRepeatedSharedNetworkSignal([{ ipPrefixHash: "hashabc", atMs: 1000 }], [{ ipPrefixHash: "hashabc", atMs: 2000 }]);
    expect(signals).toHaveLength(0);
  });

  it("repeated shared network observations produce a signal, but scored well below the family cap", () => {
    const obsA = [{ ipPrefixHash: "hashabc", atMs: 1000 }, { ipPrefixHash: "hashabc", atMs: 5000 }];
    const obsB = [{ ipPrefixHash: "hashabc", atMs: 1500 }, { ipPrefixHash: "hashabc", atMs: 5500 }];
    const signals = computeRepeatedSharedNetworkSignal(obsA, obsB);
    expect(signals).toHaveLength(1);
    expect(signals[0].score).toBeLessThan(FAMILY_SCORE_CAPS.SESSION_NETWORK_DEVICE + 0.5); // weak raw score
    expect(signals[0].confidence).toBeLessThan(0.5); // low confidence — supporting evidence only
  });

  it("a shared device token produces REPEATED_SHARED_DEVICE, still a low-confidence signal", () => {
    const sessionsA = [{ deviceTokenHash: "devhash1", firstSeenAtMs: 0, lastSeenAtMs: 1000, status: "ACTIVE" }];
    const sessionsB = [{ deviceTokenHash: "devhash1", firstSeenAtMs: 500, lastSeenAtMs: 1500, status: "ACTIVE" }];
    const signals = computeRepeatedSharedDeviceSignal(sessionsA, sessionsB);
    expect(signals).toHaveLength(1);
    expect(signals[0].signalType).toBe("REPEATED_SHARED_DEVICE");
  });

  it("never includes a raw IP address or raw device token in evidence — only hashed/coarse fields are ever passed in, and evidence stays free of any recognisable raw value", () => {
    const obsA = [{ ipPrefixHash: "hashabc", atMs: 1000 }, { ipPrefixHash: "hashabc", atMs: 5000 }];
    const obsB = [{ ipPrefixHash: "hashabc", atMs: 1500 }, { ipPrefixHash: "hashabc", atMs: 5500 }];
    const sessionsA = [{ deviceTokenHash: "devhash1", firstSeenAtMs: 0, lastSeenAtMs: 100_000, status: "ACTIVE" }];
    const sessionsB = [{ deviceTokenHash: "devhash1", firstSeenAtMs: 500, lastSeenAtMs: 100_500, status: "ACTIVE" }];
    const signals = computeSessionNetworkDeviceSignals(obsA, obsB, sessionsA, sessionsB);
    for (const s of signals) {
      const json = JSON.stringify(s.evidence);
      expect(json).not.toContain("hashabc");
      expect(json).not.toContain("devhash1");
      expect(json.toLowerCase()).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/); // no raw-IP-shaped string
    }
  });
});
