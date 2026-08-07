import { describe, it, expect } from "vitest";
import {
  computeRemoteSessionMonitorTransitions,
  INITIAL_REMOTE_SESSION_MONITOR_STATE,
  type RemoteSessionMonitorState,
} from "./remoteSessionMonitorLogic";
import type { WindowsSessionClassification } from "./windowsSessionDetectionLogic";

function classification(overrides: Partial<WindowsSessionClassification> = {}): WindowsSessionClassification {
  return {
    isRemoteSession: false,
    remoteSessionSignalSource: "BOTH_AGREE",
    isLikelyVirtualMachine: false,
    vmSignatureMatched: null,
    ...overrides,
  };
}

const ACTIVE = classification({ isRemoteSession: true, remoteSessionSignalSource: "BOTH_AGREE" });
const INACTIVE = classification({ isRemoteSession: false, remoteSessionSignalSource: "BOTH_AGREE" });
const UNAVAILABLE = classification({ isRemoteSession: false, remoteSessionSignalSource: "UNAVAILABLE" });

describe("computeRemoteSessionMonitorTransitions — inactive -> active", () => {
  it("emits exactly one BECAME_ACTIVE transition", () => {
    const { transitions, nextState } = computeRemoteSessionMonitorTransitions(INITIAL_REMOTE_SESSION_MONITOR_STATE, ACTIVE);
    expect(transitions).toEqual([{ kind: "BECAME_ACTIVE", previousState: "INACTIVE", currentState: "ACTIVE", classification: ACTIVE }]);
    expect(nextState.lastKnownActiveState).toBe("ACTIVE");
  });
});

describe("computeRemoteSessionMonitorTransitions — deduplication (repeated active results)", () => {
  it("emits zero transitions for a second, third, fourth identical ACTIVE poll", () => {
    let state: RemoteSessionMonitorState = INITIAL_REMOTE_SESSION_MONITOR_STATE;
    const first = computeRemoteSessionMonitorTransitions(state, ACTIVE);
    state = first.nextState;
    expect(first.transitions).toHaveLength(1);

    for (let i = 0; i < 5; i++) {
      const { transitions, nextState } = computeRemoteSessionMonitorTransitions(state, ACTIVE);
      expect(transitions).toEqual([]);
      state = nextState;
    }
    expect(state.lastKnownActiveState).toBe("ACTIVE");
  });

  it("emits zero transitions for repeated INACTIVE polls from the initial state", () => {
    let state: RemoteSessionMonitorState = INITIAL_REMOTE_SESSION_MONITOR_STATE;
    for (let i = 0; i < 5; i++) {
      const { transitions, nextState } = computeRemoteSessionMonitorTransitions(state, INACTIVE);
      expect(transitions).toEqual([]);
      state = nextState;
    }
  });
});

describe("computeRemoteSessionMonitorTransitions — active -> inactive", () => {
  it("emits exactly one BECAME_INACTIVE (recovery/clear) transition", () => {
    const { nextState: activeState } = computeRemoteSessionMonitorTransitions(INITIAL_REMOTE_SESSION_MONITOR_STATE, ACTIVE);
    const { transitions, nextState } = computeRemoteSessionMonitorTransitions(activeState, INACTIVE);
    expect(transitions).toEqual([{ kind: "BECAME_INACTIVE", previousState: "ACTIVE", currentState: "INACTIVE", classification: INACTIVE }]);
    expect(nextState.lastKnownActiveState).toBe("INACTIVE");
  });
});

describe("computeRemoteSessionMonitorTransitions — check unavailable", () => {
  it("does not throw and emits exactly one CHECK_UNAVAILABLE on the first failure", () => {
    expect(() => computeRemoteSessionMonitorTransitions(INITIAL_REMOTE_SESSION_MONITOR_STATE, UNAVAILABLE)).not.toThrow();
    const { transitions, nextState } = computeRemoteSessionMonitorTransitions(INITIAL_REMOTE_SESSION_MONITOR_STATE, UNAVAILABLE);
    expect(transitions).toEqual([{ kind: "CHECK_UNAVAILABLE", classification: UNAVAILABLE }]);
    expect(nextState.lastCheckAvailable).toBe(false);
  });

  it("never changes lastKnownActiveState on a failed check (fail-closed)", () => {
    const { nextState: activeState } = computeRemoteSessionMonitorTransitions(INITIAL_REMOTE_SESSION_MONITOR_STATE, ACTIVE);
    const { nextState } = computeRemoteSessionMonitorTransitions(activeState, UNAVAILABLE);
    expect(nextState.lastKnownActiveState).toBe("ACTIVE");
  });

  it("does not repeat CHECK_UNAVAILABLE on consecutive failed polls", () => {
    let state: RemoteSessionMonitorState = INITIAL_REMOTE_SESSION_MONITOR_STATE;
    const first = computeRemoteSessionMonitorTransitions(state, UNAVAILABLE);
    state = first.nextState;
    expect(first.transitions).toEqual([{ kind: "CHECK_UNAVAILABLE", classification: UNAVAILABLE }]);
    for (let i = 0; i < 4; i++) {
      const { transitions, nextState } = computeRemoteSessionMonitorTransitions(state, UNAVAILABLE);
      expect(transitions).toEqual([]);
      state = nextState;
    }
  });
});

describe("computeRemoteSessionMonitorTransitions — check recovery", () => {
  it("records CHECK_RECOVERED exactly once when the check starts succeeding again", () => {
    const { nextState: failedState } = computeRemoteSessionMonitorTransitions(INITIAL_REMOTE_SESSION_MONITOR_STATE, UNAVAILABLE);
    const { transitions, nextState } = computeRemoteSessionMonitorTransitions(failedState, INACTIVE);
    expect(transitions).toEqual([{ kind: "CHECK_RECOVERED", classification: INACTIVE }]);
    expect(nextState.lastCheckAvailable).toBe(true);

    // A further successful poll must not repeat CHECK_RECOVERED.
    const next = computeRemoteSessionMonitorTransitions(nextState, INACTIVE);
    expect(next.transitions).toEqual([]);
  });

  it("can emit BOTH CHECK_RECOVERED and BECAME_ACTIVE in the same poll", () => {
    const { nextState: failedState } = computeRemoteSessionMonitorTransitions(INITIAL_REMOTE_SESSION_MONITOR_STATE, UNAVAILABLE);
    const { transitions } = computeRemoteSessionMonitorTransitions(failedState, ACTIVE);
    expect(transitions).toEqual([
      { kind: "CHECK_RECOVERED", classification: ACTIVE },
      { kind: "BECAME_ACTIVE", previousState: "INACTIVE", currentState: "ACTIVE", classification: ACTIVE },
    ]);
  });
});

describe("computeRemoteSessionMonitorTransitions — never produces a misconduct/decision field", () => {
  it("every transition kind is only ever a recorded signal (BECAME_*/CHECK_*), never e.g. a TERMINATE/SUBMIT/MISCONDUCT kind", () => {
    const allKinds = new Set<string>();
    let state: RemoteSessionMonitorState = INITIAL_REMOTE_SESSION_MONITOR_STATE;
    for (const c of [ACTIVE, INACTIVE, UNAVAILABLE, ACTIVE, UNAVAILABLE, INACTIVE]) {
      const { transitions, nextState } = computeRemoteSessionMonitorTransitions(state, c);
      state = nextState;
      for (const t of transitions) allKinds.add(t.kind);
    }
    for (const kind of allKinds) {
      expect(["BECAME_ACTIVE", "BECAME_INACTIVE", "CHECK_UNAVAILABLE", "CHECK_RECOVERED"]).toContain(kind);
    }
  });
});
