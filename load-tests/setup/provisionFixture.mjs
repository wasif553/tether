#!/usr/bin/env node
/**
 * TETHER_LOAD_TEST_HARNESS_READINESS_P0_V1 — fixture provisioning.
 *
 * Creates one synthetic lecturer, one synthetic exam (20 questions: 12
 * MCQ + 8 short-answer, one-question-at-a-time, Question Navigator
 * enabled, STANDALONE assignment mode), and N synthetic students —
 * ENTIRELY through the deployed HTTP API, exactly like a real browser
 * would (POST /api/signup, NextAuth Credentials login, POST
 * .../standalone-invite/accept). This script never touches a database
 * directly — there is no DATABASE_URL for it to misconfigure. See
 * ../verify/verifyRun.mjs for the one script in this harness that does
 * connect directly to a database, gated by the same production denylist.
 *
 * Deliberately does NOT call POST /api/exams/[id]/start for any student —
 * that call, and everything after it, is the k6-driven TIMED workload
 * (see load-tests/README.md, "Pre-exam/authentication phase" vs. "Attempt
 * start"). This script's own job ends at "every student can log in and
 * has an ExamAssignment for the fixture exam" — authentication latency is
 * therefore measured HERE, separately from the active-exam capacity
 * result k6 produces, exactly as the task's STUDENT LIFECYCLE section
 * requires.
 *
 * Login concurrency is deliberately bounded (see CONCURRENCY_LIMIT below)
 * — never a single Promise.all across all N students — so this script can
 * never itself present a burst of hundreds of simultaneous credential
 * attempts from one generator IP against
 * LOGIN_SOURCE_FAILURES_SCOPE (200/5min, see
 * src/lib/security/rateLimitScopes.ts). A successful login releases its
 * own slot immediately (see src/lib/security/loginAttempt.ts) — only
 * genuine failures accumulate — so bounded concurrency plus this script's
 * own retry-free "fail loud" design is sufficient; there is no reason to
 * additionally throttle the LOGIN RATE itself for a run of the sizes this
 * harness targets (up to 500).
 *
 * Usage:
 *   LOADTEST_TARGET_BASE_URL=https://your-dedicated-loadtest-deployment.vercel.app \
 *   node load-tests/setup/provisionFixture.mjs --students=100 --label=stage1
 *
 * Writes load-tests/runs/<runId>/manifest.json (non-secret — safe to
 * commit, though the runs/ directory is gitignored by default) and
 * load-tests/runs/<runId>/credentials.local.json (SECRET — plaintext
 * passwords and session cookies; matched by .gitignore, never committed).
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertLoadTestEnvironmentIsSafe } from "../shared/productionDenylist.mjs";
import { buildFixtureQuestionDefinitions } from "../shared/deterministicAnswers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = path.join(__dirname, "..", "runs");

const CONCURRENCY_LIMIT = 8;

function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [k, v] = arg.replace(/^--/, "").split("=");
      return [k, v ?? "true"];
    }),
  );
  return {
    students: Number(args.students ?? 10),
    label: args.label ?? "unlabeled",
  };
}

function nowIso() {
  return new Date().toISOString();
}

/** Small dependency-free bounded-concurrency pool — never a single Promise.all across the whole student list. */
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runOne() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await worker(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, runOne);
  await Promise.all(workers);
  return results;
}

/** Cookie-jar-per-actor fetch helper — same convention as the prior scripts/load-test-secure-exam.mjs, kept independent here since that script remains untouched (see this harness's own README for why). */
function makeActor(baseUrl) {
  const jar = new Map();
  return {
    jar,
    async request(path, init = {}) {
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
      const url = new URL(path, baseUrl).toString();
      const start = Date.now();
      const res = await fetch(url, {
        ...init,
        headers: { ...(init.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) },
        redirect: "manual",
      });
      const ms = Date.now() - start;
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) {
        for (const part of setCookie.split(/,(?=\s*[\w.-]+=)/)) {
          const [nameValue] = part.split(";");
          const eq = nameValue.indexOf("=");
          if (eq === -1) continue;
          jar.set(nameValue.slice(0, eq).trim(), nameValue.slice(eq + 1).trim());
        }
      }
      let body = null;
      try {
        body = await res.json();
      } catch {
        // non-JSON response — leave body null (e.g. a redirect with no body)
      }
      return { ok: res.status < 400, status: res.status, body, ms };
    },
    cookieHeader() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}

async function getCsrfToken(actor) {
  const { body } = await actor.request("/api/auth/csrf");
  return body?.csrfToken;
}

async function signup(actor, name, email, password, role, extra = {}) {
  return actor.request("/api/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password, role, ...extra }),
  });
}

/**
 * POST /api/auth/callback/credentials ALWAYS redirects with 302, on both
 * success (to the callback URL) and failure (to
 * /login?error=CredentialsSignin) — status alone can never distinguish
 * the two, so `res.status < 400`-based `.ok` from `actor.request()` is
 * not trustworthy here. A genuine success also always sets a real
 * `authjs.session-token` cookie in the same response; a failure never
 * does. Checking for that cookie's actual presence in the jar AFTER the
 * request is what makes this check accurate.
 */
async function login(actor, email, password) {
  const csrfToken = await getCsrfToken(actor);
  const result = await actor.request("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, email, password, json: "true" }).toString(),
  });
  const hasSessionToken = [...actor.jar.keys()].some((name) => name.includes("session-token"));
  return { ...result, ok: result.ok && hasSessionToken };
}

function generatePassword() {
  return `Lt_${randomBytes(18).toString("base64url")}`;
}

async function main() {
  const { students: studentCount, label } = parseArgs();
  if (!Number.isInteger(studentCount) || studentCount < 1) {
    console.error("--students must be a positive integer");
    process.exit(2);
  }

  // MANDATORY, unconditional, non-overridable — see productionDenylist.mjs.
  // databaseUrl is intentionally NOT read/passed here: this script never
  // touches a database, so there is nothing for that half of the guard to
  // check. It still runs (with databaseUrl undefined) purely so a
  // misconfigured environment that also happens to export
  // LOADTEST_DATABASE_URL=<production> is at least caught by the OTHER
  // half of the same combined check when verify/verifyRun.mjs runs next —
  // this script's own safety comes entirely from the target-URL check.
  const targetBaseUrl = process.env.LOADTEST_TARGET_BASE_URL;
  assertLoadTestEnvironmentIsSafe({ targetBaseUrl, databaseUrl: "postgresql://placeholder-not-used-by-this-script@localhost/placeholder" });

  const runId = `LT-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const runDir = path.join(RUNS_DIR, runId);
  await mkdir(runDir, { recursive: true });

  console.log(`[provisionFixture] Target: ${targetBaseUrl}`);
  console.log(`[provisionFixture] Run ID: ${runId} (label: ${label})`);
  console.log(`[provisionFixture] Students to provision: ${studentCount}`);

  const authTimings = { lecturerSignupMs: null, lecturerLoginMs: null, studentSignupMs: [], studentLoginMs: [], acceptInviteMs: [] };

  // --- lecturer ---
  const lecturer = makeActor(targetBaseUrl);
  // Lowercased explicitly — signup (src/lib/selfServiceSignup.ts's
  // emailSchema) normalizes every stored email to lowercase, but the
  // Credentials login lookup deliberately uses the RAW email exactly as
  // supplied (see src/lib/security/loginAttempt.ts's own doc comment).
  // runId embeds uppercase hex/timestamp characters, so building an email
  // from it without lowercasing here would store one casing at signup and
  // send a different one at login — a genuine, silent CredentialsSignin
  // failure this exact bug produced during this task's own local smoke
  // run before being caught and fixed.
  const lecturerEmail = `loadtest-lecturer-${runId}@example.invalid`.toLowerCase();
  const lecturerPassword = generatePassword();
  const lecturerName = `LOADTEST_Lecturer_${runId}`;

  let t0 = Date.now();
  // LECTURER self-service signup creates a brand-new Institution atomically
  // (see src/lib/selfServiceSignup.ts's lecturerSignupSchema, `.strict()` —
  // organisationName is required for this role, unlike the STUDENT branch).
  const lecturerSignup = await signup(lecturer, lecturerName, lecturerEmail, lecturerPassword, "LECTURER", { organisationName: `LOADTEST_Org_${runId}` });
  authTimings.lecturerSignupMs = Date.now() - t0;
  if (!lecturerSignup.ok) {
    console.error("Lecturer signup failed:", lecturerSignup.status, lecturerSignup.body);
    process.exit(1);
  }

  t0 = Date.now();
  const lecturerLogin = await login(lecturer, lecturerEmail, lecturerPassword);
  authTimings.lecturerLoginMs = Date.now() - t0;
  if (!lecturerLogin.ok) {
    console.error("Lecturer login failed:", lecturerLogin.status, lecturerLogin.body);
    process.exit(1);
  }
  console.log(`[provisionFixture] Lecturer ready (signup ${authTimings.lecturerSignupMs}ms, login ${authTimings.lecturerLoginMs}ms)`);

  // --- exam ---
  const examTitle = `LOADTEST_${runId}_${label}`;
  const { ok: examOk, body: exam } = await lecturer.request("/api/exams", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: examTitle, durationMins: 90 }),
  });
  if (!examOk || !exam?.id) {
    console.error("Exam creation failed:", exam);
    process.exit(1);
  }
  console.log(`[provisionFixture] Exam created: ${exam.id}`);

  // Architecture decision (see load-tests/README.md, "Secure Tether
  // session strategy" and this run's own PHASE-0 investigation): deliberately
  // STANDARD_WEB. TETHER_CLIENT_REQUIRED/SEB_REQUIRED content access is
  // additionally gated by a content-access lease that is ONLY mintable via
  // genuine native installation-key attestation (see
  // src/lib/secureClient/requireTetherContentAccess.ts) — no automated
  // script can legitimately obtain one without forging cryptographic
  // proof, which this task's own hard rules explicitly forbid. STANDARD_WEB
  // exercises the full one-question-at-a-time/Question Navigator/autosave/
  // save-and-navigate/submit surface with zero secure-client machinery
  // required, so it is the only delivery mode this harness may safely
  // target.
  const patchSettings = await lecturer.request(`/api/exams/${exam.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secureSettings: {
        deliveryMode: "STANDARD_WEB",
        secureModeEnabled: true,
        blockCopyPaste: true,
        trackWindowBlur: true,
        oneQuestionAtATime: true,
        allowBackNavigation: true,
        allowQuestionJumping: true,
        allowFlagForReview: true,
        showQuestionNavigator: true,
        // Avoids spurious deadline-related failures from harness/network
        // overhead polluting the capacity measurement — same rationale
        // scripts/load-test-secure-exam.mjs already documents.
        allowLateSubmit: true,
      },
    }),
  });
  if (!patchSettings.ok) {
    console.error("Exam settings PATCH failed:", patchSettings.body);
    process.exit(1);
  }

  // --- questions ---
  const questionDefs = buildFixtureQuestionDefinitions();
  const createdQuestions = [];
  for (const def of questionDefs) {
    const { ok, body } = await lecturer.request(`/api/exams/${exam.id}/questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(def),
    });
    if (!ok || !body?.id) {
      console.error("Question creation failed:", def.type, body);
      process.exit(1);
    }
    createdQuestions.push({ id: body.id, type: body.type, order: body.order });
  }
  console.log(`[provisionFixture] Created ${createdQuestions.length} questions (${createdQuestions.filter((q) => q.type === "MULTIPLE_CHOICE").length} MCQ, ${createdQuestions.filter((q) => q.type === "SHORT_ANSWER").length} short-answer)`);

  // --- publish ---
  const publishRes = await lecturer.request(`/api/exams/${exam.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ published: true }),
  });
  if (!publishRes.ok) {
    console.error("Publish failed:", publishRes.body);
    process.exit(1);
  }
  console.log(`[provisionFixture] Exam published`);

  // --- standalone invite (STANDALONE assignment mode — no institution
  // membership required, so a self-service student with institutionId:
  // null can still legitimately gain access; see this file's own header
  // and load-tests/README.md, "Synthetic-data strategy") ---
  const inviteRes = await lecturer.request(`/api/exams/${exam.id}/standalone-invite`, { method: "POST" });
  if (!inviteRes.ok || !inviteRes.body?.inviteUrl) {
    console.error("Standalone invite creation failed:", inviteRes.body);
    process.exit(1);
  }
  const inviteToken = inviteRes.body.inviteUrl.split("/").pop();
  console.log(`[provisionFixture] Standalone invite token issued`);

  // --- students ---
  const studentIndices = Array.from({ length: studentCount }, (_, i) => i);
  const students = await runWithConcurrency(studentIndices, CONCURRENCY_LIMIT, async (studentIndex) => {
    // See lecturerEmail's own comment above for why this must be lowercased.
    const email = `loadtest-student-${runId}-${studentIndex}@example.invalid`.toLowerCase();
    const password = generatePassword();
    const name = `LOADTEST_Student_${runId}_${studentIndex}`;
    const actor = makeActor(targetBaseUrl);

    const signupStart = Date.now();
    const signupRes = await signup(actor, name, email, password, "STUDENT");
    authTimings.studentSignupMs.push(Date.now() - signupStart);
    if (!signupRes.ok) return { studentIndex, ok: false, stage: "signup", detail: signupRes.body };

    const loginStart = Date.now();
    const loginRes = await login(actor, email, password);
    authTimings.studentLoginMs.push(Date.now() - loginStart);
    if (!loginRes.ok) return { studentIndex, ok: false, stage: "login", detail: loginRes.body };

    const acceptStart = Date.now();
    const acceptRes = await actor.request(`/api/exams/${exam.id}/standalone-invite/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteToken }),
    });
    authTimings.acceptInviteMs.push(Date.now() - acceptStart);
    if (!acceptRes.ok || acceptRes.body?.ok !== true) return { studentIndex, ok: false, stage: "accept-invite", detail: acceptRes.body };

    return { studentIndex, ok: true, email, password, cookieHeader: actor.cookieHeader() };
  });

  const succeeded = students.filter((s) => s.ok);
  const failed = students.filter((s) => !s.ok);
  console.log(`[provisionFixture] Students provisioned: ${succeeded.length}/${studentCount}`);
  if (failed.length > 0) {
    console.warn(`[provisionFixture] ${failed.length} student(s) failed setup — see manifest.json's "setupFailures" for detail. k6 will only use the ${succeeded.length} that succeeded.`);
  }

  function percentile(values, p) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, idx)];
  }

  const manifest = {
    runId,
    label,
    targetBaseUrl,
    createdAt: nowIso(),
    examId: exam.id,
    examTitle,
    lecturerEmail,
    questions: createdQuestions.map((q, i) => ({ ...q, fixtureIndex: i })),
    studentCountRequested: studentCount,
    studentCountProvisioned: succeeded.length,
    setupFailures: failed.map((f) => ({ studentIndex: f.studentIndex, stage: f.stage, detail: f.detail })),
    authTiming: {
      lecturerSignupMs: authTimings.lecturerSignupMs,
      lecturerLoginMs: authTimings.lecturerLoginMs,
      studentSignupMsP50: percentile(authTimings.studentSignupMs, 50),
      studentSignupMsP95: percentile(authTimings.studentSignupMs, 95),
      studentLoginMsP50: percentile(authTimings.studentLoginMs, 50),
      studentLoginMsP95: percentile(authTimings.studentLoginMs, 95),
      acceptInviteMsP50: percentile(authTimings.acceptInviteMs, 50),
      acceptInviteMsP95: percentile(authTimings.acceptInviteMs, 95),
    },
  };
  await writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // SECRET — plaintext passwords and session cookies. Matched by
  // load-tests/.gitignore; never committed. k6 reads this file via
  // open() at init time to pre-authenticate every VU without performing
  // its own login during the timed run (see this file's own header).
  const credentials = {
    runId,
    lecturer: { email: lecturerEmail, password: lecturerPassword },
    students: succeeded.map((s) => ({ studentIndex: s.studentIndex, email: s.email, password: s.password, cookieHeader: s.cookieHeader })),
  };
  await writeFile(path.join(runDir, "credentials.local.json"), JSON.stringify(credentials, null, 2));

  console.log(`[provisionFixture] Wrote ${path.join(runDir, "manifest.json")}`);
  console.log(`[provisionFixture] Wrote ${path.join(runDir, "credentials.local.json")} (secret — not committed)`);
  console.log(`[provisionFixture] Auth timing (separate from active-exam capacity): lecturer signup ${authTimings.lecturerSignupMs}ms / login ${authTimings.lecturerLoginMs}ms; student login P50 ${manifest.authTiming.studentLoginMsP50}ms / P95 ${manifest.authTiming.studentLoginMsP95}ms`);
  console.log(`\nNext: k6 run load-tests/k6/scenarios/<stage>.js -e RUN_ID=${runId}`);
}

main().catch((err) => {
  console.error("[provisionFixture] FAILED:", err);
  process.exit(1);
});
