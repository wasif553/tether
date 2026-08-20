import "dotenv/config";

// Cryptography audit v1, P1 fix — EXAM_BINDING_HMAC_SECRET and
// NETWORK_EVIDENCE_SALT now fail closed (throw, never a silently
// generated fallback key — see src/lib/sessionBinding.ts and
// src/lib/networkEvidence.ts) when unconfigured. Neither is set in the
// local .env template (both are optional-in-development,
// required-in-production secrets), so the test suite needs its own
// explicit, synthetic values here — never a real Production secret —
// so every existing test that exercises session-binding/network-
// evidence hashing keeps running exactly as before. Tests that
// specifically exercise the "secret missing" fail-closed path unset
// these locally within their own test and restore them afterward (see
// sessionBinding.test.ts / networkEvidenceRoutes.test.ts).
process.env.EXAM_BINDING_HMAC_SECRET ??= "test-only-exam-binding-hmac-secret-synthetic-value";
process.env.NETWORK_EVIDENCE_SALT ??= "test-only-network-evidence-salt-synthetic-value";
