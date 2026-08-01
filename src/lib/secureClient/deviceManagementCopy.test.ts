import { describe, it, expect } from "vitest";
import {
  describeRegistrationFailure,
  describeRevocationFailure,
  buildRevokeConfirmCopy,
  formatActiveComputersSummary,
  SOFTWARE_PROTECTED_EXPLANATION,
} from "./deviceManagementCopy";

const BANNED_TERMS = [
  "cryptographically genuine",
  "trusted hardware",
  "tpm protected",
  "tamper-proof",
  "cheat-proof",
  "suspicious device",
  "compromised device",
  "hardware-backed",
  "hardware attestation", // only allowed in the explicit negation sentence, checked separately
];

describe("SOFTWARE_PROTECTED_EXPLANATION", () => {
  it("matches the exact required wording", () => {
    expect(SOFTWARE_PROTECTED_EXPLANATION).toBe(
      "Tether uses an installation-specific key protected by Windows for this user account. This helps identify and revoke individual installations. It is not hardware attestation.",
    );
  });

  it("never claims hardware attestation is true — only ever negates it", () => {
    expect(SOFTWARE_PROTECTED_EXPLANATION).toContain("It is not hardware attestation.");
    expect(SOFTWARE_PROTECTED_EXPLANATION).not.toMatch(/is hardware attestation/i);
  });
});

describe("describeRegistrationFailure", () => {
  it("never returns the raw SCREAMING_SNAKE_CASE internal code verbatim for any known code", () => {
    const codes = [
      "LIMIT_REACHED",
      "RATE_LIMITED",
      "CHALLENGE_ALREADY_CONSUMED",
      "EXPIRED",
      "WRONG_PUBLIC_KEY",
      "PROOF_OF_POSSESSION_INVALID",
      "DUPLICATE_KEY",
      "SECURE_STORAGE_UNAVAILABLE",
      "BRIDGE_UNAVAILABLE",
      "NETWORK_ERROR",
      "SOME_UNKNOWN_FUTURE_CODE",
    ];
    for (const code of codes) {
      const message = describeRegistrationFailure(code, 2);
      expect(message).not.toBe(code);
      // The raw underscored identifier form must never appear verbatim —
      // ordinary English words that happen to overlap (e.g. "expired")
      // are fine and expected in plain-language copy.
      expect(message).not.toContain(code.replace(/_/g, "_"));
      expect(message).not.toMatch(/[A-Z]{2,}_[A-Z_]+/);
    }
  });

  it("LIMIT_REACHED includes the configured maximum and points at removing an old computer", () => {
    const message = describeRegistrationFailure("LIMIT_REACHED", 2);
    expect(message).toContain("2 of 2");
    expect(message.toLowerCase()).toContain("remove");
  });

  it("unrecognised codes fall back to a generic, non-alarming message", () => {
    expect(describeRegistrationFailure("TOTALLY_UNKNOWN", 2)).toBe("Something went wrong registering this computer. Try again.");
  });

  it("no banned product-language terms ever appear in any mapped message", () => {
    const codes = ["LIMIT_REACHED", "RATE_LIMITED", "PROOF_OF_POSSESSION_INVALID", "DUPLICATE_KEY", "SECURE_STORAGE_UNAVAILABLE", "unknown"];
    for (const code of codes) {
      const message = describeRegistrationFailure(code, 2).toLowerCase();
      for (const banned of BANNED_TERMS) {
        expect(message).not.toContain(banned);
      }
    }
  });
});

describe("describeRevocationFailure", () => {
  it("ACTIVE_EXAM_IN_PROGRESS matches the exact required wording", () => {
    expect(describeRevocationFailure("ACTIVE_EXAM_IN_PROGRESS")).toBe(
      "This computer cannot be removed while a secure examination is in progress.",
    );
  });

  it("never returns the raw code", () => {
    expect(describeRevocationFailure("ACTIVE_EXAM_IN_PROGRESS")).not.toBe("ACTIVE_EXAM_IN_PROGRESS");
    expect(describeRevocationFailure("NOT_FOUND")).not.toBe("NOT_FOUND");
  });

  it("ACTIVE_EXAM_IN_PROGRESS_ACCOUNT_WIDE matches the exact required wording and never exposes internal terminology", () => {
    const message = describeRevocationFailure("ACTIVE_EXAM_IN_PROGRESS_ACCOUNT_WIDE");
    expect(message).toBe("Tether computer access cannot be changed while your secure examination is in progress.");
    expect(message).not.toBe("ACTIVE_EXAM_IN_PROGRESS_ACCOUNT_WIDE");
    expect(message.toLowerCase()).not.toContain("legacy");
    expect(message.toLowerCase()).not.toContain("v2");
    expect(message.toLowerCase()).not.toContain("attestation");
    expect(message.toLowerCase()).not.toContain("session");
  });

  it("the two active-exam messages are distinct", () => {
    expect(describeRevocationFailure("ACTIVE_EXAM_IN_PROGRESS")).not.toBe(
      describeRevocationFailure("ACTIVE_EXAM_IN_PROGRESS_ACCOUNT_WIDE"),
    );
  });
});

describe("buildRevokeConfirmCopy", () => {
  it("current-device copy matches the exact required title and message", () => {
    const copy = buildRevokeConfirmCopy(true);
    expect(copy.title).toBe("Remove access from this computer?");
    expect(copy.message).toBe("Tether will need to register this computer again before it can be used for another secure examination.");
  });

  it("other-device copy matches the exact required title and message", () => {
    const copy = buildRevokeConfirmCopy(false);
    expect(copy.title).toBe("Remove this computer's access?");
    expect(copy.message).toBe("This computer will no longer be able to complete Tether system checks or start secure examinations until it is registered again.");
  });

  it("current-device and other-device copy are never identical", () => {
    expect(buildRevokeConfirmCopy(true)).not.toEqual(buildRevokeConfirmCopy(false));
  });
});

describe("formatActiveComputersSummary", () => {
  it("matches the exact required phrasing", () => {
    expect(formatActiveComputersSummary(2, 2)).toBe("2 of 2 active computers");
    expect(formatActiveComputersSummary(0, 2)).toBe("0 of 2 active computers");
    expect(formatActiveComputersSummary(1, 5)).toBe("1 of 5 active computers");
  });
});
