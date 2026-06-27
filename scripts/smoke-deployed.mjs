#!/usr/bin/env node
// Smoke test for a deployed (or local) SES instance. Read-only, no secrets
// required, no data mutation. Distinguishes core deployment failures from
// optional Canvas/AI module unavailability.
//
// Usage:
//   node scripts/smoke-deployed.mjs https://your-ses-domain.com
//   node scripts/smoke-deployed.mjs http://localhost:3001

const baseUrl = process.argv[2];

if (!baseUrl) {
  console.error("Usage: node scripts/smoke-deployed.mjs <base-url>");
  console.error("Example: node scripts/smoke-deployed.mjs https://your-ses-domain.com");
  process.exit(2);
}

const url = (path) => new URL(path, baseUrl).toString();

let coreFailures = 0;
const optionalWarnings = [];

function pass(label, detail) {
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label, detail) {
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  coreFailures++;
}

function optionalUnavailable(label, detail) {
  console.log(`  SKIP  ${label} — optional module unavailable${detail ? `: ${detail}` : ""}`);
  optionalWarnings.push(label);
}

async function getJson(path) {
  const res = await fetch(url(path));
  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON response is handled by the caller via res.status/body=null
  }
  return { res, body };
}

async function checkHealth() {
  console.log("\n[core] GET /api/health");
  try {
    const { res, body } = await getJson("/api/health");
    if (res.status !== 200) {
      fail("health endpoint", `expected 200, got ${res.status}`);
      return;
    }
    if (!body || body.status !== "ok") {
      fail("health endpoint", `unexpected body: ${JSON.stringify(body)}`);
      return;
    }
    pass("health endpoint", `database=${body.database}`);
  } catch (err) {
    fail("health endpoint", `request failed: ${err.message}`);
  }
}

async function checkReadiness() {
  console.log("\n[core] GET /api/readiness");
  try {
    const { res, body } = await getJson("/api/readiness");
    if (res.status !== 200) {
      fail("readiness endpoint", `expected 200, got ${res.status}`);
      return;
    }
    const expectedBooleanKeys = [
      "databaseConnected",
      "ltiKeysConfigured",
      "appUrlConfigured",
      "aiKeyConfigured",
      "authSecretConfigured",
    ];
    const missing = expectedBooleanKeys.filter((k) => typeof body?.[k] !== "boolean");
    if (missing.length > 0) {
      fail("readiness endpoint", `missing/non-boolean fields: ${missing.join(", ")}`);
      return;
    }
    const serialized = JSON.stringify(body);
    if (/[A-Za-z0-9+/]{40,}={0,2}/.test(serialized) || serialized.includes("-----BEGIN")) {
      fail("readiness endpoint", "response looks like it may contain secret/key material");
      return;
    }
    pass("readiness endpoint", "all booleans present, no secret-shaped values");
    if (!body.databaseConnected) fail("database connection", "readiness reports databaseConnected=false");
    if (!body.authSecretConfigured) fail("auth secret", "readiness reports authSecretConfigured=false");
    if (!body.appUrlConfigured) fail("app URL", "readiness reports appUrlConfigured=false");
    if (!body.ltiKeysConfigured) optionalUnavailable("Canvas/LTI keys");
    if (!body.aiKeyConfigured) optionalUnavailable("AI (Anthropic) key");
  } catch (err) {
    fail("readiness endpoint", `request failed: ${err.message}`);
  }
}

async function checkPage(path, label) {
  console.log(`\n[core] GET ${path}`);
  try {
    const res = await fetch(url(path));
    if (res.status !== 200) {
      fail(label, `expected 200, got ${res.status}`);
      return;
    }
    pass(label);
  } catch (err) {
    fail(label, `request failed: ${err.message}`);
  }
}

async function checkLtiConfig() {
  console.log("\n[optional: Canvas] GET /api/lti/config");
  try {
    const { res, body } = await getJson("/api/lti/config");
    if (res.status !== 200) {
      optionalUnavailable("LTI tool config", `status ${res.status}`);
      return;
    }
    if (!body?.public_jwk) {
      fail("LTI tool config", "200 response missing public_jwk");
      return;
    }
    pass("LTI tool config", "available");
  } catch (err) {
    optionalUnavailable("LTI tool config", err.message);
  }
}

async function checkJwks() {
  console.log("\n[optional: Canvas] GET /api/lti/jwks");
  try {
    const { res, body } = await getJson("/api/lti/jwks");
    if (res.status !== 200) {
      optionalUnavailable("LTI JWKS", `status ${res.status}`);
      return;
    }
    if (!Array.isArray(body?.keys) || body.keys.length === 0) {
      fail("LTI JWKS", "200 response missing keys array");
      return;
    }
    const serialized = JSON.stringify(body);
    if (serialized.includes("-----BEGIN") || serialized.toLowerCase().includes("private")) {
      fail("LTI JWKS", "response appears to contain private key material");
      return;
    }
    const hasOnlyPublicFields = body.keys.every(
      (k) => typeof k.n === "string" && typeof k.e === "string" && !("d" in k),
    );
    if (!hasOnlyPublicFields) {
      fail("LTI JWKS", "key entries contain unexpected private-key fields");
      return;
    }
    pass("LTI JWKS", `${body.keys.length} public key(s), no private material`);
  } catch (err) {
    optionalUnavailable("LTI JWKS", err.message);
  }
}

async function main() {
  console.log(`Smoke testing ${baseUrl}\n` + "=".repeat(40));

  await checkHealth();
  await checkReadiness();
  await checkPage("/privacy/student-exam-notice", "privacy notice page");
  await checkPage("/lti/not-linked", "LTI not-linked page");
  await checkLtiConfig();
  await checkJwks();

  console.log("\n" + "=".repeat(40));
  if (coreFailures > 0) {
    console.log(`RESULT: CORE DEPLOYMENT FAILURE (${coreFailures} check(s) failed)`);
    process.exit(1);
  }
  if (optionalWarnings.length > 0) {
    console.log(`RESULT: core deployment OK. Optional module(s) not available: ${optionalWarnings.join(", ")}`);
  } else {
    console.log("RESULT: core deployment OK. All optional modules available.");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Smoke script crashed:", err);
  process.exit(1);
});
