#!/usr/bin/env node
// Live concurrency/load validation for Secure Exam Mode. Creates throwaway
// LOADTEST_-prefixed lecturer/student accounts and exams against a real
// deployment, drives concurrent start/autosave/integrity-event/submit
// traffic, fetches analytics + integrity events, reports pass/fail metrics,
// and cleans up the exams it created (cascades submissions/answers/events).
//
// This script does not require Canvas or AI — it never touches either
// optional module.
//
// Usage:
//   node scripts/load-test-secure-exam.mjs --baseUrl=https://your-domain.com --students=10 --exams=1
//   node scripts/load-test-secure-exam.mjs --baseUrl=https://your-domain.com --students=25 --exams=2
//   node scripts/load-test-secure-exam.mjs --baseUrl=https://your-domain.com --students=50 --exams=3

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [k, v] = arg.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);

const baseUrl = args.baseUrl;
const studentCount = Number(args.students ?? 10);
const examCount = Number(args.exams ?? 1);
const skipCleanup = args.cleanup === "false";

if (!baseUrl) {
  console.error("Usage: node scripts/load-test-secure-exam.mjs --baseUrl=<url> --students=<n> --exams=<n>");
  process.exit(2);
}
if (!Number.isInteger(studentCount) || studentCount < 1) {
  console.error("--students must be a positive integer");
  process.exit(2);
}
if (!Number.isInteger(examCount) || examCount < 1) {
  console.error("--exams must be a positive integer");
  process.exit(2);
}
if (studentCount > 50) {
  console.warn(
    `WARNING: --students=${studentCount} exceeds the recommended 50-student cap for this script. ` +
      "Proceeding anyway since it was explicitly passed, but treat results above 50 with extra caution.",
  );
}

const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "LoadTest123!"; // never logged with an identifying account

const url = (path) => new URL(path, baseUrl).toString();

// --- metrics ---
const samples = []; // { route, status, ms, ok }
const errorsByRouteStatus = new Map(); // "route:status" -> count

function record(route, status, ms, ok) {
  samples.push({ route, status, ms, ok });
  if (!ok) {
    const key = `${route}:${status}`;
    errorsByRouteStatus.set(key, (errorsByRouteStatus.get(key) ?? 0) + 1);
  }
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// --- cookie-jar-per-actor fetch helper (no global cookie state, no logging of cookie values) ---
function makeActor() {
  const jar = new Map(); // cookie name -> value, merged across requests
  return {
    async request(route, path, init = {}) {
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
      const start = Date.now();
      let res;
      try {
        res = await fetch(url(path), {
          ...init,
          headers: {
            ...(init.headers ?? {}),
            ...(cookie ? { Cookie: cookie } : {}),
          },
          redirect: "manual",
        });
      } catch (err) {
        record(route, "network-error", Date.now() - start, false);
        return { ok: false, status: 0, error: err.message };
      }
      const ms = Date.now() - start;
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) {
        // Cookie names here (e.g. authjs.session-token, __Secure-authjs.session-token)
        // contain dots, so split only on a comma followed by a name made of
        // word chars, dots, underscores, or hyphens, then "=".
        for (const part of setCookie.split(/,(?=\s*[\w.-]+=)/)) {
          const [nameValue] = part.split(";");
          const eq = nameValue.indexOf("=");
          if (eq === -1) continue;
          const name = nameValue.slice(0, eq).trim();
          const value = nameValue.slice(eq + 1).trim();
          jar.set(name, value);
        }
      }
      record(route, res.status, ms, res.status < 400);
      let body = null;
      try {
        body = await res.json();
      } catch {
        // non-JSON (e.g. redirects) — leave body null
      }
      return { ok: res.status < 400, status: res.status, body };
    },
  };
}

async function getCsrfToken(actor) {
  const { body } = await actor.request("auth:csrf", "/api/auth/csrf");
  return body?.csrfToken;
}

async function signup(actor, name, email, role) {
  return actor.request("signup", "/api/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password: PASSWORD, role }),
  });
}

async function login(actor, email) {
  const csrfToken = await getCsrfToken(actor);
  return actor.request("auth:callback", "/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, email, password: PASSWORD, json: "true" }).toString(),
  });
}

async function main() {
  console.log(`Load testing ${baseUrl}`);
  console.log(`Run ID: LOADTEST_${runId}`);
  console.log(`Students: ${studentCount}, Exams: ${examCount}\n` + "=".repeat(50));

  const createdExamIds = [];
  const createdAccountEmails = [];

  // --- lecturer setup ---
  const lecturer = makeActor();
  const lecturerEmail = `loadtest-lect-${runId}@example.com`;
  createdAccountEmails.push(lecturerEmail);
  const signupRes = await signup(lecturer, `LOADTEST_Lecturer_${runId}`, lecturerEmail, "LECTURER");
  const loginRes = await login(lecturer, lecturerEmail);
  const lecturerSetupOk = signupRes.ok && loginRes.ok;
  console.log(`Lecturer setup: ${lecturerSetupOk ? "OK" : "FAILED"}`);
  if (!lecturerSetupOk) {
    console.error("Cannot continue without a working lecturer account. Aborting.");
    printReport({ lecturerSetupOk, studentSetupOk: 0, examIds: [], cleanupDone: false });
    process.exit(1);
  }

  // --- exam setup ---
  const exams = [];
  for (let i = 0; i < examCount; i++) {
    const title = `LOADTEST_${runId}_exam${i}`;
    const { ok: createOk, body: exam } = await lecturer.request("exams:create", "/api/exams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, durationMins: 30 }),
    });
    if (!createOk || !exam?.id) {
      console.error(`Failed to create exam ${i}`);
      continue;
    }
    createdExamIds.push(exam.id);

    await lecturer.request("exams:patch-secure", `/api/exams/${exam.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secureSettings: {
          secureModeEnabled: true,
          blockCopyPaste: true,
          blockRightClick: true,
          trackWindowBlur: true,
          // allowLateSubmit avoids spurious deadline failures from load-test
          // overhead/latency — this script measures throughput, not the
          // deadline-enforcement behavior already covered by unit tests.
          allowLateSubmit: true,
        },
      }),
    });

    const { body: mcq } = await lecturer.request("exams:add-question", `/api/exams/${exam.id}/questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "MULTIPLE_CHOICE",
        text: "What is 2 + 2?",
        options: ["3", "4", "5"],
        correctAnswer: "4",
        points: 1,
      }),
    });
    const { body: shortAnswer } = await lecturer.request(
      "exams:add-question",
      `/api/exams/${exam.id}/questions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "SHORT_ANSWER", text: "Name one exam integrity signal.", points: 1 }),
      },
    );

    await lecturer.request("exams:publish", `/api/exams/${exam.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ published: true }),
    });

    exams.push({ id: exam.id, title, mcqId: mcq?.id, shortAnswerId: shortAnswer?.id });
  }
  console.log(`Exams created: ${exams.length}/${examCount}`);

  if (exams.length === 0) {
    console.error("No exams available. Aborting.");
    printReport({ lecturerSetupOk, studentSetupOk: 0, examIds: [], cleanupDone: false });
    process.exit(1);
  }

  // --- student setup ---
  const students = [];
  let studentSetupOk = 0;
  for (let i = 0; i < studentCount; i++) {
    const email = `loadtest-stud-${runId}-${i}@example.com`;
    createdAccountEmails.push(email);
    const actor = makeActor();
    const sRes = await signup(actor, `LOADTEST_Student_${runId}_${i}`, email, "STUDENT");
    const lRes = await login(actor, email);
    const exam = exams[i % exams.length];
    if (sRes.ok && lRes.ok) {
      studentSetupOk++;
      students.push({ actor, email, exam });
    }
  }
  console.log(`Student setup: ${studentSetupOk}/${studentCount}\n` + "=".repeat(50));

  // --- concurrent phases ---
  async function runPhase(label, fn) {
    console.log(`\nRunning phase: ${label} (${students.length} concurrent requests)`);
    const results = await Promise.allSettled(students.map(fn));
    const ok = results.filter((r) => r.status === "fulfilled" && r.value === true).length;
    console.log(`  ${label}: ${ok}/${students.length} succeeded`);
    return ok;
  }

  const startedSubmissions = new Map(); // email -> submissionId
  const startOk = await runPhase("start exam", async (s) => {
    const { ok, body } = await s.actor.request("submissions:start", `/api/exams/${s.exam.id}/start`, {
      method: "POST",
    });
    if (ok && body?.id) {
      startedSubmissions.set(s.email, body.id);
      return true;
    }
    return false;
  });

  const autosaveOk = await runPhase("autosave answer", async (s) => {
    const subId = startedSubmissions.get(s.email);
    if (!subId || !s.exam.mcqId) return false;
    const { ok } = await s.actor.request("submissions:answers", `/api/submissions/${subId}/answers`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId: s.exam.mcqId, response: "4" }),
    });
    return ok;
  });

  const integrityOk = await runPhase("integrity event", async (s) => {
    const subId = startedSubmissions.get(s.email);
    if (!subId) return false;
    const { ok } = await s.actor.request(
      "submissions:integrity-events",
      `/api/submissions/${subId}/integrity-events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType: "RIGHT_CLICK_ATTEMPT",
          severity: "MEDIUM",
          message: "A right-click was attempted.",
          occurredAt: new Date().toISOString(),
        }),
      },
    );
    return ok;
  });

  const submitOk = await runPhase("submit", async (s) => {
    const subId = startedSubmissions.get(s.email);
    if (!subId) return false;
    const { ok } = await s.actor.request("submissions:submit", `/api/submissions/${subId}/submit`, {
      method: "POST",
    });
    return ok;
  });

  // --- duplicate submission detection ---
  // Re-start each exam once more per student; a healthy deployment returns
  // the SAME submission id (idempotent), never a new one.
  let duplicateSubmissionIssues = 0;
  for (const s of students) {
    const subId = startedSubmissions.get(s.email);
    if (!subId) continue;
    const { ok, body } = await s.actor.request("submissions:restart-check", `/api/exams/${s.exam.id}/start`, {
      method: "POST",
    });
    if (ok && body?.id && body.id !== subId) duplicateSubmissionIssues++;
  }

  // --- lecturer review fetches ---
  let analyticsOk = 0;
  let integrityFetchOk = 0;
  for (const exam of exams) {
    const a = await lecturer.request("lecturer:analytics", `/api/lecturer/exams/${exam.id}/analytics`);
    if (a.ok) analyticsOk++;
    const ie = await lecturer.request(
      "lecturer:integrity-events",
      `/api/lecturer/exams/${exam.id}/integrity-events`,
    );
    if (ie.ok) integrityFetchOk++;
  }
  console.log(`\nAnalytics fetch: ${analyticsOk}/${exams.length}`);
  console.log(`Integrity events fetch: ${integrityFetchOk}/${exams.length}`);

  // --- cleanup ---
  let cleanupDone = false;
  if (!skipCleanup) {
    let deleted = 0;
    for (const examId of createdExamIds) {
      const { ok } = await lecturer.request("cleanup:delete-exam", `/api/exams/${examId}`, {
        method: "DELETE",
      });
      if (ok) deleted++;
    }
    cleanupDone = deleted === createdExamIds.length;
    console.log(`\nCleanup: deleted ${deleted}/${createdExamIds.length} LOADTEST exams (cascades submissions/answers/integrity events).`);
  }
  console.log(
    `Cleanup note: lecturer/student USER accounts created by this run cannot be deleted via any` +
      ` existing API (no delete-user route exists) and were left in place. They are clearly` +
      ` identifiable by the LOADTEST_${runId} prefix and loadtest-*-${runId}-* email pattern for` +
      ` manual cleanup if desired:`,
  );
  for (const email of createdAccountEmails) console.log(`  - ${email}`);

  printReport({
    lecturerSetupOk,
    studentSetupOk,
    examIds: createdExamIds,
    startOk,
    autosaveOk,
    integrityOk,
    submitOk,
    analyticsOk,
    integrityFetchOk,
    duplicateSubmissionIssues,
    cleanupDone,
  });
}

function printReport(r) {
  console.log("\n" + "=".repeat(50));
  console.log("LOAD TEST REPORT");
  console.log("=".repeat(50));
  console.log(`Deployment: ${baseUrl}`);
  console.log(`Exams: ${examCount} (created: ${r.examIds?.length ?? 0})`);
  console.log(`Students requested: ${studentCount}`);
  console.log(`Lecturer setup: ${r.lecturerSetupOk ? "OK" : "FAILED"}`);
  console.log(`Student signups: ${r.studentSetupOk ?? 0}/${studentCount}`);

  const total = r.studentSetupOk ?? 0;
  const pct = (n) => (total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "n/a");
  if (r.startOk != null) {
    console.log(`Exam start success: ${r.startOk}/${total} (${pct(r.startOk)})`);
    console.log(`Autosave success: ${r.autosaveOk}/${total} (${pct(r.autosaveOk)})`);
    console.log(`Integrity event success: ${r.integrityOk}/${total} (${pct(r.integrityOk)})`);
    console.log(`Submit success: ${r.submitOk}/${total} (${pct(r.submitOk)})`);
    console.log(`Analytics fetch success: ${r.analyticsOk}/${r.examIds.length}`);
    console.log(`Integrity events fetch success: ${r.integrityFetchOk}/${r.examIds.length}`);
    console.log(`Duplicate submission issues detected: ${r.duplicateSubmissionIssues ?? 0}`);
  }
  console.log(`Cleanup completed: ${r.cleanupDone ? "yes" : "no / skipped"}`);

  const allMs = samples.map((s) => s.ms);
  const avg = allMs.length ? allMs.reduce((a, b) => a + b, 0) / allMs.length : null;
  const p95 = percentile(allMs, 95);
  console.log(`\nAverage response time: ${avg != null ? avg.toFixed(0) + "ms" : "n/a"}`);
  console.log(`P95 response time: ${p95 != null ? p95 + "ms" : "n/a"}`);

  console.log("\nErrors by route:status (count):");
  if (errorsByRouteStatus.size === 0) {
    console.log("  none");
  } else {
    for (const [key, count] of errorsByRouteStatus.entries()) {
      console.log(`  ${key}: ${count}`);
    }
  }

  console.log("\nRecommendation:");
  if (!r.lecturerSetupOk || (r.studentSetupOk ?? 0) === 0) {
    console.log("  NEEDS INVESTIGATION — setup itself failed.");
    return;
  }
  const startRate = total > 0 ? r.startOk / total : 0;
  const submitRate = total > 0 ? r.submitOk / total : 0;
  const autosaveRate = total > 0 ? r.autosaveOk / total : 0;
  const hasDuplicates = (r.duplicateSubmissionIssues ?? 0) > 0;

  if (hasDuplicates || startRate < 0.95 || submitRate < 0.95 || autosaveRate < 0.95) {
    console.log("  NEEDS INVESTIGATION — one or more core phases dropped below 95% success, or duplicate submissions were detected.");
  } else if (p95 != null && p95 > 3000) {
    console.log("  PASS for internal pilot only — P95 latency is high (>3s); validate further before a larger class.");
  } else if (studentCount <= 30) {
    console.log("  PASS for small controlled class.");
  } else {
    console.log("  PASS for internal pilot — re-run at a larger size before recommending for a full class.");
  }
}

main().catch((err) => {
  console.error("Load test crashed:", err);
  process.exit(1);
});
